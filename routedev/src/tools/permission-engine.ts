// src/tools/permission-engine.ts
// 三层权限引擎（AgentScope 模式）— Phase 0c 后为唯一权限决策源
// Phase 21 Task 1：deny（不可覆盖）> confirm（需用户确认）> auto（自动放行）
// Phase 0c 修复：删除原 PermissionChecker（src/tools/permission.ts），权限统一由本类决策
//
// 设计原则：
//   1. Deny 不可覆盖 — 任何 autonomy mode 都不能绕过 deny 规则
//   2. 最严规则永远胜出 — 同时命中 deny + auto，最终是 deny
//   3. argsPredicate 支持 — 同一工具不同参数可命中不同层级
//
// 接入方式：
//   通过 AgentMiddlewarePipeline.onActing 中间件拦截工具调用
//   详见 src/cli/plugin-init.ts 的 registerPermissionMiddleware()

import type { AutonomyMode } from '../config/schema.js';
import { parseCommand } from './command-parser.js';
import type { ParsedCommand } from './command-parser.js';
import type { TrustGradientManager } from './trust-gradient.js';

/** 权限决策结果（三层） */
export type PermissionDecision = 'deny' | 'confirm' | 'auto';

// ============================================================
// Phase 47 Task 4：沙箱级与审批级分离的权限模型
// ============================================================

/** 沙箱级：决定工具能做多少（确定性 deny） */
export type SandboxLevel = 'read-only' | 'workspace-write' | 'full-access';

/** 审批级：决定是否询问用户 */
export type ApprovalLevel = 'always-ask' | 'on-request' | 'never-ask';

/** 工具分类 */
export type ToolCategory = 'read' | 'write' | 'shell' | 'network' | 'git-read' | 'git-write' | 'agent' | 'mcp';

/**
 * 沙箱级允许的工具类别映射
 * - read-only：仅允许读取类工具
 * - workspace-write：允许读取 + 工作区写入 + shell + git 读取
 * - full-access：允许所有类别
 */
const SANDBOX_ALLOWED: Record<SandboxLevel, ToolCategory[]> = {
  'read-only': ['read', 'git-read'],
  'workspace-write': ['read', 'write', 'shell', 'git-read'],
  'full-access': ['read', 'write', 'shell', 'network', 'git-read', 'git-write', 'agent', 'mcp'],
};

/**
 * 各工具类别的默认审批级
 * - read / git-read：never-ask（只读安全，无需询问）
 * - write / agent / mcp：on-request（按规则决定）
 * - shell / network / git-write：always-ask（高风险，强制询问）
 */
const DEFAULT_APPROVAL: Record<ToolCategory, ApprovalLevel> = {
  'read': 'never-ask',
  'write': 'on-request',
  'shell': 'always-ask',
  'network': 'always-ask',
  'git-read': 'never-ask',
  'git-write': 'always-ask',
  'agent': 'on-request',
  'mcp': 'on-request',
};

/**
 * 工具名 → 类别映射表
 * 未列出的工具默认归为 'write'（保守策略）
 * mcp__ 前缀的工具归为 'mcp'
 */
const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  // 读取类
  'file_read': 'read',
  'file_search': 'read',
  'glob': 'read',
  'code_search': 'read',
  'list_directory': 'read',
  'repo_map': 'read',
  // 写入类
  'file_write': 'write',
  'file_edit': 'write',
  'todo_write': 'write',
  'notes': 'write',
  // Shell
  'shell_exec': 'shell',
  // 网络
  'web_search': 'network',
  'web_fetch': 'network',
  // Git（保守归为 git-write，因为 git_op 可执行写操作）
  'git_op': 'git-write',
  // 子 Agent
  'spawn_agent': 'agent',
};

/**
 * I1 修复：对命令链中的所有子命令执行检查
 * 如果命令包含 &&、||、; 分隔的子命令链，对每个子命令独立检查
 * 任一子命令命中谓词则返回 true（最严规则胜出）
 * @param rawCommand 原始命令字符串
 * @param predicate 单个子命令的检查谓词，返回 true 表示命中
 */
function checkAllSubCommands(
  rawCommand: string,
  predicate: (parsed: ParsedCommand) => boolean,
): boolean {
  const parsed = parseCommand(rawCommand);
  // 单条命令（无命令链）
  if (!parsed.subCommands || parsed.subCommands.length <= 1) {
    return predicate(parsed);
  }
  // 命令链：任一子命令命中即返回 true
  return parsed.subCommands.some(sc => predicate(sc));
}

/** 权限规则（带参数谓词） */
export interface PermissionRule {
  /** 规则 ID（用于日志和测试） */
  id: string;
  /** 规则层级 */
  layer: PermissionDecision;
  /** 工具名 pattern（支持通配符 *，如 "file_*"） */
  toolPattern: string;
  /** 参数谓词（可选，命中工具名后再判断参数） */
  argsPredicate?: (args: Record<string, unknown>) => boolean;
  /** 规则描述（用于日志和给用户的提示） */
  description: string;
}

/** 权限检查结果 */
export interface PermissionCheckResult {
  /** 最终决策 */
  decision: PermissionDecision;
  /** 命中的规则 ID（fallback 时为 undefined） */
  matchedRuleId?: string;
  /** 决策原因（用于日志和给用户的提示） */
  reason: string;
}

/**
 * 三层权限引擎
 *
 * 检查顺序：deny > confirm > auto
 * - deny 命中 → 直接返回 deny（不可被 auto 覆盖）
 * - confirm 命中 → 返回 confirm（需用户确认）
 * - auto 命中或无规则 → 按 autonomy mode 决定（auto 模式放行，其他模式 confirm）
 */
export class PermissionEngine {
  private rules: PermissionRule[] = [];
  /** Phase 40 Task 1：注入的信任梯度管理器（可选） */
  private trustManager?: TrustGradientManager;

  // ============================================================
  // Phase 47 Task 4：沙箱级与审批级双旋钮
  // ============================================================

  /** 沙箱级（默认 workspace-write）：决定工具能做多少 */
  private sandboxLevel: SandboxLevel = 'workspace-write';

  /**
   * 沙箱是否已激活（向后兼容）
   * - false：未显式配置沙箱，跳过沙箱级和审批级检查（行为与 Phase 47 前一致）
   * - true：已通过 setSandboxLevel() 或配置加载器显式配置，启用沙箱级和审批级检查
   */
  private sandboxActive: boolean = false;

  /** 审批级覆盖（按工具类别覆盖默认审批级） */
  private approvalOverrides: Map<ToolCategory, ApprovalLevel> = new Map();

  /** headless 模式（无 TTY，always-ask 工具自动 deny） */
  private headless: boolean = false;

  /** 设置沙箱级（同时激活沙箱和审批级检查） */
  setSandboxLevel(level: SandboxLevel): void {
    this.sandboxLevel = level;
    this.sandboxActive = true;
  }

  /** 获取当前沙箱级 */
  getSandboxLevel(): SandboxLevel {
    return this.sandboxLevel;
  }

  /** 设置某类工具的审批级覆盖 */
  setApproval(category: ToolCategory, level: ApprovalLevel): void {
    this.approvalOverrides.set(category, level);
  }

  /** 设置 headless 模式（陷阱 #135：always-ask 在 headless 下自动 deny） */
  setHeadlessMode(headless: boolean): void {
    this.headless = headless;
  }

  /**
   * 工具名 → 类别映射
   * - 已知工具按 TOOL_CATEGORY_MAP 映射
   * - mcp__ 前缀归为 'mcp'
   * - 未知工具默认归为 'write'（保守策略）
   */
  categorize(toolName: string): ToolCategory {
    const mapped = TOOL_CATEGORY_MAP[toolName];
    if (mapped) {
      return mapped;
    }
    if (toolName.startsWith('mcp__')) {
      return 'mcp';
    }
    return 'write';
  }

  /** 加载规则集（替换现有规则） */
  loadRules(rules: PermissionRule[]): void {
    this.rules = [...rules];
  }

  /** 追加单条规则 */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /** 获取当前规则集（用于测试） */
  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /**
   * Phase 40 Task 1：注入 TrustGradientManager
   *
   * 注入后，check() 方法会在 deny 规则之后、confirm/auto 规则之前
   * 调用 TrustGradientManager.checkOperation() 进行信任梯度检查
   */
  setTrustGradientManager(manager: TrustGradientManager): void {
    this.trustManager = manager;
  }

  /** 获取注入的 TrustGradientManager（用于 /trust 命令） */
  getTrustGradientManager(): TrustGradientManager | undefined {
    return this.trustManager;
  }

  /**
   * 检查工具调用的权限
   *
   * Phase 40 Task 1：集成 TrustGradientManager
   * Phase 47 Task 4：沙箱级 + 审批级双旋钮
   *
   * 检查顺序（陷阱 #136：沙箱级判断必须在审批级之前）：
   *   0. 沙箱级检查（确定性 deny）— 工具类别不在当前沙箱允许列表中 → deny
   *   1. deny 规则检查（最高优先级，不可被临时授权绕过）
   *   2. TrustGradientManager 检查（如果注入了）
   *      - checkOperation() 返回临时放行 → 返回 auto
   *      - checkOperation() 返回需要确认 → 继续后续规则检查
   *      - checkOperation() 返回拦截（plan 模式）→ 返回 deny
   *   3. confirm/auto 规则检查
   *   4. 默认 confirm
   *   5. 审批级检查（陷阱 #135：always-ask 在 headless 模式下自动 deny）
   *      - never-ask：confirm → auto（不询问）
   *      - always-ask：headless → deny；非 headless → auto 升级为 confirm
   *      - on-request：不改变规则决策
   *
   * @param toolName 工具名
   * @param args 工具参数
   * @param mode 当前自主度模式（仅用于 fallback）
   */
  check(
    toolName: string,
    args: Record<string, unknown>,
    mode: AutonomyMode,
  ): PermissionCheckResult {
    // 工具分类（沙箱级和审批级共用）
    const category = this.categorize(toolName);

    // 0. 沙箱级检查（确定性 deny）— 陷阱 #136：必须在审批级之前
    // 向后兼容：仅在沙箱显式激活时执行（未配置时跳过，行为与 Phase 47 前一致）
    if (this.sandboxActive) {
      const allowedCategories = SANDBOX_ALLOWED[this.sandboxLevel];
      if (!allowedCategories.includes(category)) {
        return {
          decision: 'deny',
          reason: `沙箱级拒绝: ${toolName} 属于 "${category}" 类别，当前沙箱级 "${this.sandboxLevel}" 不允许此类别`,
        };
      }
    }

    // 找出所有命中的规则（工具名 + 参数谓词都满足）
    const matched = this.rules.filter(r => this.matchRule(r, toolName, args));

    // 1. deny 优先级最高，不可被覆盖（不可被临时授权绕过）
    const denyRule = matched.find(r => r.layer === 'deny');
    if (denyRule) {
      return {
        decision: 'deny',
        matchedRuleId: denyRule.id,
        reason: denyRule.description,
      };
    }

    // 2. TrustGradientManager 检查（如果注入了）
    if (this.trustManager) {
      const isWriteOp = this.isWriteOperation(toolName);
      const trustResult = this.trustManager.checkOperation(toolName, args, isWriteOp);
      // 临时放行 → 返回 auto（仍需经过审批级检查）
      if (trustResult.allowed && !trustResult.requiresConfirmation) {
        return this.applyApproval(category, {
          decision: 'auto',
          reason: trustResult.reason,
        });
      }
      // 拦截（plan 模式）→ 返回 deny（最终决策，不经过审批级）
      if (!trustResult.allowed) {
        return {
          decision: 'deny',
          reason: trustResult.reason,
        };
      }
      // 需要确认 → 继续后续规则检查
    }

    // 3. confirm 次之
    const confirmRule = matched.find(r => r.layer === 'confirm');
    if (confirmRule) {
      return this.applyApproval(category, {
        decision: 'confirm',
        matchedRuleId: confirmRule.id,
        reason: confirmRule.description,
      });
    }

    // auto 命中 → 放行（仍需经过审批级检查）
    const autoRule = matched.find(r => r.layer === 'auto');
    if (autoRule) {
      return this.applyApproval(category, {
        decision: 'auto',
        matchedRuleId: autoRule.id,
        reason: autoRule.description,
      });
    }

    // 4. 无规则命中 → 按 autonomy mode fallback
    // auto 模式放行，semi/manual 模式需确认
    return this.applyApproval(category, {
      decision: mode === 'auto' ? 'auto' : 'confirm',
      reason: 'Fallback: 无匹配规则，按自主度模式决定',
    });
  }

  /**
   * 审批级检查（Phase 47 Task 4）
   *
   * 对非 deny 决策应用审批级旋钮：
   * - never-ask：confirm → auto（用户不想被询问）
   * - always-ask：headless → deny（陷阱 #135）；非 headless → auto 升级为 confirm
   * - on-request：不改变决策
   *
   * @param category 工具类别
   * @param result 规则检查结果（非 deny）
   */
  private applyApproval(
    category: ToolCategory,
    result: PermissionCheckResult,
  ): PermissionCheckResult {
    // 向后兼容：沙箱未激活时跳过审批级检查（行为与 Phase 47 前一致）
    if (!this.sandboxActive) {
      return result;
    }

    // deny 决策不可被审批级覆盖
    if (result.decision === 'deny') {
      return result;
    }

    const approvalLevel = this.approvalOverrides.get(category) ?? DEFAULT_APPROVAL[category];

    // never-ask：confirm → auto（用户不想被询问）
    if (approvalLevel === 'never-ask' && result.decision === 'confirm') {
      return {
        decision: 'auto',
        matchedRuleId: result.matchedRuleId,
        reason: `${result.reason} [审批级 never-ask: 自动放行]`,
      };
    }

    // always-ask：陷阱 #135 — headless 模式下自动 deny
    if (approvalLevel === 'always-ask') {
      if (this.headless) {
        return {
          decision: 'deny',
          reason: `headless 模式下 "${category}" 类别 (always-ask) 自动拒绝`,
        };
      }
      // 非 headless：auto 升级为 confirm（强制询问）
      if (result.decision === 'auto') {
        return {
          decision: 'confirm',
          matchedRuleId: result.matchedRuleId,
          reason: `${result.reason} [审批级 always-ask: 强制确认]`,
        };
      }
    }

    // on-request 或无需调整：原样返回
    return result;
  }

  /**
   * 判断规则是否命中
   * - 工具名匹配：精确匹配、'*' 通配、'prefix*' 前缀通配
   * - 参数谓词：若规则定义了 argsPredicate，必须返回 true
   */
  private matchRule(
    rule: PermissionRule,
    toolName: string,
    args: Record<string, unknown>,
  ): boolean {
    // 工具名匹配
    if (rule.toolPattern !== '*' && rule.toolPattern !== toolName) {
      // 支持 prefix* 形式的通配
      if (
        !rule.toolPattern.endsWith('*') ||
        !toolName.startsWith(rule.toolPattern.slice(0, -1))
      ) {
        return false;
      }
    }

    // 参数谓词匹配
    if (rule.argsPredicate && !rule.argsPredicate(args)) {
      return false;
    }

    return true;
  }

  /**
   * 判断工具是否为写操作（Phase 40 Task 1）
   *
   * 用于向 TrustGradientManager.checkOperation() 传递 isWriteOp 参数
   */
  private isWriteOperation(toolName: string): boolean {
    return (
      toolName === 'file_write' ||
      toolName === 'file_edit' ||
      toolName === 'shell_exec' ||
      toolName === 'git_op' ||
      toolName === 'todo_write' ||
      toolName === 'notes'
    );
  }
}

// ============================================================
// 默认规则集
// ============================================================

/** 默认 deny 规则（不可覆盖） */
export const DEFAULT_DENY_RULES: PermissionRule[] = [
  {
    id: 'deny-rm-rf-root',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // Phase 29 Task 3：基于 tokenize 解析替代正则匹配（修复 S1）
    // 修复绕过场景：rm -rf "/"（引号）、RM -rf /（大写）、rm -rf "/"（引号+大写）
    // I7 修复：同时检查原始命令字符串，防止子 shell/变量展开绕过 tokenize
    // I1 修复：对命令链（&&、||、;）中的每个子命令独立检查
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      // 先检查原始字符串是否包含危险模式（防止 bash -c "rm -rf /" 等子 shell 绕过）
      if (/\brm\b(?=[\s\S]*\s-[a-zA-Z]*r)(?=[\s\S]*\s-[a-zA-Z]*f)[\s\S]*\s['"]?\/['"]?(\s|$|--)/i.test(rawCommand)) {
        return true;
      }
      // I1 修复：对命令链中的每个子命令独立检查
      return checkAllSubCommands(rawCommand, parsed => {
        // 命令名是 rm（不区分大小写）
        if (parsed.command.toLowerCase() !== 'rm') return false;
        // 参数含 -f 类标志（如 -rf、-fr、-f）
        const hasRecursiveFlag = parsed.args.some(arg => /^-[a-zA-Z]*r[a-zA-Z]*$/.test(arg));
        const hasForceFlag = parsed.args.some(arg => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg));
        // 目标是根目录（支持引号包裹的变体）
        const targetsRoot = parsed.args.some(arg =>
          arg === '/' || arg === '"/"' || arg === "'/'"
        );
        return hasRecursiveFlag && hasForceFlag && targetsRoot;
      });
    },
    description: '禁止: rm -rf /（删除根目录）',
  },
  {
    id: 'deny-find-delete',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 阻止 find ... -delete（可递归删除文件）
    // 安全修复：统一使用 toLowerCase()，防止 FIND/Find 等大写变体绕过
    // I7 修复：同时检查原始命令字符串
    // I1 修复：对命令链中的每个子命令独立检查
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      if (/\bfind\b.*(?:-delete|-exec\s+rm\b)/i.test(rawCommand)) return true;
      return checkAllSubCommands(rawCommand, parsed => {
        if (parsed.command.toLowerCase() !== 'find') return false;
        if (parsed.args.includes('-delete')) return true;
        const execIndex = parsed.args.findIndex(arg => arg === '-exec');
        return execIndex >= 0 && parsed.args.slice(execIndex + 1).some(arg => arg.toLowerCase() === 'rm');
      });
    },
    description: '禁止: find ... -delete（递归删除）',
  },
  {
    id: 'deny-dd-device',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 阻止 dd 写入设备文件（可破坏磁盘）
    // 安全修复：统一使用 toLowerCase()，防止 DD/Dd 等大写变体绕过
    // I7 修复：同时检查原始命令字符串，匹配 of= 任意位置
    // I1 修复：对命令链中的每个子命令独立检查
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      if (/\bdd\b.*of=\/dev\//i.test(rawCommand)) return true;
      return checkAllSubCommands(rawCommand, parsed => {
        return parsed.command.toLowerCase() === 'dd' && parsed.args.some(arg => /^of=\/dev\//.test(arg));
      });
    },
    description: '禁止: dd of=/dev/...（写入设备文件）',
  },
  {
    id: 'deny-system-dirs',
    layer: 'deny',
    toolPattern: 'file_write',
    // C6 修复：同时检查 Unix 和 Windows 系统目录
    argsPredicate: a => {
      const p = String(a.path ?? '');
      // Unix 系统目录
      if (/^\/(etc|proc|sys|dev|boot|root)\//.test(p)) return true;
      // Windows 系统目录（不区分大小写、支持正反斜杠）
      const normalized = p.replace(/\\/g, '/').toLowerCase();
      if (/^[a-z]:\/(windows|program files|programdata|system32)/.test(normalized)) return true;
      // Windows 用户目录下的系统关键路径
      if (/^[a-z]:\/users\/[^/]+\/appdata\/local\/microsoft\//.test(normalized)) return true;
      return false;
    },
    description: '禁止: 写入系统目录（Unix: /etc, /proc, /sys, /dev, /boot, /root；Windows: C:\\Windows, C:\\Program Files, C:\\ProgramData）',
  },
  {
    id: 'deny-file-edit-system-dirs',
    layer: 'deny',
    toolPattern: 'file_edit',
    // C6 修复：file_edit 也禁止写入系统目录
    argsPredicate: a => {
      const p = String(a.path ?? '');
      if (/^\/(etc|proc|sys|dev|boot|root)\//.test(p)) return true;
      const normalized = p.replace(/\\/g, '/').toLowerCase();
      if (/^[a-z]:\/(windows|program files|programdata|system32)/.test(normalized)) return true;
      if (/^[a-z]:\/users\/[^/]+\/appdata\/local\/microsoft\//.test(normalized)) return true;
      return false;
    },
    description: '禁止: 编辑系统目录中的文件',
  },
  // Phase 40 Task 1：Windows 特有危险命令
  {
    id: 'deny-windows-format',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 禁止 format 命令（格式化磁盘）
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      if (/\bformat\b\s+[a-z]:/i.test(rawCommand)) return true;
      return checkAllSubCommands(rawCommand, parsed => {
        return parsed.command.toLowerCase() === 'format';
      });
    },
    description: '禁止: format（格式化磁盘）',
  },
  {
    id: 'deny-windows-diskpart',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 禁止 diskpart 命令（磁盘分区管理）
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      if (/\bdiskpart\b/i.test(rawCommand)) return true;
      return checkAllSubCommands(rawCommand, parsed => {
        return parsed.command.toLowerCase() === 'diskpart';
      });
    },
    description: '禁止: diskpart（磁盘分区操作）',
  },
  {
    id: 'deny-windows-reg-delete',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 禁止 reg delete 命令（注册表删除）
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      if (/\breg\s+delete\b/i.test(rawCommand)) return true;
      return checkAllSubCommands(rawCommand, parsed => {
        return parsed.command.toLowerCase() === 'reg' &&
          parsed.args.length > 0 &&
          parsed.args[0].toLowerCase() === 'delete';
      });
    },
    description: '禁止: reg delete（注册表删除）',
  },
  {
    id: 'deny-windows-bcdedit',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 禁止 bcdedit 命令（引导配置数据编辑）
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      if (/\bbcdedit\b/i.test(rawCommand)) return true;
      return checkAllSubCommands(rawCommand, parsed => {
        return parsed.command.toLowerCase() === 'bcdedit';
      });
    },
    description: '禁止: bcdedit（引导配置编辑）',
  },
  {
    id: 'deny-windows-netsh-firewall',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 禁止 netsh firewall 命令（防火墙规则修改）
    argsPredicate: a => {
      const rawCommand = String(a.command ?? '');
      if (/\bnetsh\s+.*firewall\b/i.test(rawCommand)) return true;
      return checkAllSubCommands(rawCommand, parsed => {
        return parsed.command.toLowerCase() === 'netsh' &&
          parsed.args.some(arg => arg.toLowerCase() === 'firewall');
      });
    },
    description: '禁止: netsh firewall（防火墙规则修改）',
  },
];

/** 默认 confirm 规则（需用户确认） */
export const DEFAULT_CONFIRM_RULES: PermissionRule[] = [
  {
    id: 'confirm-shell-exec',
    layer: 'confirm',
    toolPattern: 'shell_exec',
    description: 'Shell 命令执行需要确认',
  },
  {
    id: 'confirm-git-op',
    layer: 'confirm',
    toolPattern: 'git_op',
    description: 'Git 写操作需要确认',
  },
  {
    id: 'confirm-web-search',
    layer: 'confirm',
    toolPattern: 'web_search',
    description: '网络搜索需要确认',
  },
];

/** 默认 auto 规则（自动放行） */
export const DEFAULT_AUTO_RULES: PermissionRule[] = [
  {
    id: 'auto-file-read',
    layer: 'auto',
    toolPattern: 'file_read',
    description: '文件读取安全，自动放行',
  },
  // C3 修复：删除 auto-file-wildcard（file_*），因为它会自动放行 file_write/file_edit
  // 破坏性文件操作必须走 confirm 规则，不能被 auto 规则覆盖
  {
    id: 'auto-file-search',
    layer: 'auto',
    toolPattern: 'file_search',
    description: '文件搜索（只读）自动放行',
  },
  {
    id: 'auto-glob',
    layer: 'auto',
    toolPattern: 'glob',
    description: '文件搜索安全，自动放行',
  },
  {
    id: 'auto-code-search',
    layer: 'auto',
    toolPattern: 'code_search',
    description: '代码搜索自动放行',
  },
];

/**
 * 加载所有默认规则到引擎
 *
 * Phase 47 Task 4：向后兼容 — createDefaultEngine 设置沙箱为 'full-access'
 * 避免现有测试和未配置沙箱的场景因 workspace-write 沙箱限制而行为变更
 * （如 web_search/git_op 等工具在 workspace-write 下会被沙箱 deny）
 * 用户通过配置文件显式设置 sandbox 时，由 config loader 覆盖此值
 */
export function createDefaultEngine(): PermissionEngine {
  const engine = new PermissionEngine();
  engine.loadRules([
    ...DEFAULT_DENY_RULES,
    ...DEFAULT_CONFIRM_RULES,
    ...DEFAULT_AUTO_RULES,
  ]);
  // 向后兼容：默认引擎不启用沙箱限制
  engine.setSandboxLevel('full-access');
  return engine;
}

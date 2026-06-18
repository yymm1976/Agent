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

/** 权限决策结果（三层） */
export type PermissionDecision = 'deny' | 'confirm' | 'auto';

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
   * 检查工具调用的权限
   * 三层按优先级合并：deny > confirm > auto
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
    // 找出所有命中的规则（工具名 + 参数谓词都满足）
    const matched = this.rules.filter(r => this.matchRule(r, toolName, args));

    // deny 优先级最高，不可被覆盖
    const denyRule = matched.find(r => r.layer === 'deny');
    if (denyRule) {
      return {
        decision: 'deny',
        matchedRuleId: denyRule.id,
        reason: denyRule.description,
      };
    }

    // confirm 次之
    const confirmRule = matched.find(r => r.layer === 'confirm');
    if (confirmRule) {
      return {
        decision: 'confirm',
        matchedRuleId: confirmRule.id,
        reason: confirmRule.description,
      };
    }

    // auto 命中 → 放行
    const autoRule = matched.find(r => r.layer === 'auto');
    if (autoRule) {
      return {
        decision: 'auto',
        matchedRuleId: autoRule.id,
        reason: autoRule.description,
      };
    }

    // 无规则命中 → 按 autonomy mode fallback
    // auto 模式放行，semi/manual 模式需确认
    return {
      decision: mode === 'auto' ? 'auto' : 'confirm',
      reason: 'Fallback: 无匹配规则，按自主度模式决定',
    };
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
    argsPredicate: a => {
      const parsed = parseCommand(String(a.command ?? ''));
      // 命令名是 rm（不区分大小写）
      if (parsed.command.toLowerCase() !== 'rm') return false;
      // 参数含 -f 类标志（如 -rf、-fr、-f）
      const hasForceFlag = parsed.args.some(arg => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg));
      // 目标是根目录（支持引号包裹的变体）
      const targetsRoot = parsed.args.some(arg =>
        arg === '/' || arg === '"/"' || arg === "'/'"
      );
      return hasForceFlag && targetsRoot;
    },
    description: '禁止: rm -rf /（删除根目录）',
  },
  {
    id: 'deny-find-delete',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 阻止 find ... -delete（可递归删除文件）
    argsPredicate: a => {
      const parsed = parseCommand(String(a.command ?? ''));
      return parsed.command === 'find' && parsed.args.includes('-delete');
    },
    description: '禁止: find ... -delete（递归删除）',
  },
  {
    id: 'deny-dd-device',
    layer: 'deny',
    toolPattern: 'shell_exec',
    // 阻止 dd 写入设备文件（可破坏磁盘）
    argsPredicate: a => {
      const parsed = parseCommand(String(a.command ?? ''));
      return parsed.command === 'dd' && parsed.args.some(arg => /^of=\/dev\//.test(arg));
    },
    description: '禁止: dd of=/dev/...（写入设备文件）',
  },
  {
    id: 'deny-system-dirs',
    layer: 'deny',
    toolPattern: 'file_write',
    argsPredicate: a =>
      /^\/(etc|proc|sys|dev|boot)\//.test(String(a.path ?? '')),
    description: '禁止: 写入系统目录（/etc, /proc, /sys, /dev, /boot）',
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
  {
    id: 'auto-file-wildcard',
    layer: 'auto',
    toolPattern: 'file_*',
    description: '文件操作自动放行',
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

/** 加载所有默认规则到引擎 */
export function createDefaultEngine(): PermissionEngine {
  const engine = new PermissionEngine();
  engine.loadRules([
    ...DEFAULT_DENY_RULES,
    ...DEFAULT_CONFIRM_RULES,
    ...DEFAULT_AUTO_RULES,
  ]);
  return engine;
}

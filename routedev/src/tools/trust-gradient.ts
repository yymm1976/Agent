// src/tools/trust-gradient.ts
// Claude Code 7 级信任梯度 + 权限 resume 不恢复
//
// 借鉴来源：Claude Code 的 Deny-first + 7 级信任梯度设计
//
// 最优解思考：
//   原有的 deny > confirm > auto 三层粒度太粗
//   Claude Code 的 7 级梯度更精细：
//     plan → default → acceptEdits → auto → bypassPermissions
//   关键设计：权限状态在 resume 时不恢复——每次新会话必须重新建立信任
//   这是一个安全意识极强的设计，防止"上次开了 auto 模式这次忘了关"

import type { AutonomyMode } from '../config/schema.js';
import { logger } from '../utils/logger.js';
import { createHash } from 'node:crypto';
import type { ProjectTrustStore } from './project-trust-store.js';

/**
 * 7 级信任梯度（借鉴 Claude Code）
 *
 * 从最严格到最宽松：
 *   1. plan          — 只规划不执行
 *   2. default       — 每次都确认
 *   3. acceptEdits   — 文件操作自动通过，Shell 需确认
 *   4. acceptAll     — 所有操作自动通过但记录
 *   5. auto          — LLM 分类器判断安全性
 *   6. bypassPermissions — 跳过所有检查
 *   7. trusted       — 完全信任（仅用于测试环境）
 */
export type TrustLevel = 'plan' | 'default' | 'acceptEdits' | 'acceptAll' | 'auto' | 'bypassPermissions' | 'trusted';

/**
 * 五级操作风险分类（Phase 40 Task 1）
 *
 * 从最低风险到最高风险：
 *   1. read    — 只读操作（file_read, list_directory, glob 等）
 *   2. write   — 文件写入（file_write, file_edit, todo_write 等）
 *   3. execute — 命令执行（shell_exec, git_op 非 push）
 *   4. network — 网络访问（web_search, web_fetch）
 *   5. push    — 推送到远程（git push，最高风险）
 */
type RiskLevel = 'read' | 'write' | 'execute' | 'network' | 'push';

/**
 * 每个 TrustLevel 对应的风险容忍阈值
 *
 * 在容忍阈值内的操作自动放行，超出阈值的操作需要确认（或被拦截）
 *
 * 关键设计：
 *   - bypassPermissions 放行所有但不包含 push（防止误推到远程）
 *   - trusted 放行所有（仅用于测试环境）
 */
const TRUST_RISK_TOLERANCE: Record<TrustLevel, RiskLevel[]> = {
  plan: ['read'],
  default: ['read'],
  acceptEdits: ['read', 'write'],
  acceptAll: ['read', 'write', 'execute'],
  auto: ['read', 'write', 'execute', 'network'],
  bypassPermissions: ['read', 'write', 'execute', 'network'], // 不含 push
  trusted: ['read', 'write', 'execute', 'network', 'push'],
};

/** 临时授权记录（会话级，resume 时不恢复） */
interface TemporaryGrant {
  toolName: string;
  argsHash: string;
  grantedAt: number;
  /** 过期时间戳（毫秒），到期后自动清理 */
  expiresAt: number;
  /** 路径前缀（可选，用于前缀匹配——对路径参数做前缀放行） */
  pathPrefix?: string;
}

/** 默认临时授权有效期：30 分钟 */
const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * 信任梯度管理器
 *
 * 核心设计：
 *   1. Deny-first：一个宽泛的 deny 永远覆盖一个狭窄的 allow
 *   2. 权限 resume 不恢复：新会话启动时清理所有临时授权
 *   3. 临时授权有 TTL，到期自动失效
 */
export class TrustGradientManager {
  /** 当前信任级别 */
  private currentLevel: TrustLevel = 'default';
  /** 会话级临时授权（resume 时不恢复） */
  private temporaryGrants: Map<string, TemporaryGrant> = new Map();
  /** 会话 ID（用于标识授权范围） */
  private sessionId: string;
  /** P6：临时授权 Map 上限（超出时淘汰最旧的未过期项） */
  private readonly maxGrants = 1000;
  /**
   * P2-8：可选的持久化仓库
   *
   * 注入后：
   *   - setLevel 自动调用 store.save(cwd, level) 持久化到 .routedev/trust.json
   *   - 启动时可通过 loadInheritedFromStore() 加载继承的级别
   * 未注入时（默认）：保持纯内存行为，向后兼容
   */
  private trustStore: ProjectTrustStore | null = null;
  /** P2-8：当前工作目录（持久化用） */
  private cwd: string | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** 获取当前信任级别 */
  getLevel(): TrustLevel {
    return this.currentLevel;
  }

  /**
   * P2-8：注入 ProjectTrustStore 并设置当前工作目录
   *
   * 注入后 setLevel 会自动持久化到 cwd/.routedev/trust.json
   * 不自动加载（loadInheritedFromStore 由调用方显式触发，避免构造期 IO）
   *
   * @param store 信任仓库实例
   * @param cwd 当前工作目录绝对路径
   */
  attachPersistence(store: ProjectTrustStore, cwd: string): void {
    this.trustStore = store;
    this.cwd = cwd;
    logger.debug('TrustGradientManager: persistence attached', { cwd });
  }

  /**
   * P2-8：从 store 加载继承的信任级别
   *
   * 调用 store.findInherited(cwd) 向上查找最近的 .routedev/trust.json，
   * 找到时把当前级别设为该值；找不到时保持默认。
   *
   * 设计：仅恢复"信任级别"这一持久化字段，不恢复临时授权
   * （保持 Claude Code 的"resume 时不恢复权限"设计）
   *
   * @returns 加载来源信息（含 sourcePath / isLocal）
   */
  async loadInheritedFromStore(): Promise<{ sourcePath: string | null; isLocal: boolean } | null> {
    if (!this.trustStore || !this.cwd) return null;
    const inherited = await this.trustStore.findInherited(this.cwd);
    this.currentLevel = inherited.level;
    logger.info('Trust level loaded from store (inherited)', {
      level: inherited.level,
      sourcePath: inherited.sourcePath,
      isLocal: inherited.isLocal,
      session: this.sessionId,
    });
    return { sourcePath: inherited.sourcePath, isLocal: inherited.isLocal };
  }

  /** 设置信任级别 */
  setLevel(level: TrustLevel): void {
    if (this.currentLevel === level) return;
    logger.info('Trust level changed', {
      from: this.currentLevel,
      to: level,
      session: this.sessionId,
    });
    this.currentLevel = level;
    // P2-8：注入了 store 时持久化到磁盘（fire-and-forget，不阻塞调用方）
    if (this.trustStore && this.cwd) {
      this.trustStore.save(this.cwd, level).catch((err) => {
        logger.warn('TrustGradientManager: failed to persist trust level', {
          cwd: this.cwd,
          level,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * 新会话启动：清理所有临时授权
   *
   * 这是 Claude Code 的核心安全设计：
   *   "权限状态在 resume 时不恢复——每次新会话必须重新建立信任"
   *   防止"上次开了 auto 模式这次忘了关"
   */
  clearSessionGrants(): void {
    const count = this.temporaryGrants.size;
    this.temporaryGrants.clear();
    if (count > 0) {
      logger.info('Session grants cleared (resume does not restore permissions)', {
        session: this.sessionId,
        clearedCount: count,
      });
    }
  }

  /**
   * 授予临时授权
   *
   * @param toolName 工具名
   * @param args 参数（用于计算 hash）
   * @param ttlMs 有效期（毫秒），默认 30 分钟
   */
  grantTemporary(toolName: string, args: Record<string, unknown>, ttlMs = DEFAULT_GRANT_TTL_MS): void {
    const argsHash = this.hashArgs(args);
    const key = `${toolName}:${argsHash}`;
    const pathPrefix = this.extractPathPrefix(args);
    // P6：达到上限时先清理过期项，仍超限则淘汰最旧项
    if (this.temporaryGrants.size >= this.maxGrants) {
      this.cleanupExpiredGrants();
      if (this.temporaryGrants.size >= this.maxGrants) {
        // 淘汰 grantedAt 最早的项
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [k, g] of this.temporaryGrants) {
          if (g.grantedAt < oldestTime) {
            oldestTime = g.grantedAt;
            oldestKey = k;
          }
        }
        if (oldestKey) this.temporaryGrants.delete(oldestKey);
      }
    }
    this.temporaryGrants.set(key, {
      toolName,
      argsHash,
      grantedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      pathPrefix,
    });
  }

  /**
   * 检查是否有临时授权
   *
   * 匹配顺序：
   *   1. 精确匹配（argsHash 完全一致）
   *   2. 前缀匹配（pathPrefix 匹配——对 file_write 在 src/utils/ 下放行时，
   *      src/utils/helpers/format.ts 也匹配）
   */
  hasTemporaryGrant(toolName: string, args: Record<string, unknown>): boolean {
    const argsHash = this.hashArgs(args);
    const key = `${toolName}:${argsHash}`;
    const grant = this.temporaryGrants.get(key);

    // 1. 精确匹配
    if (grant) {
      if (Date.now() > grant.expiresAt) {
        this.temporaryGrants.delete(key);
        logger.debug('Temporary grant expired', { toolName, argsHash });
        return false;
      }
      return true;
    }

    // 2. 前缀匹配：检查是否有同工具的授权其 pathPrefix 匹配当前路径
    const currentPath = this.extractPathPrefix(args);
    if (currentPath) {
      for (const [k, g] of this.temporaryGrants) {
        if (g.toolName !== toolName) continue;
        if (!g.pathPrefix) continue;
        // 过期检查
        if (Date.now() > g.expiresAt) {
          this.temporaryGrants.delete(k);
          continue;
        }
        // 前缀匹配：当前路径以授权路径前缀开头
        if (currentPath.startsWith(g.pathPrefix)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 检查操作是否被当前信任级别允许
   *
   * Phase 40 Task 1：基于五级风险分类 + 风险容忍阈值决策
   *
   * Deny-first 原则：宽泛的 deny 永远覆盖狭窄的 allow
   *
   * @param toolName 工具名
   * @param args 参数
   * @param isWriteOp 是否为写操作（向后兼容，实际决策由风险分类决定）
   * @returns { allowed, requiresConfirmation, reason }
   */
  checkOperation(
    toolName: string,
    args: Record<string, unknown>,
    _isWriteOp: boolean,
  ): { allowed: boolean; requiresConfirmation: boolean; reason: string } {
    const risk = this.classifyRisk(toolName, args);
    const tolerated = TRUST_RISK_TOLERANCE[this.currentLevel];

    // trusted：放行所有（含 push）
    if (this.currentLevel === 'trusted') {
      return { allowed: true, requiresConfirmation: false, reason: `信任级别 trusted，跳过检查` };
    }

    // 风险在容忍阈值内 → 自动放行
    if (tolerated.includes(risk)) {
      if (this.currentLevel === 'acceptAll') {
        logger.info('Operation auto-approved (acceptAll)', { toolName });
      }
      return { allowed: true, requiresConfirmation: false, reason: `${this.currentLevel} 模式放行 ${risk} 操作` };
    }

    // plan：超出容忍阈值的操作直接拦截（不允许确认）
    if (this.currentLevel === 'plan') {
      return { allowed: false, requiresConfirmation: false, reason: 'Plan 模式拦截写操作' };
    }

    // 检查临时授权（前缀匹配）
    if (this.hasTemporaryGrant(toolName, args)) {
      return { allowed: true, requiresConfirmation: false, reason: '临时授权有效' };
    }

    // 其他级别：需要确认
    return { allowed: true, requiresConfirmation: true, reason: `${this.currentLevel} 模式需要确认` };
  }

  /**
   * 分类操作的风险级别（Phase 40 Task 1）
   *
   * @param toolName 工具名
   * @param args 参数
   * @returns 风险级别（read/write/execute/network/push）
   */
  classifyRisk(toolName: string, args: Record<string, unknown>): RiskLevel {
    // git_op with push → push（最高风险）
    if (toolName === 'git_op') {
      const op = String(args.operation ?? args.action ?? args.subcommand ?? '');
      if (op === 'push') return 'push';
      return 'execute';
    }

    // shell_exec with git push → push（防止通过 shell 绕过）
    if (toolName === 'shell_exec') {
      const cmd = String(args.command ?? '');
      if (/\bgit\s+push\b/i.test(cmd)) return 'push';
      return 'execute';
    }

    // 只读操作
    if (
      toolName === 'file_read' ||
      toolName === 'list_directory' ||
      toolName === 'file_search' ||
      toolName === 'glob' ||
      toolName === 'code_search' ||
      toolName === 'repo_map'
    ) {
      return 'read';
    }

    // 写入操作
    if (
      toolName === 'file_write' ||
      toolName === 'file_edit' ||
      toolName === 'todo_write' ||
      toolName === 'notes'
    ) {
      return 'write';
    }

    // 网络操作
    if (toolName === 'web_search' || toolName === 'web_fetch') {
      return 'network';
    }

    // 默认：execute（未知工具按较高风险处理）
    return 'execute';
  }

  /** 清理过期的临时授权 */
  cleanupExpiredGrants(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, grant] of this.temporaryGrants) {
      if (now > grant.expiresAt) {
        this.temporaryGrants.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug('Expired grants cleaned up', { count: cleaned });
    }
  }

  /** 获取当前临时授权数量（用于测试） */
  getTemporaryGrantsCount(): number {
    return this.temporaryGrants.size;
  }

  /**
   * 从参数中提取路径前缀（用于前缀匹配）
   *
   * 对 file_write 在 src/utils/foo.ts 放行时，
   * 提取 src/utils/ 作为前缀，使 src/utils/helpers/format.ts 也匹配
   *
   * @param args 工具参数
   * @returns 路径前缀（无路径参数时返回 undefined）
   */
  private extractPathPrefix(args: Record<string, unknown>): string | undefined {
    const p = String(args.path ?? args.filePath ?? args.file ?? '');
    if (!p) return undefined;

    // 提取目录部分作为前缀
    const normalized = p.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return undefined;

    const dir = normalized.substring(0, lastSlash + 1); // 含尾部 /
    return dir;
  }

  /**
   * 计算参数 hash
   * I3 修复：使用 SHA-256 替代 djb2 32 位 hash
   * 原 djb2 hash 只有 ~42 亿可能值，~77000 次授权后生日悖论碰撞概率显著
   * SHA-256 提供足够的抗碰撞性，防止权限泄漏
   */
  private hashArgs(args: Record<string, unknown>): string {
    const str = JSON.stringify(args, Object.keys(args).sort());
    return createHash('sha256').update(str, 'utf-8').digest('hex');
  }

  /** 将信任级别映射到 AutonomyMode（向后兼容） */
  toAutonomyMode(): AutonomyMode {
    switch (this.currentLevel) {
      case 'plan': return 'manual';
      case 'default': return 'manual';
      case 'acceptEdits': return 'semi';
      case 'acceptAll': return 'semi';
      case 'auto': return 'auto';
      case 'bypassPermissions': return 'auto';
      case 'trusted': return 'auto';
    }
  }

  /** 从 AutonomyMode 映射到信任级别（向后兼容） */
  static fromAutonomyMode(mode: AutonomyMode): TrustLevel {
    switch (mode) {
      case 'manual': return 'default';
      case 'semi': return 'acceptEdits';
      case 'auto': return 'auto';
    }
  }
}

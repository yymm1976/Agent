// src/hooks/hook-enhancement.ts
// Phase 40 Task 9：Hook 增强
//
// 四项增强：
//   1. 函数型 Hook：注册 JS 函数而非 shell 命令，沙箱化受限 API
//   2. Hook 试用模式：trial 期间不执行 block，只记录 "would block"
//   3. Hook Group：多个 Hook 按顺序/并行执行，失败时 abort
//   4. 安全审查增强：检测危险命令、base64 编码、管道链
//
// /goal 生命周期新事件：
//   post-plan / pre-step-execution / post-step-execution
//   pre-adopt / on-goal-complete / on-goal-failed / on-goal-paused

import { logger } from '../utils/logger.js';

// ============================================================
// /goal 生命周期新事件
// ============================================================

export type GoalHookEvent =
  | 'post-plan'
  | 'pre-step-execution'
  | 'post-step-execution'
  | 'pre-adopt'
  | 'on-goal-complete'
  | 'on-goal-failed'
  | 'on-goal-paused';

// ============================================================
// 函数型 Hook 接口
// ============================================================

/** Hook 执行上下文（受限 API） */
export interface HookContext {
  event: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  filePath?: string;
  goalId?: string;
  stepId?: string;
  /** 受限 API：解析 AST */
  parseAst?: (filePath: string) => Promise<unknown>;
  /** 受限 API：读文件 */
  readFile?: (filePath: string) => Promise<string>;
  /** 受限 API：读状态 */
  getState?: (key: string) => unknown;
}

/** Hook 执行结果 */
export interface HookResult {
  action: 'continue' | 'block' | 'warn' | 'abort';
  message?: string;
  data?: Record<string, unknown>;
}

/** 函数型 Hook 签名 */
export type FunctionHook = (ctx: HookContext) => Promise<HookResult>;

// ============================================================
// Hook 试用模式
// ============================================================

/** 试用状态 */
export interface HookTrial {
  hookId: string;
  status: 'trial' | 'enabled' | 'disabled';
  triggeredCount: number;
  lastTriggeredAt?: number;
  anomalies: string[];
  startedAt: number;
  /** 试用天数，默认 7 */
  trialDays: number;
}

// ============================================================
// Hook Group
// ============================================================

/** Hook 组 */
export interface HookGroup {
  id: string;
  name: string;
  /** hookId 列表 */
  hooks: string[];
  /** 执行顺序 */
  sequence: 'sequential' | 'parallel';
  /** 失败行为 */
  onFailure: 'abort' | 'warn';
}

// ============================================================
// 安全审查：危险命令关键词
// ============================================================

/** 危险命令模式 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; risk: string }> = [
  { pattern: /\brm\s+-rf?\s+[/~]/i, risk: '递归删除根目录或家目录' },
  { pattern: /\brm\s+-rf?\b/i, risk: '递归删除文件' },
  { pattern: /git\s+push\s+(--force|-f)\b/i, risk: '强制推送覆盖远程历史' },
  { pattern: /git\s+reset\s+--hard\b/i, risk: '硬重置丢弃工作区改动' },
  { pattern: /\bchmod\s+777\b/i, risk: '设置全权限' },
  { pattern: /\bcurl\b.*\|\s*sh/i, risk: '下载并执行脚本' },
  { pattern: /\bwget\b.*\|\s*sh/i, risk: '下载并执行脚本' },
  { pattern: /\bdd\s+if=/i, risk: '磁盘级写入' },
  { pattern: /\bmkfs\b/i, risk: '格式化文件系统' },
  { pattern: /:\(\)\s*\{.+:|:&\s*\}\s*;/i, risk: 'fork 炸弹' },
  { pattern: /\bshutdown\b/i, risk: '关机命令' },
  { pattern: /\breboot\b/i, risk: '重启命令' },
];

// ============================================================
// HookEnhancementManager
// ============================================================

export class HookEnhancementManager {
  private trials: Map<string, HookTrial> = new Map();
  private functionHooks: Map<string, FunctionHook> = new Map();
  private groups: Map<string, HookGroup> = new Map();

  // ============================================================
  // 试用模式
  // ============================================================

  /**
   * 启动试用
   *
   * @param hookId Hook ID
   * @param trialDays 试用天数，默认 7
   */
  startTrial(hookId: string, trialDays: number = 7): void {
    const trial: HookTrial = {
      hookId,
      status: 'trial',
      triggeredCount: 0,
      anomalies: [],
      startedAt: Date.now(),
      trialDays,
    };
    this.trials.set(hookId, trial);
    logger.debug('HookEnhancementManager.startTrial', { hookId, trialDays });
  }

  /**
   * 记录一次触发
   */
  recordTrigger(hookId: string, result: HookResult): void {
    const trial = this.trials.get(hookId);
    if (!trial) return;
    trial.triggeredCount++;
    trial.lastTriggeredAt = Date.now();
    // 试用期间 block 被降级为 warn，记录为异常候选
    if (result.action === 'block') {
      trial.anomalies.push(`would block: ${result.message ?? '(no message)'}`);
    }
    if (result.action === 'abort') {
      trial.anomalies.push(`would abort: ${result.message ?? '(no message)'}`);
    }
  }

  /**
   * 查询试用状态
   *
   * 若试用已过期（超过 trialDays），自动转为 enabled
   */
  checkTrialStatus(hookId: string): HookTrial {
    const trial = this.trials.get(hookId);
    if (!trial) {
      // 未启动试用的视为已启用
      return {
        hookId,
        status: 'enabled',
        triggeredCount: 0,
        anomalies: [],
        startedAt: Date.now(),
        trialDays: 0,
      };
    }
    // 试用过期自动转 enabled
    if (trial.status === 'trial') {
      const elapsed = Date.now() - trial.startedAt;
      if (elapsed > trial.trialDays * 24 * 60 * 60 * 1000) {
        trial.status = 'enabled';
      }
    }
    return trial;
  }

  /**
   * 提升为启用（结束试用）
   */
  promoteToEnabled(hookId: string): void {
    const trial = this.trials.get(hookId);
    if (!trial) return;
    trial.status = 'enabled';
    logger.debug('HookEnhancementManager.promoteToEnabled', { hookId });
  }

  /**
   * 因异常禁用
   */
  disableForAnomaly(hookId: string, anomaly: string): void {
    const trial = this.trials.get(hookId);
    if (!trial) return;
    trial.status = 'disabled';
    trial.anomalies.push(anomaly);
    logger.warn('HookEnhancementManager.disableForAnomaly', { hookId, anomaly });
  }

  /**
   * 试用期间不执行 block，只记录 "would block"
   *
   * 只有 status === 'enabled' 时才真正执行 block
   */
  static shouldExecuteBlock(trial: HookTrial): boolean {
    return trial.status === 'enabled';
  }

  // ============================================================
  // 函数型 Hook
  // ============================================================

  /**
   * 注册函数型 Hook
   */
  registerFunctionHook(hookId: string, fn: FunctionHook): void {
    this.functionHooks.set(hookId, fn);
    logger.debug('HookEnhancementManager.registerFunctionHook', { hookId });
  }

  /**
   * 执行函数型 Hook
   *
   * 若 Hook 未注册，返回 continue
   * 若 Hook 处于试用/禁用状态，block 会被降级为 warn
   */
  async executeFunctionHook(hookId: string, ctx: HookContext): Promise<HookResult> {
    const fn = this.functionHooks.get(hookId);
    if (!fn) {
      return { action: 'continue', message: `Hook ${hookId} not registered` };
    }

    let result: HookResult;
    try {
      result = await fn(ctx);
    } catch (err) {
      return {
        action: 'warn',
        message: `Hook ${hookId} threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 试用模式：记录触发，必要时降级 block
    const trial = this.trials.get(hookId);
    if (trial) {
      this.recordTrigger(hookId, result);
      if (result.action === 'block' && !HookEnhancementManager.shouldExecuteBlock(trial)) {
        return {
          action: 'warn',
          message: `[trial] would block: ${result.message ?? ''}`,
          data: result.data,
        };
      }
      if (result.action === 'abort' && trial.status === 'disabled') {
        return {
          action: 'warn',
          message: `[disabled] would abort: ${result.message ?? ''}`,
          data: result.data,
        };
      }
    }

    return result;
  }

  /**
   * 静态分析函数型 Hook：检查是否包含文件系统写操作
   *
   * @returns 警告列表（空数组表示无警告）
   */
  static validateFunctionHook(fn: FunctionHook): string[] {
    const warnings: string[] = [];
    const src = fn.toString();

    // 检测文件系统写操作
    const writePatterns: Array<{ pattern: RegExp; risk: string }> = [
      { pattern: /fs\.writeFile\b/, risk: '检测到 fs.writeFile 写文件操作' },
      { pattern: /fs\.appendFile\b/, risk: '检测到 fs.appendFile 追加写操作' },
      { pattern: /fs\.mkdir\b/, risk: '检测到 fs.mkdir 创建目录操作' },
      { pattern: /fs\.unlink\b/, risk: '检测到 fs.unlink 删除文件操作' },
      { pattern: /fs\.rmdir\b/, risk: '检测到 fs.rmdir 删除目录操作' },
      { pattern: /fs\.rename\b/, risk: '检测到 fs.rename 重命名操作' },
      { pattern: /fs\.chmod\b/, risk: '检测到 fs.chmod 修改权限操作' },
      { pattern: /fs\.rm\b/, risk: '检测到 fs.rm 删除操作' },
      { pattern: /writeFileSync\b/, risk: '检测到 writeFileSync 同步写操作' },
      { pattern: /child_process\b/, risk: '检测到 child_process 子进程调用' },
      { pattern: /execSync\b/, risk: '检测到 execSync 同步执行命令' },
      { pattern: /spawnSync\b/, risk: '检测到 spawnSync 同步派生进程' },
      { pattern: /process\.exit\b/, risk: '检测到 process.exit 退出进程' },
    ];

    for (const { pattern, risk } of writePatterns) {
      if (pattern.test(src)) {
        warnings.push(risk);
      }
    }

    return warnings;
  }

  // ============================================================
  // Hook Group
  // ============================================================

  /**
   * 创建 Hook 组
   */
  createGroup(group: HookGroup): void {
    this.groups.set(group.id, group);
    logger.debug('HookEnhancementManager.createGroup', { id: group.id, hooks: group.hooks.length });
  }

  /**
   * 执行 Hook 组
   *
   * sequential：按顺序执行，任一返回 abort 则停止后续
   * parallel：并行执行所有 Hook
   *
   * @returns 每个 Hook 的结果 + 是否中止
   */
  async executeGroup(
    groupId: string,
    ctx: HookContext,
  ): Promise<{ results: Array<{ hookId: string; result: HookResult }>; aborted: boolean }> {
    const group = this.groups.get(groupId);
    if (!group) {
      return { results: [], aborted: false };
    }

    const results: Array<{ hookId: string; result: HookResult }> = [];
    let aborted = false;

    if (group.sequence === 'sequential') {
      for (const hookId of group.hooks) {
        const result = await this.executeFunctionHook(hookId, ctx);
        results.push({ hookId, result });
        if (result.action === 'abort') {
          aborted = true;
          break;
        }
        // onFailure=abort 时，block 也中止
        if (group.onFailure === 'abort' && result.action === 'block') {
          aborted = true;
          break;
        }
      }
    } else {
      // parallel
      const settled = await Promise.all(
        group.hooks.map(async (hookId) => ({
          hookId,
          result: await this.executeFunctionHook(hookId, ctx),
        })),
      );
      results.push(...settled);
      if (group.onFailure === 'abort') {
        aborted = settled.some((r) => r.result.action === 'abort' || r.result.action === 'block');
      } else {
        aborted = settled.some((r) => r.result.action === 'abort');
      }
    }

    return { results, aborted };
  }

  /**
   * 检测循环依赖
   *
   * 通过 Hook 之间的依赖关系（此处用 hooks 数组的引用关系简化）
   * 构建 图，用 DFS 检测环
   *
   * @returns 循环路径（如 ['g1', 'g2', 'g1']）或 null
   *
   * 注意：当前 HookGroup 不直接引用其他 group，此处用 group.id 与
   * hooks 列表中可能存在的 group id 引用做检测（约定 hookId === groupId
   * 时视为引用另一个 group）。
   */
  static detectCircularDependency(groups: HookGroup[]): string[] | null {
    // 构建邻接表：group.id -> 它引用的其他 group.id
    const adj = new Map<string, string[]>();
    const groupIds = new Set(groups.map((g) => g.id));
    for (const g of groups) {
      const refs = g.hooks.filter((h) => groupIds.has(h));
      adj.set(g.id, refs);
    }

    // DFS 三色标记法检测环
    const WHITE = 0; // 未访问
    const GRAY = 1; // 正在访问（在递归栈中）
    const BLACK = 2; // 已完成
    const color = new Map<string, number>();
    for (const id of groupIds) color.set(id, WHITE);

    const path: string[] = [];

    const dfs = (u: string): boolean => {
      color.set(u, GRAY);
      path.push(u);
      const neighbors = adj.get(u) ?? [];
      for (const v of neighbors) {
        if (color.get(v) === GRAY) {
          // 找到环：从 path 中 v 第一次出现到当前
          path.push(v);
          return true;
        }
        if (color.get(v) === WHITE) {
          if (dfs(v)) return true;
        }
      }
      color.set(u, BLACK);
      path.pop();
      return false;
    };

    for (const id of groupIds) {
      if (color.get(id) === WHITE) {
        if (dfs(id)) {
          // 从 path 中截取环
          const last = path[path.length - 1];
          const firstIdx = path.indexOf(last);
          return path.slice(firstIdx);
        }
      }
    }
    return null;
  }

  // ============================================================
  // 安全审查增强
  // ============================================================

  /**
   * 分析命令安全性
   *
   * @returns safe=true 表示无危险，risks 列出命中的危险模式
   */
  static analyzeCommand(command: string): { safe: boolean; risks: string[] } {
    const risks: string[] = [];
    for (const { pattern, risk } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        risks.push(risk);
      }
    }
    // 额外检测 base64 编码命令
    if (HookEnhancementManager.detectBase64Command(command)) {
      risks.push('检测到 base64 编码命令（可能隐藏真实意图）');
    }
    // 检测管道链（可能用于命令注入）
    if (HookEnhancementManager.detectPipeChain(command)) {
      // 管道链本身不一定是危险，但若同时含 base64 则已在上面标记
      // 此处仅在管道链超过 3 段时标记为可疑
      const pipeCount = (command.match(/\|/g) ?? []).length;
      if (pipeCount >= 3) {
        risks.push(`管道链过长（${pipeCount} 段），可能存在命令注入风险`);
      }
    }
    return { safe: risks.length === 0, risks };
  }

  /**
   * 检测 base64 编码命令
   *
   * 启发式：
   *   - 含 `base64 -d` 或 `base64 --decode`
   *   - 含 `echo <长base64串> | ... sh`
   *   - 含 `eval(atob(...))`
   */
  static detectBase64Command(command: string): boolean {
    // 显式 base64 解码
    if (/base64\s+(?:-d|--decode)/i.test(command)) return true;
    // echo <base64> | sh 模式
    if (/echo\s+[A-Za-z0-9+/=]{20,}\s*\|/i.test(command)) return true;
    // eval(atob(...))
    if (/eval\s*\(\s*atob\s*\(/i.test(command)) return true;
    // base64 -D (macOS)
    if (/base64\s+-D\b/i.test(command)) return true;
    return false;
  }

  /**
   * 检测管道链
   */
  static detectPipeChain(command: string): boolean {
    // 统计管道符数量（排除 || 逻辑或）
    const pipeMatches = command.match(/(?<!\|)\|(?!\|)/g);
    return pipeMatches !== null && pipeMatches.length >= 1;
  }
}

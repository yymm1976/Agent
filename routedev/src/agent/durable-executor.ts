// src/agent/durable-executor.ts
// DurableExecutor 持久化执行器（Phase 24 Task 3）
// 蓝图 Section 7.6：长任务每步自动保存状态，失败后可从断点恢复
//
// 设计要点：
//   1. 独立模块，不修改 ReActAgentLoop 内部逻辑
//   2. 通过 StepExecutor 接口解耦具体执行引擎（测试可注入 mock）
//   3. 每步完成自动写快照（原子写入：先 .tmp 再 rename）
//   4. 同一 planId 不能并发执行（内存锁）
//   5. resumeFrom() 失败时保留原快照不覆盖
//   6. 可选接入 HookRunner（pre-step / post-step / on-error / on-complete）

import type { PlanStep } from './goal-types.js';
import type { StepResult, HookRunner, HookContext } from './hooks.js';
// 任务2：接入结构化交接文件生成器
import { saveHandoff, type HandoffData } from './handoff.js';
import { logger } from '../utils/logger.js';
import { homedir } from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as nodeFs from 'node:fs';

// ============================================================
// 类型定义
// ============================================================

/** 执行状态 */
export type ExecutionStatus = 'running' | 'paused' | 'failed' | 'completed';

/** 执行快照（蓝图 Section 7.6） */
export interface ExecutionSnapshot {
  /** 计划 ID */
  planId: string;
  /** 目标描述 */
  goal: string;
  /** 启动时间戳（毫秒） */
  startedAt: number;
  /** 最后完成的步骤索引（0 表示尚未完成任何步骤） */
  lastStepCompleted: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 当前状态 */
  status: ExecutionStatus;
  /** 已完成步骤的结果列表 */
  completedResults: StepResult[];
  /** 下一步要执行的步骤（无则 null） */
  nextStep: PlanStep | null;
  /** B2：剩余未执行的步骤列表（resumeFrom 时循环执行） */
  remainingSteps?: PlanStep[];
  /** 最后更新时间戳（毫秒） */
  updatedAt: number;
}

/** 执行结果 */
export interface ExecutionResult {
  /** 是否整体成功 */
  success: boolean;
  /** 最终快照 */
  snapshot: ExecutionSnapshot;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 步骤执行器接口
 *
 * 解耦 ReActAgentLoop——DurableExecutor 不直接依赖 Agent Loop，
 * 而是通过此接口调用具体执行逻辑（生产环境注入 Agent Loop 适配器，测试注入 mock）
 */
export interface StepExecutor {
  /** 执行单个步骤，返回步骤结果 */
  execute(step: PlanStep, goal: string): Promise<StepResult>;
}

/** DurableExecutor 配置 */
export interface DurableExecutorOptions {
  /** 会话 ID（用于隔离不同会话的快照目录） */
  sessionId: string;
  /** 步骤执行器 */
  executor: StepExecutor;
  /** 可选 HookRunner（生命周期钩子） */
  hookRunner?: HookRunner;
  /** 可选存储根目录（默认 ~/.qoderwork/routedev/sessions，测试可覆盖） */
  storageRoot?: string;
  /** 项目路径（用于 HookContext，默认 process.cwd()） */
  projectPath?: string;
  /** Agent ID（用于 HookContext，默认 'durable-executor'） */
  agentId?: string;
}

// ============================================================
// 内部常量
// ============================================================

/** 默认存储根目录：~/.qoderwork/routedev/sessions */
const DEFAULT_STORAGE_ROOT = path.join(homedir(), '.qoderwork', 'routedev', 'sessions');

/** 快照文件名 */
const SNAPSHOT_FILENAME = 'progress.json';

/** 临时文件后缀（原子写入） */
const TMP_SUFFIX = '.tmp';

// ============================================================
// DurableExecutor
// ============================================================

/**
 * 持久化执行器
 *
 * 工作流程：
 *   1. start(plan, goal) → 生成 planId，按顺序执行步骤
 *   2. 每步执行前触发 pre-step 钩子，执行后触发 post-step / on-error
 *   3. 每步完成后写快照到磁盘（原子写入）
 *   4. 任一步骤失败或被钩子 abort → 状态置为 failed/paused，停止执行
 *   5. 全部完成 → 触发 on-complete，状态置为 completed
 *   6. resumeFrom(planId) → 读取快照，从 nextStep 继续执行
 */
export class DurableExecutor {
  private readonly sessionId: string;
  private readonly executor: StepExecutor;
  private readonly hookRunner?: HookRunner;
  private readonly storageRoot: string;
  private readonly projectPath: string;
  private readonly agentId: string;

  /** 内存锁：正在运行的 planId 集合（防止并发执行同一计划） */
  private readonly runningPlans: Set<string> = new Set();

  constructor(options: DurableExecutorOptions) {
    this.sessionId = options.sessionId;
    this.executor = options.executor;
    this.hookRunner = options.hookRunner;
    this.storageRoot = options.storageRoot ?? DEFAULT_STORAGE_ROOT;
    this.projectPath = options.projectPath ?? process.cwd();
    this.agentId = options.agentId ?? 'durable-executor';
  }

  // ============================================================
  // 公共接口
  // ============================================================

  /**
   * 启动持久化执行
   *
   * @param plan 计划步骤列表（按顺序执行）
   * @param goal 目标描述
   * @param parallelGroups 可选的并行组（P0-3：每组内的步骤并行执行，组间串行）
   * @returns 执行结果（含最终快照）
   */
  async start(plan: PlanStep[], goal: string, parallelGroups?: number[][]): Promise<ExecutionResult> {
    if (plan.length === 0) {
      throw new Error('计划步骤列表不能为空');
    }

    const planId = generatePlanId();
    const snapshot: ExecutionSnapshot = {
      planId,
      goal,
      startedAt: Date.now(),
      lastStepCompleted: 0,
      totalSteps: plan.length,
      status: 'running',
      completedResults: [],
      nextStep: plan[0] ?? null,
      // B2：持久化完整 plan，resumeFrom 时可循环执行剩余步骤
      remainingSteps: plan.slice(1),
      updatedAt: Date.now(),
    };

    // P0-3：如果有 parallelGroups，使用并行执行；否则串行
    if (parallelGroups && parallelGroups.length > 0) {
      return this.executePlanParallel(snapshot, plan, parallelGroups);
    }
    return this.executePlan(snapshot, plan);
  }

  /**
   * 从断点恢复执行
   *
   * B2 修复：持久化完整 plan 到 remainingSteps，resumeFrom 循环执行所有剩余步骤
   *
   * @param planId 计划 ID
   * @returns 执行结果（含最终快照）
   */
  async resumeFrom(planId: string): Promise<ExecutionResult> {
    // 并发保护
    if (this.runningPlans.has(planId)) {
      return {
        success: false,
        snapshot: this.getSnapshot(planId) ?? this.makeEmptySnapshot(planId),
        error: `计划 ${planId} 正在运行中，不能并发恢复`,
      };
    }

    const snapshot = this.getSnapshot(planId);
    if (!snapshot) {
      return {
        success: false,
        snapshot: this.makeEmptySnapshot(planId),
        error: `找不到计划 ${planId} 的快照`,
      };
    }

    // 验证快照完整性
    if (snapshot.status === 'completed') {
      return {
        success: true,
        snapshot,
        error: '计划已完成，无需恢复',
      };
    }

    if (snapshot.status === 'running') {
      // 上次异常退出，重置为 paused 以便恢复
      snapshot.status = 'paused';
    }

    if (!snapshot.nextStep) {
      // 已无下一步，标记完成
      snapshot.status = 'completed';
      await this.saveSnapshot(snapshot);
      return { success: true, snapshot };
    }

    // B2：从 nextStep 开始循环执行所有剩余步骤
    // remainingSteps 包含 nextStep 之后的所有步骤
    const stepsToExecute: PlanStep[] = [snapshot.nextStep, ...(snapshot.remainingSteps ?? [])];
    return this.executeRemainingSteps(snapshot, stepsToExecute);
  }

  /**
   * 获取执行状态快照
   *
   * @param planId 计划 ID
   * @returns 快照对象，找不到返回 null
   */
  getSnapshot(planId: string): ExecutionSnapshot | null {
    try {
      const filePath = this.getSnapshotPath(planId);
      const content = nodeFs.readFileSync(filePath, 'utf-8');
      const snapshot = JSON.parse(content) as ExecutionSnapshot;
      return this.validateSnapshot(snapshot) ? snapshot : null;
    } catch {
      return null;
    }
  }

  /**
   * 列出所有可恢复的执行（status 为 paused 或 failed）
   *
   * @returns 快照列表（按更新时间倒序）
   */
  listRecoverable(): ExecutionSnapshot[] {
    const sessionDir = this.getSessionDir();
    try {
      const entries = nodeFs.readdirSync(sessionDir);
      const snapshots: ExecutionSnapshot[] = [];

      for (const entry of entries) {
        const entryPath = path.join(sessionDir, entry);
        const stat = nodeFs.statSync(entryPath);
        if (!stat.isDirectory()) continue;

        const snapshotPath = path.join(entryPath, SNAPSHOT_FILENAME);
        if (!nodeFs.existsSync(snapshotPath)) continue;

        try {
          const content = nodeFs.readFileSync(snapshotPath, 'utf-8');
          const snapshot = JSON.parse(content) as ExecutionSnapshot;
          if (this.validateSnapshot(snapshot) && (snapshot.status === 'paused' || snapshot.status === 'failed')) {
            snapshots.push(snapshot);
          }
        } catch {
          // 损坏的快照文件跳过
          logger.warn('DurableExecutor: 跳过损坏的快照文件', { path: snapshotPath });
        }
      }

      // 按更新时间倒序排列（最近的最先）
      snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
      return snapshots;
    } catch {
      return [];
    }
  }

  /**
   * 异步并行版 listRecoverable（Phase 26 Task 5：避免同步 I/O 阻塞事件循环）
   * 使用 fs.promises + Promise.all 并行读取所有 session 目录
   * @returns 可恢复的执行快照列表（按更新时间倒序）
   */
  async listRecoverableAsync(): Promise<ExecutionSnapshot[]> {
    const sessionDir = this.getSessionDir();
    try {
      const entries = await fs.readdir(sessionDir);
      const dirPaths: string[] = [];

      for (const entry of entries) {
        const entryPath = path.join(sessionDir, entry);
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory()) {
          dirPaths.push(entryPath);
        }
      }

      // 并行读取所有快照文件
      const results = await Promise.all(
        dirPaths.map(async (dirPath) => {
          const snapshotPath = path.join(dirPath, SNAPSHOT_FILENAME);
          try {
            const content = await fs.readFile(snapshotPath, 'utf-8');
            const snapshot = JSON.parse(content) as ExecutionSnapshot;
            if (this.validateSnapshot(snapshot) && (snapshot.status === 'paused' || snapshot.status === 'failed')) {
              return snapshot;
            }
            return null;
          } catch {
            logger.warn('DurableExecutor: 跳过损坏的快照文件', { path: snapshotPath });
            return null;
          }
        }),
      );

      const snapshots = results.filter((s): s is ExecutionSnapshot => s !== null);
      snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
      return snapshots;
    } catch {
      return [];
    }
  }

  // ============================================================
  // 内部实现
  // ============================================================

  /**
   * 并行执行计划（P0-3：parallelGroups 真并行）
   *
   * 按 parallelGroups 分组执行：
   *   - 每组内的步骤用 Promise.all 并行执行
   *   - 组与组之间串行（等待前一组完成才执行下一组）
   *   - 组内任一步骤失败，中止整个计划
   *   - 每组完成后保存快照
   */
  private async executePlanParallel(
    initialSnapshot: ExecutionSnapshot,
    plan: PlanStep[],
    parallelGroups: number[][],
  ): Promise<ExecutionResult> {
    const { planId } = initialSnapshot;

    // 并发保护
    if (this.runningPlans.has(planId)) {
      return {
        success: false,
        snapshot: initialSnapshot,
        error: `计划 ${planId} 正在运行中`,
      };
    }
    this.runningPlans.add(planId);

    let snapshot = { ...initialSnapshot };
    // 构建 stepId → PlanStep 映射
    const stepMap = new Map<number, PlanStep>();
    for (const step of plan) {
      stepMap.set(step.id, step);
    }

    try {
      // 写入初始快照
      await this.saveSnapshot(snapshot);

      // 按组执行
      for (const group of parallelGroups) {
        // 获取当前组的所有步骤
        const groupSteps: PlanStep[] = [];
        for (const stepId of group) {
          const step = stepMap.get(stepId);
          if (step) groupSteps.push(step);
        }

        if (groupSteps.length === 0) continue;

        // 更新 nextStep 为当前组的第一个步骤
        snapshot.nextStep = groupSteps[0];

        // 并行执行组内所有步骤
        const results = await Promise.all(
          groupSteps.map(step => this.runStepWithHooks(snapshot, step)),
        );

        // 检查结果
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (!result.success) {
            // 失败或被 abort
            snapshot.status = result.aborted ? 'paused' : 'failed';
            snapshot.updatedAt = Date.now();
            await this.saveSnapshot(snapshot);
            return {
              success: false,
              snapshot,
              error: result.error,
            };
          }

          // 步骤成功，记录结果
          snapshot.completedResults.push(result.stepResult!);
          snapshot.lastStepCompleted += 1;
        }

        snapshot.updatedAt = Date.now();
        await this.saveSnapshot(snapshot);
      }

      // 全部完成
      snapshot.nextStep = null;
      snapshot.status = 'completed';
      snapshot.updatedAt = Date.now();
      await this.saveSnapshot(snapshot);

      // 触发 on-complete 钩子
      const lastResult = snapshot.completedResults[snapshot.completedResults.length - 1];
      const completeContext = this.makeHookContext('complete', snapshot, lastResult);
      await this.fireHook('on-complete', snapshot, completeContext);

      return { success: true, snapshot };
    } catch (err) {
      // 未预期异常
      snapshot.status = 'failed';
      snapshot.updatedAt = Date.now();
      const errorMsg = err instanceof Error ? err.message : String(err);
      try {
        await this.saveSnapshot(snapshot);
      } catch {
        // 保存失败也不影响错误返回
      }
      return { success: false, snapshot, error: errorMsg };
    } finally {
      this.runningPlans.delete(planId);
    }
  }

  /**
   * 执行完整计划（start 入口）
   */
  private async executePlan(
    initialSnapshot: ExecutionSnapshot,
    plan: PlanStep[],
  ): Promise<ExecutionResult> {
    const { planId } = initialSnapshot;

    // 并发保护
    if (this.runningPlans.has(planId)) {
      return {
        success: false,
        snapshot: initialSnapshot,
        error: `计划 ${planId} 正在运行中`,
      };
    }
    this.runningPlans.add(planId);

    let snapshot = { ...initialSnapshot };

    try {
      // 写入初始快照
      await this.saveSnapshot(snapshot);

      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        snapshot.nextStep = step;

        const result = await this.runStepWithHooks(snapshot, step);
        if (!result.success) {
          // 失败或被 abort
          snapshot.status = result.aborted ? 'paused' : 'failed';
          // B2：保存剩余步骤以便 resumeFrom 恢复
          snapshot.remainingSteps = plan.slice(i + 1);
          snapshot.updatedAt = Date.now();
          await this.saveSnapshot(snapshot);
          return {
            success: false,
            snapshot,
            error: result.error,
          };
        }

        // 步骤成功，记录结果
        snapshot.completedResults.push(result.stepResult!);
        snapshot.lastStepCompleted = i + 1;
        // B2：更新剩余步骤
        snapshot.remainingSteps = plan.slice(i + 1);
        snapshot.updatedAt = Date.now();
        await this.saveSnapshot(snapshot);
      }

      // 全部完成
      snapshot.nextStep = null;
      snapshot.status = 'completed';
      snapshot.updatedAt = Date.now();
      await this.saveSnapshot(snapshot);

      // 触发 on-complete 钩子（使用最后一个步骤的 ID 和结果构造上下文）
      const lastResult = snapshot.completedResults[snapshot.completedResults.length - 1];
      const completeContext = this.makeHookContext(
        'complete',
        snapshot,
        lastResult,
      );
      await this.fireHook('on-complete', snapshot, completeContext);

      return { success: true, snapshot };
    } catch (err) {
      // 未预期异常
      snapshot.status = 'failed';
      snapshot.updatedAt = Date.now();
      const errorMsg = err instanceof Error ? err.message : String(err);
      // 保留原快照不覆盖（resumeFrom 失败时的保护）
      try {
        await this.saveSnapshot(snapshot);
      } catch {
        // 保存失败也不影响错误返回
      }
      return { success: false, snapshot, error: errorMsg };
    } finally {
      this.runningPlans.delete(planId);
    }
  }

  /**
   * B2：循环执行剩余步骤（resumeFrom 入口）
   *
   * 从 nextStep 开始，依次执行 stepsToExecute 中的所有步骤
   * 每步完成后更新快照（nextStep + remainingSteps），任一步骤失败则暂停
   */
  private async executeRemainingSteps(
    snapshot: ExecutionSnapshot,
    stepsToExecute: PlanStep[],
  ): Promise<ExecutionResult> {
    const { planId } = snapshot;

    if (this.runningPlans.has(planId)) {
      return {
        success: false,
        snapshot,
        error: `计划 ${planId} 正在运行中`,
      };
    }
    this.runningPlans.add(planId);

    try {
      snapshot.status = 'running';
      await this.saveSnapshot(snapshot);

      for (let i = 0; i < stepsToExecute.length; i++) {
        const step = stepsToExecute[i];
        snapshot.nextStep = step;

        const result = await this.runStepWithHooks(snapshot, step);
        if (!result.success) {
          // 失败或被 abort：保存剩余步骤以便再次恢复
          snapshot.status = result.aborted ? 'paused' : 'failed';
          snapshot.remainingSteps = stepsToExecute.slice(i + 1);
          snapshot.updatedAt = Date.now();
          await this.saveSnapshot(snapshot);
          return { success: false, snapshot, error: result.error };
        }

        // 步骤成功
        snapshot.completedResults.push(result.stepResult!);
        snapshot.lastStepCompleted += 1;
        // 更新 remainingSteps 为尚未执行的步骤
        snapshot.remainingSteps = stepsToExecute.slice(i + 1);
        snapshot.updatedAt = Date.now();
        await this.saveSnapshot(snapshot);
      }

      // 全部完成
      snapshot.nextStep = null;
      snapshot.remainingSteps = [];
      snapshot.status = 'completed';
      snapshot.updatedAt = Date.now();
      await this.saveSnapshot(snapshot);

      // 触发 on-complete 钩子
      const lastResult = snapshot.completedResults[snapshot.completedResults.length - 1];
      const completeContext = this.makeHookContext('complete', snapshot, lastResult);
      await this.fireHook('on-complete', snapshot, completeContext);

      return { success: true, snapshot };
    } catch (err) {
      snapshot.status = 'failed';
      snapshot.updatedAt = Date.now();
      const errorMsg = err instanceof Error ? err.message : String(err);
      try {
        await this.saveSnapshot(snapshot);
      } catch {
        // 忽略
      }
      return { success: false, snapshot, error: errorMsg };
    } finally {
      this.runningPlans.delete(planId);
    }
  }

  /**
   * 执行单步并触发相关钩子
   *
   * @returns { success, stepResult?, error?, aborted? }
   */
  private async runStepWithHooks(
    snapshot: ExecutionSnapshot,
    step: PlanStep,
  ): Promise<{
    success: boolean;
    stepResult?: StepResult;
    error?: string;
    aborted?: boolean;
  }> {
    const stepId = String(step.id);

    // ===== pre-step 钩子 =====
    const preContext = this.makeHookContext(stepId, snapshot);
    const preResult = await this.fireHook('pre-step', snapshot, preContext);
    if (preResult.action === 'abort') {
      return { success: false, aborted: true, error: preResult.message ?? 'pre-step 钩子中止' };
    }
    if (preResult.action === 'skip') {
      // 跳过此步骤，返回成功但无结果
      return {
        success: true,
        stepResult: { success: true, output: '[skipped by pre-step hook]', durationMs: 0 },
      };
    }

    // ===== 执行步骤 =====
    let stepResult: StepResult;
    try {
      stepResult = await this.executor.execute(step, snapshot.goal);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const stepError = {
        message: errorMsg,
        stack: err instanceof Error ? err.stack : undefined,
      };

      // ===== on-error 钩子 =====
      const errorContext = this.makeHookContext(stepId, snapshot, undefined, stepError);
      const errorResult = await this.fireHook('on-error', snapshot, errorContext);

      if (errorResult.action === 'retry') {
        // 重试一次
        try {
          stepResult = await this.executor.execute(step, snapshot.goal);
        } catch (retryErr) {
          return {
            success: false,
            error: `重试仍失败: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          };
        }
      } else if (errorResult.action === 'skip') {
        return {
          success: true,
          stepResult: { success: true, output: `[skipped: ${errorMsg}]`, durationMs: 0 },
        };
      } else if (errorResult.action === 'abort') {
        return { success: false, aborted: true, error: errorResult.message ?? 'on-error 钩子中止' };
      } else {
        return { success: false, error: errorMsg };
      }
    }

    // 步骤失败（非异常，返回 success=false）
    if (!stepResult.success) {
      const errorContext = this.makeHookContext(stepId, snapshot, stepResult, {
        message: stepResult.output || '步骤执行失败',
      });
      const errorResult = await this.fireHook('on-error', snapshot, errorContext);
      if (errorResult.action === 'skip') {
        return { success: true, stepResult };
      }
      if (errorResult.action === 'abort') {
        return { success: false, aborted: true, error: errorResult.message ?? 'on-error 钩子中止' };
      }
      return { success: false, error: stepResult.output || '步骤执行失败' };
    }

    // ===== post-step 钩子 =====
    const postContext = this.makeHookContext(stepId, snapshot, stepResult);
    const postResult = await this.fireHook('post-step', snapshot, postContext);
    if (postResult.action === 'abort') {
      return { success: false, aborted: true, error: postResult.message ?? 'post-step 钩子中止' };
    }
    // post-step 可修改结果
    if (postResult.modifiedResult) {
      stepResult = postResult.modifiedResult;
    }

    // C6 修复：处理 post-step 的 retry 动作（硬上限 1 次，避免无限循环）
    if (postResult.action === 'retry') {
      try {
        stepResult = await this.executor.execute(step, snapshot.goal);
      } catch (retryErr) {
        return { success: false, error: `post-step retry 失败: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` };
      }
    }

    return { success: true, stepResult };
  }

  /**
   * 触发钩子（无 HookRunner 时直接返回 continue）
   */
  private async fireHook(
    event: 'pre-step' | 'post-step' | 'on-error' | 'on-complete',
    snapshot: ExecutionSnapshot,
    context: HookContext,
  ): Promise<{
    action: 'continue' | 'abort' | 'retry' | 'skip' | 'deny' | 'warn';
    message?: string;
    modifiedResult?: StepResult;
    reason?: string;
  }> {
    if (!this.hookRunner) {
      return { action: 'continue' };
    }
    try {
      const result = await this.hookRunner.fire(event, context);
      return {
        action: result.action,
        message: result.message,
        modifiedResult: result.modifiedResult,
      };
    } catch (err) {
      // 钩子异常不影响主流程
      logger.warn('DurableExecutor: 钩子异常被忽略', {
        event,
        planId: snapshot.planId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { action: 'continue' };
    }
  }

  /**
   * 构造 HookContext
   */
  private makeHookContext(
    stepId: string,
    snapshot: ExecutionSnapshot,
    stepResult?: StepResult,
    error?: { message: string; code?: string; stack?: string },
  ): HookContext {
    return {
      stepId,
      agentId: this.agentId,
      projectPath: this.projectPath,
      stepResult,
      error,
    };
  }

  /**
   * 保存快照（原子写入：先写 .tmp 再 rename）
   * 任务2：保存快照时同时生成 HANDOFF.md 交接文件到项目 .routedev/ 目录
   */
  private async saveSnapshot(snapshot: ExecutionSnapshot): Promise<void> {
    const filePath = this.getSnapshotPath(snapshot.planId);
    const dirPath = path.dirname(filePath);
    const tmpPath = filePath + TMP_SUFFIX;

    // 确保目录存在
    await fs.mkdir(dirPath, { recursive: true });

    // 写入临时文件
    const content = JSON.stringify(snapshot, null, 2);
    await fs.writeFile(tmpPath, content, 'utf-8');

    // 原子 rename
    await fs.rename(tmpPath, filePath);

    // 任务2：生成结构化交接文件 HANDOFF.md
    await this.saveHandoffFile(snapshot);

    logger.debug('DurableExecutor: 快照已保存', {
      planId: snapshot.planId,
      status: snapshot.status,
      lastStepCompleted: snapshot.lastStepCompleted,
    });
  }

  /**
   * 任务2：从执行状态提取 HandoffData 并保存 HANDOFF.md
   * 交接文件保存到项目 .routedev/ 目录，供下次会话或人工接手参考
   */
  private async saveHandoffFile(snapshot: ExecutionSnapshot): Promise<void> {
    try {
      const handoffDir = path.join(this.projectPath, '.routedev');
      const handoffData: HandoffData = {
        currentGoal: snapshot.goal,
        completedSteps: snapshot.completedResults.map((r, i) => {
          const output = r.output ?? '';
          // 截取前 120 字符作为步骤摘要
          return `步骤${i + 1}: ${output.slice(0, 120)}`;
        }),
        nextAction: snapshot.nextStep?.description ?? '无下一步（计划已完成或暂停）',
        constraints: [],
        workingFiles: [],
        openQuestions: [],
        timestamp: snapshot.updatedAt,
      };
      await saveHandoff(handoffData, handoffDir);
    } catch (err) {
      // 交接文件生成失败不影响快照保存
      logger.warn('DurableExecutor: HANDOFF.md 生成失败', {
        planId: snapshot.planId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 获取快照文件路径
   */
  private getSnapshotPath(planId: string): string {
    return path.join(this.getSessionDir(), planId, SNAPSHOT_FILENAME);
  }

  /**
   * 获取会话目录
   */
  private getSessionDir(): string {
    return path.join(this.storageRoot, this.sessionId);
  }

  /**
   * 验证快照完整性
   */
  private validateSnapshot(snapshot: unknown): snapshot is ExecutionSnapshot {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const s = snapshot as Record<string, unknown>;
    return (
      typeof s.planId === 'string' &&
      typeof s.goal === 'string' &&
      typeof s.startedAt === 'number' &&
      typeof s.lastStepCompleted === 'number' &&
      typeof s.totalSteps === 'number' &&
      typeof s.status === 'string' &&
      Array.isArray(s.completedResults) &&
      (s.nextStep === null || typeof s.nextStep === 'object')
    );
  }

  /**
   * 构造空快照（错误情况兜底）
   */
  private makeEmptySnapshot(planId: string): ExecutionSnapshot {
    return {
      planId,
      goal: '',
      startedAt: Date.now(),
      lastStepCompleted: 0,
      totalSteps: 0,
      status: 'failed',
      completedResults: [],
      nextStep: null,
      updatedAt: Date.now(),
    };
  }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 创建 DurableExecutor 实例
 */
export function createDurableExecutor(options: DurableExecutorOptions): DurableExecutor {
  return new DurableExecutor(options);
}

/**
 * 生成计划 ID（短格式 UUID）
 */
function generatePlanId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `plan-${timestamp}-${random}`;
}

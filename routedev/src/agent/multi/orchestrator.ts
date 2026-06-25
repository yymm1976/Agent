// src/agent/multi/orchestrator.ts
// Orchestrator：分析 /goal 步骤的依赖关系，生成执行计划
//
// Phase 21 Task 3：增加 Worker 异常隔离（executeWorkerIsolated）
//   - Worker 崩溃不上溯，异常转结构化 WorkerError
//   - 可重试错误（timeout/llm_error）重试 maxRetries 次
//   - 不可重试错误（permission_denied/unknown）立即 skip/abort

import type { ILLMClient } from '../../router/types.js';
import type { GoalPlan, GoalStep } from '../goal-types.js';
import type { ExecutionPlan, StepDependency, WorkerRole, WorkerTask } from './types.js';
import { ConflictDetector } from './conflict.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// Phase 21 Task 3：Worker 异常隔离类型
// ============================================================

/** Worker 错误类型 */
export type WorkerErrorType =
  | 'tool_failure'
  | 'llm_error'
  | 'timeout'
  | 'permission_denied'
  | 'unknown';

/** 结构化 Worker 错误（不抛出，通过 WorkerOutcome.failure 返回） */
export interface WorkerError {
  /** 错误类型 */
  type: WorkerErrorType;
  /** 出错的 Worker ID */
  workerId: string;
  /** 错误消息 */
  message: string;
  /** 建议动作：retry（已内部处理）/ skip（跳过当前 Worker）/ abort（中止整个 plan） */
  suggestedAction: 'retry' | 'skip' | 'abort';
  /** 已重试次数 */
  retryCount: number;
}

/** Worker 执行结果（联合类型） */
export type WorkerOutcome =
  | { success: true; result: string; workerId: string }
  | { success: false; error: WorkerError };

/** Worker 执行函数签名（注入到 executeWorkerIsolated） */
export type WorkerFunction = (workerId: string, task: WorkerTask) => Promise<string>;

// ============================================================
// Phase 21 Task 3：Worker 异常隔离——独立函数（供 WorkerExecutor 复用）
// ============================================================

/**
 * 分类 Worker 错误
 * 根据错误消息和类型推断 WorkerErrorType
 */
export function classifyWorkerError(error: unknown): WorkerErrorType {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // 权限拒绝
    if (
      msg.includes('permission') ||
      msg.includes('denied') ||
      msg.includes('权限') ||
      (error as { type?: string }).type === 'permission_denied'
    ) {
      return 'permission_denied';
    }
    // 超时
    if (
      msg.includes('timeout') ||
      msg.includes('etimedout') ||
      msg.includes('超时') ||
      (error as { type?: string }).type === 'timeout'
    ) {
      return 'timeout';
    }
    // LLM 错误（含网络/认证/速率限制）
    if (
      msg.includes('llm') ||
      msg.includes('rate_limit') ||
      msg.includes('auth') ||
      msg.includes('network') ||
      msg.includes('api') ||
      (error as { type?: string }).type === 'llm_error'
    ) {
      return 'llm_error';
    }
    // 工具失败
    if (
      msg.includes('tool') ||
      msg.includes('工具') ||
      (error as { type?: string }).type === 'tool_failure'
    ) {
      return 'tool_failure';
    }
  }
  return 'unknown';
}

/**
 * 判断错误类型是否可重试
 * - timeout：可重试（通常是暂时的）
 * - llm_error：可重试（网络/速率限制可能恢复）
 * - tool_failure：可重试（工具可能因临时状态失败）
 * - permission_denied：不可重试（权限不会自动恢复）
 * - unknown：不可重试（无法判断，保守起见不重试）
 */
export function isRetryable(errorType: WorkerErrorType): boolean {
  return errorType === 'timeout' || errorType === 'llm_error' || errorType === 'tool_failure';
}

/**
 * 根据错误类型获取建议动作
 * - permission_denied → skip（权限问题不会因重试解决）
 * - unknown → abort（未知错误保守中止）
 * - 可重试类型 → retry（由 executeWorkerIsolated 内部处理）
 */
function getSuggestedAction(errorType: WorkerErrorType): 'retry' | 'skip' | 'abort' {
  if (errorType === 'permission_denied') return 'skip';
  if (errorType === 'unknown') return 'abort';
  return 'retry';
}

/**
 * 隔离执行 Worker：异常永远不抛出，转结构化 WorkerOutcome
 *
 * 行为：
 *   - 可重试错误（timeout/llm_error/tool_failure）：重试 maxRetries 次
 *   - 不可重试错误（permission_denied/unknown）：立即返回 skip/abort
 *   - 重试间隔：1000ms * retryCount（线性退避）
 *
 * @param workerId Worker 标识（用于日志和错误上下文）
 * @param task Worker 任务
 * @param workerFn Worker 执行函数（注入，通常为 WorkerExecutor.execute 的包装）
 * @param maxRetries 最大重试次数（默认 2）
 * @returns WorkerOutcome（success 或 failure）
 */
export async function executeWorkerIsolated(
  workerId: string,
  task: WorkerTask,
  workerFn: WorkerFunction,
  maxRetries = 2,
): Promise<WorkerOutcome> {
  let retryCount = 0;
  let lastErrorType: WorkerErrorType = 'unknown';
  let lastMessage = '';

  while (retryCount <= maxRetries) {
    try {
      const result = await workerFn(workerId, task);
      return { success: true, result, workerId };
    } catch (error) {
      retryCount++;
      lastErrorType = classifyWorkerError(error);
      lastMessage = error instanceof Error ? error.message : String(error);

      logger.warn(`Worker ${workerId} 失败 (尝试 ${retryCount}/${maxRetries + 1})`, {
        errorType: lastErrorType,
        message: lastMessage,
      });

      // 不可重试错误 → 立即返回
      if (!isRetryable(lastErrorType)) {
        return {
          success: false,
          error: {
            type: lastErrorType,
            workerId,
            message: lastMessage,
            suggestedAction: getSuggestedAction(lastErrorType),
            retryCount: retryCount - 1,
          },
        };
      }

      // 已达最大重试次数 → 返回失败
      if (retryCount > maxRetries) {
        return {
          success: false,
          error: {
            type: lastErrorType,
            workerId,
            message: lastMessage,
            suggestedAction: 'skip', // 重试耗尽 → 跳过
            retryCount: retryCount - 1,
          },
        };
      }

      // 线性退避：1s, 2s, 3s...
      await new Promise(r => setTimeout(r, 1000 * retryCount));
    }
  }

  // 理论上不会到达（while 循环已覆盖所有路径），防御性兜底
  return {
    success: false,
    error: {
      type: lastErrorType,
      workerId,
      message: lastMessage || 'Unexpected: retry loop exited without result',
      suggestedAction: 'abort',
      retryCount,
    },
  };
}

/** Worker 角色的 system prompt 片段 */
export const WORKER_ROLE_PROMPTS: Record<WorkerRole, string> = {
  coder: '你是一个编码专家。专注于编写高质量、可维护的代码。遵循项目已有的代码风格。',
  searcher: '你是一个信息搜索专家。专注于搜索和整理相关的技术文档、最佳实践和参考资料。提供清晰的信息摘要。',
  tester: '你是一个测试专家。专注于编写全面的测试用例，覆盖正常路径和边界情况。确保测试可运行。',
  reviewer: '你是一个代码审查专家。专注于发现潜在的 bug、安全漏洞、性能问题和代码风格不一致。提供具体的改进建议。',
};

const VALID_ROLES: WorkerRole[] = ['coder', 'searcher', 'tester', 'reviewer'];

export class Orchestrator {
  private llmClient: ILLMClient;
  private modelId: string;
  private conflictDetector: ConflictDetector;

  constructor(llmClient: ILLMClient, modelId: string) {
    this.llmClient = llmClient;
    this.modelId = modelId;
    this.conflictDetector = new ConflictDetector();
  }

  /**
   * 分析 GoalPlan，生成 ExecutionPlan
   * 如果分析失败，fallback 到串行执行
   */
  async plan(goalPlan: GoalPlan): Promise<ExecutionPlan> {
    try {
      const analysis = await this.analyzeWithLLM(goalPlan);
      if (!analysis || analysis.length === 0) {
        return this.fallbackPlan(goalPlan);
      }

      const executionOrder = this.topologicalSort(analysis);
      const parallelGroups = this.buildParallelGroups(analysis, executionOrder);
      const resolvedGroups = this.conflictDetector.resolveConflicts(
        parallelGroups,
        analysis,
      );

      return {
        dependencies: analysis,
        parallelGroups: resolvedGroups,
        executionOrder,
        analysisNotes: `分析了 ${goalPlan.steps.length} 个步骤，${resolvedGroups.length} 个执行组`,
      };
    } catch (error) {
      logger.error('Orchestrator planning failed', { error: String(error) });
      return this.fallbackPlan(goalPlan);
    }
  }

  /** LLM 驱动的步骤分析 */
  private async analyzeWithLLM(goalPlan: GoalPlan): Promise<StepDependency[] | null> {
    const systemPrompt = [
      '你是一个任务编排专家。分析以下步骤之间的依赖关系，并为每个步骤分配最合适的 Worker 角色。',
      '',
      '输出 JSON 数组，每个元素：',
      '{',
      '  "stepId": 步骤序号（从 1 开始）,',
      '  "dependsOn": [依赖的步骤序号列表，无依赖则为空数组],',
      '  "assignedRole": "coder" | "searcher" | "tester" | "reviewer",',
      '  "likelyFiles": ["该步骤可能涉及的文件路径"]',
      '}',
      '',
      '角色分配原则：',
      '- coder: 编写/修改代码的步骤',
      '- searcher: 搜索信息、查阅文档的步骤',
      '- tester: 编写/运行测试的步骤',
      '- reviewer: 审查代码、检查质量的步骤',
      '',
      '只输出 JSON 数组，不要输出其他内容。',
    ].join('\n');

    const userMessage = [
      `目标: ${goalPlan.description}`,
      '',
      '步骤列表:',
      ...goalPlan.steps.map((s, i) => `  ${i + 1}. ${s.description}`),
    ].join('\n');

    const response = await this.llmClient.complete({
      model: this.modelId,
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt,
      maxTokens: 1000,
      temperature: 0.2,
    });

    return this.parseAnalysis(response.content, goalPlan.steps);
  }

  private parseAnalysis(content: string, steps: GoalStep[]): StepDependency[] | null {
    try {
      const jsonStr = this.extractJson(content);
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;

      const result: StepDependency[] = [];
      // I21 修复：使用实际的 GoalStep.id 而非 idx+1，确保 stepId 与 GoalStep.id 格式一致
      // 原 bug：parseAnalysis 用 i+1 作为 stepId，但 GoalStep.id 可能是 LLM 提供的任意数字，
      // 导致 stepId 与 GoalStep.id 不匹配，后续执行时无法正确关联步骤
      const validStepIds = new Set(steps.map(s => s.id));
      for (let i = 0; i < steps.length; i++) {
        const stepId = steps[i].id;
        const item = parsed.find((p: any) => Number(p.stepId) === stepId) ?? parsed[i];
        if (!item) {
          result.push({
            stepId,
            dependsOn: i > 0 ? [steps[i - 1].id] : [],
            assignedRole: 'coder',
            likelyFiles: [],
          });
          continue;
        }
        result.push({
          stepId,
          dependsOn: Array.isArray(item.dependsOn)
            ? item.dependsOn.map(Number).filter((id: number) => validStepIds.has(id))
            : [],
          assignedRole: VALID_ROLES.includes(item.assignedRole) ? item.assignedRole : 'coder',
          likelyFiles: Array.isArray(item.likelyFiles) ? item.likelyFiles : [],
        });
      }
      return result;
    } catch {
      return null;
    }
  }

  private extractJson(content: string): string {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : content.trim();
  }

  /** 拓扑排序（Kahn 算法） */
  topologicalSort(dependencies: StepDependency[]): number[] {
    const inDegree = new Map<number, number>();
    const adj = new Map<number, number[]>();

    for (const dep of dependencies) {
      inDegree.set(dep.stepId, dep.dependsOn.length);
      for (const d of dep.dependsOn) {
        if (!adj.has(d)) adj.set(d, []);
        adj.get(d)!.push(dep.stepId);
      }
    }

    const queue: number[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const order: number[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const next of (adj.get(current) ?? [])) {
        const newDegree = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDegree);
        if (newDegree === 0) queue.push(next);
      }
    }

    // I20 修复：检测到循环时发出警告，跳过循环节点（不追加），避免拓扑排序混乱
    // 原 bug：循环节点被追加到 order 末尾，顺序取决于 dependencies 数组顺序，
    //         导致拓扑排序结果混乱，可能违反依赖关系执行
    // 修复：使用 Kahn 算法已正确排序的节点保留，循环节点跳过（不抛错，仅警告）
    if (order.length < dependencies.length) {
      const cycleSteps = dependencies
        .filter(dep => !order.includes(dep.stepId))
        .map(dep => dep.stepId);
      logger.warn(
        `依赖图存在循环，跳过以下步骤（不参与执行顺序）: [${cycleSteps.join(', ')}]`,
      );
      // 不追加循环节点，避免执行顺序混乱
    }

    return order;
  }

  /** 构建并行组 */
  private buildParallelGroups(
    dependencies: StepDependency[],
    order: number[],
  ): number[][] {
    const level = new Map<number, number>();

    for (const id of order) {
      const dep = dependencies.find(d => d.stepId === id);
      if (!dep || dep.dependsOn.length === 0) {
        level.set(id, 0);
      } else {
        const maxLevel = Math.max(
          ...dep.dependsOn.map(d => level.get(d) ?? 0),
        );
        level.set(id, maxLevel + 1);
      }
    }

    const groups = new Map<number, number[]>();
    for (const [id, lvl] of level) {
      if (!groups.has(lvl)) groups.set(lvl, []);
      groups.get(lvl)!.push(id);
    }

    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ids]) => ids);
  }

  /** Fallback：全部串行执行 */
  private fallbackPlan(goalPlan: GoalPlan): ExecutionPlan {
    const dependencies: StepDependency[] = goalPlan.steps.map((_, i) => ({
      stepId: i + 1,
      dependsOn: i > 0 ? [i] : [],
      assignedRole: 'coder' as WorkerRole,
      likelyFiles: [],
    }));

    return {
      dependencies,
      parallelGroups: goalPlan.steps.map((_, i) => [i + 1]),
      executionOrder: goalPlan.steps.map((_, i) => i + 1),
      analysisNotes: 'Fallback: LLM 分析失败或不可用，使用串行执行',
    };
  }

  // ============================================================
  // Phase 21 Task 3：Worker 异常隔离（委托给独立函数，保持向后兼容）
  // ============================================================

  /**
   * 隔离执行 Worker（委托给独立函数 executeWorkerIsolated）
   * 保留方法签名以保持向后兼容
   */
  async executeWorkerIsolated(
    workerId: string,
    task: WorkerTask,
    workerFn: WorkerFunction,
    maxRetries = 2,
  ): Promise<WorkerOutcome> {
    return executeWorkerIsolated(workerId, task, workerFn, maxRetries);
  }

  /** 分类 Worker 错误（委托给独立函数） */
  classifyWorkerError(error: unknown): WorkerErrorType {
    return classifyWorkerError(error);
  }

  /** 判断错误类型是否可重试（委托给独立函数） */
  isRetryable(errorType: WorkerErrorType): boolean {
    return isRetryable(errorType);
  }
}
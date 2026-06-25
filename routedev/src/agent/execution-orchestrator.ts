// src/agent/execution-orchestrator.ts
// Phase 31 Task 4：执行编排（单 Agent / 多 Agent 自适应）
//
// 根据复杂度评估结果选择执行路径：
//   - 所有步骤都不需要子 Agent → 单 Agent 串行执行（复用 goal-runner 逻辑）
//   - 任一步骤需要子 Agent → 多 Agent 并行执行（激活 Orchestrator + WorkerExecutor + Blackboard）
//
// 设计原则：
//   - 单 Agent 路径与现有 goal-runner 行为一致（向后兼容）
//   - 多 Agent 路径正确调用已写好但未使用的多 Agent 基础设施
//   - Worker 失败不中断后续步骤（容错）
//   - Token 追踪正确累加多 Agent 消耗

import { logger } from '../utils/logger.js';
import type { ILLMClient, LLMMessage, RoutingResult, TokenUsageInfo } from '../router/types.js';
import type { ReActAgentLoop } from './loop.js';
import type { ConfirmToolCallback } from './loop-config.js';
import type { GoalPlan, GoalStep } from './goal-types.js';
import type { TokenTracker } from '../router/tracker.js';
import type { AppConfig } from '../config/schema.js';
import { Blackboard } from './multi/blackboard.js';
import { Orchestrator } from './multi/orchestrator.js';
import { WorkerExecutor } from './multi/worker-executor.js';
import type { ExecutionPlan, WorkerResult, WorkerTask, WorkerRole } from './multi/types.js';
import type { StepComplexity, StepExecutionResult } from './task-orchestrator-types.js';

/**
 * 执行编排器依赖
 */
export interface ExecutionOrchestratorDeps {
  agentLoop: ReActAgentLoop;
  tracker: TokenTracker;
  config: AppConfig;
  /** 系统提示词（base）——ref 模式，支持运行时热更新（与 App.tsx systemPromptRef 共享） */
  systemPromptRef: { current: string };
  /** 中断信号 */
  signal?: AbortSignal;
  /** 工具确认回调 */
  onConfirmTool?: ConfirmToolCallback;
  /** 进度播报回调 */
  onProgress?: (progress: ExecutionProgress) => void;
  /** 系统消息回调 */
  addSystemMessage?: (content: string) => void;
}

/**
 * 执行进度信息
 */
export interface ExecutionProgress {
  /** 当前步骤 ID */
  stepId: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 步骤描述 */
  description: string;
  /** 执行模式 */
  mode: 'single' | 'multi';
  /** 是否为并行组 */
  parallelGroup?: boolean;
  /** 已完成步骤数 */
  completedSteps: number;
}

/**
 * 执行编排结果
 */
export interface ExecutionOrchestrationResult {
  /** 各步骤执行结果 */
  results: StepExecutionResult[];
  /** 总 Token 消耗 */
  totalUsage: TokenUsageInfo;
  /** 修改的文件列表 */
  modifiedFiles: string[];
  /** 执行模式（单/多 Agent） */
  mode: 'single' | 'multi';
  /** 失败的步骤 ID */
  failedStepIds: number[];
  /** Blackboard 快照（多 Agent 模式下有值） */
  blackboardSnapshot?: unknown;
}

/**
 * 判断是否需要多 Agent 执行
 */
export function anyNeedsSubAgent(complexityMap: Map<number, StepComplexity>): boolean {
  for (const complexity of complexityMap.values()) {
    if (complexity.needsSubAgent) return true;
  }
  return false;
}

/**
 * I27 修复：简单信号量——控制多任务并发数
 * 避免并行组内 Worker 数量过多导致资源耗尽（API 速率限制、内存压力等）
 * 使用 Promise 队列实现：acquire() 时若已满则排队等待，release() 时唤醒队首
 */
class Semaphore {
  private current = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (maxConcurrency < 1) {
      logger.warn('Semaphore maxConcurrency < 1, forcing to 1', { requested: maxConcurrency });
      this.maxConcurrency = 1;
    }
  }

  /** 获取许可（超过并发上限时排队等待） */
  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }
    await new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
    this.current++;
  }

  /** 释放许可（唤醒一个等待者） */
  release(): void {
    this.current--;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  /** 在信号量保护下执行异步函数 */
  async runWith<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * 执行编排器——根据复杂度选择单/多 Agent 路径
 */
export class ExecutionOrchestrator {
  constructor(private readonly deps: ExecutionOrchestratorDeps) {}

  /**
   * 主入口——根据复杂度选择执行路径
   */
  async execute(params: {
    plan: GoalPlan;
    complexityMap: Map<number, StepComplexity>;
    llmClient: ILLMClient;
    routeDecision: RoutingResult;
    conversationHistory: LLMMessage[];
  }): Promise<ExecutionOrchestrationResult> {
    const { plan, complexityMap, llmClient, routeDecision, conversationHistory } = params;

    // 检查中断
    if (this.deps.signal?.aborted) {
      logger.warn('ExecutionOrchestrator: aborted before start');
      return this.emptyResult();
    }

    // 选择执行路径
    const useMultiAgent = anyNeedsSubAgent(complexityMap);
    logger.info('ExecutionOrchestrator: selecting execution path', {
      useMultiAgent,
      stepsCount: plan.steps.length,
    });

    if (useMultiAgent) {
      return await this.executeMultiAgent(plan, complexityMap, llmClient, routeDecision, conversationHistory);
    }
    return await this.executeSingleAgent(plan, llmClient, routeDecision, conversationHistory);
  }

  // ============================================================
  // 单 Agent 路径——串行执行，复用现有逻辑
  // ============================================================

  /**
   * 单 Agent 串行执行
   * 与现有 goal-runner 行为一致，但提取为独立模块便于复用
   */
  private async executeSingleAgent(
    plan: GoalPlan,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
  ): Promise<ExecutionOrchestrationResult> {
    const results: StepExecutionResult[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    const modifiedFiles: string[] = [];
    // I4 修复：维护已完成步骤计数器，不依赖 step.id 连续
    let completedSteps = 0;

    for (const step of plan.steps) {
      if (this.deps.signal?.aborted) {
        logger.warn('ExecutionOrchestrator: aborted during single-agent execution', {
          stepId: step.id,
        });
        break;
      }

      const result = await this.executeSingleStep(
        step,
        plan.steps.length,
        llmClient,
        routeDecision,
        conversationHistory,
        completedSteps,
      );

      results.push(result);
      totalInput += result.tokenUsage.inputTokens;
      totalOutput += result.tokenUsage.outputTokens;
      for (const f of result.modifiedFiles) {
        if (!modifiedFiles.includes(f)) modifiedFiles.push(f);
      }
      completedSteps++;
    }

    return {
      results,
      totalUsage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        totalTokens: totalInput + totalOutput,
      },
      modifiedFiles,
      mode: 'single',
      failedStepIds: results.filter((r) => !r.success).map((r) => r.stepId),
    };
  }

  /**
   * 执行单个步骤（单 Agent 模式）
   */
  private async executeSingleStep(
    step: GoalStep,
    totalSteps: number,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
    completedSteps: number,
  ): Promise<StepExecutionResult> {
    const start = Date.now();
    this.deps.onProgress?.({
      stepId: step.id,
      totalSteps,
      description: step.description,
      mode: 'single',
      completedSteps,
    });

    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const modifiedFiles: string[] = [];

    try {
      for await (const event of this.deps.agentLoop.run({
        userMessage: step.description,
        llmClient,
        routeDecision,
        conversationHistory,
        systemPrompt: this.deps.systemPromptRef.current,
        signal: this.deps.signal,
        onConfirmTool: this.deps.onConfirmTool,
      })) {
        switch (event.type) {
          case 'text_delta':
            content += event.text;
            break;
          case 'tool_call_result':
            // 收集修改的文件
            if (event.toolName.includes('file_') || event.toolName.includes('git_')) {
              const fileMatch = event.result.match(/[\w/.\-]+\.\w{1,5}/);
              if (fileMatch && !modifiedFiles.includes(fileMatch[0])) {
                modifiedFiles.push(fileMatch[0]);
              }
            }
            break;
          case 'done':
            if (event.usage) {
              inputTokens = event.usage.inputTokens;
              outputTokens = event.usage.outputTokens;
              this.deps.tracker.record(event.usage, {
                modelId: routeDecision.model.id,
                agentId: 'single-agent',
                stepId: `step-${step.id}`,
              });
            }
            if (event.content) content = event.content;
            break;
        }
      }

      const durationMs = Date.now() - start;
      this.deps.onProgress?.({
        stepId: step.id,
        totalSteps,
        description: step.description,
        mode: 'single',
        completedSteps: completedSteps + 1,
      });

      return {
        stepId: step.id,
        success: true,
        conclusion: content.slice(0, 500),
        modifiedFiles,
        durationMs,
        tokenUsage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Single agent step failed', { stepId: step.id, error: errorMsg });
      return {
        stepId: step.id,
        success: false,
        conclusion: `执行失败: ${errorMsg}`,
        modifiedFiles,
        durationMs,
        tokenUsage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        error: errorMsg,
      };
    }
  }

  // ============================================================
  // 多 Agent 路径——激活 Orchestrator + WorkerExecutor + Blackboard
  // ============================================================

  /**
   * 多 Agent 并行执行
   *
   * 流程：
   *   1. 初始化 Blackboard
   *   2. Orchestrator.plan() 生成 ExecutionPlan
   *   3. 按并行组执行：
   *      - 单步骤组 → 单 Agent 执行
   *      - 多步骤组 → WorkerExecutor 并行执行
   *   4. 每完成一个步骤，结果写入 Blackboard
   *   5. Worker 失败不中断后续步骤
   */
  private async executeMultiAgent(
    plan: GoalPlan,
    complexityMap: Map<number, StepComplexity>,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
  ): Promise<ExecutionOrchestrationResult> {
    // 1. 初始化 Blackboard
    const blackboard = new Blackboard();
    blackboard.setGoal(plan.description, 'in_progress');
    blackboard.addProjectFact('plan', JSON.stringify(plan.steps.map((s) => ({
      id: s.id,
      description: s.description,
    }))));
    this.deps.addSystemMessage?.(`🤖 启动多 Agent 协作模式（${plan.steps.length} 个步骤）`);

    // 2. Orchestrator 生成执行计划
    const orchestrator = new Orchestrator(llmClient, routeDecision.model.id);
    let executionPlan: ExecutionPlan;
    try {
      executionPlan = await orchestrator.plan(plan);
      logger.info('Orchestrator plan generated', {
        groups: executionPlan.parallelGroups.length,
        notes: executionPlan.analysisNotes,
      });
      this.deps.addSystemMessage?.(`📋 执行计划: ${executionPlan.parallelGroups.length} 个执行组 (${executionPlan.analysisNotes})`);
    } catch (error) {
      logger.error('Orchestrator plan failed, fallback to single agent', { error: String(error) });
      this.deps.addSystemMessage?.('⚠️ 编排失败，回退到单 Agent 模式');
      return await this.executeSingleAgent(plan, llmClient, routeDecision, conversationHistory);
    }

    // 3. 创建 WorkerExecutor
    const workerExecutor = new WorkerExecutor(this.deps.agentLoop);

    // 4. 按并行组执行
    const results: StepExecutionResult[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    const modifiedFiles: string[] = [];
    let completedSteps = 0;

    for (const group of executionPlan.parallelGroups) {
      if (this.deps.signal?.aborted) {
        logger.warn('ExecutionOrchestrator: aborted during multi-agent execution');
        break;
      }

      // 获取组内步骤
      const groupSteps = group
        .map((id) => plan.steps.find((s) => s.id === id))
        .filter((s): s is GoalStep => s !== undefined);

      if (groupSteps.length === 0) continue;

      // 单步骤组 → 单 Agent 执行
      if (groupSteps.length === 1) {
        const step = groupSteps[0];
        this.deps.onProgress?.({
          stepId: step.id,
          totalSteps: plan.steps.length,
          description: step.description,
          mode: 'multi',
          completedSteps,
        });

        const result = await this.executeSingleStep(
          step,
          plan.steps.length,
          llmClient,
          routeDecision,
          conversationHistory,
          completedSteps,
        );

        results.push(result);
        totalInput += result.tokenUsage.inputTokens;
        totalOutput += result.tokenUsage.outputTokens;
        for (const f of result.modifiedFiles) {
          if (!modifiedFiles.includes(f)) modifiedFiles.push(f);
        }

        // 写入 Blackboard
        if (result.success) {
          const complexity = complexityMap.get(step.id);
          blackboard.addCompletedStep(
            step.id,
            complexity?.recommendedRole ?? 'coder',
            result.conclusion,
          );
        }

        completedSteps++;
        this.reportProgress(step, completedSteps, plan.steps.length, result.success, result.durationMs, result.tokenUsage);
        continue;
      }

      // 多步骤并行组 → WorkerExecutor
      this.deps.addSystemMessage?.(`⚡ 并行执行 ${groupSteps.length} 个步骤: ${groupSteps.map((s) => s.id).join(', ')}`);

      const workerTasks: WorkerTask[] = groupSteps.map((step) => {
        const complexity = complexityMap.get(step.id);
        const role: WorkerRole = complexity?.recommendedRole ?? 'coder';
        return {
          stepId: step.id,
          description: step.description,
          role,
          rolePrompt: '', // 使用默认角色提示词
          blackboardSnapshot: blackboard.getSnapshot(),
        };
      });

      // I27 修复：使用信号量控制并发数，避免并行组内 Worker 过多导致资源耗尽
      // 配置读取：config?.execution?.maxConcurrency ?? 3（默认 3）
      const maxConcurrency = this.deps.config?.execution?.maxConcurrency ?? 3;
      const semaphore = new Semaphore(maxConcurrency);
      logger.info('Parallel group execution with concurrency control', {
        groupSize: workerTasks.length,
        maxConcurrency,
      });

      // I30 修复：使用 Promise.allSettled 替代 Promise.all
      // 原行为：Promise.all 在任一 Worker reject 时丢失其他已完成结果
      // 修复：allSettled 确保所有 Worker 结果都被收集，单个失败不影响其他结果
      const settled = await Promise.allSettled(
        workerTasks.map(async (task) => {
          // I27 修复：通过信号量限制并发
          return semaphore.runWith(async () => {
            try {
              return await workerExecutor.execute(
                task,
                llmClient,
                routeDecision,
                conversationHistory,
                this.deps.systemPromptRef.current,
                this.deps.signal,
                this.deps.onConfirmTool,
              );
            } catch (error) {
              // 兜底：WorkerExecutor 内部已有异常隔离，这里捕获未预期的错误
              logger.error('WorkerExecutor unexpected error', {
                stepId: task.stepId,
                error: String(error),
              });
              return {
                stepId: task.stepId,
                role: task.role,
                success: false,
                conclusion: `Worker 异常: ${error instanceof Error ? error.message : String(error)}`,
                modifiedFiles: [],
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
              } as WorkerResult;
            }
          });
        }),
      );

      // I30 修复：allSettled 结果转换——rejected 的 promise 转为失败 WorkerResult
      const workerResults: WorkerResult[] = settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        // 理论上不会走到这里（runWith 内部已 try-catch），防御性兜底
        const task = workerTasks[i];
        logger.error('Worker promise rejected unexpectedly', {
          stepId: task.stepId,
          reason: String(s.reason),
        });
        return {
          stepId: task.stepId,
          role: task.role,
          success: false,
          conclusion: `Worker 意外终止: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
          modifiedFiles: [],
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        } as WorkerResult;
      });

      // 处理结果
      for (let i = 0; i < workerResults.length; i++) {
        const wr = workerResults[i];
        const step = groupSteps[i];
        const durationMs = 0; // WorkerExecutor 不返回耗时，这里用 0 占位
        const tokenUsage: TokenUsageInfo = {
          inputTokens: wr.tokenUsage.inputTokens,
          outputTokens: wr.tokenUsage.outputTokens,
          totalTokens: wr.tokenUsage.inputTokens + wr.tokenUsage.outputTokens,
        };

        // 记录 Token
        if (tokenUsage.totalTokens > 0) {
          this.deps.tracker.record(tokenUsage, {
            modelId: routeDecision.model.id,
            agentId: `worker-${wr.role}`,
            stepId: `step-${wr.stepId}`,
          });
        }

        results.push({
          stepId: wr.stepId,
          success: wr.success,
          conclusion: wr.conclusion,
          modifiedFiles: wr.modifiedFiles,
          durationMs,
          tokenUsage,
          error: wr.success ? undefined : wr.conclusion,
        });

        totalInput += tokenUsage.inputTokens;
        totalOutput += tokenUsage.outputTokens;
        for (const f of wr.modifiedFiles) {
          if (!modifiedFiles.includes(f)) modifiedFiles.push(f);
        }

        // 写入 Blackboard
        if (wr.success) {
          blackboard.addCompletedStep(wr.stepId, wr.role, wr.conclusion);
        }

        completedSteps++;
        this.reportProgress(step, completedSteps, plan.steps.length, wr.success, durationMs, tokenUsage);
      }
    }

    // 更新 Blackboard 目标状态
    const allSuccess = results.every((r) => r.success);
    blackboard.updateGoalStatus(allSuccess ? 'completed' : 'partial');

    return {
      results,
      totalUsage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        totalTokens: totalInput + totalOutput,
      },
      modifiedFiles,
      mode: 'multi',
      failedStepIds: results.filter((r) => !r.success).map((r) => r.stepId),
      blackboardSnapshot: blackboard.getSnapshot(),
    };
  }

  /**
   * 播报步骤进度
   * 格式：[3/5] ✅ 重构认证模块（子 Agent: coder）| ⏱ 12s | ~2,340 tokens
   */
  private reportProgress(
    step: GoalStep,
    completed: number,
    total: number,
    success: boolean,
    durationMs: number,
    tokenUsage: TokenUsageInfo,
  ): void {
    const icon = success ? '✅' : '❌';
    const duration = durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : '-';
    const tokens = tokenUsage.totalTokens > 0 ? `~${tokenUsage.totalTokens.toLocaleString()} tokens` : '';
    const msg = `[${completed}/${total}] ${icon} ${step.description} | ⏱ ${duration}${tokens ? ' | ' + tokens : ''}`;
    this.deps.addSystemMessage?.(msg);
  }

  /**
   * 空结果（中止时返回）
   */
  private emptyResult(): ExecutionOrchestrationResult {
    return {
      results: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      modifiedFiles: [],
      mode: 'single',
      failedStepIds: [],
    };
  }
}

/**
 * 创建执行编排器的工厂函数
 */
export function createExecutionOrchestrator(deps: ExecutionOrchestratorDeps): ExecutionOrchestrator {
  return new ExecutionOrchestrator(deps);
}

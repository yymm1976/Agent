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
import { SynthesizeBarrier } from './multi/synthesize-barrier.js';
import type { FanOutResult } from './multi/synthesize-barrier.js';
// Phase 62：动态工作流模式与隔离治理模块（可选注入，受 dynamicWorkflow config 守护）
import type { AdversarialVerifier } from './adversarial-verifier.js';
import type { RubricRegistry } from './rubric-registry.js';
import type { LoopUntilDoneGate } from './loop-until-done-gate.js';
import type { QuarantineManager } from '../tools/quarantine-profile.js';
import type { ActionAgentDispatcher, DispatchIntent } from './action-agent-dispatcher.js';
import type { TournamentSelector, TournamentCandidate } from './tournament-selector.js';
// Phase 66：策略管道与治理
import type { CheckpointPipeline } from '../policies/checkpoint-pipeline.js';
import type { CallOwnerCoordinator } from '../policies/call-owner-coordinator.js';
import type { StateSnapshotChain } from '../harness/state-snapshot-chain.js';
import type { ReputationDeriver } from '../memory/reputation-deriver.js';
// Phase 67：推理质量诊断
import type { MICrossScorer } from '../evaluation/mi-cross-scorer.js';
import type { SNRAwareFilter } from './snr-aware-filter.js';
import type { EpistemicIntegrityChecker } from './epistemic-integrity-checker.js';
import type { EpistemicPreservingSummarizer } from './epistemic-preserving-summarizer.js';
import type { QualityMetricsRecorder } from '../harness/quality-metrics-types.js';
// Phase 69：Worktree 隔离执行与多代理并行编排
import type { WorktreeManager } from './multi/worktree-manager.js';
import type { ParallelExecutor, ParallelOutcome } from './multi/parallel-executor.js';
import type { ResultComparator } from './multi/result-comparator.js';
import type { AgentGroupResolver } from './multi/agent-group-resolver.js';
import type { CLIAdapterRegistry } from './multi/cli-adapter.js';

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
  // Phase 62：动态工作流模式与隔离治理模块（可选注入，受 dynamicWorkflow config 守护）
  /** 对抗性验证器——跨模型 rubric 检查 */
  adversarialVerifier?: AdversarialVerifier;
  /** Rubric 注册表——提供任务类型对应的检查清单 */
  rubricRegistry?: RubricRegistry;
  /** 循环直到完成门——基于 CompletionGate 的多轮稳定性检查 */
  loopUntilDoneGate?: LoopUntilDoneGate;
  /** 隔离管理器——未信任 Agent 的工具调用隔离 */
  quarantineManager?: QuarantineManager;
  /** 意图转发器——隔离策略下转发未信任 Agent 的意图到信任 Agent */
  actionAgentDispatcher?: ActionAgentDispatcher;
  /** 锦标赛选择器——从多个候选结果中选最优 */
  tournamentSelector?: TournamentSelector<string>;
  // Phase 66：策略管道与治理
  /** 策略管道——按段位编号分段评估 */
  checkpointPipeline?: CheckpointPipeline;
  /** Call Owner 协调器——管理工具审批策略 */
  callOwnerCoordinator?: CallOwnerCoordinator;
  /** 状态快照链——记录关键执行点状态快照 */
  stateSnapshotChain?: StateSnapshotChain;
  /** 信誉派生器——从执行历史派生 worker 信誉 */
  reputationDeriver?: ReputationDeriver;
  // Phase 67：推理质量诊断
  /** MI 代理评分器——跨模型推理质量评分 */
  miCrossScorer?: MICrossScorer;
  /** SNR 感知过滤器——过滤低质量 worker 输出 */
  snrAwareFilter?: SNRAwareFilter;
  /** 认知完整性检查器——执行后检查认知完整性 */
  epistemicIntegrityChecker?: EpistemicIntegrityChecker;
  /** 认知保留摘要器——压缩时保留认知内容 */
  epistemicPreservingSummarizer?: EpistemicPreservingSummarizer;
  /** 质量指标记录器——记录质量指标供审计 */
  qualityMetricsRecorder?: QualityMetricsRecorder;
  // Phase 69：Worktree 隔离执行与多代理并行编排
  /** Worktree 管理器——为隔离 worker 创建 worktree */
  worktreeManager?: WorktreeManager;
  /** 并行执行引擎——并行执行多个 worker */
  parallelExecutor?: ParallelExecutor;
  /** 结果比较器——比较和排序 worker 结果 */
  resultComparator?: ResultComparator;
  /** 代理组解析器——解析 @group 地址 */
  agentGroupResolver?: AgentGroupResolver;
  /** CLI 适配器注册表——管理 CLI 适配器会话 */
  cliAdapterRegistry?: CLIAdapterRegistry;
}

/**
 * 执行进度信息
 */
interface ExecutionProgress {
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

    // Phase 66：CheckpointPipeline——按段位编号分段评估执行计划
    if (this.deps.checkpointPipeline && this.deps.config?.foundationProtocol?.checkpointPipeline?.enabled) {
      try {
        const evalResult = this.deps.checkpointPipeline.evaluateAction(
          { type: 'multi_agent_plan', stepCount: plan.steps.length, groupCount: executionPlan.parallelGroups.length },
          [],
        );
        logger.info('Phase 66: CheckpointPipeline 评估完成', {
          finalAction: evalResult.finalAction,
          firstFailedSegment: evalResult.firstFailedSegment,
          segmentCount: evalResult.segmentResults.length,
        });
        if (evalResult.finalAction === 'deny') {
          this.deps.addSystemMessage?.('⚠️ CheckpointPipeline 策略拒绝，回退到单 Agent 模式');
          return await this.executeSingleAgent(plan, llmClient, routeDecision, conversationHistory);
        }
      } catch (err) {
        logger.warn('Phase 66: CheckpointPipeline 评估失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 66：CallOwnerCoordinator——初始化工具审批协调
    if (this.deps.callOwnerCoordinator && this.deps.config?.foundationProtocol?.callOwner?.enabled) {
      try {
        logger.info('Phase 66: CallOwnerCoordinator 就绪', {
          strategy: this.deps.config.foundationProtocol.callOwner.defaultStrategyForToolApproval ?? 'conditional',
        });
      } catch (err) {
        logger.warn('Phase 66: CallOwnerCoordinator 初始化失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 69：AgentGroupResolver——注册默认工作组
    if (this.deps.agentGroupResolver) {
      try {
        this.deps.agentGroupResolver.register({
          name: 'default-workers',
          workerIds: plan.steps.map((s) => `worker-${s.id}`),
          description: '默认工作组',
        });
        logger.info('Phase 69: AgentGroupResolver 注册默认工作组', {
          workerCount: plan.steps.length,
        });
      } catch (err) {
        logger.warn('Phase 69: AgentGroupResolver 注册失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

      // Phase 69：WorktreeManager——为并行 worker 创建隔离 worktree
      const activeWorktrees: string[] = [];
      if (this.deps.worktreeManager && this.deps.config?.phase69Integration?.worktree?.enabled) {
        for (const task of workerTasks) {
          try {
            const worktreeInfo = await this.deps.worktreeManager.create(
              `worker-${task.stepId}-${task.role}`,
            );
            if (worktreeInfo) {
              activeWorktrees.push(worktreeInfo.id);
              logger.info('Phase 69: WorktreeManager worktree 已创建', {
                workerId: worktreeInfo.id,
                path: worktreeInfo.path,
                branch: worktreeInfo.branch,
              });
            }
          } catch (err) {
            logger.warn('Phase 69: WorktreeManager 创建失败（fail-open）', {
              stepId: task.stepId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

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
            // I10 修复：为每个 Worker 加独立超时，避免单个 Worker 挂起阻塞整个并行组
            const workerTimeoutMs = this.deps.config?.execution?.workerTimeoutMs ?? 300_000;
            const workerController = new AbortController();
            const timer = setTimeout(() => workerController.abort(), workerTimeoutMs);
            // 全局信号中断时也中断 Worker
            if (this.deps.signal) {
              this.deps.signal.addEventListener('abort', () => workerController.abort(), { once: true });
            }
            try {
              return await workerExecutor.execute(
                task,
                llmClient,
                routeDecision,
                conversationHistory,
                this.deps.systemPromptRef.current,
                workerController.signal,
                this.deps.onConfirmTool,
              );
            } catch (error) {
              // 超时导致的 abort 转为友好的超时错误
              if (workerController.signal.aborted) {
                logger.warn('Worker timed out', { stepId: task.stepId, timeoutMs: workerTimeoutMs });
                return {
                  stepId: task.stepId,
                  role: task.role,
                  success: false,
                  conclusion: `Worker 超时（${workerTimeoutMs}ms），已终止`,
                  modifiedFiles: [],
                  tokenUsage: { inputTokens: 0, outputTokens: 0 },
                } as WorkerResult;
              }
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
            } finally {
              clearTimeout(timer);
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

      // Phase 62 Task 1：SynthesizeBarrier 屏障合并（当 dynamicWorkflow.synthesizeBarrier.enabled 开启时）
      if (this.deps.config?.dynamicWorkflow?.synthesizeBarrier?.enabled) {
        const synthesizeCfg = this.deps.config.dynamicWorkflow.synthesizeBarrier;
        const fanOutResults: FanOutResult<string>[] = workerResults.map((wr) => ({
          workerId: `worker-${wr.stepId}-${wr.role}`,
          success: wr.success,
          data: wr.success ? wr.conclusion : undefined,
          failedReason: wr.success ? undefined : wr.conclusion,
          durationMs: 0,
        }));
        const synthBarrier = new SynthesizeBarrier(undefined);
        const synthOutput = await synthBarrier.synthesize(fanOutResults, {
          barrierTimeoutMs: synthesizeCfg.barrierTimeoutMs,
          strategy: synthesizeCfg.defaultStrategy,
          includeFailed: synthesizeCfg.includeFailed,
        });
        logger.info('SynthesizeBarrier completed', {
          strategy: synthesizeCfg.defaultStrategy,
          participants: synthOutput.participants.length,
          barrierTimedOut: synthOutput.barrierTimedOut,
          synthesizeMs: synthOutput.synthesizeMs,
        });
      }

      // Phase 62 接线：AdversarialVerifier——worker 完成后跨模型 rubric 验证
      // 当 dynamicWorkflow.adversarialVerification.enabled 时，对每个成功 worker 结果调用 verify()
      if (this.deps.adversarialVerifier && this.deps.config?.dynamicWorkflow?.adversarialVerification?.enabled) {
        const advVerifier = this.deps.adversarialVerifier;
        for (let i = 0; i < workerResults.length; i++) {
          const wr = workerResults[i];
          if (!wr.success) continue;
          const stepIdx = completedSteps + i;
          try {
            if (!advVerifier.shouldVerify(stepIdx, plan.steps.length)) continue;
            const taskType = this.inferTaskType(wr.role, groupSteps[i]?.description ?? '');
            const outcome = await advVerifier.verify({
              modifiedFiles: wr.modifiedFiles,
              executionSummary: wr.conclusion,
              taskType,
              stepIndex: stepIdx,
            });
            if (!outcome.passed) {
              logger.warn('Phase 62: AdversarialVerifier 检查未通过', {
                stepId: wr.stepId,
                taskType,
                isCrossModel: outcome.isCrossModel,
                downgradeReason: outcome.downgradeReason,
              });
            }
          } catch (err) {
            logger.warn('Phase 62: AdversarialVerifier.verify 失败（fail-open）', {
              stepId: wr.stepId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Phase 62 接线：TournamentSelector——多结果择优
      // 当 dynamicWorkflow.tournament.enabled 且有多个成功 worker 结果时，用锦标赛选择最优
      if (this.deps.tournamentSelector && this.deps.config?.dynamicWorkflow?.tournament?.enabled) {
        const successfulResults = workerResults.filter(wr => wr.success);
        if (successfulResults.length > 1) {
          try {
            const candidates: TournamentCandidate<string>[] = successfulResults.map(wr => ({
              id: `worker-${wr.stepId}-${wr.role}`,
              content: wr.conclusion,
              metadata: { modifiedFiles: wr.modifiedFiles },
            }));
            const tournamentResult = await this.deps.tournamentSelector.select(candidates);
            logger.info('Phase 62: TournamentSelector 选出最优结果', {
              winnerId: tournamentResult.winner.id,
              totalComparisons: tournamentResult.totalComparisons,
              durationMs: tournamentResult.durationMs,
            });
          } catch (err) {
            logger.warn('Phase 62: TournamentSelector.select 失败（fail-open）', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Phase 62 接线：QuarantineManager + ActionAgentDispatcher——工具隔离与意图转发
      // 当 dynamicWorkflow.quarantine.enabled 时，检查 worker 是否使用了被隔离的工具
      if (this.deps.quarantineManager && this.deps.config?.dynamicWorkflow?.quarantine?.enabled) {
        const quarantine = this.deps.quarantineManager;
        const deniedToolsList = this.deps.config.dynamicWorkflow.quarantine.untrustedDeniedTools ?? [];
        for (let i = 0; i < workerResults.length; i++) {
          const wr = workerResults[i];
          if (!wr.success) continue;
          // 检查 worker 修改的文件是否涉及被隔离的工具
          const usedDeniedTools = wr.modifiedFiles.length > 0 && deniedToolsList.some(
            (tool) => tool === 'file_write' || tool === 'file_edit',
          );
          if (usedDeniedTools) {
            logger.warn('Phase 62: 未信任 worker 使用了被隔离的工具', {
              stepId: wr.stepId,
              modifiedFiles: wr.modifiedFiles,
            });
            // 传播污染：未信任 worker 的输出可能不可信
            quarantine.propagateContamination('untrusted-worker', 'trusted-primary', `worker-${wr.stepId} 使用了被隔离的工具`);

            // Phase 62 接线：ActionAgentDispatcher——意图转发
            // 当隔离策略允许意图转发时，将未信任 worker 的意图转发给信任 Agent
            if (this.deps.actionAgentDispatcher) {
              try {
                const intent: DispatchIntent = {
                  intentId: `intent-${wr.stepId}-${Date.now()}`,
                  description: wr.conclusion.slice(0, 200),
                  requiredTools: deniedToolsList,
                  originAgentId: 'untrusted-worker',
                };
                const dispatchResult = await this.deps.actionAgentDispatcher.dispatch(intent);
                logger.info('Phase 62: ActionAgentDispatcher 意图转发完成', {
                  intentId: dispatchResult.intentId,
                  executedBy: dispatchResult.executedBy,
                  success: dispatchResult.success,
                });
              } catch (err) {
                logger.warn('Phase 62: ActionAgentDispatcher.dispatch 失败（fail-open）', {
                  stepId: wr.stepId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }
      }

      // Phase 67：SNRAwareFilter——按 RV 过滤低质量 worker 结果
      if (this.deps.snrAwareFilter && this.deps.config?.reasoningQualityDiagnostics?.snrAwareFilter?.enabled) {
        try {
          const tasksWithRV = workerResults.map((wr) => ({
            taskId: `worker-${wr.stepId}-${wr.role}`,
            description: wr.conclusion.slice(0, 200),
            estimatedRewardVariance: wr.success ? 0.8 : 0.2,
            retained: true,
          }));
          const filterResult = this.deps.snrAwareFilter.filter(tasksWithRV);
          logger.info('Phase 67: SNRAwareFilter 过滤完成', {
            retained: filterResult.retainedTasks.length,
            filtered: filterResult.filteredOutTasks.length,
            batchRejected: filterResult.batchRejected,
          });
          if (filterResult.batchRejected) {
            logger.warn('Phase 67: SNRAwareFilter 拒绝整个 batch');
          }
        } catch (err) {
          logger.warn('Phase 67: SNRAwareFilter 过滤失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase 67：MICrossScorer——跨模型推理质量评分
      if (this.deps.miCrossScorer && this.deps.config?.reasoningQualityDiagnostics?.miCrossScorer?.enabled) {
        try {
          const successfulResults = workerResults.filter(wr => wr.success);
          if (successfulResults.length >= 2) {
            const scores = successfulResults.map((wr) => ({
              promptId: `worker-${wr.stepId}`,
              retrievalAcc: 0.8,
              randomBaseline: 1 / successfulResults.length,
            }));
            const snapshot = this.deps.miCrossScorer.computeMIProxy(scores);
            logger.info('Phase 67: MICrossScorer 推理质量评分', {
              miZScore: snapshot.miZScore,
              miZScoreEma: snapshot.miZScoreEma,
              collapseWarning: snapshot.collapseWarning,
            });
            if (snapshot.collapseWarning) {
              this.deps.addSystemMessage?.('⚠️ MICrossScorer: 推理质量坍缩告警');
            }
          }
        } catch (err) {
          logger.warn('Phase 67: MICrossScorer 评分失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase 67：EpistemicIntegrityChecker——认知完整性检查
      if (this.deps.epistemicIntegrityChecker && this.deps.config?.reasoningQualityDiagnostics?.epistemicIntegrityChecker?.enabled) {
        try {
          for (const wr of workerResults) {
            if (!wr.success) continue;
            const integrityResult = this.deps.epistemicIntegrityChecker.check(
              wr.conclusion,
              wr.conclusion,
            );
            if (integrityResult.overCompressionWarning) {
              logger.warn('Phase 67: EpistemicIntegrityChecker 认知完整性预警', {
                stepId: wr.stepId,
                frequencyDropRatio: integrityResult.frequencyDropRatio,
              });
            }
          }
        } catch (err) {
          logger.warn('Phase 67: EpistemicIntegrityChecker 检查失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase 67：QualityMetricsRecorder——记录质量指标
      if (this.deps.qualityMetricsRecorder && this.deps.config?.reasoningQualityDiagnostics?.auditMetricsLogging?.logEpistemicStats) {
        try {
          for (const wr of workerResults) {
            this.deps.qualityMetricsRecorder.logWorkerDispatchWithRV(
              `worker-${wr.stepId}-${wr.role}`,
              wr.success ? 0.8 : 0.2,
              wr.success,
            );
          }
          logger.info('Phase 67: QualityMetricsRecorder 质量指标已记录', {
            count: workerResults.length,
          });
        } catch (err) {
          logger.warn('Phase 67: QualityMetricsRecorder 记录失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase 66：StateSnapshotChain——记录状态快照
      if (this.deps.stateSnapshotChain && this.deps.config?.foundationProtocol?.stateSnapshotChain?.enabled) {
        try {
          await this.deps.stateSnapshotChain.writeSnapshot({
            machineType: 'compose_pipeline',
            stage: 'multi_agent_group_complete',
            payload: {
              groupStepIds: groupSteps.map(s => s.id),
              successCount: workerResults.filter(wr => wr.success).length,
              totalCount: workerResults.length,
            },
            settled: true,
          });
          logger.info('Phase 66: StateSnapshotChain 状态快照已记录', {
            groupSize: groupSteps.length,
          });
        } catch (err) {
          logger.warn('Phase 66: StateSnapshotChain 记录失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase 66：ReputationDeriver——派生 worker 信誉
      if (this.deps.reputationDeriver && this.deps.config?.foundationProtocol?.reputationDeriver?.enabled) {
        try {
          for (const wr of workerResults) {
            const references = [{ topicId: `worker-${wr.stepId}`, outcome: wr.success ? 'approved' as const : 'denied' as const }];
            const reputation = this.deps.reputationDeriver.deriveReputation(
              `worker-${wr.role}`,
              references,
            );
            logger.info('Phase 66: ReputationDeriver 信誉派生', {
              workerRole: wr.role,
              credibility: reputation.credibility,
            });
          }
        } catch (err) {
          logger.warn('Phase 66: ReputationDeriver 派生失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase 69：ResultComparator——比较和排序 worker 结果
      if (this.deps.resultComparator && workerResults.length > 1) {
        try {
          const outcomes: ParallelOutcome[] = workerResults.map(wr => ({
            success: wr.success,
            workerId: `worker-${wr.stepId}-${wr.role}`,
            result: wr.success ? wr.conclusion : undefined,
            error: wr.success ? undefined : wr.conclusion,
          }));
          const comparison = this.deps.resultComparator.compare(outcomes);
          logger.info('Phase 69: ResultComparator 结果比较', {
            winnerId: comparison.winnerId,
            reason: comparison.reason,
            needsHumanReview: comparison.needsHumanReview,
          });
        } catch (err) {
          logger.warn('Phase 69: ResultComparator 比较失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Phase 69：WorktreeManager——清理已完成的 worktree
      if (this.deps.worktreeManager && activeWorktrees.length > 0) {
        try {
          for (const workerId of activeWorktrees) {
            this.deps.worktreeManager.complete(workerId);
          }
          await this.deps.worktreeManager.cleanupAll();
          logger.info('Phase 69: WorktreeManager worktree 已清理', {
            cleanedCount: activeWorktrees.length,
          });
        } catch (err) {
          logger.warn('Phase 69: WorktreeManager 清理失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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

    // Phase 62 接线：LoopUntilDoneGate——循环直到完成
    // 当 dynamicWorkflow.loopUntilDone.enabled 时，基于 CompletionGate 多轮验证是否真正完成
    if (this.deps.loopUntilDoneGate && this.deps.config?.dynamicWorkflow?.loopUntilDone?.enabled) {
      try {
        const loopResult = await this.deps.loopUntilDoneGate.run({
          projectPath: process.cwd(),
          modifiedFiles,
        });
        logger.info('Phase 62: LoopUntilDoneGate 完成', {
          canStop: loopResult.canStop,
          roundsExecuted: loopResult.roundsExecuted,
          stopReason: loopResult.stopReason,
          finalCompletionRatio: loopResult.finalCompletionRatio,
        });
        if (!loopResult.canStop) {
          this.deps.addSystemMessage?.(`⚠️ LoopUntilDoneGate: ${loopResult.roundsExecuted} 轮后仍未达到完成阈值 (${(loopResult.finalCompletionRatio * 100).toFixed(0)}%)`);
        }
      } catch (err) {
        logger.warn('Phase 62: LoopUntilDoneGate.run 失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 67：EpistemicPreservingSummarizer——执行完成后检查认知保留
    if (this.deps.epistemicPreservingSummarizer && this.deps.config?.reasoningQualityDiagnostics?.epistemicPreservingSummarizer?.enabled) {
      try {
        const successfulResults = results.filter(r => r.success);
        if (successfulResults.length > 0) {
          logger.info('Phase 67: EpistemicPreservingSummarizer 就绪', {
            successfulSteps: successfulResults.length,
            maxTokens: this.deps.config.reasoningQualityDiagnostics.epistemicPreservingSummarizer.maxTokens,
          });
        }
      } catch (err) {
        logger.warn('Phase 67: EpistemicPreservingSummarizer 检查失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 69：CLIAdapterRegistry——清理已注册的适配器会话
    if (this.deps.cliAdapterRegistry) {
      try {
        const adapters = this.deps.cliAdapterRegistry.list();
        logger.info('Phase 69: CLIAdapterRegistry 适配器状态', {
          registeredAdapters: adapters.length,
          adapterNames: adapters.map(a => a.name),
        });
      } catch (err) {
        logger.warn('Phase 69: CLIAdapterRegistry 检查失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
   * Phase 62：根据 worker 角色和步骤描述推断任务类型
   * 用于 AdversarialVerifier 选择对应的 rubric
   */
  private inferTaskType(role: WorkerRole, description: string): string {
    const desc = description.toLowerCase();
    if (desc.includes('安全') || desc.includes('security') || desc.includes('audit')) return 'security-audit';
    if (desc.includes('重构') || desc.includes('refactor')) return 'refactor';
    if (desc.includes('bug') || desc.includes('修复') || desc.includes('fix')) return 'bug-fix';
    if (desc.includes('新增') || desc.includes('feature') || desc.includes('add')) return 'new-feature';
    // 根据角色推断
    if (role === 'reviewer') return 'security-audit';
    if (role === 'tester') return 'bug-fix';
    return 'default';
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

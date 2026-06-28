// src/agent/dual-loop-orchestrator.ts
// Phase 49 Task 2.2：双循环编排器——把内循环 ReAct 和外循环验证统一编排
//
// 知识库要求：
//   - 内循环：ReAct 完成任务（执行 Agent）
//   - 外循环：独立验证审核结果（验证 Agent）
//   - 验证不通过 → 打回重跑（形成闭环）
//   - 执行与验证分离（不同模型，打破自评盲区）
//
// Loop 五模块对应：
//   - 目标来源：goal.plan + goal.gates
//   - 执行 Agent：内循环 ReActAgentLoop
//   - 验证 Agent：外循环 GoalVerifier + CompletionGate + 跨模型审查
//   - 记忆：LoopMemory（失败原因沉淀）
//   - 终止条件：外循环验证通过 OR 达到最大重跑次数
//
// 2.5 节"让 AI 自己改"约束：
//   1. 重跑时把 LoopMemory.buildPrompt() 注入 system prompt
//   2. 重跑时不允许外部 patch/hotfix（由调用方约束）
//   3. 检测到人工修改（git diff 非内循环产出）→ 标记"人工介入"并停止自动重跑
//   4. 连续 maxReruns 次同一原因失败 → 提示用户接管（Pilot 模式）
//
// Phase 51 Task 1/7 扩展（Reviewer 分级 + 审查反馈协议）：
//   - 启用 reviewerPolicy.tieredReviewEnabled 后，按 tiny/medium/big/high-risk 分级
//   - tiny 跳过外循环，high-risk 强制跨模型审查
//   - 启用 enforceEvidenceProtocol 后校验审查反馈结构（Flue 三件证据协议）
//   - 未设置 reviewerPolicy 时退回旧的 critical 过滤行为（向后兼容）
//
// Phase 52 Task 3 扩展（有界局部恢复）：
//   - 启用 boundedRecovery.enabled 后，失败时优先尝试局部恢复
//   - 局部恢复范围超限时退回全局重跑（向后兼容）
//   - 未设置 boundedRecoveryConfig 时退回全局重跑行为（向后兼容）

import { logger } from '../utils/logger.js';
import type { ReActEvent } from './loop-config.js';
// Phase 55 Task 7：ReActRunParams 和 ReActAgentLoop（type-only，避免与 loop.ts 运行时循环依赖）
import type { ReActRunParams, ReActAgentLoop } from './loop.js';
import { LoopMemory } from './loop-memory.js';
import type {
  DualLoopParams,
  DualLoopEvent,
  InnerLoopResult,
  LoopFailure,
  OuterLoopEvaluation,
} from './dual-loop-types.js';
import type { VerificationResult } from './goal-types.js';
import type { GateResult } from './completion-gate.js';
import type { CodeReviewResult } from './unified-reviewer.js';
import type { TokenUsageInfo } from '../router/types.js';
// Phase 51 Task 1/7：Reviewer 分级与审查反馈协议
import {
  determineReviewerTier,
  assessRisk,
  getReviewPassesForTier,
  type ReviewerTier,
  type RiskAssessment,
  type StructuredReviewFeedback,
  validateReviewFeedback,
} from './reviewer-tier-evaluator.js';
// Phase 52 Task 3：有界局部恢复
import { BoundedRecoveryManager, type StepArtifact } from './bounded-recovery.js';
// Phase 51/52 配置类型（schema.ts 中已定义，由另一个 Agent 维护）
import type {
  ReviewerPolicyConfig,
  BoundedRecoveryConfig,
} from '../config/schema.js';
// Phase 52 消费方接入（I-2）：仅引入类型，避免运行时循环依赖
// 实际实例由 app-init.ts 创建并通过 setter 注入；run() 中的消费逻辑待 Phase 53 完整接入
import type { ArchitectureAwareMetricsCollector } from '../evaluation/architecture-aware-metrics.js';
import type { GodelProposer } from './self-evolution/godel-proposer.js';
import type { SelfHarnessLoop } from './self-evolution/self-harness-loop.js';
// Phase 55 Task 13：SelfEvolutionFramework（消费执行信号产出优化提案）
import { SelfEvolutionFramework } from './self-evolution/framework.js';
import type { EvolutionSignal } from './self-evolution/types.js';

/** 陷阱 #141：maxReruns 默认 2 而非 3，避免 Token 爆炸 */
export const DEFAULT_MAX_RERUNS = 2;

/**
 * 外循环上下文（Phase 51 Task 1）
 *
 * 用于 evaluateOuterLoop 的分级判定：
 *   - stepCount：当前任务的步骤数（用于 tiny / medium / big 分级）
 *   - affectsSecurity / affectsDataIntegrity / affectsFileSystem / crossModuleChange / hasExternalSideEffects：风险因子
 *
 * 未传入 context 时退回旧的 critical 过滤行为（向后兼容）
 */
export interface OuterLoopContext {
  stepCount?: number;
  affectsSecurity?: boolean;
  affectsDataIntegrity?: boolean;
  affectsFileSystem?: boolean;
  crossModuleChange?: boolean;
  hasExternalSideEffects?: boolean;
}

/**
 * 有界局部恢复事件（Phase 52 Task 3）
 *
 * 当 boundedRecoveryConfig.enabled=true 且成功计算局部恢复范围时触发。
 * 调用方可基于此事件展示恢复进度。
 *
 * 注：DualLoopEvent 是 union type 无法被 extends，故独立定义；
 *     run 方法的返回类型已扩展为 DualLoopEvent | BoundedRecoveryEvent。
 */
export interface BoundedRecoveryEvent {
  type: 'bounded-recovery-attempted';
  iteration: number;
  recoverySteps: string[];
}

/** 双循环输出事件（含 Phase 52 有界恢复事件） */
export type DualLoopEventWithRecovery = DualLoopEvent | BoundedRecoveryEvent;

/**
 * 双循环编排器
 *
 * 流程：
 *   1. 内循环：ReActAgentLoop.run() 执行任务
 *   2. 外循环：GoalVerifier.verify() + CompletionGate.verify() + 跨模型审查
 *   3. 外循环通过 → 完成
 *   4. 外循环不通过 → 把失败原因注入 LoopMemory → 打回内循环重跑
 *   5. 达到最大重跑次数 → 终止并报告
 *
 * 2.5 节约束：重跑时由 AI 基于记忆自修正，不依赖人工 patch
 *
 * 向后兼容：
 *   - 未调用 setReviewerPolicy 时退回旧的 critical 过滤行为
 *   - 未调用 setBoundedRecovery 时退回全局重跑行为
 */
export class DualLoopOrchestrator {
  // Phase 51 Task 1/7：Reviewer 分级策略（未设置时退回旧的 critical 过滤行为）
  private reviewerPolicy?: ReviewerPolicyConfig;
  // Phase 52 Task 3：有界恢复配置（未设置时退回全局重跑行为）
  private boundedRecoveryConfig?: BoundedRecoveryConfig;
  // Phase 52 Task 3：有界恢复管理器（仅在 boundedRecoveryConfig.enabled=true 时使用）
  private recoveryManager?: BoundedRecoveryManager;
  // Phase 52 消费方接入（I-2）：以下三个实例由 app-init.ts 创建并通过 setter 注入
  // 未注入时 run() 中的相关分支自动跳过（向后兼容）；完整消费逻辑待 Phase 53 接入
  private metricsCollector?: ArchitectureAwareMetricsCollector;
  private godelProposer?: GodelProposer;
  private selfHarnessLoop?: SelfHarnessLoop;
  // Phase 55 Task 13：SelfEvolution 框架（消费执行信号产出提案，未注入时跳过）
  private selfEvolutionFramework?: SelfEvolutionFramework;
  // Phase 55 Task 7：内循环 Agent（占位，Task 9 完整接入 inner/outer 循环逻辑）
  private innerAgent?: ReActAgentLoop;

  /**
   * 设置 Reviewer 分级策略（Phase 51 Task 1/7）
   * 未调用此方法时退回旧的 critical 过滤行为（向后兼容）
   */
  setReviewerPolicy(policy: ReviewerPolicyConfig): void {
    this.reviewerPolicy = policy;
    logger.debug('DualLoopOrchestrator: reviewer policy set', {
      tieredReviewEnabled: policy.tieredReviewEnabled,
      autoCrossModelForHighRisk: policy.autoCrossModelForHighRisk,
      enforceEvidenceProtocol: policy.enforceEvidenceProtocol,
    });
  }

  /**
   * 设置有界恢复配置（Phase 52 Task 3）
   * 未调用此方法时退回全局重跑行为（向后兼容）
   */
  setBoundedRecovery(config: BoundedRecoveryConfig): void {
    this.boundedRecoveryConfig = config;
    // 启用时延迟初始化恢复管理器（避免未启用时也产生实例开销）
    if (config.enabled && !this.recoveryManager) {
      this.recoveryManager = new BoundedRecoveryManager();
    }
    logger.debug('DualLoopOrchestrator: bounded recovery config set', {
      enabled: config.enabled,
      maxBacktrack: config.maxBacktrack,
      artifactBinding: config.artifactBinding,
    });
  }

  /**
   * 注册步骤工件（Phase 52 Task 3）
   *
   * 当 boundedRecoveryConfig.artifactBinding=true 时，调用方可通过此方法
   * 注册每步的工件，以便 computeRecoveryScope 追踪依赖闭包。
   *
   * 未启用 boundedRecovery 时此方法为空操作（向后兼容）
   */
  registerRecoveryArtifact(artifact: StepArtifact): void {
    if (this.boundedRecoveryConfig?.enabled && this.recoveryManager) {
      this.recoveryManager.registerArtifact(artifact);
    }
  }

  /**
   * 注入架构感知指标采集器（Phase 52 Task 6，I-2 消费方接入）
   *
   * 由 app-init.ts 在创建 ArchitectureAwareMetricsCollector 后调用。
   * 未注入时 run() 中的指标采集分支自动跳过（向后兼容）。
   *
   * 注：当前 run() 仅记录采集意图，完整的 extractFromTrajectory 调用待 Phase 53 接入
   *     （需要先构建 TrajectoryInput，涉及多组件事件聚合）。
   */
  setMetricsCollector(collector: ArchitectureAwareMetricsCollector): void {
    this.metricsCollector = collector;
    logger.debug('DualLoopOrchestrator: metrics collector injected', {
      sensitivity: collector.getAnomalySensitivity(),
    });
  }

  /**
   * 注入 Gödel 提案器（Phase 52 Task 8，I-2 消费方接入）
   *
   * 由 app-init.ts 在创建 GodelProposer 后调用。
   * 未注入时 run() 中的优化提案生成分支自动跳过（向后兼容）。
   *
   * 注：当前 run() 仅记录提案意图，完整的 proposeModifications 调用待 Phase 53 接入
   *     （需要先构建 ExecutionHistoryEntry[] / CurrentRuleEntry[]）。
   */
  setGodelProposer(proposer: GodelProposer): void {
    this.godelProposer = proposer;
    logger.debug('DualLoopOrchestrator: godel proposer injected');
  }

  /**
   * 注入 Self-Harness 循环（Phase 52 Task 9，I-2 消费方接入）
   *
   * 由 app-init.ts 在创建 SelfHarnessLoop 后调用。
   * 未注入时 run() 中的自安全套件分支自动跳过（向后兼容）。
   *
   * 注：当前 run() 仅记录弱点发现意图，完整的 discoverWeaknesses/proposeModifications
   *     调用待 Phase 53 接入（需要先构建 failureLogs / currentHarness 输入）。
   */
  setSelfHarnessLoop(loop: SelfHarnessLoop): void {
    this.selfHarnessLoop = loop;
    logger.debug('DualLoopOrchestrator: self-harness loop injected');
  }

  /**
   * 注入 SelfEvolution 框架（Phase 55 Task 13）
   *
   * 由 app-init.ts 在创建 SelfEvolutionFramework 后调用。
   * 未注入时 runDualLoop 末尾的提案生成分支自动跳过（向后兼容）。
   *
   * 注入后,runDualLoop 的三个退出点（成功/重复失败/maxReruns 耗尽）之前会:
   *   1. collectSignals() 拉取已注册源信号 + 递增 collectionCount
   *   2. 从 loopMemory 失败历史 + evaluation 结果构造 EvolutionSignal[]
   *   3. shouldTriggerOptimization 判定是否触发
   *   4. 触发时 selectOptimizationTarget + optimize 产出 OptimizationProposal（applied=false）
   */
  setSelfEvolutionFramework(framework: SelfEvolutionFramework): void {
    this.selfEvolutionFramework = framework;
    logger.debug('DualLoopOrchestrator: self-evolution framework injected');
  }

  /**
   * Phase 55 Task 13：触发 SelfEvolution 优化（若已注入且触发条件满足）
   *
   * 在 runDualLoop 的三个退出点之前调用：
   *   1. 成功完成（dual-loop-complete）
   *   2. 重复失败触发 Pilot 模式（pilot-mode-triggered）
   *   3. maxReruns 耗尽（dual-loop-exhausted）
   *
   * 信号构造：
   *   - loopMemory.getHistory() 的每条 LoopFailure → type='failure' 信号
   *   - evaluationResult（若传入且 !passed）→ type='quality_drop' 信号
   *
   * 向后兼容：未注入 selfEvolutionFramework 时直接 return（零开销）
   * 错误隔离：try/catch 降级,失败不阻塞主流程（仅 logger.warn）
   *
   * @param loopMemory 本次 runDualLoop 的循环记忆（含失败历史）
   * @param evaluationResult 最后一次外循环评估结果（可选,成功时为 null 或不传）
   */
  private triggerSelfEvolutionIfEnabled(
    loopMemory: { getHistory(): import('./dual-loop-types.js').LoopFailure[] },
    evaluationResult?: { passed: boolean; reason: string } | null,
  ): void {
    if (!this.selfEvolutionFramework) return;
    try {
      // 1. collectSignals 递增 collectionCount（用于 shouldTriggerOptimization 规则 3: evaluationInterval）
      //    即使无注册源,调用此方法也能让 collectionCount 递增,保证规则 3 正常工作
      const collectedSignals = this.selfEvolutionFramework.collectSignals();

      // 2. 从 loopMemory 失败历史构造 failure 信号
      const failures = loopMemory.getHistory();
      const failureSignals: EvolutionSignal[] = failures.map(f => ({
        source: 'loop_memory',
        type: 'failure',
        severity: 'medium',
        description: `[迭代${f.iteration}] ${f.reason}`,
        data: f,
        timestamp: Date.now(),
      }));

      // 3. evaluation 不通过时追加 quality_drop 信号
      const qualitySignals: EvolutionSignal[] = [];
      if (evaluationResult && !evaluationResult.passed) {
        qualitySignals.push({
          source: 'loop_memory',
          type: 'quality_drop',
          severity: 'high',
          description: evaluationResult.reason,
          data: evaluationResult,
          timestamp: Date.now(),
        });
      }

      const allSignals = [...collectedSignals, ...failureSignals, ...qualitySignals];
      if (allSignals.length === 0) {
        logger.debug('SelfEvolution: 无信号可分析,跳过优化判定');
        return;
      }

      // 4. 判定是否触发优化
      const trigger = this.selfEvolutionFramework.shouldTriggerOptimization(allSignals);
      if (!trigger.trigger) {
        logger.debug('SelfEvolution: 未触发优化', { reason: trigger.reason, signalCount: allSignals.length });
        return;
      }

      // 5. 选择优化目标 + 产出提案
      const target = this.selfEvolutionFramework.selectOptimizationTarget(allSignals);
      if (!target) {
        logger.debug('SelfEvolution: 无可用优化目标,跳过');
        return;
      }
      const proposal = this.selfEvolutionFramework.optimize(target, allSignals);
      logger.info('SelfEvolution: 提案已生成（待用户确认）', {
        proposalId: proposal.id,
        target,
        expectedImpact: proposal.expectedImpact,
        riskLevel: proposal.riskLevel,
        applied: proposal.applied,
        signalCount: allSignals.length,
      });
    } catch (error) {
      logger.warn('SelfEvolution 提案生成失败（非阻塞）', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Phase 55 Task 7：注入内循环 Agent
   * 注入后 run(ReActRunParams) 会把控制权转交给 innerAgent.run()
   * 传入 null 可显式卸载；未注入时 ReActRunParams 路径抛错（占位行为，Task 9 完整接入）
   */
  setInnerAgent(agent: ReActAgentLoop | null): void {
    this.innerAgent = agent ?? undefined;
    logger.debug('DualLoopOrchestrator: inner agent injected');
  }

  /**
   * Phase 55 Task 7：DualLoop 主入口（与 ReActAgentLoop.run 签名一致）
   *
   * 供 ReActAgentLoop.run 在 dualLoopOrchestrator 注入时转交控制权。
   * 当前为最小占位（直接转交 innerAgent），完整 inner/outer 循环逻辑在 Task 9 实现。
   */
  async *run(params: ReActRunParams): AsyncGenerator<ReActEvent> {
    // Phase 55 Task 7：最小占位——直接转交 innerAgent（ReActAgentLoop 实例）
    if (this.innerAgent) {
      yield* this.innerAgent.run(params);
      return;
    }
    // 无 innerAgent 时抛错（不应发生，Task 9 完整接入后通过 setter 注入）
    throw new Error('DualLoopOrchestrator.innerAgent 未注入');
  }

  /**
   * 运行完整双循环（Phase 49/51/52 生产实现）
   *
   * 原 run(DualLoopParams) 方法，Phase 55 Task 7 重命名为 runDualLoop 以腾出 run 签名
   * 供 ReActAgentLoop.run 转交控制权。完整 inner/outer 循环逻辑保留在此，
   * Task 9 会基于新架构重新整合到 run(ReActRunParams) 中。
   *
   * @param params 运行参数（含依赖注入的各组件）
   * @returns AsyncGenerator<DualLoopEvent | BoundedRecoveryEvent> 流式输出事件
   */
  async *runDualLoop(
    params: DualLoopParams,
  ): AsyncGenerator<DualLoopEvent | BoundedRecoveryEvent> {
    const { goal, reactLoop, reactParams } = params;
    const maxReruns = params.maxReruns ?? DEFAULT_MAX_RERUNS;

    // 初始化 LoopMemory
    const loopMemory = new LoopMemory(goal.projectPath);
    if (goal.plan.id) {
      await loopMemory.load(goal.plan.id);
      loopMemory.setGoalId(goal.plan.id);
    }

    // Phase 52 Task 3：维护本轮 run 的步骤 ID 列表（供 computeRecoveryScope 使用）
    // 注：每次 run 调用独立维护，避免跨 run 污染
    const stepIds: string[] = [];

    let rerunCount = 0;
    let totalUsage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let lastFailureReason = '';

    while (rerunCount <= maxReruns) {
      const iteration = rerunCount + 1;
      const stepId = `step-${iteration}`;
      stepIds.push(stepId);

      // 2.5 节约束 3：重跑前检测人工介入（仅在非首次迭代时检测）
      if (rerunCount > 0 && params.humanInterventionDetector) {
        const intervened = await params.humanInterventionDetector();
        if (intervened) {
          logger.warn('DualLoopOrchestrator: 人工介入检测到，停止自动重跑', { iteration });
          yield {
            type: 'human-intervention-detected',
            iteration,
            message: '检测到非内循环产出的人工修改，已停止自动重跑。请用户确认是否由 AI 接管继续。',
          };
          return;
        }
      }

      // 2.5 节约束 1：把 LoopMemory 中的历史失败原因注入 system prompt
      const memoryPrompt = loopMemory.buildPrompt();
      const innerParams = {
        ...reactParams,
        systemPrompt: (reactParams.systemPrompt ?? '') + memoryPrompt,
      };

      // ===== 内循环：执行任务 =====
      yield { type: 'inner-loop-start', iteration };

      let innerResult: InnerLoopResult = {
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        modifiedFiles: [],
      };
      const modifiedFilesSet = new Set<string>();
      // Phase 51 Task 1：收集工具调用名称，用于风险因子推断
      const toolCallNames: string[] = [];

      for await (const event of reactLoop.run(innerParams)) {
        yield { type: 'inner-loop-event', event, iteration };

        // 累计 token 使用量
        if (event.type === 'done') {
          innerResult = {
            content: event.content,
            usage: event.usage,
            modifiedFiles: Array.from(modifiedFilesSet),
          };
          totalUsage = this.mergeUsage(totalUsage, event.usage);
        }

        // 从工具调用中收集修改的文件（file-edit/file-write）+ 工具名（风险因子推断）
        if (event.type === 'tool_call_start' && event.args) {
          toolCallNames.push(event.toolName);
          const path = this.extractFilePath(event.toolName, event.args);
          if (path) modifiedFilesSet.add(path);
        }
      }

      yield { type: 'inner-loop-complete', iteration, result: innerResult };

      // ===== Phase 52 Task 6（I-2 消费方接入）：内循环完成后采集架构感知指标 =====
      // 向后兼容：未注入 metricsCollector 时跳过；完整 extractFromTrajectory 调用待 Phase 53
      // （需先聚合本轮 routerDecisions / toolCalls / dualLoopEvents 等为 TrajectoryInput）
      if (this.metricsCollector) {
        try {
          logger.info('DualLoopOrchestrator: 指标采集占位（待 Phase 53 接入 extractFromTrajectory）', {
            iteration,
            sensitivity: this.metricsCollector.getAnomalySensitivity(),
            toolCalls: toolCallNames.length,
            modifiedFiles: innerResult.modifiedFiles.length,
          });
        } catch (err) {
          logger.warn('DualLoopOrchestrator: 指标采集占位记录失败', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ===== 外循环：独立验证 =====
      yield { type: 'outer-loop-start', iteration };

      // 2.1 GoalVerifier：LLM 验证目标是否完成
      const verification: VerificationResult = await this.runGoalVerifier(params, goal);

      // 2.2 CompletionGate：工程化验证（typecheck/lint/tests）
      const gateResult: GateResult = await this.runCompletionGate(
        params,
        goal,
        innerResult.modifiedFiles,
      );

      // 2.3 跨模型审查（可选；打破自评盲区）
      let crossModelReview: CodeReviewResult | undefined;
      if (params.crossModelReviewer) {
        crossModelReview = await this.runCrossModelReview(params, innerResult, goal);
      }

      // ===== 判定 =====
      // Phase 51 Task 1：传入 context 用于分级判定
      //   stepCount 取 goal.plan.steps.length（任务实际步骤数，而非重跑轮次）
      //   风险因子从本轮工具调用记录中推断（CR-2 修复：原全部 ?? false 导致 autoCrossModelForHighRisk 永不触发）
      const riskContext: OuterLoopContext = {
        stepCount: goal.plan.steps.length,
        affectsSecurity: toolCallNames.some(n => ['shell_exec', 'bash', 'git_op', 'git-write'].includes(n)),
        affectsDataIntegrity: toolCallNames.some(n => ['file_write', 'file_edit', 'shell_exec', 'git_op'].includes(n)),
        affectsFileSystem: innerResult.modifiedFiles.length > 0,
        crossModuleChange: new Set(innerResult.modifiedFiles.map(f => f.split('/')[0])).size > 1,
        hasExternalSideEffects: toolCallNames.some(n => ['web_fetch', 'web_search', 'git_op', 'http_request', 'mcp_call'].includes(n)),
      };
      const evaluation = this.evaluateOuterLoop(
        verification,
        gateResult,
        crossModelReview,
        riskContext,
      );

      if (evaluation.passed) {
        logger.info('DualLoopOrchestrator: outer loop passed', { iteration });
        // Phase 55 Task 13：成功完成时也触发 SelfEvolution（收集成功模式信号 + 失败历史）
        this.triggerSelfEvolutionIfEnabled(loopMemory, evaluation);
        yield {
          type: 'dual-loop-complete',
          iteration,
          verification,
          gateResult,
          crossModelReview,
          totalUsage,
        };
        return;
      }

      // ===== Phase 52 Task 3：尝试有界局部恢复（在沉淀失败原因之前尝试） =====
      // 仅当 boundedRecovery.enabled=true 且 recoveryManager 已初始化时尝试
      if (this.boundedRecoveryConfig?.enabled && this.recoveryManager) {
        const recoveryScope = this.recoveryManager.computeRecoveryScope(
          stepId,
          this.boundedRecoveryConfig.maxBacktrack,
          stepIds,
        );
        // 局部恢复范围有效且未超限时，优先走局部恢复路径
        if (!recoveryScope.isGlobalRerun && recoveryScope.stepsToRerun.length > 0) {
          logger.info('DualLoopOrchestrator: 尝试有界局部恢复', {
            iteration,
            recoverySteps: recoveryScope.stepsToRerun.length,
          });
          // 触发恢复事件，便于调用方展示恢复进度
          yield {
            type: 'bounded-recovery-attempted',
            iteration,
            recoverySteps: recoveryScope.stepsToRerun,
          };
          yield {
            type: 'outer-loop-failed',
            iteration,
            reason: `${evaluation.reason}（尝试局部恢复 ${recoveryScope.stepsToRerun.length} 步）`,
            suggestion: `局部恢复范围：${recoveryScope.stepsToRerun.join(', ')}`,
            verification,
            gateResult,
            crossModelReview,
          };
          // artifactBinding=true 时清理失效的下游工件
          if (this.boundedRecoveryConfig.artifactBinding) {
            this.recoveryManager.invalidateDownstreamArtifacts(recoveryScope);
          }
          // 继续下一轮（局部恢复等价于重跑失败步骤）
          rerunCount++;
          continue;
        }
        // 恢复范围超限 → 全局重跑（落入下面的旧逻辑）
        logger.warn('DualLoopOrchestrator: 恢复范围超限，退回全局重跑', {
          iteration,
          reason: recoveryScope.reason,
        });
      }

      // ===== 不通过：沉淀失败原因到 LoopMemory，打回重跑 =====
      const failure: LoopFailure = {
        iteration,
        reason: evaluation.reason,
        missingItems: verification.missingItems,
        gateFailures: gateResult.checks.filter(c => !c.ok && !c.skipped),
        reviewIssues: crossModelReview?.issues ?? [],
      };
      loopMemory.recordFailure(failure);

      yield {
        type: 'outer-loop-failed',
        iteration,
        reason: evaluation.reason,
        suggestion: loopMemory.buildResuggestion(),
        verification,
        gateResult,
        crossModelReview,
      };

      // ===== Phase 52 Task 8/9（I-2 消费方接入）：外循环失败后生成优化提案 =====
      // 向后兼容：未注入实例时跳过；完整 proposeModifications / discoverWeaknesses 调用待 Phase 53
      // （需先构建 ExecutionHistoryEntry[] / CurrentRuleEntry[] / failureLogs / currentHarness 输入）
      if (this.godelProposer) {
        try {
          logger.info('DualLoopOrchestrator: Gödel 提案占位（待 Phase 53 接入 proposeModifications）', {
            iteration,
            reason: evaluation.reason,
          });
        } catch (err) {
          logger.warn('DualLoopOrchestrator: Gödel 提案占位记录失败', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (this.selfHarnessLoop) {
        try {
          logger.info('DualLoopOrchestrator: Self-Harness 占位（待 Phase 53 接入 discoverWeaknesses）', {
            iteration,
            reason: evaluation.reason,
          });
        } catch (err) {
          logger.warn('DualLoopOrchestrator: Self-Harness 占位记录失败', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 2.5 节约束 4：连续 maxReruns 次同一原因失败 → Pilot 模式
      if (lastFailureReason === evaluation.reason && rerunCount === maxReruns - 1) {
        logger.warn('DualLoopOrchestrator: 同一原因重复失败，触发 Pilot 模式', {
          iteration,
          repeatedReason: evaluation.reason,
        });
        // Phase 55 Task 13：Pilot 模式触发时收集失败信号
        this.triggerSelfEvolutionIfEnabled(loopMemory, evaluation);
        yield {
          type: 'pilot-mode-triggered',
          iteration,
          repeatedReason: evaluation.reason,
        };
        return;
      }
      lastFailureReason = evaluation.reason;

      rerunCount++;
    }

    // 达到最大重跑次数
    logger.warn('DualLoopOrchestrator: max reruns exhausted', { maxReruns });
    // Phase 55 Task 13：maxReruns 耗尽时收集失败信号（evaluation 可能未定义,传 null）
    this.triggerSelfEvolutionIfEnabled(loopMemory, null);
    yield {
      type: 'dual-loop-exhausted',
      maxReruns,
      finalMemory: loopMemory.getHistory(),
    };
  }

  /**
   * 评估外循环结果
   *
   * 知识库要求：仲裁规则
   *   - 默认以 CompletionGate 为准
   *   - 高严重度 reviewer 质疑（critical）可推翻 CompletionGate 的 pass
   *
   * 判定顺序：
   *   1. CompletionGate 失败 → 不通过
   *   2. GoalVerifier 失败 → 不通过
   *   3. 跨模型审查发现 critical 问题 → 推翻 pass，不通过
   *   4. 否则通过
   *
   * Phase 51 Task 1/7 扩展（向后兼容，未设置 reviewerPolicy 时退回旧逻辑）：
   *   - tiny 分级直接通过（跳过外循环，节省 token）
   *   - high-risk 分级且启用 autoCrossModelForHighRisk 但未做跨模型审查 → 不通过
   *   - enforceEvidenceProtocol=true 时校验 crossModelReview 的结构化反馈
   *
   * @param context 可选的分级上下文（Phase 51 Task 1）；未传入时退回旧逻辑
   */
  evaluateOuterLoop(
    verification: VerificationResult,
    gateResult: GateResult,
    crossModelReview?: CodeReviewResult,
    context?: OuterLoopContext,
  ): OuterLoopEvaluation {
    // ===== Phase 51 Task 1/7：分级前置判定（仅在启用且传入 context 时生效） =====
    if (this.reviewerPolicy?.tieredReviewEnabled && context) {
      const risk = assessRisk({
        affectsSecurity: context.affectsSecurity ?? false,
        affectsDataIntegrity: context.affectsDataIntegrity ?? false,
        affectsFileSystem: context.affectsFileSystem ?? false,
        stepCount: context.stepCount ?? 0,
        crossModuleChange: context.crossModuleChange ?? false,
        hasExternalSideEffects: context.hasExternalSideEffects ?? false,
      });
      const tier = determineReviewerTier(
        context.stepCount ?? 0,
        risk.isHighRisk,
        {
          tinyTaskStepThreshold: this.reviewerPolicy.tinyTaskStepThreshold,
          bigTaskStepThreshold: this.reviewerPolicy.bigTaskStepThreshold,
        },
      );
      const passes = getReviewPassesForTier(tier);

      // tiny 分级：跳过目标验证和跨模型审查，但保留 CompletionGate（工程验证是底线）
      // CR-3 修复：原逻辑直接返回 passed:true，即使 typecheck 失败也通过——外循环对 tiny 任务静默失效
      if (tier === 'tiny') {
        if (!gateResult.passed) {
          const failedChecks = gateResult.checks.filter(c => !c.ok && !c.skipped);
          return {
            passed: false,
            reason: `tiny 任务但工程验证未通过：${failedChecks.map(c => c.name).join(', ') || '存在未通过的检查项'}`,
          };
        }
        return {
          passed: true,
          reason: `tiny 任务（${context.stepCount ?? 0}步），跳过目标验证与跨模型审查`,
        };
      }

      // high-risk 且启用跨模型但未做跨模型审查 → 不通过
      if (
        passes.crossModel &&
        !crossModelReview &&
        this.reviewerPolicy.autoCrossModelForHighRisk
      ) {
        return {
          passed: false,
          reason: `high-risk 任务（风险分 ${risk.riskScore}）需要跨模型审查`,
        };
      }

      // Phase 51 Task 7：审查反馈三件证据协议校验
      // 仅在 enforceEvidenceProtocol=true 且 crossModelReview 携带 structuredFeedback 时执行
      // （CodeReviewResult 当前未声明 structuredFeedback 字段；此处做尽力校验，向后兼容）
      if (this.reviewerPolicy.enforceEvidenceProtocol && crossModelReview) {
        const structured = (
          crossModelReview as CodeReviewResult & { structuredFeedback?: StructuredReviewFeedback }
        ).structuredFeedback;
        if (structured) {
          const validation = validateReviewFeedback(structured, {
            enforceEvidenceProtocol: this.reviewerPolicy.enforceEvidenceProtocol,
          });
          if (!validation.valid) {
            return {
              passed: false,
              reason: `审查反馈不符合三件证据协议：${validation.errors.join('; ')}`,
            };
          }
        }
      }
    }

    // ===== 旧逻辑（保持不变，向后兼容） =====
    // 1. CompletionGate 优先
    if (!gateResult.passed) {
      const failedChecks = gateResult.checks.filter(c => !c.ok && !c.skipped);
      return {
        passed: false,
        reason: `工程验证未通过：${failedChecks.map(c => c.name).join(', ') || '存在未通过的检查项'}`,
      };
    }

    // 2. GoalVerifier 判定
    if (!verification.passed) {
      const missing = verification.missingItems.length > 0
        ? verification.missingItems.join(', ')
        : verification.reasoning || '未说明';
      return {
        passed: false,
        reason: `目标未完成：${missing}`,
      };
    }

    // 3. 跨模型审查：critical 级别问题可推翻 pass
    if (crossModelReview) {
      const criticalIssues = crossModelReview.issues.filter(i => i.severity === 'critical');
      if (criticalIssues.length > 0) {
        return {
          passed: false,
          reason: `跨模型审查发现 ${criticalIssues.length} 个 critical 问题`,
        };
      }
    }

    return { passed: true, reason: '全部验证通过' };
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /** 执行 GoalVerifier（隔离异常，失败返回保守的"未通过"结果） */
  private async runGoalVerifier(
    params: DualLoopParams,
    goal: DualLoopParams['goal'],
  ): Promise<VerificationResult> {
    try {
      return await params.goalVerifier.verify(
        goal.plan,
        params.verifierOptions,
        goal.gates,
      );
    } catch (error) {
      logger.error('DualLoopOrchestrator: GoalVerifier failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        passed: false,
        confidence: 0,
        reasoning: `GoalVerifier 执行出错: ${error instanceof Error ? error.message : String(error)}`,
        missingItems: ['GoalVerifier 执行异常'],
        suggestions: ['检查 GoalVerifier 配置'],
      };
    }
  }

  /** 执行 CompletionGate（隔离异常，失败返回"未通过"结果） */
  private async runCompletionGate(
    params: DualLoopParams,
    goal: DualLoopParams['goal'],
    modifiedFiles: string[],
  ): Promise<GateResult> {
    try {
      return await params.completionGate.verify({
        modifiedFiles,
        projectPath: goal.projectPath,
        planDescription: goal.description,
      });
    } catch (error) {
      logger.error('DualLoopOrchestrator: CompletionGate failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        passed: false,
        checks: [{
          name: 'completion-gate',
          ok: false,
          output: `CompletionGate 执行异常: ${error instanceof Error ? error.message : String(error)}`,
          duration: 0,
        }],
      };
    }
  }

  /** 执行跨模型审查（陷阱 #142：失败时由 CrossModelReviewer 内部回退，不抛错） */
  private async runCrossModelReview(
    params: DualLoopParams,
    innerResult: InnerLoopResult,
    goal: DualLoopParams['goal'],
  ): Promise<CodeReviewResult | undefined> {
    if (!params.crossModelReviewer) return undefined;
    try {
      return await params.crossModelReviewer.review({
        modifiedFiles: innerResult.modifiedFiles,
        executionSummary: innerResult.content,
        goalDescription: goal.description,
      });
    } catch (error) {
      logger.error('DualLoopOrchestrator: CrossModelReviewer failed (unexpected)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** 合并 Token 使用量 */
  private mergeUsage(a: TokenUsageInfo, b: TokenUsageInfo): TokenUsageInfo {
    return {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  /**
   * 从工具调用参数中提取文件路径
   * 用于在内循环执行过程中收集 modifiedFiles
   */
  private extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
    // 常见的文件编辑类工具
    const fileEditTools = ['file-edit', 'file_write', 'file-write', 'write_file', 'edit_file', 'file-edit-tool'];
    if (!fileEditTools.some(t => t === toolName || toolName.startsWith(t))) {
      return null;
    }
    // 尝试常见的参数名
    const candidates = ['file_path', 'filePath', 'path', 'file'];
    for (const key of candidates) {
      const v = args[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }
}

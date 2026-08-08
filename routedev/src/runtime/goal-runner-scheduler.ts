// src/runtime/goal-runner-scheduler.ts
// 目标运行器·步骤调度模块：执行循环、路径路由、单步执行
// 从原 goal-runner.ts 拆分，行为不变仅文件拆分
//
// 职责：
//   - executeGoalPlan：主执行入口——持久化、路径路由、升降级、验证、迭代闭环、收尾
//   - executeSingleStep：单步执行核心（classify → route → agentLoop.run → 返回内容）
//   - executePlanWithSingleAgent：单 Agent 串行执行路径
//   - executePlanWithDag：DAG 引擎执行路径（拓扑排序/分层并行/重试）
//   - executePlanWithCompose：CompositionalRouter 跨领域任务分解执行路径

import type { GoalRunnerCtx } from './goal-runner-types.js';
import type { GoalPlan, GoalPlanStatus, GoalStep, GoalEvent } from '../agent/goal-types.js';
import type { RoutingResult } from '../router/types.js';
import type { RoutingRecord } from '../router/routing-history.js';
// Phase 55：DagEngine 真实类型（替代 unknown 占位，适配 execute(workflow, executor) 签名）
import type { DagNode, DagWorkflow } from '../agent/workflow/dag-engine.js';
// Phase 55 Task 11：CompositionalRouter 底层类型（AtomicSubTask 用于 decomposeFn 签名）
import type { AtomicSubTask } from '../skills/compositional-router.js';
import type { HookContext, StepResult } from '../agent/hooks.js';
// Phase 54 Task 5：自主度行为映射（auto/semi/manual → 具体行为开关）
import { AUTONOMY_BEHAVIOR, type AutonomyMode } from '../config/schema.js';
// Phase 58：统一路径路由器（合并 execution-router + level-path-router）
import { PathRouter } from '../agent/path-router.js';
import { StateMigration } from '../agent/state-migration.js';
import { attestPlan, verifyPlanAttestation } from '../agent/plan-attestation.js';
import { logger } from '../utils/logger.js';
// GA Hardening 第4项：类型化取消语义（PlanAbortError 继承 CancellationError）
import { CancellationError } from '../errors/agent-errors.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { renderGoalProgressText, renderGoalCompletionSummary, formatDuration } from './components/goal-progress.js';
import { notifyRoutingFallback } from './notification.js';
import { toCompletionStatus, type GateResult } from '../agent/completion-gate.js';
import { MAX_CONTEXT_ITEMS } from './goal-runner-types.js';
import * as path from 'node:path';

/**
 * Phase 55 RISK 3 修复：compose 路径临时 GoalStep id 偏移量
 *
 * 问题：compose 路径用 `idx + 1`（从 1 递增）作为临时 GoalStep id，
 * 与原 plan.steps id（GoalParser 输出 1..N）命名空间重叠。
 * 影响：
 *   - GoalExecutionCard 按 stepId 匹配原 plan 步骤显示状态，id 重叠会导致 UI 混淆
 *   - blackboard.addCompletedStep(step.id, ...) 会覆盖原 plan 同 id 步骤的记录
 *
 * 修复：compose 路径临时 GoalStep id 用 `COMPOSE_STEP_ID_OFFSET + idx`，
 * 确保与原 plan.steps id（通常 1-20）不冲突。
 * UI 可通过 stepId >= COMPOSE_STEP_ID_OFFSET 识别 compose 子任务。
 */
const COMPOSE_STEP_ID_OFFSET = 10000;

/**
 * Phase 55：计划中止错误（预算耗尽/用户中断时抛出）
 * executeSingleStep 抛出后，调用方据此中止整个 plan（区别于普通步骤失败）
 * GA Hardening 第4项：继承 CancellationError——类型化取消语义（retryable=false）
 */
class PlanAbortError extends CancellationError {
  constructor(reason: string) {
    super(reason);
    this.name = 'PlanAbortError';
  }
}

/**
 * 创建调度模块函数
 *
 * Phase 83: parallel scheduling frozen —— 并行调度路径已冻结
 *   - Phase 58 已删除 executePlanWithMultiAgent（legacy 并行路径）与 executeWorkerStep
 *   - 当前仅保留 single / dag / compose 三条串行/拓扑执行路径
 *   - DagEngine 内部的"分层并行"是 DAG 引擎固有行为，非 goal 层面的并行调度
 *   - 冲突检测在 goal 路径中本就无调用点（conflictDetection 仅属于 ExperimentConfigSchema）
 *   - 冻结策略：不删代码，仅标注路径不可达；如需恢复，重新接线 executePlanWithMultiAgent
 *
 * @param ctx 共享上下文（由 createGoalRunner 创建并传入）
 * @returns { executeGoalPlan, executeSingleStep, executePlanWithSingleAgent, executePlanWithDag, executePlanWithCompose }
 */
export function createSchedulerFunctions(ctx: GoalRunnerCtx) {
  const {
    classifier, modelRouter, clientManager, tracker, agentLoop,
    checkpointManager, contextManager, config, systemPromptRef,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    currentPlanRef,
    addSystemMessage, setIsProcessing, profiler,
    completionGate,
    goalPersistence,
    blackboard,
    pathRouter, dagEngine, compositionalRouter,
    dualLoopOrchestratorRef,
    nextId,
    onGoalEvent,
    goalId: depsGoalId,
    onToolConfirmRequest,
    hookRunner,
    routingHistory, routingMemory, executionVerifier, routingRegretTracker, routingOrchestrator,
    provenanceGraph, kanObstacleChecker, quantitativeGate, classifyOperation,
  } = ctx.deps;
  const { emit, gid, gateManager, goalCfg, goalIntegration } = ctx;

  /** 执行目标计划：逐步骤运行 Agent Loop，支持中断 + 检查点 + 压缩 */
  async function executeGoalPlan(plan: GoalPlan): Promise<void> {
    setIsProcessing(true);
    if (!plan.attestation) {
      attestPlan(plan, 'execution_auto_repair');
    }
    if (!verifyPlanAttestation(plan)) {
      plan.status = 'failed';
      addSystemMessage('❌ 计划签名校验失败，已中止执行');
      return;
    }
    plan.status = 'executing';
    currentPlanRef.current = plan;

    // 持久化 GoalPlan
    await checkpointManager.saveGoalPlan(plan);

    // Phase 31/32 P0 接线：TokenTracker 任务级 API——启动任务级 Token 预算追踪
    // Phase 43：优先使用 config.goal.tokenBudget，未配置时回退到 perRequestLimit
    // Phase 54 修复：Electron 端（onGoalEvent 存在）原设为 Number.MAX_SAFE_INTEGER（无穷大），
    // 导致 40 分钟超长执行无任何约束。改为合理上限 1M token（约 30 万字上下文，足够长任务但有兜底）
    const goalCfg = config.goal;
    const ELECTRON_TASK_BUDGET = 1_000_000;  // Electron 端合理上限，避免无穷大
    const taskBudget = onGoalEvent
      ? (goalCfg?.tokenBudget ?? ELECTRON_TASK_BUDGET)
      : (goalCfg?.tokenBudget ?? config.router.budget.perRequestLimit ?? 100000);
    const softStopRatio = goalCfg?.softStopRatio ?? 0.9;
    tracker.startTask(taskBudget);
    addSystemMessage(`📊 任务级 Token 预算已启动: ${taskBudget.toLocaleString()}（软停止 ${(softStopRatio * 100).toFixed(0)}%）`);

    // Phase 50 Task 1：persistenceEnabled 时用 GoalPersistence 持久化到 .routedev/goals/<id>.json
    // 失败时 try/catch 降级（不阻塞执行）
    if (goalIntegration?.persistenceEnabled && goalPersistence) {
      try {
        await goalPersistence.save({
          id: plan.id,
          spec: {
            goal: plan.description,
            // F-023：currentGoalSpec 已移除（永远为 null），scope/doneWhen 改为空值
            scope: '',
            constraints: [],
            doneWhen: [],
            stopIf: [],
            tokenBudget: taskBudget,
          },
          plan: {
            steps: plan.steps.map(s => ({
              id: String(s.id),
              description: s.description,
              status: s.status,
              dependencies: s.dependencies.map(d => String(d)),
            })),
            attestation: plan.attestation,
            archivedVersions: plan.archivedVersions,
          },
          status: 'executing',
          checkpointIds: [],
          createdAt: plan.createdAt,
          updatedAt: Date.now(),
          tokenUsed: 0,
          tokenBudget: taskBudget,
        });
        addSystemMessage('💾 GoalPersistence 已持久化目标');
      } catch (error) {
        logger.warn('GoalPersistence.save failed (non-blocking)', { error: String(error) });
      }
    }

    // Phase 58：统一 PathRouter 替代 executionRouter + levelPathRouter 双重判定
    // 优先级：难度路由（difficultyRouting.enabled + plan.difficultyAssessment）> route() 启发式 > 默认 'single'
    const router = pathRouter ?? new PathRouter();
    const difficultyRoute = config.goal?.difficultyRouting?.enabled && plan.difficultyAssessment
      ? router.selectPath(plan.difficultyAssessment.level)
      : null;
    // F-012：goalAdvanced pack 未启用时强制 single，避免引入未装配的 dag/compose 路径
    // Phase 94 Task 2：优先从 deps.enabledPacks 读取（单点计算），fallback 到 config.packs（兼容）
    const goalAdvancedEnabled = ctx.deps.enabledPacks?.goalAdvanced ?? config.packs?.goalAdvanced?.enabled;
    const mode = goalAdvancedEnabled
      ? (config.goal?.executionRouter?.mode ?? 'single')
      : 'single';
    const route = difficultyRoute ? difficultyRoute.route : router.route(plan, {
      mode,
      explicitRoute: config.goal?.executionRouter?.explicitRoute,
      singleAgentMaxSteps: config.goal?.executionRouter?.singleAgentMaxSteps ?? 2,
      dagMaxDomains: config.goal?.executionRouter?.dagMaxDomains ?? 1,
    });
    if (difficultyRoute) {
      addSystemMessage(`🧭 难度路由: ${plan.difficultyAssessment!.level} → ${route}（${difficultyRoute.reason}）`);
    }

    // Phase 55 Task 5：动态升降级——执行后检测信号，升级则迁移状态并用新路径重跑剩余步骤
    // 限制最多 1 次升级重跑，避免无限循环
    let levelSwitchCount = 0;
    let currentRoute = route;
    while (true) {
      switch (currentRoute) {
        case 'single':
          await executePlanWithSingleAgent(plan);
          break;
        case 'dag':
          await executePlanWithDag(plan);
          break;
        case 'compose':
          await executePlanWithCompose(plan);
          break;
        default:
          // Phase 58：未识别路径回退到 single（原 'legacy' 路径已删除）
          await executePlanWithSingleAgent(plan);
          break;
      }

      // 检测升降级信号
      if (config.goal?.difficultyRouting?.dynamicLevelSwitchEnabled && plan.difficultyAssessment && levelSwitchCount < 1) {
        const suggestion = router.detectLevelSwitch(plan.difficultyAssessment.level, {
          failureCount: plan.steps.filter(step => step.status === 'failed').length,
          contextUsagePercent: tracker.getTaskUsagePercent(),
          crossDomain: (plan.uniqueDomains?.length ?? 0) > 1,
          unresolvedBlockers: plan.steps.filter(step => step.status === 'failed' && step.error).length,
        });
        if (suggestion) {
          const migration = new StateMigration().migrate({ plan, suggestion });
          // Phase 71：保存修订历史（before=迁移前 steps，after=迁移后 steps）
          await ctx.savePlanRevision(plan.steps, migration.plan.steps, 'dynamic_level_switch');
          plan.steps = migration.plan.steps;
          plan.difficultyAssessment = migration.plan.difficultyAssessment;
          // 还有 pending 步骤才需要重跑
          const hasPending = plan.steps.some(step => step.status === 'pending' || step.status === 'failed');
          if (hasPending) {
            currentRoute = router.selectPath(suggestion.to).route;
            levelSwitchCount++;
            addSystemMessage(`🔁 动态升降级: ${migration.migrationSummary}，切换到 ${currentRoute} 路径重跑剩余步骤`);
            continue;
          }
        }
      }
      break;
    }

    // 验证目标完成度
    // Phase 43：根据 config.goal.auditMode 控制验证与代码验证门的顺序/开关
    plan.completedAt = Date.now();
    const hasFailedSteps = plan.steps.some(step => step.status === 'failed');
    if (hasFailedSteps) {
      plan.status = 'failed';
      addSystemMessage('❌ 存在失败步骤，目标标记为失败');
    }
    const auditMode = goalCfg?.auditMode ?? 'completion_gate_first';
    let gateResult: GateResult | undefined;
    if ((plan.status as GoalPlanStatus) === 'failed') {
      addSystemMessage('⏭ 已跳过目标验证（存在失败步骤）');
    } else if (auditMode === 'none') {
      plan.status = 'completed';
      addSystemMessage('⏭ 已跳过目标验证（auditMode=none）');
    } else {
      // GA Hardening 第3项：验证门阶段安装独立 AbortController——步骤结束后
      // abortControllerRef.current 已被清空，stopGeneration 必须仍能取消验证门
      // （spawn 的 typecheck/lint/tests 进程树）。完成后恢复原 ref。
      const prevAbortController = abortControllerRef.current;
      const gateAbort = new AbortController();
      abortControllerRef.current = gateAbort;
      try {
        if (auditMode === 'completion_gate_first') {
          gateResult = await ctx.runCompletionGate(plan, gateAbort.signal);
          await ctx.verifyPlan(plan);
        } else if (auditMode === 'reviewer_first') {
          await ctx.verifyPlan(plan);
          gateResult = await ctx.runCompletionGate(plan, gateAbort.signal);
        } else {
          // 'full' 或默认值：两者都执行，先 LLM 验证后代码验证门
          await ctx.verifyPlan(plan);
          gateResult = await ctx.runCompletionGate(plan, gateAbort.signal);
        }
      } finally {
        abortControllerRef.current = prevAbortController;
      }
      // 用户中断验证门：与步骤中断一致的 PlanAbortError 语义（调用方据此中止整个 plan）
      if (gateAbort.signal.aborted) {
        throw new PlanAbortError('用户中断（验证门阶段）');
      }
    }

    // Phase 55 Task 9：用 DualLoop + BoundedRecovery 替代迭代闭环
    // 旧迭代闭环代码保留为 P2 降级 fallback（见设计文档第 7 节）
    const dualLoopOrchestrator = dualLoopOrchestratorRef?.current ?? null;
    // 注意：runCompletionGate / verifyPlan 可能将 plan.status 置为 'failed'，
    // 但 TS 无法透过函数调用感知突变，故显式断言回声明类型 GoalPlanStatus。
    if ((plan.status as GoalPlanStatus) === 'failed' && config.phase49Integration?.dualLoopEnabled && dualLoopOrchestrator) {
      try {
        // 调用 DualLoopOrchestrator.runDualLoop（完整 inner/outer 循环）
        // 注意：不是调用 run 占位方法，而是调用包含完整双循环逻辑的 runDualLoop
        // BoundedRecovery 已在 orchestrator 内部启用（app-init.ts 通过 setBoundedRecovery 注入配置）
        const dualLoopSuccess = await ctx.runDualLoopPlan(plan, dualLoopOrchestrator);
        plan.status = dualLoopSuccess ? 'completed' : 'failed';
      } catch (error) {
        logger.warn('DualLoop 异常，降级到基础迭代闭环', { error: String(error) });
        addSystemMessage('⚠️ 高级恢复异常，降级到基础重跑');
        // 走旧迭代闭环 fallback
        await ctx.legacyIterativeLoop(plan);
      }
    } else {
      // DualLoop 未启用或 orchestrator 未注入，走旧迭代闭环
      await ctx.legacyIterativeLoop(plan);
    }

    // Phase 31/32 P0 接线：TokenTracker 任务级 API——任务结束，清理任务级预算状态
    // 移到迭代闭环之后，确保补救步骤也纳入任务级预算追踪
    tracker.endTask();

    // 任务完成摘要（成功或失败均展示，便于用户复盘）
    addSystemMessage(renderGoalCompletionSummary(plan));

    // Phase 54：发出 done 事件——驱动 GoalExecutionCard 折叠为完成态单行摘要
    // success 以 plan.status 为准（audit 后处理可能将 completed 改为 failed）
    // totalDurationMs 用 plan.completedAt - plan.createdAt（与 renderGoalCompletionSummary 一致）
    const totalDurationMs = plan.completedAt !== undefined && plan.createdAt !== undefined
      ? plan.completedAt - plan.createdAt
      : 0;
    const completedCount = plan.steps.filter(s => s.status === 'completed').length;
    const verifyText = plan.verificationResult
      ? ` · 验证${plan.verificationResult.passed ? '通过' : '未通过'}`
      : '';
    emit({
      type: 'done',
      goalId: gid,
      success: plan.status === 'completed',
      totalDurationMs,
      summary: `${completedCount}/${plan.steps.length} 步骤完成${verifyText} · ${formatDuration(totalDurationMs)}`,
      completionStatus: toCompletionStatus(gateResult, plan.status === 'completed'),
    });

    currentPlanRef.current = null;
    setIsProcessing(false);

    // Phase 30 P1-1：goal 路径补 profiler.persistSession——与 chat-runner 路径对齐
    // 原缺陷：executeGoalPlan 末尾未调用 persistSession，长任务（数十分钟）的 token profile 仅在内存中，
    // 应用崩溃或用户关闭后丢失。此处 fail-open，不阻塞主流程
    if (profiler && config.optimization?.tokenTracking?.persistSession) {
      try {
        const outputDir = config.optimization.tokenTracking.outputDir;
        const fullDir = path.isAbsolute(outputDir) ? outputDir : path.join(process.cwd(), outputDir);
        await profiler.persistSession(fullDir, `goal-${plan.id}-${Date.now()}`);
      } catch (err) {
        logger.warn('GoalRunner: profiler.persistSession failed (non-blocking)', { error: String(err) });
      }
    }

    // Phase 53 P5：on-complete 钩子——覆盖 single/dag/compose/legacy 全部执行路径
    // 触发一次，传入最终 plan.status 与步骤统计。返回值仅 message 字段有效，fail-open
    if (hookRunner) {
      try {
        const completedSteps = plan.steps.filter(s => s.status === 'completed').length;
        const completeCtx: HookContext = {
          stepId: 'plan-complete',
          agentId: 'goal',
          projectPath: process.cwd(),
          stepResult: {
            success: plan.status === 'completed',
            output: `${completedSteps}/${plan.steps.length} 步骤完成`,
            durationMs: plan.completedAt !== undefined && plan.createdAt !== undefined
              ? plan.completedAt - plan.createdAt
              : 0,
          },
        };
        await hookRunner.fire('on-complete', completeCtx);
      } catch (err) {
        logger.warn('GoalRunner: on-complete hook failed (fail-open)', { error: String(err) });
      }
    }
  }

  /**
   * Phase 55：单步执行核心逻辑（classify → route → agentLoop.run → 返回内容）
   * 从 executePlanWithSingleAgent 提取，供 single 和 dag 路径复用，避免代码重复。
   * 不管理 step.status/gate/emit/checkpoint——这些由调用方负责。
   * 预算耗尽或用户中断时抛 PlanAbortError，调用方据此中止整个 plan。
   * Phase 53 P5：注入 hookRunner 后，pre-step（abort/skip）+ post-step（abort/modifiedResult）触发
   * @param step 待执行的步骤
   * @returns 步骤执行内容（assistant 回复全文）
   */
  async function executeSingleStep(step: GoalStep): Promise<string> {
    if (hookRunner) {
      try {
        const preCtx: HookContext = {
          stepId: String(step.id),
          agentId: 'goal',
          projectPath: process.cwd(),
        };
        const preResult = await hookRunner.fire('pre-step', preCtx);
        if (preResult.action === 'abort') {
          throw new PlanAbortError(preResult.message ?? 'pre-step 钩子中止');
        }
        if (preResult.action === 'skip') {
          return '[skipped by pre-step hook]';
        }
      } catch (err) {
        if (err instanceof PlanAbortError) throw err;
        logger.warn('GoalRunner: pre-step hook failed (fail-open)', { error: String(err) });
      }
    }

    const softStopRatio = goalCfg?.softStopRatio ?? 0.9;
    const classifyResult = await classifier.classify({ query: step.description });

    // TD-26：HybridRetriever 已退役，记忆检索由 Core KG recallV2 覆盖
    let relevantMemories: string | null = null;

    let operationClassification: import('../skills/operation-classifier.js').OperationClassification | null = null;
    if (classifyOperation) {
      try {
        operationClassification = classifyOperation({}, gid);
        logger.info('Phase 68: 操作分类', { kind: operationClassification.kind });
      } catch (err) {
        logger.warn('Phase 68: classifyOperation 失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (kanObstacleChecker) {
      try {
        const obstacleResult = kanObstacleChecker.check([]);
        if (obstacleResult.hasObstacle) {
          addSystemMessage(`⚠️ Kan 障碍: ${obstacleResult.warning}`);
        }
      } catch (err) {
        logger.warn('Phase 68: KanObstacleChecker.check 失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 61 接线：当 RoutingOrchestrator 可用时，用它的 route() 方法做综合路由决策
    // RoutingOrchestrator 内部整合 baseRouter + memory(kNN 检索) + history(先验)，做加权投票
    let routeDecision: RoutingResult;
    if (routingOrchestrator?.isEnabled()) {
      try {
        routeDecision = await routingOrchestrator.route(step.description, classifyResult);
      } catch (err) {
        logger.warn('Phase 61: RoutingOrchestrator.route 失败，回退到基础路由', {
          error: err instanceof Error ? err.message : String(err),
        });
        routeDecision = await modelRouter.route(classifyResult);
      }
    } else {
      routeDecision = await modelRouter.route(classifyResult);
    }
    const stepFallbackNotice = notifyRoutingFallback(routeDecision);
    if (stepFallbackNotice) addSystemMessage(stepFallbackNotice);
    const client = clientManager.get(routeDecision.providerId);
    if (!client || !client.isReady()) {
      throw new Error(`提供商 ${routeDecision.providerId} 不可用`);
    }

    let stepContent = '';
    // Phase 61 接线：记录步骤执行起始时间，供 ExecutionVerifier 计算 latency 信号
    const stepStartMs = Date.now();
    // V2-022 修复：覆盖 abortControllerRef.current 前先 abort 旧的 controller，
    // 确保正在运行的 task 收到取消信号（用户停止生成 / 新步骤覆盖旧步骤时预期行为）
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const stepAbort = new AbortController();
    abortControllerRef.current = stepAbort;
    for await (const event of agentLoop.run({
      userMessage: step.description,
      llmClient: client,
      routeDecision,
      conversationHistory: conversationHistoryRef.current,
      systemPrompt: systemPromptRef.current,
      signal: stepAbort.signal,
      // 传递当前自主度模式给权限中间件
      autonomyMode: (config.autonomy?.defaultMode ?? 'manual') as 'manual' | 'semi' | 'auto',
      onModelSuccess: modelId => modelRouter.recordModelSuccess(modelId),
      onModelFailure: modelId => modelRouter.recordModelFailure(modelId),
      onConfirmTool: async (toolName, args) => {
        // Phase 54 修复：自主度模式判定——auto/semi 直接批准
        const mode = (config.autonomy?.defaultMode ?? 'manual') as AutonomyMode;
        if (!AUTONOMY_BEHAVIOR[mode].requireToolConfirmation && toolName !== 'ask_user') {
          return true;
        }
        return new Promise<boolean>(resolve => {
          pendingConfirmRef.current = {
            resolve: (r) => resolve(typeof r === 'boolean' ? r : r.approved),
            toolName,
          };
          const argsStr = JSON.stringify(args, null, 2).slice(0, MAX_CONTEXT_ITEMS);
          addSystemMessage(`⚠️  目标步骤 · 工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`);
          // Phase 54 修复 (Grok F-001)：Electron 端触发渲染层 ToolConfirmDialog，CLI 端依赖 addSystemMessage
          if (onToolConfirmRequest) onToolConfirmRequest(toolName, args);
        });
      },
    })) {
      if (event.type === 'text_delta') stepContent += event.text;
      if (event.type === 'done') {
        tracker.record(event.usage, {
          modelId: routeDecision.model.id,
          agentId: 'goal',
          stepId: `step-${step.id}`,
        });
        // Phase 31/32 P0 接线：任务级 Token 预算追踪
        // record() 同时累加日预算和 taskSpent，recordTaskUsage() 只查询状态（不累加，避免双计数）
        const taskStatus = tracker.recordTaskUsage();
        const taskUsagePercent = tracker.getTaskUsagePercent();
        if (taskStatus === 'exceeded' || taskUsagePercent >= 1) {
          addSystemMessage('⏹ 任务级 Token 预算已耗尽，goal 执行中止');
          throw new PlanAbortError('任务级 Token 预算耗尽');
        }
        // Phase 43：使用 config.goal.softStopRatio 作为软停止阈值（默认 0.9）
        if (taskUsagePercent >= softStopRatio) {
          addSystemMessage(`⚠️ 任务级 Token 预算接近上限 (${(taskUsagePercent * 100).toFixed(0)}%，软停止阈值 ${(softStopRatio * 100).toFixed(0)}%)`);
        }
        // F-022：setTodayTokensUsed 调用已移除（goal-bridge.ts 从未传入此字段，原为死代码）
        // 预算检查：超限时中止后续步骤，避免长时间运行的 goal 无限消耗 token
        // checkBudget 返回 false 表示已超限（enforce 模式下）
        if (!tracker.checkBudget()) {
          addSystemMessage('⏹ Token 日预算已耗尽，goal 执行中止');
          throw new PlanAbortError('Token 预算耗尽');
        }
      }
      // Phase 30：token_profile 事件由 profiler 内部记录，无需额外处理
    }

    if (routingHistory) {
      const record: RoutingRecord = {
        taskSignature: step.description.slice(0, MAX_CONTEXT_ITEMS),
        modelId: routeDecision.model.id,
        timestamp: Date.now(),
        userOverride: !!ctx.deps.modelRouter.getManualOverride(),
      };
      if (routingMemory?.isEnabled()) {
        try {
          const { HashEmbedder } = await import('../router/embedder.js');
          const embedder = new HashEmbedder();
          record.taskEmbedding = await embedder.embed(record.taskSignature);
        } catch (error) {
          logger.warn('[goal-runner] HashEmbedder 失败（fail-open）', { stepId: step.id, error });
        }
      }
      // Phase 61 接线：当 ExecutionVerifier 可用时，验证执行结果并填充 qualityScore
      // ExecutionVerifier 通过沙盒原生多路信号（compile/typecheck/test/latency）聚合打分
      if (executionVerifier?.isEnabled()) {
        try {
          const executionMs = Date.now() - stepStartMs;
          const verification = await executionVerifier.verify({
            modifiedFiles: [],
            projectPath: process.cwd(),
            executionMs,
          });
          record.qualityScore = verification.qualityScore;
          record.verificationTrace = verification.trace;
        } catch (err) {
          logger.warn('Phase 61: ExecutionVerifier.verify 失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      routingHistory.append(record);

      // Phase 61 接线：当 RoutingRegretTracker 可用时，记录累积遗憾指标
      // RoutingRegretTracker 基于 history 中所有 record 计算 oracle 近似与累积遗憾
      if (routingRegretTracker) {
        try {
          const regretResult = routingRegretTracker.computeCumulativeRegret();
          if (regretResult.regret > 0) {
            logger.info('Phase 61: RoutingRegretTracker 累积遗憾指标', {
              regret: regretResult.regret,
              records: routingHistory.getRecordCount(),
              perModelRegret: Object.fromEntries(regretResult.perModelRegret),
            });
          }
        } catch (err) {
          logger.warn('Phase 61: RoutingRegretTracker.computeCumulativeRegret 失败（fail-open）', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 用户中断：抛 PlanAbortError，调用方据此中止整个 plan
    if (stepAbort.signal.aborted) {
      throw new PlanAbortError('用户中断');
    }

    // 支持 abort（中止整个 plan）和 modifiedResult（替换步骤输出）
    // retry 不支持（需重写主体为独立函数，留作未来扩展）；fail-open 不阻塞主流程
    if (hookRunner) {
      try {
        const stepResult: StepResult = {
          success: true,
          output: stepContent,
          durationMs: 0, // 精确耗时由 trace 记录，此处仅满足类型
        };
        const postCtx: HookContext = {
          stepId: String(step.id),
          agentId: 'goal',
          projectPath: process.cwd(),
          stepResult,
        };
        const postResult = await hookRunner.fire('post-step', postCtx);
        if (postResult.action === 'abort') {
          throw new PlanAbortError(postResult.message ?? 'post-step 钩子中止');
        }
        if (postResult.modifiedResult?.output) {
          stepContent = postResult.modifiedResult.output;
        }
      } catch (err) {
        if (err instanceof PlanAbortError) throw err;
        logger.warn('GoalRunner: post-step hook failed (fail-open)', { error: String(err) });
      }
    }

    // TD-26：MemoryStore/LocalMaintenance 已退役，步骤结果由 Core KG checkpoint 覆盖

    if (provenanceGraph) {
      try {
        const { randomUUID } = await import('node:crypto');
        provenanceGraph.addArtifact({
          id: randomUUID(),
          artifactType: 'decision',
          producingOperation: operationClassification?.kind ?? 'retrieval',
          parentIds: [],
          content: stepContent.slice(0, 1000),
          relatedFiles: [],
          timestamp: Date.now(),
          sessionId: gid,
          operationKind: operationClassification?.kind,
        });
        logger.info('Phase 68: 决策制品已记录到 ProvenanceGraph');
      } catch (err) {
        logger.warn('Phase 68: ProvenanceGraph.addArtifact 失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (quantitativeGate) {
      try {
        const gateEval = quantitativeGate.evaluate({
          id: String(step.id),
          description: step.description,
          artifact: stepContent.slice(0, 500),
        });
        if (gateEval.decision === 'reject') {
          logger.warn('Phase 68: QuantitativeGate 评估为 reject', {
            compositeScore: gateEval.compositeScore,
            rationale: gateEval.rationale,
          });
        }
      } catch (err) {
        logger.warn('Phase 68: QuantitativeGate.evaluate 失败（fail-open）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 步骤正常完成，清理 abortControllerRef：仅当仍指向当前 stepAbort 时置 null，
    // 避免持有已完成 controller 的引用、误判"仍有进行中步骤"。
    // 注意：抛 PlanAbortError 路径（预算耗尽/用户中断）不清理——
    // 用户中断时 stepAbort.signal.aborted=true，line 645 据此让后续步骤正确跳过。
    if (abortControllerRef.current === stepAbort) {
      abortControllerRef.current = null;
    }

    return stepContent;
  }

  /**
   * 从 executeGoalPlan 提取的 for 循环逻辑：逐步骤运行 Agent Loop + 检查点 + 上下文压缩
   * 闭包变量（gid/emit/gateManager/tracker 等）直接复用，softStopRatio 在 executeSingleStep 内读取
   * Phase 55：单步执行逻辑已提取为 executeSingleStep，本函数负责步骤生命周期管理（status/gate/emit/checkpoint）
   * @param plan 目标计划
   */
  async function executePlanWithSingleAgent(plan: GoalPlan): Promise<void> {
    for (const step of plan.steps) {
      // 检查中断
      if (abortControllerRef.current?.signal.aborted) {
        addSystemMessage(`⏸ 目标已暂停。已完成 ${plan.steps.indexOf(step)}/${plan.steps.length} 个步骤。`);
        plan.status = 'failed';
        break;
      }

      // 步骤执行前自动创建检查点
      if (config.checkpoint.enabled) {
        const checkpoint = await checkpointManager.create({
          description: `步骤 ${step.id} 前快照: ${step.description.slice(0, 40)}`,
          stepId: step.id,
          goalId: plan.id,
          isAutoCreated: true,
        });
        if (checkpoint) {
          addSystemMessage(`💾 检查点已创建: cp-${checkpoint.id} (${checkpoint.filesSnapshot.length} 个文件)`);
        }
      }

      step.status = 'in_progress';
      step.startedAt = Date.now();
      addSystemMessage(`▶ 步骤 ${step.id}/${plan.steps.length}: ${step.description}`);
      emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'running' });

      try {
        // Phase 55：单步执行委托给 executeSingleStep（与 DAG 路径复用同一实现）
        const stepContent = await executeSingleStep(step);
        step.status = 'completed';
        step.completedAt = Date.now();
        step.result = stepContent.slice(0, MAX_CONTEXT_ITEMS);
        addSystemMessage(renderGoalProgressText(plan));
        conversationHistoryRef.current.push({ role: 'user', content: step.description });
        conversationHistoryRef.current.push({ role: 'assistant', content: stepContent });
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
        }

        gateManager.updateGate(`step-${step.id}`, 'passed', step.result);

        // 步骤间 checkpoint + 压缩
        if (config.checkpoint.enabled) {
          const usagePercent = tracker.getUsagePercent();
          const triggers = config.checkpoint.triggers.map(t => ({
            level: t.level,
            action: t.action as 'initial' | 'incremental' | 'compress',
          }));

          const triggerAction = contextManager.shouldTriggerCheckpoint(usagePercent, triggers);
          if (triggerAction) {
            await contextManager.triggerCheckpoint(triggerAction, conversationHistoryRef.current, usagePercent);
            await contextManager.saveCheckpoint();
            addSystemMessage(`🧠 步骤间记忆已保存 (${triggerAction})`);
          }

          const estimatedTokens = conversationHistoryRef.current.reduce((acc, msg) => {
            const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            return acc + estimateTokens(t);
          }, 0);

          // Phase 21 Task 5：使用 compressEnhanced 替代 compress（两轮压缩 + offload）
          if (contextManager.shouldCompress(conversationHistoryRef.current.length, estimatedTokens)) {
            const { compressed } = await contextManager.compressEnhanced(
              conversationHistoryRef.current,
              {
                offloadDir: path.join(process.cwd(), '.routedev', 'offloaded'),
              },
            );
            conversationHistoryRef.current = compressed;
            addSystemMessage('📦 上下文已压缩（步骤间）');
          }
        }
        addSystemMessage(`✅ 步骤 ${step.id} 完成`);
        emit({
          type: 'step_update',
          goalId: gid,
          stepId: step.id,
          status: 'completed',
          durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
        });
      } catch (error) {
        step.status = 'failed';
        step.completedAt = Date.now();
        step.error = error instanceof Error ? error.message : String(error);
        gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
        addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
        addSystemMessage(renderGoalProgressText(plan));
        emit({
          type: 'step_update',
          goalId: gid,
          stepId: step.id,
          status: 'failed',
          error: step.error,
          durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
        });
        // Phase 55：预算耗尽/用户中断（PlanAbortError）→ 中止整个 plan
        if (error instanceof PlanAbortError) {
          plan.status = 'failed';
          break;
        }
      }
    }
  }

  /**
   * DagEngine 未注入时降级到单 Agent 串行。
   * Phase 55：已适配真实 DagEngine API——execute(workflow, executor)。
   *   - GoalPlan → DagWorkflow 转换：step.id(number) → node.id(`step-${id}`)，
   *     dependencies(number[]) → dependsOn(string[])，description → action
   *   - executor 回调复用 executeSingleStep 执行单步，DagEngine 负责拓扑排序/分层并行/重试
   * @param plan 目标计划
   */
  async function executePlanWithDag(plan: GoalPlan): Promise<void> {
    if (!dagEngine) {
      logger.warn('DagEngine 未注入，降级到单 Agent 串行');
      addSystemMessage('⚠️ DAG 引擎未启用，降级到串行执行');
      return executePlanWithSingleAgent(plan);
    }
    try {
      // step.id(number) → node.id(`step-${id}`)；dependencies(number[]) → dependsOn(`step-${depId}`[])
      // action 用 step.description（无模板变量，resolvedAction 与 description 等价）
      const workflow: DagWorkflow = {
        nodes: plan.steps.map(step => ({
          id: `step-${step.id}`,
          dependsOn: step.dependencies.map(depId => `step-${depId}`),
          action: step.description,
        })),
        variables: {},
      };

      // Phase 55：node.id → GoalStep 反查映射，executor 回调内按 node.id 找回原 step
      const stepMap = new Map(plan.steps.map(s => [`step-${s.id}`, s]));

      // Phase 55：executor 回调——复用 executeSingleStep 执行单步，结果写 blackboard + emit
      // DagEngine 负责拓扑排序/分层并行/失败重试，executor 只关心单步执行与状态更新
      const executor = async (node: DagNode, _resolvedAction: string): Promise<unknown> => {
        const step = stepMap.get(node.id);
        if (!step) throw new Error(`未找到节点 ${node.id} 对应的 GoalStep`);
        step.status = 'in_progress';
        step.startedAt = Date.now();
        addSystemMessage(`▶ 步骤 ${step.id}/${plan.steps.length}: ${step.description}`);
        emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'running' });
        try {
          const result = await executeSingleStep(step);
          step.status = 'completed';
          step.completedAt = Date.now();
          step.result = result.slice(0, MAX_CONTEXT_ITEMS);
          conversationHistoryRef.current.push({ role: 'user', content: step.description });
          conversationHistoryRef.current.push({ role: 'assistant', content: result });
          if (conversationHistoryRef.current.length > 20) {
            conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
          }
          gateManager.updateGate(`step-${step.id}`, 'passed', step.result);
          blackboard?.addCompletedStep(step.id, 'coder', result ?? '');
          emit({
            type: 'step_update',
            goalId: gid,
            stepId: step.id,
            status: 'completed',
            durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
          });
          addSystemMessage(`✅ 步骤 ${step.id} 完成`);
          return result;
        } catch (error) {
          step.status = 'failed';
          step.completedAt = Date.now();
          step.error = error instanceof Error ? error.message : String(error);
          gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
          emit({
            type: 'step_update',
            goalId: gid,
            stepId: step.id,
            status: 'failed',
            error: step.error,
            durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
          });
          addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
          // 重新抛出：DagEngine 记录到 failedNodes 并按 retryLimit 决定是否重试
          throw error;
        }
      };

      const dagResult = await dagEngine.execute(workflow, executor);

      // Phase 55：部分节点失败（重试耗尽）时记录日志 + emit，不降级——成功节点结果已写入 blackboard
      if (dagResult.failedNodes.length > 0) {
        logger.warn('DAG 执行部分节点失败', { failedNodes: dagResult.failedNodes });
        for (const nodeId of dagResult.failedNodes) {
          const stepId = parseInt(nodeId.replace('step-', ''), 10);
          emit({ type: 'step_update', goalId: gid, stepId, status: 'failed' });
        }
      }
    } catch (error) {
      logger.warn('DAG 引擎异常，降级到单 Agent 串行', { error: String(error) });
      addSystemMessage('⚠️ DAG 引擎异常，降级到串行执行');
      return executePlanWithSingleAgent(plan);
    }
  }

  /**
   * 跨领域任务（uniqueDomains > dagMaxDomains）走此路径：
   *   1. 用 LLM 把 plan 拆成原子子任务（SAD 迭代技能感知分解）
   *   2. 检索 Skill 并组合为 DAG（当前 Skill 检索未启用，按纯依赖 DAG 执行）
   *   3. 转换为 DagWorkflow，交由 dagEngine.execute() 执行
   * 异常时降级到 executePlanWithDag（用原始 plan）
   * @param plan 目标计划
   */
  async function executePlanWithCompose(plan: GoalPlan): Promise<void> {
    // 前置检查：compositionalRouter 或 dagEngine 未注入时降级到 DAG
    if (!compositionalRouter || !dagEngine) {
      logger.warn('CompositionalRouter 或 DagEngine 未注入，降级到 DAG');
      addSystemMessage('⚠️ 组合路由未启用，降级到 DAG 执行');
      return executePlanWithDag(plan);
    }
    try {
      addSystemMessage('🧩 组合路由：分解任务 + 检索 Skill...');

      // 拼接任务描述（带 step id 前缀，便于 LLM 理解结构）
      const taskDesc = plan.steps.map(s => `[步骤${s.id}] ${s.description}`).join('\n');

      // decomposeFn：用闭包内的 LLM 客户端把任务拆成原子子任务
      // 失败时返回空数组，让 compositionalRouter 上层降级
      const decomposeFn = async (task: string): Promise<AtomicSubTask[]> => {
        try {
          const classifyResult = await classifier.classify({ query: task });
          const routeDecision = await modelRouter.route(classifyResult);
          const client = clientManager.get(routeDecision.providerId);
          if (!client || !client.isReady()) return [];

          const systemPrompt = [
            '把给定的复杂任务分解为原子子任务（每个子任务可由单个 Skill 或单步操作完成）。',
            '输出严格的 JSON 数组（不要输出任何其他内容）：',
            '[{"id": "sub-1", "description": "子任务描述", "expectedSkillCategory": "code-review"}]',
            'expectedSkillCategory 可选值: code-review / refactor / test / docs / build / deploy / general',
          ].join('\n');

          const response = await client.complete({
            model: routeDecision.model.id,
            messages: [{ role: 'user', content: task }],
            systemPrompt,
            maxTokens: 1500,
            temperature: 0.2,
            stream: false,
          });

          // 兼容 ```json 代码块包裹与裸 JSON 两种输出格式
          const jsonStr = response.content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? response.content.trim();
          const parsed = JSON.parse(jsonStr);
          if (!Array.isArray(parsed)) return [];
          return parsed.map(
            (s: { id?: string; description?: string; expectedSkillCategory?: string }, i: number) => ({
              id: s.id ?? `sub-${i + 1}`,
              description: s.description ?? '',
              expectedSkillCategory: s.expectedSkillCategory ?? 'general',
            }),
          );
        } catch (err) {
          logger.warn('[compose] decomposeFn 调用失败', { error: String(err) });
          return [];
        }
      };

      // SAD 分解（availableSkills 传空数组，当前不接入 SkillsRouter）
      const subTasks = await compositionalRouter.decompose(taskDesc, [], decomposeFn);
      if (subTasks.length === 0) {
        logger.warn('CompositionalRouter 分解结果为空，降级到 DAG');
        addSystemMessage('⚠️ 组合路由分解结果为空，降级到 DAG 执行');
        return executePlanWithDag(plan);
      }
      addSystemMessage(`📋 组合计划已生成（${subTasks.length} 个原子子任务）`);

      // Skill 检索 + DAG 组合（availableSkills 传空数组，retrieveSkill 返回 null，
      // composeDAG 生成无 Skill 匹配的纯依赖 DAG——基于子任务顺序的 control 边）
      const skillDagPlan = compositionalRouter.planDAG(subTasks, []);
      addSystemMessage('ℹ️ Skill 检索未启用，按纯依赖 DAG 执行');

      // SkillDAGPlan → DagWorkflow 转换
      // nodes：id 透传；dependsOn 取 edges 中 to==node.id 的 from 列表；action 用 subTask.description
      const workflow: DagWorkflow = {
        nodes: skillDagPlan.nodes.map(node => ({
          id: node.id,
          dependsOn: skillDagPlan.edges.filter(e => e.to === node.id).map(e => e.from),
          action: node.subTask.description,
        })),
        variables: {},
      };

      // 节点 id → 临时 GoalStep 反查映射（compose 路径节点是 subTask 不是 GoalStep，
      // 构造临时 GoalStep 让 executeSingleStep 可消费；id 用 COMPOSE_STEP_ID_OFFSET + idx
      // 避免与原 plan.steps id 命名空间重叠——RISK 3 修复）
      const stepMap = new Map<number, GoalStep>();
      skillDagPlan.nodes.forEach((node, idx) => {
        const stepId = COMPOSE_STEP_ID_OFFSET + idx;
        stepMap.set(stepId, {
          id: stepId,
          description: node.subTask.description,
          acceptanceCriteria: '',
          dependencies: [],
          domain: 'general',
          status: 'pending',
        });
      });

      // executor 回调——复用 executeSingleStep 执行单步，状态更新 + emit + blackboard 写入
      const executor = async (node: DagNode, _resolvedAction: string): Promise<unknown> => {
        const idx = skillDagPlan.nodes.findIndex(n => n.id === node.id);
        const stepId = COMPOSE_STEP_ID_OFFSET + idx;
        const step = stepMap.get(stepId);
        if (!step) throw new Error(`未找到节点 ${node.id} 对应的 GoalStep`);
        step.status = 'in_progress';
        step.startedAt = Date.now();
        addSystemMessage(`▶ 子任务 ${idx + 1}/${skillDagPlan.nodes.length}: ${step.description}`);
        emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'running' });
        try {
          const result = await executeSingleStep(step);
          step.status = 'completed';
          step.completedAt = Date.now();
          step.result = result.slice(0, MAX_CONTEXT_ITEMS);
          conversationHistoryRef.current.push({ role: 'user', content: step.description });
          conversationHistoryRef.current.push({ role: 'assistant', content: result });
          if (conversationHistoryRef.current.length > 20) {
            conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
          }
          blackboard?.addCompletedStep(step.id, 'coder', result ?? '');
          emit({
            type: 'step_update',
            goalId: gid,
            stepId: step.id,
            status: 'completed',
            durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
          });
          addSystemMessage(`✅ 子任务 ${idx + 1} 完成`);
          return result;
        } catch (error) {
          step.status = 'failed';
          step.completedAt = Date.now();
          step.error = error instanceof Error ? error.message : String(error);
          emit({
            type: 'step_update',
            goalId: gid,
            stepId: step.id,
            status: 'failed',
            error: step.error,
            durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
          });
          addSystemMessage(`❌ 子任务 ${idx + 1} 失败: ${step.error}`);
          // 重新抛出：DagEngine 记录到 failedNodes 并按 retryLimit 决定是否重试
          throw error;
        }
      };

      const dagResult = await dagEngine.execute(workflow, executor);

      // 部分节点失败（重试耗尽）时记录日志 + emit，不降级——成功节点结果已写入 blackboard
      if (dagResult.failedNodes.length > 0) {
        logger.warn('Compose DAG 执行部分节点失败', { failedNodes: dagResult.failedNodes });
        for (const nodeId of dagResult.failedNodes) {
          const idx = skillDagPlan.nodes.findIndex(n => n.id === nodeId);
          if (idx >= 0) emit({ type: 'step_update', goalId: gid, stepId: COMPOSE_STEP_ID_OFFSET + idx, status: 'failed' });
        }
      }
    } catch (error) {
      // 异常降级：整个 compose 流程出错时回到 executePlanWithDag（用原始 plan）
      logger.warn('CompositionalRouter 异常，降级到 DAG', { error: String(error) });
      addSystemMessage('⚠️ 组合路由异常，降级到 DAG 执行');
      return executePlanWithDag(plan);
    }
  }

  // Phase 58：executePlanWithMultiAgent（legacy 路径）已删除
  // 原 Phase 54 Task 1 多 Agent 编排执行函数已移除，未注入 pathRouter 时回退到 single 路径
  // Phase 58：executeWorkerStep 已删除（原唯一调用者 executePlanWithMultiAgent 在 Phase 58 移除）

  return { executeGoalPlan, executeSingleStep, executePlanWithSingleAgent, executePlanWithDag, executePlanWithCompose };
}

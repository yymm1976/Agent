// src/cli/goal-runner.ts
// 目标分解与执行器：从 App.tsx 提取的 /goal 命令核心逻辑
// 包含 handleGoalCommand（解析+分解+确认）和 executeGoalPlan（执行+验证）

import type { LLMMessage, ILLMClient, ScenarioTier } from '../router/types.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { TokenTracker } from '../router/tracker.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { TokenProfiler } from '../agent/token-profiler.js';
import type { CheckpointManager } from '../harness/checkpoint-manager.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import type { AppConfig } from '../config/schema.js';
import type { GoalPlan, GoalStep, PlanStep, GoalEvent } from '../agent/goal-types.js';
// Phase 55 Task 6：执行路径判定器（/goal 路径分发）
import type { ExecutionRouter } from '../agent/execution-router.js';
// Phase 55 Task 9：DualLoop + BoundedRecovery 替代迭代闭环
import type { DualLoopOrchestrator } from '../agent/dual-loop-orchestrator.js';
import type { DualLoopParams } from '../agent/dual-loop-types.js';
// Phase 54 Task 5：自主度行为映射（auto/semi/manual → 具体行为开关）
import { AUTONOMY_BEHAVIOR, type AutonomyMode } from '../config/schema.js';
// Phase 32 Task 1.4：接入 CompletionGate（独立代码验证门）
import type { CompletionGate } from '../agent/completion-gate.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import { GoalGateManager, gatesFromSteps } from '../agent/goal-gates.js';
// Phase 50 Task 1：接入核心模块（默认 enabled: false，开关在 config.goalIntegration）
import { GoalAuditor } from '../agent/goal-audit.js';
import { GoalPersistence } from '../agent/goal-persistence.js';
import { GoalPromptBuilder } from '../agent/goal-prompt-builder.js';
import { analyzeChangeImpact, isRequirementChange, type RequirementChange } from '../agent/requirement-change.js';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { renderGoalProgressText, renderGoalCompletionSummary, formatDuration } from './components/goal-progress.js';
import { notifyRoutingFallback } from './notification.js';
// Phase 54 Task 1/4：多 Agent 编排 + 统一审查器接入
import type { Orchestrator } from '../agent/multi/orchestrator.js';
import type { WorkerExecutor } from '../agent/multi/worker-executor.js';
import type { Blackboard } from '../agent/multi/blackboard.js';
import type { UnifiedReviewer } from '../agent/unified-reviewer.js';
import type { WorkerTask, WorkerResult, WorkerRole, ExecutionPlan } from '../agent/multi/types.js';
import type { StepExecutionResult } from '../agent/task-orchestrator-types.js';

/** GoalRunner 依赖的外部对象（由 App.tsx 注入） */
export interface GoalRunnerDeps {
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  clientManager: LLMClientManager;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  checkpointManager: CheckpointManager;
  contextManager: ContextManager;
  config: AppConfig;
  /** Phase 30：系统提示词改为 ref（支持 PromptTemplateManager 异步渲染后更新） */
  systemPromptRef: { current: string };
  /** 对话历史 ref（会被读写） */
  conversationHistoryRef: { current: LLMMessage[] };
  /** 工具确认 pending ref（会被读写） */
  // Phase 54：resolve 扩展为接收 payload（ask_user 用户回答内容通过 payload 传回）
  pendingConfirmRef: { current: { resolve: (approved: boolean | { approved: boolean; payload?: unknown }) => void; toolName: string } | null };
  /** 中断控制器 ref（会被读写） */
  abortControllerRef: { current: AbortController | null };
  /** 当前计划 ref（会被读写） */
  currentPlanRef: { current: GoalPlan | null };
  /** 目标确认 pending ref（会被读写） */
  awaitingGoalConfirmRef: { current: { resolve: (approved: boolean) => void; plan: GoalPlan } | null };
  /** 添加系统消息 */
  addSystemMessage: (content: string) => void;
  /** 请求用户编辑计划步骤（Phase 20：返回修改后的步骤或 null 表示取消） */
  requestPlanEdit: (plan: GoalPlan) => Promise<PlanStep[] | null>;
  /** 设置处理状态 */
  setIsProcessing: (v: boolean) => void;
  /** Phase 30：累加今日 Token 用量（修复 goal-runner 缺失 setTodayTokensUsed 的 bug） */
  setTodayTokensUsed?: (updater: (prev: number) => number) => void;
  /** Phase 30：Token Profiler（可选） */
  profiler?: TokenProfiler;
  /** Phase 32 Task 1.4：独立代码验证门（typecheck/lint/tests 兜底，可选） */
  completionGate?: CompletionGate;
  /** Phase 50 Task 1：核心模块实例（由 app-init.ts 在开关开启时创建并注入，可选） */
  goalAuditor?: GoalAuditor;
  goalPersistence?: GoalPersistence;
  goalPromptBuilder?: GoalPromptBuilder;
  /**
   * Phase 54 Task 1：多 Agent 编排实例（可选，三者同时注入后 /goal 走多 Agent 路径）
   * - orchestrator：分析依赖图 + 生成并行组 + 分配角色
   * - workerExecutor：4 角色 Worker 执行（coder/searcher/tester/reviewer）+ 异常隔离
   * - blackboard：跨 Worker 共享状态（currentGoal/completedSteps/projectFacts）
   */
  orchestrator?: Orchestrator;
  workerExecutor?: WorkerExecutor;
  blackboard?: Blackboard;
  /**
   * Phase 54 Task 4：统一审查器（可选，注入后 verifyPlan 调用 review() 获得 reviewerResult）
   * GoalAuditor.audit 的第三层（reviewer_agent）需要此结果
   */
  unifiedReviewer?: UnifiedReviewer;
  /** Phase 55：执行路径判定器（由 app-init.ts 注入，Task 8 完成） */
  executionRouter?: ExecutionRouter;
  /**
   * Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，通过 ref 延迟绑定）
   * app-init.ts 中 DualLoopOrchestrator 在动态 import 的 .then() 回调内创建，
   * 此时 createGoalRunner 已被调用，故用 ref 让 /goal 实际触发时读取最新引用。
   * BoundedRecovery 已在 orchestrator 内部启用（setBoundedRecovery 注入配置）。
   */
  dualLoopOrchestratorRef?: { current: DualLoopOrchestrator | null };
  /**
   * Phase 55：DAG 引擎（由 app-init.ts 注入，可选，未注入时降级到单 Agent）
   * TODO: Task 8 接入真实 DagEngine 类型（src/agent/workflow/dag-engine.ts），
   * 当前用 unknown 占位——实际 execute 签名与任务描述不同，需在 Task 8 对齐
   */
  dagEngine?: unknown;
  /** 生成消息 ID */
  nextId: () => string;
  /**
   * Phase 54：Goal 执行结构化事件回调（Electron 端注入，驱动 GoalExecutionCard 就地刷新）
   * 可选——CLI 端不传，行为不变；Electron 端注入后与 addSystemMessage 并存
   * goalId 由 engine-bridge 生成并注入，所有事件共用同一个 goalId
   */
  onGoalEvent?: (event: GoalEvent) => void;
  /** Phase 54：Goal 唯一标识（由 engine-bridge 生成注入，onGoalEvent 事件携带） */
  goalId?: string;
  /**
   * Phase 54：工具确认/用户提问触发器（Electron 端注入，复用 sendChat 的 onToolConfirmRequest）
   * clarifyGoalIfNeeded 检测到模糊参数时通过此回调触发 ask_user UI
   * CLI 端不传——澄清环节跳过，直接用原描述
   */
  onToolConfirmRequest?: (toolName: string, params: Record<string, unknown>) => void;
}

/** 创建目标运行器 */
export function createGoalRunner(deps: GoalRunnerDeps) {
  const {
    classifier, modelRouter, clientManager, tracker, agentLoop,
    checkpointManager, contextManager, config, systemPromptRef,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    currentPlanRef, awaitingGoalConfirmRef,
    addSystemMessage, requestPlanEdit, setIsProcessing, setTodayTokensUsed, profiler,
    completionGate,
    goalAuditor, goalPersistence, goalPromptBuilder,
    // Phase 54 Task 1/4：多 Agent 编排 + 统一审查器
    orchestrator, workerExecutor, blackboard, unifiedReviewer,
    // Phase 55 Task 6：执行路径判定器 + DAG 引擎（可选注入，未注入时降级到 legacy）
    executionRouter, dagEngine,
    // Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，通过 ref 延迟绑定）
    dualLoopOrchestratorRef,
    nextId,
    // Phase 54：结构化事件回调 + goalId + 工具确认触发器
    onGoalEvent,
    goalId: depsGoalId,
    onToolConfirmRequest,
  } = deps;

  // Phase 54：emit 辅助函数——安全调用 onGoalEvent（CLI 端未注入时为 no-op）
  const emit = (event: GoalEvent): void => {
    if (onGoalEvent) {
      try {
        onGoalEvent(event);
      } catch (err) {
        logger.warn('[goal-runner] onGoalEvent 调用失败（非阻塞）', { error: String(err) });
      }
    }
  };

  // Phase 54：goalId 统一来源——提升到 createGoalRunner 顶部，供所有闭包内函数复用
  // Electron 端由 engine-bridge 注入 depsGoalId；CLI 端用 nextId 生成临时 id
  const gid = depsGoalId ?? nextId();

  // Phase 54 Task 4：缓存最近一次 runCompletionGate 的 typecheck/lint/tests 结果
  // 供 verifyPlan 中 GoalAuditor.audit 的 completion_gate 层使用（修复原接入缺陷：未传客观验证结果）
  let lastGateChecks: { typecheck: boolean; lint: boolean; tests: boolean } | null = null;

  // Phase 21 Task 2：GoalGateManager 管理冻结的验收门控
  const gateManager = new GoalGateManager(process.cwd());
  // Phase 43：缓存 goal 配置，避免多处重复访问
  const goalCfg = config.goal;
  // Phase 50 Task 1：缓存 goalIntegration 开关（默认全部 false，渐进接入）
  const goalIntegration = config.goalIntegration;
  // Phase 50 Task 1：当前目标的五段式规范（promptBuilder 开启时由 build() 生成，供 audit 复用 doneWhen）
  let currentGoalSpec: { doneWhen: string[] } | null = null;

  /**
   * Phase 54：目标澄清——用 LLM 检测描述中的模糊参数（如"指定目录"、"某个文件"），
   * 如有，通过 ask_user 流程向用户提问，把答案拼接到描述中
   * 失败时 fail-open（返回原描述，不阻塞 goal 流程）
   */
  async function clarifyGoalIfNeeded(description: string, client: ILLMClient, modelId: string): Promise<string> {
    try {
      const systemPrompt = [
        '分析用户的目标描述，检测是否存在模糊参数（如"指定目录"、"某个文件"、"相应位置"等未明确具体值的占位词）。',
        '如果有模糊参数，输出一个 JSON 对象：{"needsClarification": true, "questions": ["需要澄清的问题1", "问题2"]}',
        '问题应具体且可直接回答（如"保存到哪个目录？请提供完整路径"）。',
        '如果没有模糊参数，输出：{"needsClarification": false}',
        '只输出 JSON，不要输出其他内容。',
      ].join('\n');

      const response = await client.complete({
        model: modelId,
        messages: [{ role: 'user', content: `目标描述: ${description}` }],
        systemPrompt,
        maxTokens: 500,
        temperature: 0.1,
        stream: false,
      });

      const jsonStr = response.content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? response.content.trim();
      const parsed = JSON.parse(jsonStr);

      if (!parsed.needsClarification || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
        return description;
      }

      // 通过 pendingConfirmRef + onToolConfirmRequest 触发 ask_user UI（复用现有提问模块）
      // CLI 端无 onToolConfirmRequest，跳过澄清返回原描述
      if (!onToolConfirmRequest) return description;

      const answers = await new Promise<string[]>((resolve) => {
        pendingConfirmRef.current = {
          resolve: (result) => {
            pendingConfirmRef.current = null;
            // engine-bridge resolveToolConfirm 传 { approved, payload }
            if (typeof result === 'object' && result !== null && 'approved' in result) {
              if (!result.approved) {
                resolve([]);
                return;
              }
              const payload = result.payload as { answers?: string[] } | undefined;
              resolve(payload?.answers ?? []);
            } else {
              resolve([]);
            }
          },
          toolName: 'ask_user',
        };
        // 触发渲染层 ask_user UI（questions 参数）
        onToolConfirmRequest('ask_user', { questions: parsed.questions });
      });

      if (answers.length === 0) return description;

      // 把问答拼接到描述中
      const clarificationLines = parsed.questions.map((q: string, i: number) => {
        const answer = answers[i] ?? '(未回答)';
        return `${q} → ${answer}`;
      });
      return `${description}\n（澄清：${clarificationLines.join('；')}）`;
    } catch (error) {
      logger.warn('[goal-runner] clarifyGoalIfNeeded failed (non-blocking)', { error: String(error) });
      return description;
    }
  }

  /** 处理 /goal 命令：解析目标、分解步骤、请求用户确认 */
  async function handleGoalCommand(text: string): Promise<void> {
    setIsProcessing(true);

    // 解析: /goal "目标描述" --verify "验证条件"
    const goalMatch = text.match(/^\/goal\s+"([^"]+)"/);
    let description: string;
    if (!goalMatch) {
      const noQuoteMatch = text.match(/^\/goal\s+(\S+)/);
      if (!noQuoteMatch) {
        addSystemMessage('❌ 用法: /goal "目标描述" [--verify "验证条件"]');
        setIsProcessing(false);
        return;
      }
      description = noQuoteMatch[1];
    } else {
      description = goalMatch[1];
    }

    const verifyMatch = text.match(/--verify\s+"([^"]+)"/);
    const verificationCriteria = verifyMatch ? verifyMatch[1] : undefined;

    addSystemMessage(`🎯 解析目标: ${description}${verificationCriteria ? `\n验证条件: ${verificationCriteria}` : ''}`);

    // 路由决策
    const classifyResult = await classifier.classify({ query: description });
    const routeDecision = await modelRouter.route(classifyResult);
    const goalFallbackNotice = notifyRoutingFallback(routeDecision);
    if (goalFallbackNotice) addSystemMessage(goalFallbackNotice);
    const client = clientManager.get(routeDecision.providerId);
    if (!client || !client.isReady()) {
      addSystemMessage(`❌ 错误: 提供商 ${routeDecision.providerId} 不可用`);
      setIsProcessing(false);
      return;
    }

    const parser = new GoalParser();

    // Phase 54：目标澄清——检测模糊参数（如"指定目录"），如有则向用户提问
    // 仅在 onToolConfirmRequest 存在时启用（Electron 端），CLI 端跳过
    const clarifiedDescription = onToolConfirmRequest
      ? await clarifyGoalIfNeeded(description, client, routeDecision.model.id)
      : description;
    // 用澄清后的描述替换原描述（后续 parser/promptBuilder 都用 clarifiedDescription）
    description = clarifiedDescription;

    // Phase 50 Task 1：promptBuilderEnabled 时用 GoalPromptBuilder 构造五段式规范
    // 失败时 try/catch 降级到原行为（直接用 description 喂给 parser）
    let enrichedDescription = description;
    if (goalIntegration?.promptBuilderEnabled && goalPromptBuilder) {
      try {
        const spec = await goalPromptBuilder.build(description);
        currentGoalSpec = { doneWhen: spec.doneWhen };
        // 用 scope + constraints 增强描述，让 GoalParser 拿到更明确的上下文
        const scopeLine = spec.scope ? `\n范围: ${spec.scope}` : '';
        const constraintsLine = spec.constraints.length > 0
          ? `\n约束: ${spec.constraints.join('; ')}`
          : '';
        const doneWhenLine = spec.doneWhen.length > 0
          ? `\n完成标准: ${spec.doneWhen.join('; ')}`
          : '';
        enrichedDescription = `${description}${scopeLine}${constraintsLine}${doneWhenLine}`;
        addSystemMessage('📐 已用 GoalPromptBuilder 构造五段式规范');
      } catch (error) {
        logger.warn('GoalPromptBuilder.build failed (non-blocking)', { error: String(error) });
        currentGoalSpec = null;
      }
    }

    const plan = await parser.parse(enrichedDescription, {
      verificationCriteria,
      routeDecision,
      llmClient: client,
    });

    // Phase 20：通过 StepEditor 让用户编辑计划步骤
    // Phase 54 Task 5：用自主度模式（auto/semi/manual）统一判定是否需要确认计划
    // 优先使用 autonomy.defaultMode；若用户显式设置 goal.requireConfirmation=false 则尊重该设置（向后兼容）
    const autonomyMode = (config.autonomy?.defaultMode ?? 'semi') as AutonomyMode;
    const autonomyBehavior = AUTONOMY_BEHAVIOR[autonomyMode];
    // 向后兼容：goal.requireConfirmation === false 时强制跳过确认（即使 manual 模式）
    const skipPlanConfirmation = !autonomyBehavior.requirePlanConfirmation
      || goalCfg?.requireConfirmation === false;
    if (!skipPlanConfirmation) {
      addSystemMessage('📋 计划已生成，请在编辑器中审查和修改步骤...');
      const editedSteps = await requestPlanEdit(plan);

      if (editedSteps === null) {
        addSystemMessage('❌ 已取消目标计划');
        setIsProcessing(false);
        return;
      }

      // 用编辑后的步骤更新计划
      plan.steps = editedSteps;
    } else {
      // Phase 54 Task 5：auto 模式跳过确认时给出提示
      addSystemMessage(`⚙️ 自主度模式: ${autonomyMode}，跳过计划确认直接执行`);
    }

    addSystemMessage('✅ 计划已确认，开始执行...');
    addSystemMessage(renderGoalProgressText(plan));
    currentPlanRef.current = plan;

    // Phase 54：发出结构化事件——plan_created + plan_confirmed（驱动渲染层创建卡片）
    // 用 depsGoalId || 临时 id 兜底（CLI 端无 goalId 时用 nextId 生成）
    const gid = depsGoalId ?? nextId();
    emit({
      type: 'plan_created',
      goalId: gid,
      description,
      steps: plan.steps.map(s => ({ id: s.id, description: s.description })),
      autonomyMode,
      verificationCriteria,
    });
    emit({ type: 'plan_confirmed', goalId: gid });

    // Phase 21 Task 2：冻结验收门控（计划确认后，执行前）
    try {
      await gateManager.freeze(description, gatesFromSteps(plan.steps.map(s => s.description)));
    } catch (error) {
      logger.warn('GoalGateManager freeze failed (non-blocking)', { error: String(error) });
    }

    await executeGoalPlan(plan);
  }

  /**
   * 验证目标完成度（LLM 验证）
   * 提取为独立函数，供迭代闭环复用
   * @returns 验证是否通过（验证异常时返回 true 以保持向后兼容）
   */
  async function verifyPlan(plan: GoalPlan): Promise<boolean> {
    plan.status = 'verifying';
    addSystemMessage('🔍 正在验证目标完成度...');

    try {
      const verifierQuery = plan.description;
      const verifyClassify = await classifier.classify({ query: verifierQuery });
      const verifyRoute = await modelRouter.route(verifyClassify);
      const verifyClient = clientManager.get(verifyRoute.providerId);
      if (verifyClient && verifyClient.isReady()) {
        // Phase 21 Task 4：对抗性验证——用 fast tier 廉价模型尝试推翻主验证结论
        let adversarial: import('../agent/goal-verifier.js').AdversarialOptions | undefined;
        if (config.adversarial?.enabled) {
          // 路由一个简单查询获取 fast tier 客户端（廉价模型）
          const advClassify = await classifier.classify({ query: 'adversarial check' });
          const advRoute = await modelRouter.route(advClassify);
          const advClient = clientManager.get(advRoute.providerId);
          if (advClient && advClient.isReady()) {
            adversarial = {
              enabled: true,
              threshold: config.adversarial.threshold ?? 0.5,
              adversarialClient: advClient,
            };
          }
        }

        const verifier = new GoalVerifier();
        // Phase 21 Task 2：传入冻结的 gates 辅助验证（向后兼容，gates 可选）
        const result = await verifier.verify(
          plan,
          {
            routeDecision: verifyRoute,
            llmClient: verifyClient,
            adversarial,
            // Phase 30：修复验证步骤和对抗步骤的 token 记录缺失
            onUsage: (usage, source) => {
              tracker.record(usage, {
                modelId: source === 'adversarial' ? 'adversarial' : verifyRoute.model.id,
                agentId: 'goal-verifier',
                stepId: `verify-${source}`,
              });
              if (setTodayTokensUsed) {
                setTodayTokensUsed(prev => prev + usage.totalTokens);
              }
            },
          },
          gateManager.getGates() ?? undefined,
        );
        plan.verificationResult = result;
        plan.status = result.passed ? 'completed' : 'failed';
        const passedIcon = result.passed ? '✅' : '⚠️';
        addSystemMessage(
          `${passedIcon} 验证结果 (置信度 ${(result.confidence * 100).toFixed(0)}%): ${result.reasoning}\n${result.missingItems.length > 0 ? `缺失项: ${result.missingItems.join('; ')}` : ''}`,
        );

        // Phase 54：发出 verification 事件——驱动 GoalExecutionCard 渲染验证结果区块
        // 注意：此处发出的是 LLM 验证器原始结果，audit 后处理不会改变此事件
        emit({
          type: 'verification',
          goalId: gid,
          passed: result.passed,
          confidence: result.confidence,
          reasoning: result.reasoning,
          missingItems: result.missingItems,
        });

        // Phase 50 Task 1：auditEnabled 时用 GoalAuditor 执行三层独立审计
        // Phase 54 Task 4 修复：补全 audit() 入参——typecheck/lint/tests/reviewer
        //   原缺陷：仅传 verifierResult，导致 completion_gate 层和 reviewer_agent 层形同虚设
        //   修复后：lastGateChecks（runCompletionGate 缓存）+ reviewerResult（unifiedReviewer 生成）均传入
        // 失败时 try/catch 降级（不阻塞返回 result.passed）
        if (goalIntegration?.auditEnabled && goalAuditor) {
          try {
            // Phase 54 Task 4：调用 UnifiedReviewer 获得 reviewerResult（第三层）
            // unifiedReviewer 未注入时跳过（reviewerResult 为 undefined，audit 内部按未启用处理）
            let reviewerResult: { passed: boolean; evidence: string[]; severity?: 'info' | 'warning' | 'error' } | undefined;
            if (unifiedReviewer) {
              try {
                reviewerResult = await getReviewerResult(plan);
              } catch (err) {
                logger.warn('Phase 54 Task 4: getReviewerResult failed (non-blocking)', { error: String(err) });
              }
            }
            const auditOutcome = await goalAuditor.audit({
              spec: { doneWhen: currentGoalSpec?.doneWhen ?? [] },
              // Phase 54 Task 4：补全 completion_gate 层入参（来自最近一次 runCompletionGate）
              typecheckPassed: lastGateChecks?.typecheck,
              lintPassed: lastGateChecks?.lint,
              testsPassed: lastGateChecks?.tests,
              // 第二层：VerifierLLM 结果（原有）
              verifierResult: {
                passed: result.passed,
                evidence: [result.reasoning],
                missing: result.missingItems,
              },
              // 第三层：ReviewerAgent 结果（Phase 54 Task 4 新增）
              reviewerResult,
            });
            addSystemMessage(`🔬 GoalAuditor 审计: ${auditOutcome.overallPassed ? '通过' : '未通过'} (${auditOutcome.results.length} 层)`);
            // 审计未通过时覆盖 plan.status 为 failed
            if (!auditOutcome.overallPassed) {
              plan.status = 'failed';
            }
          } catch (error) {
            logger.warn('GoalAuditor.audit failed (non-blocking)', { error: String(error) });
          }
        }

        return result.passed;
      }
    } catch (error) {
      logger.error('Goal verification failed', { error: String(error) });
      plan.status = 'completed';
    }
    return true; // 验证异常时保持向后兼容
  }

  /**
   * 运行独立代码验证门（typecheck/lint/tests）
   * 提取为独立函数，供迭代闭环复用
   */
  async function runCompletionGate(plan: GoalPlan): Promise<void> {
    // Phase 32 Task 1.4：CompletionGate 独立代码验证门
    // 在 GoalVerifier（LLM 验证）之后运行，通过实际执行 typecheck/lint/tests 验证代码状态
    // 不信任 LLM 的"已完成"判断——只有代码编译通过、测试通过才算真正完成
    // 配置开关：optimization.safety.completionGate（默认 true）
    if (completionGate && config.optimization?.safety?.completionGate !== false && plan.status === 'completed') {
      try {
        addSystemMessage('🔬 正在运行独立代码验证（typecheck/lint/tests）...');
        // 收集所有步骤修改的文件列表
        const modifiedFiles = plan.steps
          .filter(s => s.status === 'completed')
          .flatMap(s => s.modifiedFiles || []);
        const gateResult = await completionGate.verify({
          modifiedFiles,
          projectPath: process.cwd(),
          planDescription: plan.description,
        });

        // Phase 54 Task 4：缓存 typecheck/lint/tests 结果，供 verifyPlan 中 GoalAuditor.audit 使用
        // 按 name 字段模糊匹配（兼容不同 CompletionGate 实现的命名）
        // skipped 项视为通过（未执行不代表失败）
        lastGateChecks = {
          typecheck: gateResult.checks.find(c => c.name.toLowerCase().includes('typecheck'))?.ok
            ?? gateResult.checks.find(c => c.name.toLowerCase().includes('type'))?.ok
            ?? true,
          lint: gateResult.checks.find(c => c.name.toLowerCase().includes('lint'))?.ok
            ?? true,
          tests: gateResult.checks.find(c => c.name.toLowerCase().includes('test'))?.ok
            ?? true,
        };

        const failedChecks = gateResult.checks.filter(c => !c.ok && !c.skipped);
        const skippedChecks = gateResult.checks.filter(c => c.skipped);
        const passedChecks = gateResult.checks.filter(c => c.ok);

        if (gateResult.passed) {
          addSystemMessage(`✅ 代码验证通过（${passedChecks.length} 项通过${skippedChecks.length > 0 ? `，${skippedChecks.length} 项跳过` : ''}）`);
        } else {
          // 验证未通过——将失败信息展示给用户，但不自动回滚（让用户决定）
          const failedDetails = failedChecks.map(c => `  • ${c.name}: ${c.output.slice(0, 200)}`).join('\n');
          addSystemMessage(`⚠️ 代码验证未通过：\n${failedDetails}\n\n请根据上述错误信息修复代码后重新验证。`);
          // 将 plan 状态从 completed 改为 failed（LLM 说完成但代码验证不过）
          plan.status = 'failed';
          logger.warn('CompletionGate verification failed', {
            failedChecks: failedChecks.map(c => c.name),
            skippedChecks: skippedChecks.map(c => c.name),
          });
        }
      } catch (error) {
        // 验证门自身异常不阻断任务完成（已通过 LLM 验证）
        logger.error('CompletionGate verification threw (non-blocking)', { error: String(error) });
        addSystemMessage(`⚠️ 代码验证门异常（不影响任务完成）: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * 执行单个补救步骤（迭代闭环专用）
   * 简化版步骤执行：不含检查点创建和上下文压缩，专注于补救执行
   */
  async function executeRemediationStep(step: GoalStep, plan: GoalPlan): Promise<void> {
    step.status = 'in_progress';
    step.startedAt = Date.now();
    addSystemMessage(`▶ 补救步骤 ${step.id}: ${step.description}`);

    try {
      const classifyResult = await classifier.classify({ query: step.description });
      const routeDecision = await modelRouter.route(classifyResult);
      const stepFallbackNotice = notifyRoutingFallback(routeDecision);
      if (stepFallbackNotice) addSystemMessage(stepFallbackNotice);
      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        step.status = 'failed';
        step.error = `提供商 ${routeDecision.providerId} 不可用`;
        addSystemMessage(`❌ 补救步骤 ${step.id} 失败: ${step.error}`);
        return;
      }

      let stepContent = '';
      const stepAbort = new AbortController();
      abortControllerRef.current = stepAbort;
      for await (const event of agentLoop.run({
        userMessage: step.description,
        llmClient: client,
        routeDecision,
        conversationHistory: conversationHistoryRef.current,
        systemPrompt: systemPromptRef.current,
        signal: stepAbort.signal,
        onConfirmTool: async (toolName, args) => {
          // Phase 54 修复：自主度模式判定——auto/semi 直接批准
          const mode = (config.autonomy?.defaultMode ?? 'semi') as AutonomyMode;
          if (!AUTONOMY_BEHAVIOR[mode].requireToolConfirmation && toolName !== 'ask_user') {
            return true;
          }
          return new Promise<boolean>(resolve => {
            pendingConfirmRef.current = {
            resolve: (r) => resolve(typeof r === 'boolean' ? r : r.approved),
            toolName,
          };
            const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
            addSystemMessage(`⚠️  补救步骤 · 工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`);
          });
        },
      })) {
        if (event.type === 'text_delta') stepContent += event.text;
        if (event.type === 'done') {
          tracker.record(event.usage, {
            modelId: routeDecision.model.id,
            agentId: 'goal',
            stepId: `remediation-${step.id}`,
          });
          // 任务级 Token 预算追踪
          const taskStatus = tracker.recordTaskUsage(event.usage);
          if (taskStatus === 'exceeded') {
            addSystemMessage('⏹ 任务级 Token 预算已耗尽，补救步骤中止');
            step.status = 'failed';
            step.error = '任务级 Token 预算耗尽';
            gateManager.updateGate(`remediation-${step.id}`, 'failed', step.error);
            return;
          }
          if (setTodayTokensUsed) {
            setTodayTokensUsed(prev => prev + event.usage.totalTokens);
          }
          if (!tracker.checkBudget()) {
            addSystemMessage('⏹ Token 日预算已耗尽，补救步骤中止');
            step.status = 'failed';
            step.error = 'Token 预算耗尽';
            gateManager.updateGate(`remediation-${step.id}`, 'failed', step.error);
            return;
          }
        }
      }

      // 用户中断时，当前补救步骤标记为 failed
      if (stepAbort.signal.aborted) {
        step.status = 'failed';
        step.error = '用户中断';
        gateManager.updateGate(`remediation-${step.id}`, 'failed', step.error);
        addSystemMessage(`⏸ 补救步骤 ${step.id} 已中断`);
        return;
      }
      step.status = 'completed';
      step.completedAt = Date.now();
      step.result = stepContent.slice(0, 200);
      addSystemMessage(`✅ 补救步骤 ${step.id} 完成`);
      conversationHistoryRef.current.push({ role: 'user', content: step.description });
      conversationHistoryRef.current.push({ role: 'assistant', content: stepContent });
      if (conversationHistoryRef.current.length > 20) {
        conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
      }
      gateManager.updateGate(`remediation-${step.id}`, 'passed', step.result);
    } catch (error) {
      step.status = 'failed';
      step.completedAt = Date.now();
      step.error = error instanceof Error ? error.message : String(error);
      gateManager.updateGate(`remediation-${step.id}`, 'failed', step.error);
      addSystemMessage(`❌ 补救步骤 ${step.id} 失败: ${step.error}`);
    }
  }

  /**
   * Phase 55 Task 9：原迭代闭环逻辑提取为独立函数（P2 降级 fallback）
   *
   * 当 DualLoop 未启用或异常时使用。保留原逻辑不变，仅做结构重组。
   * @param plan 目标计划
   */
  async function legacyIterativeLoop(plan: GoalPlan): Promise<void> {
    // 迭代闭环：验证失败时自动生成补救步骤并重新执行（借鉴 kimi-code 的"迭代到目标达成为止"模式）
    // 配置开关：goalVerifier.iterative.enabled（默认 false）
    const iterativeConfig = config.goalVerifier?.iterative;
    if (iterativeConfig?.enabled && plan.status === 'failed') {
      const maxRounds = iterativeConfig.maxRounds;
      for (let round = 1; round <= maxRounds; round++) {
        // 检查中断
        if (abortControllerRef.current?.signal.aborted) {
          addSystemMessage('⏸ 迭代闭环被中断');
          break;
        }

        const verification = plan.verificationResult;
        // 无验证结果或已通过，跳出循环
        if (!verification || verification.passed) break;

        addSystemMessage(`🔄 迭代闭环第 ${round}/${maxRounds} 轮：验证未通过，生成补救步骤...`);

        // 构建补救描述：包含缺失项和改进建议，让 GoalParser 生成针对性的补救步骤
        const remediationParts: string[] = [`目标: ${plan.description}`];
        if (verification.missingItems.length > 0) {
          remediationParts.push(`缺失项: ${verification.missingItems.join('; ')}`);
        }
        if (verification.suggestions.length > 0) {
          remediationParts.push(`改进建议: ${verification.suggestions.join('; ')}`);
        }
        if (plan.verificationCriteria) {
          remediationParts.push(`验证条件: ${plan.verificationCriteria}`);
        }
        const remediationDescription = remediationParts.join('\n');

        // 调用 GoalParser 生成补救步骤
        const remediateClassify = await classifier.classify({ query: remediationDescription });
        const remediateRoute = await modelRouter.route(remediateClassify);
        const remediateClient = clientManager.get(remediateRoute.providerId);
        if (!remediateClient || !remediateClient.isReady()) {
          addSystemMessage(`❌ 迭代闭环：提供商 ${remediateRoute.providerId} 不可用，中止迭代`);
          break;
        }

        const parser = new GoalParser();
        const remediationPlan = await parser.parse(remediationDescription, {
          verificationCriteria: plan.verificationCriteria,
          routeDecision: remediateRoute,
          llmClient: remediateClient,
        });

        addSystemMessage(`📋 补救计划已生成（${remediationPlan.steps.length} 个步骤），开始执行...`);

        // 执行补救步骤
        for (const step of remediationPlan.steps) {
          if (abortControllerRef.current?.signal.aborted) break;
          await executeRemediationStep(step, plan);
          // 将补救步骤追加到原计划，便于最终摘要展示
          plan.steps.push(step);
        }

        if (abortControllerRef.current?.signal.aborted) break;

        // 重新验证
        await verifyPlan(plan);
        await runCompletionGate(plan);

        // 重新读取 plan.status（verifyPlan 和 runCompletionGate 可能已将其改为 completed 或 failed）
        // 使用局部变量断言避免 TypeScript 的类型窄化（它不知道函数调用会修改 plan.status）
        const currentStatus: string = plan.status;
        if (currentStatus === 'completed') {
          addSystemMessage(`✅ 迭代闭环第 ${round} 轮：目标已达成`);
          break;
        }

        if (round < maxRounds) {
          addSystemMessage(`⚠️ 迭代闭环第 ${round} 轮：验证仍未通过，继续迭代...`);
        } else {
          addSystemMessage(`⚠️ 迭代闭环：已达到最大迭代次数 ${maxRounds}，停止迭代`);
        }
      }
    }
  }

  /**
   * Phase 55 Task 9：调用 DualLoopOrchestrator.runDualLoop 执行完整双循环
   *
   * 构造 DualLoopParams 并消费 async generator 事件流，根据终态事件判定成功/失败。
   * BoundedRecovery 已在 DualLoopOrchestrator 内部启用（app-init.ts 通过 setBoundedRecovery 注入配置），
   * 失败时优先尝试局部恢复（computeRecoveryScope），超限时退回全局重跑。
   *
   * @param plan 目标计划
   * @param orchestrator DualLoopOrchestrator 实例
   * @returns true 表示双循环验证通过，false 表示耗尽重跑次数仍失败
   */
  async function runDualLoopPlan(
    plan: GoalPlan,
    orchestrator: DualLoopOrchestrator,
  ): Promise<boolean> {
    if (!completionGate) {
      throw new Error('completionGate 未注入，DualLoop 不可用');
    }

    // 路由 executor 使用的 LLM 客户端（与目标描述同级）
    const execClassify = await classifier.classify({ query: plan.description });
    const execRoute = await modelRouter.route(execClassify);
    const execClient = clientManager.get(execRoute.providerId);
    if (!execClient || !execClient.isReady()) {
      throw new Error(`executor 提供商 ${execRoute.providerId} 不可用`);
    }

    // 路由 verifier 使用的 LLM 客户端（独立路由，与 verifyPlan 一致）
    const verifyClassify = await classifier.classify({ query: plan.description });
    const verifyRoute = await modelRouter.route(verifyClassify);
    const verifyClient = clientManager.get(verifyRoute.providerId);
    if (!verifyClient || !verifyClient.isReady()) {
      throw new Error(`verifier 提供商 ${verifyRoute.providerId} 不可用`);
    }

    const dualLoopParams: DualLoopParams = {
      goal: {
        description: plan.description,
        plan,
        projectPath: process.cwd(),
        gates: gateManager.getGates() ?? undefined,
      },
      reactLoop: agentLoop,
      reactParams: {
        userMessage: plan.description,
        llmClient: execClient,
        routeDecision: execRoute,
        conversationHistory: conversationHistoryRef.current,
        systemPrompt: systemPromptRef.current,
        signal: abortControllerRef.current?.signal,
      },
      goalVerifier: new GoalVerifier(),
      verifierOptions: {
        routeDecision: verifyRoute,
        llmClient: verifyClient,
        onUsage: (usage, source) => {
          tracker.record(usage, {
            modelId: source === 'adversarial' ? 'adversarial' : verifyRoute.model.id,
            agentId: 'goal-verifier',
            stepId: `dual-loop-verify-${source}`,
          });
          if (setTodayTokensUsed) {
            setTodayTokensUsed(prev => prev + usage.totalTokens);
          }
        },
      },
      completionGate,
      maxReruns: config.goalVerifier?.iterative?.maxRounds ?? 3,
    };

    addSystemMessage('🔄 启动 DualLoop 双循环恢复（含 BoundedRecovery）...');

    // 消费 async generator 事件流，根据终态事件判定成功/失败
    let success = false;
    for await (const event of orchestrator.runDualLoop(dualLoopParams)) {
      switch (event.type) {
        case 'inner-loop-start':
          addSystemMessage(`▶ DualLoop 内循环 #${event.iteration} 开始`);
          break;
        case 'inner-loop-complete':
          addSystemMessage(`✅ DualLoop 内循环 #${event.iteration} 完成（修改 ${event.result.modifiedFiles.length} 个文件）`);
          break;
        case 'outer-loop-start':
          addSystemMessage(`🔍 DualLoop 外循环 #${event.iteration} 验证开始`);
          break;
        case 'outer-loop-failed':
          addSystemMessage(`⚠️ DualLoop 外循环 #${event.iteration} 验证失败：${event.reason}`);
          break;
        case 'bounded-recovery-attempted':
          addSystemMessage(`🔧 BoundedRecovery 尝试局部恢复（${event.recoverySteps.length} 步）`);
          break;
        case 'dual-loop-complete':
          addSystemMessage(`✅ DualLoop 双循环通过（第 ${event.iteration} 轮）`);
          plan.verificationResult = event.verification;
          success = true;
          break;
        case 'dual-loop-exhausted':
          addSystemMessage(`⚠️ DualLoop 已达最大重跑次数 ${event.maxReruns}，仍失败`);
          break;
        case 'human-intervention-detected':
          addSystemMessage(`⏸ ${event.message}`);
          break;
        case 'pilot-mode-triggered':
          addSystemMessage(`🛑 Pilot 模式触发：${event.repeatedReason}`);
          break;
      }
      // 检查中断
      if (abortControllerRef.current?.signal.aborted) {
        addSystemMessage('⏸ DualLoop 被中断');
        break;
      }
    }

    return success;
  }

  /** 执行目标计划：逐步骤运行 Agent Loop，支持中断 + 检查点 + 压缩 */
  async function executeGoalPlan(plan: GoalPlan): Promise<void> {
    setIsProcessing(true);
    plan.status = 'executing';
    currentPlanRef.current = plan;

    // 持久化 GoalPlan
    await checkpointManager.saveGoalPlan(plan);

    // Phase 31/32 P0 接线：TokenTracker 任务级 API——启动任务级 Token 预算追踪
    // Phase 43：优先使用 config.goal.tokenBudget，未配置时回退到 perRequestLimit
    // Phase 54 修复：Electron 端（onGoalEvent 存在）原设为 Number.MAX_SAFE_INTEGER（无穷大），
    // 导致 40 分钟超长执行无任何约束。改为合理上限 1M token（约 30 万字上下文，足够长任务但有兜底）
    const goalCfg = config.goal;
    const ELECTRON_TASK_BUDGET = 1_000_000;  // Phase 54：Electron 端合理上限，避免无穷大
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
            scope: currentGoalSpec ? String(currentGoalSpec.doneWhen) : '',
            constraints: [],
            doneWhen: currentGoalSpec?.doneWhen ?? [],
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

    // Phase 55 Task 6：用 ExecutionRouter 替代 orchestrationEnabled 判定
    // executionRouter 未注入时降级到 legacy（保持向后兼容，走原多 Agent 编排路径）
    const route = executionRouter
      ? executionRouter.route(plan, {
          mode: config.goal?.executionRouter?.mode ?? 'auto',
          explicitRoute: config.goal?.executionRouter?.explicitRoute,
          singleAgentMaxSteps: config.goal?.executionRouter?.singleAgentMaxSteps ?? 2,
          dagMaxDomains: config.goal?.executionRouter?.dagMaxDomains ?? 1,
        })
      : 'legacy';

    switch (route) {
      case 'single':
        // 走单 Agent 串行路径（复用现有 for 循环逻辑，提取为独立函数）
        await executePlanWithSingleAgent(plan);
        break;
      case 'dag':
        await executePlanWithDag(plan);
        break;
      case 'compose':
        await executePlanWithCompose(plan);
        break;
      case 'legacy':
        // 旧路径 fallback（原多 Agent 编排逻辑，验证通过后删除见设计文档第 9 节）
        await executePlanWithMultiAgent(plan);
        break;
    }

    // Phase 55 Task 6：原串行 for 循环已提取为 executePlanWithSingleAgent 函数（见下方定义）
    // 以下 for 循环体保留作为函数源代码参考，用 if (false as boolean) 临时禁用（避免常量折叠导致类型窄化）
    if (false as boolean)
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
      // Phase 54：step_update running
      emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'running' });

      try {
        const classifyResult = await classifier.classify({ query: step.description });
        const routeDecision = await modelRouter.route(classifyResult);
        const stepFallbackNotice = notifyRoutingFallback(routeDecision);
        if (stepFallbackNotice) addSystemMessage(stepFallbackNotice);
        const client = clientManager.get(routeDecision.providerId);
        if (!client || !client.isReady()) {
          step.status = 'failed';
          step.error = `提供商 ${routeDecision.providerId} 不可用`;
          addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
          continue;
        }

        let stepContent = '';
        const stepAbort = new AbortController();
        abortControllerRef.current = stepAbort;
        for await (const event of agentLoop.run({
          userMessage: step.description,
          llmClient: client,
          routeDecision,
          conversationHistory: conversationHistoryRef.current,
          systemPrompt: systemPromptRef.current,
          signal: stepAbort.signal,
          onConfirmTool: async (toolName, args) => {
            // Phase 54 修复：自主度模式判定——auto/semi 直接批准
            const mode = (config.autonomy?.defaultMode ?? 'semi') as AutonomyMode;
            if (!AUTONOMY_BEHAVIOR[mode].requireToolConfirmation && toolName !== 'ask_user') {
              return true;
            }
            return new Promise<boolean>(resolve => {
              pendingConfirmRef.current = {
            resolve: (r) => resolve(typeof r === 'boolean' ? r : r.approved),
            toolName,
          };
              const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
              addSystemMessage(`⚠️  目标步骤 · 工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`);
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
          const taskStatus = tracker.recordTaskUsage(event.usage);
          const taskUsagePercent = tracker.getTaskUsagePercent();
          if (taskStatus === 'exceeded' || taskUsagePercent >= 1) {
            addSystemMessage('⏹ 任务级 Token 预算已耗尽，goal 执行中止');
            step.status = 'failed';
            step.error = '任务级 Token 预算耗尽';
            gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
            plan.status = 'failed';
            break;
          }
          // Phase 43：使用 config.goal.softStopRatio 作为软停止阈值（默认 0.9）
          if (taskUsagePercent >= softStopRatio) {
            addSystemMessage(`⚠️ 任务级 Token 预算接近上限 (${(taskUsagePercent * 100).toFixed(0)}%，软停止阈值 ${(softStopRatio * 100).toFixed(0)}%)`);
          }
          // Phase 30：修复 goal-runner 缺失 setTodayTokensUsed 的 bug
          if (setTodayTokensUsed) {
            setTodayTokensUsed(prev => prev + event.usage.totalTokens);
          }
          // 预算检查：超限时中止后续步骤，避免长时间运行的 goal 无限消耗 token
          // checkBudget 返回 false 表示已超限（enforce 模式下）
          if (!tracker.checkBudget()) {
            addSystemMessage('⏹ Token 日预算已耗尽，goal 执行中止');
            step.status = 'failed';
            step.error = 'Token 预算耗尽';
            gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
            plan.status = 'failed';
            break;
          }
        }
        // Phase 30：token_profile 事件由 profiler 内部记录，无需额外处理
      }

        // 用户中断时，当前步骤标记为 failed 而非 completed
        if (stepAbort.signal.aborted) {
          step.status = 'failed';
          step.error = '用户中断';
          gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
          addSystemMessage(`⏸ 步骤 ${step.id} 已中断`);
          plan.status = 'failed';
          break;
        }
        step.status = 'completed';
        step.completedAt = Date.now();
        step.result = stepContent.slice(0, 200);
        addSystemMessage(renderGoalProgressText(plan));
        conversationHistoryRef.current.push({ role: 'user', content: step.description });
        conversationHistoryRef.current.push({ role: 'assistant', content: stepContent });
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
        }

        // Phase 21 Task 2：更新对应 gate 状态为 passed
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
            const { compressed } = await contextManager.compressEnhanced(conversationHistoryRef.current);
            conversationHistoryRef.current = compressed;
            addSystemMessage('📦 上下文已压缩（步骤间）');
          }
        }
        addSystemMessage(`✅ 步骤 ${step.id} 完成`);
        // Phase 54：step_update completed
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
        // Phase 21 Task 2：更新对应 gate 状态为 failed
        gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
        addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
        addSystemMessage(renderGoalProgressText(plan));
        // Phase 54：step_update failed
        emit({
          type: 'step_update',
          goalId: gid,
          stepId: step.id,
          status: 'failed',
          error: step.error,
          durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
        });
      }
    }

    // 验证目标完成度
    // Phase 43：根据 config.goal.auditMode 控制验证与代码验证门的顺序/开关
    plan.completedAt = Date.now();
    const auditMode = goalCfg?.auditMode ?? 'completion_gate_first';
    if (auditMode === 'none') {
      plan.status = 'completed';
      addSystemMessage('⏭ 已跳过目标验证（auditMode=none）');
    } else if (auditMode === 'completion_gate_first') {
      await runCompletionGate(plan);
      await verifyPlan(plan);
    } else if (auditMode === 'reviewer_first') {
      await verifyPlan(plan);
      await runCompletionGate(plan);
    } else {
      // 'full' 或默认值：两者都执行，先 LLM 验证后代码验证门
      await verifyPlan(plan);
      await runCompletionGate(plan);
    }

    // Phase 55 Task 9：用 DualLoop + BoundedRecovery 替代迭代闭环
    // 旧迭代闭环代码保留为 P2 降级 fallback（见设计文档第 7 节）
    const dualLoopOrchestrator = dualLoopOrchestratorRef?.current ?? null;
    if (plan.status === 'failed' && config.phase49Integration?.dualLoopEnabled && dualLoopOrchestrator) {
      try {
        // 调用 DualLoopOrchestrator.runDualLoop（完整 inner/outer 循环）
        // 注意：不是调用 run 占位方法，而是调用包含完整双循环逻辑的 runDualLoop
        // BoundedRecovery 已在 orchestrator 内部启用（app-init.ts 通过 setBoundedRecovery 注入配置）
        const dualLoopSuccess = await runDualLoopPlan(plan, dualLoopOrchestrator);
        plan.status = dualLoopSuccess ? 'completed' : 'failed';
      } catch (error) {
        logger.warn('DualLoop 异常，降级到基础迭代闭环', { error: String(error) });
        addSystemMessage('⚠️ 高级恢复异常，降级到基础重跑');
        // 走旧迭代闭环 fallback
        await legacyIterativeLoop(plan);
      }
    } else {
      // DualLoop 未启用或 orchestrator 未注入，走旧迭代闭环
      await legacyIterativeLoop(plan);
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
    });

    currentPlanRef.current = null;
    setIsProcessing(false);
  }

  /**
   * Phase 55 Task 6：单 Agent 串行执行路径
   * 从 executeGoalPlan 提取的 for 循环逻辑：逐步骤运行 Agent Loop + 检查点 + 上下文压缩
   * 闭包变量（gid/emit/gateManager/tracker 等）直接复用，softStopRatio 在函数内重新计算
   * @param plan 目标计划
   */
  async function executePlanWithSingleAgent(plan: GoalPlan): Promise<void> {
    const softStopRatio = goalCfg?.softStopRatio ?? 0.9;
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
      // Phase 54：step_update running
      emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'running' });

      try {
        const classifyResult = await classifier.classify({ query: step.description });
        const routeDecision = await modelRouter.route(classifyResult);
        const stepFallbackNotice = notifyRoutingFallback(routeDecision);
        if (stepFallbackNotice) addSystemMessage(stepFallbackNotice);
        const client = clientManager.get(routeDecision.providerId);
        if (!client || !client.isReady()) {
          step.status = 'failed';
          step.error = `提供商 ${routeDecision.providerId} 不可用`;
          addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
          continue;
        }

        let stepContent = '';
        const stepAbort = new AbortController();
        abortControllerRef.current = stepAbort;
        for await (const event of agentLoop.run({
          userMessage: step.description,
          llmClient: client,
          routeDecision,
          conversationHistory: conversationHistoryRef.current,
          systemPrompt: systemPromptRef.current,
          signal: stepAbort.signal,
          onConfirmTool: async (toolName, args) => {
            // Phase 54 修复：自主度模式判定——auto/semi 直接批准
            const mode = (config.autonomy?.defaultMode ?? 'semi') as AutonomyMode;
            if (!AUTONOMY_BEHAVIOR[mode].requireToolConfirmation && toolName !== 'ask_user') {
              return true;
            }
            return new Promise<boolean>(resolve => {
              pendingConfirmRef.current = {
            resolve: (r) => resolve(typeof r === 'boolean' ? r : r.approved),
            toolName,
          };
              const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
              addSystemMessage(`⚠️  目标步骤 · 工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`);
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
          const taskStatus = tracker.recordTaskUsage(event.usage);
          const taskUsagePercent = tracker.getTaskUsagePercent();
          if (taskStatus === 'exceeded' || taskUsagePercent >= 1) {
            addSystemMessage('⏹ 任务级 Token 预算已耗尽，goal 执行中止');
            step.status = 'failed';
            step.error = '任务级 Token 预算耗尽';
            gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
            plan.status = 'failed';
            break;
          }
          // Phase 43：使用 config.goal.softStopRatio 作为软停止阈值（默认 0.9）
          if (taskUsagePercent >= softStopRatio) {
            addSystemMessage(`⚠️ 任务级 Token 预算接近上限 (${(taskUsagePercent * 100).toFixed(0)}%，软停止阈值 ${(softStopRatio * 100).toFixed(0)}%)`);
          }
          // Phase 30：修复 goal-runner 缺失 setTodayTokensUsed 的 bug
          if (setTodayTokensUsed) {
            setTodayTokensUsed(prev => prev + event.usage.totalTokens);
          }
          // 预算检查：超限时中止后续步骤，避免长时间运行的 goal 无限消耗 token
          // checkBudget 返回 false 表示已超限（enforce 模式下）
          if (!tracker.checkBudget()) {
            addSystemMessage('⏹ Token 日预算已耗尽，goal 执行中止');
            step.status = 'failed';
            step.error = 'Token 预算耗尽';
            gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
            plan.status = 'failed';
            break;
          }
        }
        // Phase 30：token_profile 事件由 profiler 内部记录，无需额外处理
      }

        // 用户中断时，当前步骤标记为 failed 而非 completed
        if (stepAbort.signal.aborted) {
          step.status = 'failed';
          step.error = '用户中断';
          gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
          addSystemMessage(`⏸ 步骤 ${step.id} 已中断`);
          plan.status = 'failed';
          break;
        }
        step.status = 'completed';
        step.completedAt = Date.now();
        step.result = stepContent.slice(0, 200);
        addSystemMessage(renderGoalProgressText(plan));
        conversationHistoryRef.current.push({ role: 'user', content: step.description });
        conversationHistoryRef.current.push({ role: 'assistant', content: stepContent });
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
        }

        // Phase 21 Task 2：更新对应 gate 状态为 passed
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
            const { compressed } = await contextManager.compressEnhanced(conversationHistoryRef.current);
            conversationHistoryRef.current = compressed;
            addSystemMessage('📦 上下文已压缩（步骤间）');
          }
        }
        addSystemMessage(`✅ 步骤 ${step.id} 完成`);
        // Phase 54：step_update completed
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
        // Phase 21 Task 2：更新对应 gate 状态为 failed
        gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
        addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
        addSystemMessage(renderGoalProgressText(plan));
        // Phase 54：step_update failed
        emit({
          type: 'step_update',
          goalId: gid,
          stepId: step.id,
          status: 'failed',
          error: step.error,
          durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
        });
      }
    }
  }

  /**
   * Phase 55 Task 6：DAG 引擎执行路径
   * DagEngine 未注入时降级到单 Agent 串行
   * TODO: Task 8 接入真实 DagEngine 类型——当前 DagEngine.execute 签名为
   *       execute(workflow: DagWorkflow, executor: (node, action) => Promise<unknown>)，
   *       与本任务的 (plan, options) 调用方式不同，需在 Task 8 中适配（GoalPlan → DagWorkflow 转换）
   * @param plan 目标计划
   */
  async function executePlanWithDag(plan: GoalPlan): Promise<void> {
    if (!dagEngine) {
      logger.warn('DagEngine 未注入，降级到单 Agent 串行');
      addSystemMessage('⚠️ DAG 引擎未启用，降级到串行执行');
      return executePlanWithSingleAgent(plan);
    }
    try {
      // Phase 55：dagEngine 类型暂为 unknown（Task 8 接入真实 DagEngine 类型）
      // 调用方式按任务描述占位，Task 8 会改为 GoalPlan → DagWorkflow 转换 + DagEngine.execute(workflow, executor)
      await (dagEngine as { execute: (plan: GoalPlan, options: {
        workerExecutor: WorkerExecutor | undefined;
        onStepComplete: (step: GoalStep) => void;
        onStepFailed: (step: GoalStep) => void;
      }) => Promise<void> }).execute(plan, {
        workerExecutor,
        onStepComplete: (step) => {
          blackboard?.addCompletedStep(step.id, 'coder', step.result ?? '');
          emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'completed' });
        },
        onStepFailed: (step) => {
          emit({
            type: 'step_update',
            goalId: gid,
            stepId: step.id,
            status: 'failed',
            error: step.error,
          });
        },
      });
    } catch (error) {
      logger.warn('DAG 引擎异常，降级到单 Agent 串行', { error: String(error) });
      addSystemMessage('⚠️ DAG 引擎异常，降级到串行执行');
      return executePlanWithSingleAgent(plan);
    }
  }

  /**
   * Phase 55 Task 6：CompositionalRouter 执行路径（占位，Task 11 完整实现）
   * 当前降级到 DAG
   * @param plan 目标计划
   */
  async function executePlanWithCompose(plan: GoalPlan): Promise<void> {
    // Phase 55 阶段 3 实现：CompositionalRouter.route(plan) → DagEngine.execute(composedPlan)
    // 当前降级到 DAG
    logger.warn('CompositionalRouter 未实现，降级到 DAG');
    addSystemMessage('⚠️ 组合路由未启用，降级到 DAG 执行');
    return executePlanWithDag(plan);
  }

  // Phase 55：legacy fallback 路径，验证通过后删除（见设计文档第 9 节）
  /**
   * Phase 54 Task 1：多 Agent 编排执行
   * 调用 Orchestrator.plan() 生成执行计划（依赖图 + 并行组 + 角色分配）
   * 按 parallelGroups 执行：组内并行（Promise.all），组间串行
   * 每个 Worker 的结果写入 Blackboard，供后续 Worker 读取（独立上下文 + 选择性传递）
   *
   * 设计要点：
   *   - Worker 间不共享 conversationHistory，仅通过 Blackboard 快照传递共识（独立上下文）
   *   - Orchestrator 分配 4 种角色（coder/searcher/tester/reviewer）（多角色任务）
   *   - WorkerExecutor 内部调用 ContextPacker 按角色权重打包上下文（选择性传递）
   *   - 任一 Worker 失败不中止整体（异常隔离），失败信息记录到 Blackboard
   */
  async function executePlanWithMultiAgent(plan: GoalPlan): Promise<void> {
    if (!orchestrator || !workerExecutor || !blackboard) {
      // 类型守卫：调用方应确保三者均已注入
      logger.warn('Phase 54 Task 1: orchestrator/workerExecutor/blackboard missing, falling back to serial');
      return;
    }

    addSystemMessage('🎭 Phase 54：启用多 Agent 协作编排');

    // 1. 初始化 Blackboard：写入当前目标（所有 Worker 可读）
    blackboard.setGoal(plan.description, 'executing');

    // 2. 调用 Orchestrator.plan() 生成执行计划
    let executionPlan: ExecutionPlan;
    try {
      executionPlan = await orchestrator.plan(plan);
      addSystemMessage(
        `📋 编排计划：${executionPlan.parallelGroups.length} 个并行组，${executionPlan.dependencies.length} 个依赖\n${executionPlan.analysisNotes}`,
      );
    } catch (error) {
      logger.warn('Phase 54 Task 1: Orchestrator.plan failed, falling back to serial', { error: String(error) });
      addSystemMessage('⚠️ 编排失败，回退到串行执行');
      // 回退：按顺序执行，角色统一为 coder
      for (const step of plan.steps) {
        if (abortControllerRef.current?.signal.aborted) break;
        await executeWorkerStep(plan, step, {
          role: 'coder',
          rolePrompt: '',
          likelyFiles: [],
          stepId: step.id,
          dependsOn: [],
        });
      }
      return;
    }

    // 3. 按 parallelGroups 执行：组内并行，组间串行
    for (const group of executionPlan.parallelGroups) {
      // 检查中断
      if (abortControllerRef.current?.signal.aborted) {
        addSystemMessage('⏸ 多 Agent 编排已暂停');
        plan.status = 'failed';
        return;
      }

      // 找到组内所有步骤（group 是 stepId 数组）
      const groupSteps = group
        .map(stepId => plan.steps.find(s => s.id === stepId))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);

      if (groupSteps.length === 0) continue;

      addSystemMessage(`▶ 并行组 [${group.join(',')}]：${groupSteps.length} 个步骤并行执行`);

      // 组内并行执行（Promise.all），任一失败不中断其他 Worker（异常隔离）
      await Promise.all(
        groupSteps.map(step => {
          // 从 dependencies 中找到该步骤的依赖信息（含角色分配）
          // StepDependency.assignedRole → executeWorkerStep.dep.role（字段名映射）
          const dep = executionPlan.dependencies.find(d => d.stepId === step.id);
          return executeWorkerStep(plan, step, dep
            ? {
                role: dep.assignedRole,
                rolePrompt: '',
                likelyFiles: dep.likelyFiles,
                stepId: dep.stepId,
                dependsOn: dep.dependsOn,
              }
            : {
                role: 'coder' as WorkerRole,
                rolePrompt: '',
                likelyFiles: [],
                stepId: step.id,
                dependsOn: [],
              });
        }),
      );
    }
  }

  /**
   * Phase 54 Task 1：执行单个 Worker 步骤
   * 构建 WorkerTask（注入 Blackboard 快照）→ 调用 WorkerExecutor.execute() → 更新 GoalStep + Blackboard
   *
   * @param plan 目标计划（用于更新 step 状态）
   * @param step 当前步骤
   * @param dep 依赖信息（含角色分配、likelyFiles）
   */
  async function executeWorkerStep(
    plan: GoalPlan,
    step: GoalStep,
    dep: { role: WorkerRole; rolePrompt: string; likelyFiles: string[]; stepId: number; dependsOn: number[] },
  ): Promise<WorkerResult> {
    // 检查中断
    if (abortControllerRef.current?.signal.aborted) {
      return {
        stepId: step.id,
        role: dep.role,
        success: false,
        conclusion: '用户中断',
        modifiedFiles: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    // 步骤执行前自动创建检查点（与串行路径保持一致）
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
    addSystemMessage(`▶ [${dep.role}] 步骤 ${step.id}/${plan.steps.length}: ${step.description}`);
    // Phase 54：step_update running + agent_activity（gid 来自 createGoalRunner 顶部）
    emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'running' });
    emit({
      type: 'agent_activity',
      goalId: gid,
      stepId: step.id,
      role: dep.role,
      activity: `步骤 ${step.id}/${plan.steps.length}: ${step.description}`,
      timestamp: Date.now(),
    });

    try {
      const classifyResult = await classifier.classify({ query: step.description });
      const routeDecision = await modelRouter.route(classifyResult);
      const stepFallbackNotice = notifyRoutingFallback(routeDecision);
      if (stepFallbackNotice) addSystemMessage(stepFallbackNotice);
      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        step.status = 'failed';
        step.error = `提供商 ${routeDecision.providerId} 不可用`;
        addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
        return {
          stepId: step.id,
          role: dep.role,
          success: false,
          conclusion: step.error,
          modifiedFiles: [],
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      }

      // 构建 WorkerTask：注入 Blackboard 快照（Worker 通过快照读取已完成步骤的结论）
      const workerTask: WorkerTask = {
        stepId: step.id,
        description: step.description,
        role: dep.role,
        rolePrompt: dep.rolePrompt,
        blackboardSnapshot: blackboard!.getSnapshot(),
      };

      const stepAbort = new AbortController();
      abortControllerRef.current = stepAbort;

      // 调用 WorkerExecutor.execute()——内部会注入角色 system prompt + Blackboard 上下文
      // 若 contextPacker 已注入（Task 2），还会调用 pack() 生成结构化上下文包（选择性传递可视化）
      // Phase 54 修复：工具确认尊重自主度模式——auto/semi 直接批准（requireToolConfirmation=false），
      // manual 才弹确认。原缺陷：Worker 总是等待用户确认，Electron 端无对应 UI 导致卡死
      // 修复：executeWorkerStep 是顶层函数，访问不到 handleGoalCommand 内的 autonomyBehavior，
      // 在此用 config 直接判定（与 AUTONOMY_BEHAVIOR 定义一致）
      const mode = (config.autonomy?.defaultMode ?? 'semi') as AutonomyMode;
      const requireToolConfirm = AUTONOMY_BEHAVIOR[mode].requireToolConfirmation;
      const workerResult = await workerExecutor!.execute(
        workerTask,
        client,
        routeDecision,
        conversationHistoryRef.current,
        systemPromptRef.current,
        stepAbort.signal,
        async (toolName, args) => {
          // auto/semi 模式：直接批准（与 sendChat 的 onConfirmTool 逻辑一致）
          if (!requireToolConfirm && toolName !== 'ask_user') {
            return true;
          }
          // manual 模式：设置 pendingConfirmRef 等待用户确认
          return new Promise<boolean>(resolve => {
            pendingConfirmRef.current = {
            resolve: (r) => resolve(typeof r === 'boolean' ? r : r.approved),
            toolName,
          };
            const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
            addSystemMessage(`⚠️  [${dep.role}] 步骤 ${step.id} · 工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`);
          });
        },
      );

      // 记录 token（任务级预算追踪 + 日预算累加）
      const totalTokens = workerResult.tokenUsage.inputTokens + workerResult.tokenUsage.outputTokens;
      if (totalTokens > 0) {
        tracker.record(
          {
            inputTokens: workerResult.tokenUsage.inputTokens,
            outputTokens: workerResult.tokenUsage.outputTokens,
            totalTokens,
          },
          {
            modelId: routeDecision.model.id,
            agentId: `worker-${dep.role}`,
            stepId: `step-${step.id}`,
          },
        );
        const taskStatus = tracker.recordTaskUsage({
          inputTokens: workerResult.tokenUsage.inputTokens,
          outputTokens: workerResult.tokenUsage.outputTokens,
          totalTokens,
        });
        if (taskStatus === 'exceeded') {
          addSystemMessage('⏹ 任务级 Token 预算已耗尽，goal 执行中止');
          plan.status = 'failed';
        }
        if (setTodayTokensUsed) {
          setTodayTokensUsed(prev => prev + totalTokens);
        }
        if (!tracker.checkBudget()) {
          addSystemMessage('⏹ Token 日预算已耗尽，goal 执行中止');
          plan.status = 'failed';
        }
      }

      // 用户中断
      if (stepAbort.signal.aborted) {
        step.status = 'failed';
        step.error = '用户中断';
        gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
        addSystemMessage(`⏸ [${dep.role}] 步骤 ${step.id} 已中断`);
        plan.status = 'failed';
        return workerResult;
      }

      if (workerResult.success) {
        step.status = 'completed';
        step.completedAt = Date.now();
        step.result = workerResult.conclusion.slice(0, 200);
        step.modifiedFiles = workerResult.modifiedFiles;
        // 写入 Blackboard：后续 Worker 通过 getSnapshot() 读取（独立上下文 + 选择性传递）
        blackboard!.addCompletedStep(step.id, dep.role, workerResult.conclusion);
        gateManager.updateGate(`step-${step.id}`, 'passed', step.result);
        addSystemMessage(`✅ [${dep.role}] 步骤 ${step.id} 完成`);
        // Phase 54：step_update completed + agent_activity
        emit({
          type: 'step_update',
          goalId: gid,
          stepId: step.id,
          status: 'completed',
          durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
        });
        emit({
          type: 'agent_activity',
          goalId: gid,
          stepId: step.id,
          role: dep.role,
          activity: `[${dep.role}] 步骤 ${step.id} 完成`,
          timestamp: Date.now(),
        });
      } else {
        step.status = 'failed';
        step.completedAt = Date.now();
        step.error = workerResult.conclusion;
        gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
        addSystemMessage(`❌ [${dep.role}] 步骤 ${step.id} 失败: ${workerResult.conclusion}`);
        // Phase 54：step_update failed
        emit({
          type: 'step_update',
          goalId: gid,
          stepId: step.id,
          status: 'failed',
          error: step.error,
          durationMs: step.startedAt ? Date.now() - step.startedAt : undefined,
        });
      }

      addSystemMessage(renderGoalProgressText(plan));
      return workerResult;
    } catch (error) {
      step.status = 'failed';
      step.completedAt = Date.now();
      step.error = error instanceof Error ? error.message : String(error);
      gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
      addSystemMessage(`❌ [${dep.role}] 步骤 ${step.id} 异常: ${step.error}`);
      return {
        stepId: step.id,
        role: dep.role,
        success: false,
        conclusion: step.error,
        modifiedFiles: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  /**
   * Phase 54 Task 4：调用 UnifiedReviewer 获取 reviewerResult
   * 将 plan.steps 的执行结果映射为 StepExecutionResult[]，调用 review() 获得 codeReview
   * 映射为 GoalAuditor.audit 的 reviewerResult 参数（三层仲裁的第三层）
   *
   * @returns reviewerResult，或 undefined（unifiedReviewer 未注入/调用失败时）
   */
  async function getReviewerResult(
    plan: GoalPlan,
  ): Promise<{ passed: boolean; evidence: string[]; severity?: 'info' | 'warning' | 'error' } | undefined> {
    if (!unifiedReviewer) return undefined;

    try {
      const verifyClassify = await classifier.classify({ query: plan.description });
      const verifyRoute = await modelRouter.route(verifyClassify);
      const verifyClient = clientManager.get(verifyRoute.providerId);
      if (!verifyClient || !verifyClient.isReady()) return undefined;

      // 将 GoalStep 执行结果映射为 StepExecutionResult[]
      const executionResults: StepExecutionResult[] = plan.steps
        .filter(s => s.status === 'completed' || s.status === 'failed')
        .map(s => ({
          stepId: s.id,
          success: s.status === 'completed',
          conclusion: s.result ?? s.error ?? '',
          modifiedFiles: s.modifiedFiles ?? [],
          durationMs: (s.completedAt ?? 0) - (s.startedAt ?? 0),
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          error: s.error,
        }));

      const reviewResult = await unifiedReviewer.review({
        plan,
        executionResults,
        llmClient: verifyClient,
        routeDecision: verifyRoute,
        conversationHistory: conversationHistoryRef.current,
      });

      // 映射 codeReview → reviewerResult（GoalAuditor.audit 的第三层入参）
      if (reviewResult.codeReview) {
        const hasCritical = reviewResult.codeReview.issues.some(i => i.severity === 'critical');
        const hasWarning = reviewResult.codeReview.issues.some(i => i.severity === 'warning');
        const severity: 'error' | 'warning' | 'info' = hasCritical ? 'error' : hasWarning ? 'warning' : 'info';
        return {
          passed: reviewResult.codeReview.passed,
          evidence: reviewResult.codeReview.issues.map(
            i => `${i.severity}: ${i.file}${i.line ? `:${i.line}` : ''} ${i.description}`,
          ),
          severity,
        };
      }
      return undefined;
    } catch (error) {
      logger.warn('Phase 54 Task 4: UnifiedReviewer.review failed (non-blocking)', { error: String(error) });
      return undefined;
    }
  }

  /**
   * Phase 50 Task 1：分析需求变更影响
   * 在用户追加/编辑需求时调用，若 requirementChangeEnabled 则用 analyzeChangeImpact 分析
   * 失败时 try/catch 降级返回 null
   *
   * @param before 变更前的需求文本
   * @param after 变更后的需求文本
   * @returns 变更影响分析结果，或 null（开关关闭/降级失败）
   */
  async function analyzeRequirementChange(
    before: string,
    after: string,
  ): Promise<{ needsReplan: boolean; reason: string; severity: string; affectedSteps: string[] } | null> {
    // 开关关闭时回退到原行为（返回 null，调用方不处理）
    if (!goalIntegration?.requirementChangeEnabled) {
      return null;
    }
    try {
      const isChange = isRequirementChange(
        { role: 'user', content: before },
        { role: 'user', content: after },
      );
      if (!isChange) {
        return { needsReplan: false, reason: '未检测到需求变更', severity: 'minor', affectedSteps: [] };
      }
      const change: RequirementChange = {
        type: 'edit',
        targetNodeId: 'user-input',
        before,
        after,
        impactedBranches: [],
        timestamp: Date.now(),
      };
      const currentPlan = currentPlanRef.current;
      const result = analyzeChangeImpact(
        change,
        currentPlan
          ? {
              description: currentPlan.description,
              steps: currentPlan.steps.map(s => ({
                id: s.id,
                description: s.description,
                status: s.status,
              })),
            }
          : undefined,
        // currentGoalSpec 只存了 doneWhen，这里补齐 analyzeChangeImpact 所需的完整结构
        currentGoalSpec
          ? { goal: '', scope: '', constraints: [], doneWhen: currentGoalSpec.doneWhen, stopIf: [] }
          : undefined,
      );
      addSystemMessage(`📝 需求变更分析: ${result.severity} - ${result.reason}`);
      return {
        needsReplan: result.needsReplan,
        reason: result.reason,
        severity: result.severity,
        affectedSteps: result.affectedSteps,
      };
    } catch (error) {
      logger.warn('analyzeRequirementChange failed (non-blocking)', { error: String(error) });
      return null;
    }
  }

  return { handleGoalCommand, executeGoalPlan, analyzeRequirementChange };
}

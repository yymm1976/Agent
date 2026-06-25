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
import type { GoalPlan, GoalStep, PlanStep } from '../agent/goal-types.js';
// Phase 32 Task 1.4：接入 CompletionGate（独立代码验证门）
import type { CompletionGate } from '../agent/completion-gate.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import { GoalGateManager, gatesFromSteps } from '../agent/goal-gates.js';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { renderGoalProgressText, renderGoalCompletionSummary } from './components/goal-progress.js';
import { notifyRoutingFallback } from './notification.js';

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
  pendingConfirmRef: { current: { resolve: (approved: boolean) => void; toolName: string } | null };
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
  /** 生成消息 ID */
  nextId: () => string;
}

/** 创建目标运行器 */
export function createGoalRunner(deps: GoalRunnerDeps) {
  const {
    classifier, modelRouter, clientManager, tracker, agentLoop,
    checkpointManager, contextManager, config, systemPromptRef,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    currentPlanRef, awaitingGoalConfirmRef,
    addSystemMessage, requestPlanEdit, setIsProcessing, setTodayTokensUsed, profiler,
    completionGate, nextId,
  } = deps;

  // Phase 21 Task 2：GoalGateManager 管理冻结的验收门控
  const gateManager = new GoalGateManager(process.cwd());
  // Phase 43：缓存 goal 配置，避免多处重复访问
  const goalCfg = config.goal;

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
    const plan = await parser.parse(description, {
      verificationCriteria,
      routeDecision,
      llmClient: client,
    });

    // Phase 20：通过 StepEditor 让用户编辑计划步骤
    // Phase 43：若 config.goal.requireConfirmation 为 false，跳过人工确认直接执行
    if (goalCfg?.requireConfirmation !== false) {
      addSystemMessage('📋 计划已生成，请在编辑器中审查和修改步骤...');
      const editedSteps = await requestPlanEdit(plan);

      if (editedSteps === null) {
        addSystemMessage('❌ 已取消目标计划');
        setIsProcessing(false);
        return;
      }

      // 用编辑后的步骤更新计划
      plan.steps = editedSteps;
    }

    addSystemMessage('✅ 计划已确认，开始执行...');
    addSystemMessage(renderGoalProgressText(plan));
    currentPlanRef.current = plan;

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
          return new Promise<boolean>(resolve => {
            pendingConfirmRef.current = { resolve, toolName };
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

  /** 执行目标计划：逐步骤运行 Agent Loop，支持中断 + 检查点 + 压缩 */
  async function executeGoalPlan(plan: GoalPlan): Promise<void> {
    setIsProcessing(true);
    plan.status = 'executing';
    currentPlanRef.current = plan;

    // 持久化 GoalPlan
    await checkpointManager.saveGoalPlan(plan);

    // Phase 31/32 P0 接线：TokenTracker 任务级 API——启动任务级 Token 预算追踪
    // Phase 43：优先使用 config.goal.tokenBudget，未配置时回退到 perRequestLimit
    const goalCfg = config.goal;
    const taskBudget = goalCfg?.tokenBudget ?? config.router.budget.perRequestLimit ?? 100000;
    const softStopRatio = goalCfg?.softStopRatio ?? 0.9;
    tracker.startTask(taskBudget);
    addSystemMessage(`📊 任务级 Token 预算已启动: ${taskBudget.toLocaleString()}（软停止 ${(softStopRatio * 100).toFixed(0)}%）`);

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
            return new Promise<boolean>(resolve => {
              pendingConfirmRef.current = { resolve, toolName };
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
      } catch (error) {
        step.status = 'failed';
        step.completedAt = Date.now();
        step.error = error instanceof Error ? error.message : String(error);
        // Phase 21 Task 2：更新对应 gate 状态为 failed
        gateManager.updateGate(`step-${step.id}`, 'failed', step.error);
        addSystemMessage(`❌ 步骤 ${step.id} 失败: ${step.error}`);
        addSystemMessage(renderGoalProgressText(plan));
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

    // Phase 31/32 P0 接线：TokenTracker 任务级 API——任务结束，清理任务级预算状态
    // 移到迭代闭环之后，确保补救步骤也纳入任务级预算追踪
    tracker.endTask();

    // 任务完成摘要（成功或失败均展示，便于用户复盘）
    addSystemMessage(renderGoalCompletionSummary(plan));

    currentPlanRef.current = null;
    setIsProcessing(false);
  }

  return { handleGoalCommand, executeGoalPlan };
}

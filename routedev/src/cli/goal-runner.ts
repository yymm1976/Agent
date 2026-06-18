// src/cli/goal-runner.ts
// 目标分解与执行器：从 App.tsx 提取的 /goal 命令核心逻辑
// 包含 handleGoalCommand（解析+分解+确认）和 executeGoalPlan（执行+验证）

import type { LLMMessage, ILLMClient, ScenarioTier } from '../router/types.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { TokenTracker } from '../router/tracker.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { CheckpointManager } from '../harness/checkpoint-manager.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import type { AppConfig } from '../config/schema.js';
import type { GoalPlan, PlanStep } from '../agent/goal-types.js';
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
  systemPrompt: string;
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
  /** 生成消息 ID */
  nextId: () => string;
}

/** 创建目标运行器 */
export function createGoalRunner(deps: GoalRunnerDeps) {
  const {
    classifier, modelRouter, clientManager, tracker, agentLoop,
    checkpointManager, contextManager, config, systemPrompt,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    currentPlanRef, awaitingGoalConfirmRef,
    addSystemMessage, requestPlanEdit, setIsProcessing, nextId,
  } = deps;

  // Phase 21 Task 2：GoalGateManager 管理冻结的验收门控
  const gateManager = new GoalGateManager(process.cwd());

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
    addSystemMessage('📋 计划已生成，请在编辑器中审查和修改步骤...');
    const editedSteps = await requestPlanEdit(plan);

    if (editedSteps === null) {
      addSystemMessage('❌ 已取消目标计划');
      setIsProcessing(false);
      return;
    }

    // 用编辑后的步骤更新计划并执行
    plan.steps = editedSteps;
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

  /** 执行目标计划：逐步骤运行 Agent Loop，支持中断 + 检查点 + 压缩 */
  async function executeGoalPlan(plan: GoalPlan): Promise<void> {
    setIsProcessing(true);
    plan.status = 'executing';
    currentPlanRef.current = plan;

    // 持久化 GoalPlan
    await checkpointManager.saveGoalPlan(plan);

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
          systemPrompt,
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
          }
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
    plan.status = 'verifying';
    plan.completedAt = Date.now();
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
          },
          gateManager.getGates() ?? undefined,
        );
        plan.verificationResult = result;
        plan.status = result.passed ? 'completed' : 'failed';
        const passedIcon = result.passed ? '✅' : '⚠️';
        addSystemMessage(
          `${passedIcon} 验证结果 (置信度 ${(result.confidence * 100).toFixed(0)}%): ${result.reasoning}\n${result.missingItems.length > 0 ? `缺失项: ${result.missingItems.join('; ')}` : ''}`,
        );
      }
    } catch (error) {
      logger.error('Goal verification failed', { error: String(error) });
      plan.status = 'completed';
    }

    // 任务完成摘要（成功或失败均展示，便于用户复盘）
    addSystemMessage(renderGoalCompletionSummary(plan));

    currentPlanRef.current = null;
    setIsProcessing(false);
  }

  return { handleGoalCommand, executeGoalPlan };
}

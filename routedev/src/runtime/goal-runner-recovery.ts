// src/runtime/goal-runner-recovery.ts
// 目标运行器·错误恢复模块：验证、补救、迭代闭环、双循环恢复、冷启动恢复
// 从原 goal-runner.ts 拆分（Phase 79 Task 2），行为不变仅文件拆分
//
// 职责：
//   - verifyPlan：LLM 验证目标完成度（含对抗性验证 + GoalAuditor 三层审计）
//   - runCompletionGate：独立代码验证门（typecheck/lint/tests）
//   - executeRemediationStep：执行单个补救步骤（迭代闭环专用）
//   - legacyIterativeLoop：旧迭代闭环 fallback（DualLoop 未启用或异常时使用）
//   - runDualLoopPlan：DualLoop 双循环恢复（含 BoundedRecovery）
//   - getReviewerResult：调用 UnifiedReviewer 获取 reviewerResult（verifyPlan 辅助）
//   - resumeGoalPlan：从持久化的 PersistedGoal 恢复执行（冷启动恢复）

import type { GoalRunnerCtx } from './goal-runner-core.js';
import type { GoalPlan, GoalPlanStatus, GoalStep, GoalEvent } from '../agent/goal-types.js';
// Phase 55 Task 9：DualLoop + BoundedRecovery 替代迭代闭环
import type { DualLoopParams } from '../agent/dual-loop-types.js';
import type { StepExecutionResult } from '../agent/task-orchestrator-types.js';
import type { PersistedGoal } from '../agent/goal-persistence.js';
// Phase 54 Task 5：自主度行为映射（auto/semi/manual → 具体行为开关）
import { AUTONOMY_BEHAVIOR, type AutonomyMode } from '../config/schema.js';
// Phase 60：跨模型审查接线——高风险任务用不同模型交叉审查
import { CrossModelReviewer } from '../agent/cross-model-reviewer.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import { attestPlan } from '../agent/plan-attestation.js';
import { notifyRoutingFallback } from './notification.js';
import { logger } from '../utils/logger.js';
import { MAX_CONTEXT_ITEMS } from './goal-runner-core.js';

/**
 * 创建恢复模块函数
 *
 * @param ctx 共享上下文（由 createGoalRunner 创建并传入）
 * @returns { verifyPlan, runCompletionGate, executeRemediationStep, legacyIterativeLoop, runDualLoopPlan, getReviewerResult, resumeGoalPlan }
 */
export function createRecoveryFunctions(ctx: GoalRunnerCtx) {
  const {
    classifier, modelRouter, clientManager, tracker, agentLoop,
    config, systemPromptRef, conversationHistoryRef,
    pendingConfirmRef, abortControllerRef,
    // F-022：setTodayTokensUsed 解构已移除（goal-bridge.ts 从未传入此字段，原为死代码）
    addSystemMessage, setIsProcessing,
    completionGate,
    goalAuditor, goalPersistence,
    unifiedReviewer,
    dualLoopOrchestratorRef,
    onToolConfirmRequest,
  } = ctx.deps;
  // F-023：currentGoalSpec 解构已移除（永远为 null，无实际消费方）
  const { emit, gid, gateManager, goalIntegration } = ctx;

  // Phase 54 Task 4：缓存最近一次 runCompletionGate 的 typecheck/lint/tests 结果
  // 供 verifyPlan 中 GoalAuditor.audit 的 completion_gate 层使用（修复原接入缺陷：未传客观验证结果）
  let lastGateChecks: { typecheck: boolean; lint: boolean; tests: boolean } | null = null;

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
              // F-022：setTodayTokensUsed 调用已移除（原为死代码）
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
              // F-023：currentGoalSpec 已移除（永远为 null），doneWhen 改为空数组
              spec: { doneWhen: [] },
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
      plan.status = 'failed';
      return false;
    }
    return true;
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
          const failedDetails = failedChecks.map(c => `  • ${c.name}: ${c.output.slice(0, MAX_CONTEXT_ITEMS)}`).join('\n');
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
        onModelSuccess: modelId => modelRouter.recordModelSuccess(modelId),
        onModelFailure: modelId => modelRouter.recordModelFailure(modelId),
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
            const argsStr = JSON.stringify(args, null, 2).slice(0, MAX_CONTEXT_ITEMS);
            addSystemMessage(`⚠️  补救步骤 · 工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`);
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
          // F-022：setTodayTokensUsed 调用已移除（原为死代码）
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
      step.result = stepContent.slice(0, MAX_CONTEXT_ITEMS);
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
          // Phase 55 修复：补救计划分解同样需要更长超时（与主路径一致）
          timeoutMs: 120000,
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
    orchestrator: import('../agent/dual-loop-orchestrator.js').DualLoopOrchestrator,
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
          // F-022：setTodayTokensUsed 调用已移除（原为死代码）
        },
      },
      completionGate,
      maxReruns: config.goalVerifier?.iterative?.maxRounds ?? 3,
      // Phase 60：跨模型审查接线——启用 autoCrossModelForHighRisk 时注入 CrossModelReviewer
      // 用 verifyClient 作为审查客户端（已路由到与内循环不同的模型），availableModels 从 router 获取
      // Phase 81 Task 4：packs.adversarial.enabled 门控（extended-pack，默认 false 退出装配）
      //   未启用时不注入 crossModelReviewer；enabled:true 恢复装配
      ...((config.reviewerPolicy?.autoCrossModelForHighRisk && config.packs?.adversarial?.enabled === true)
        ? {
            crossModelReviewer: new CrossModelReviewer(
              verifyClient,
              execRoute.model.id,
              modelRouter.getAvailableModels().map(m => m.id),
            ),
          }
        : {}),
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

  // Phase 59：analyzeRequirementChange 函数已删除（批次1 requirementChangeEnabled 无价值 Integration）

  // ============================================================
  // Phase 77：冷启动恢复——resumeGoalPlan
  // ============================================================
  //
  // 设计：从 PersistedGoal 重建 GoalPlan，跳过目标分解+确认阶段，直接执行剩余步骤
  // - 已完成步骤（status='completed'）从 plan.steps 中过滤掉，executeGoalPlan 只跑剩余步骤
  // - in_progress / pending / failed 步骤都重新执行（in_progress 因中断未完成）
  // - token 预算继承：通过给 plan 注入起始 tokenUsed 让 tracker.startTask 后能感知已用量
  //   （实际 tokenUsed 由 tracker 内部维护，此处仅作信息提示，不修改 tracker 内部状态）
  // - 复用 executeGoalPlan 的执行核心（路径路由/DAG/压缩/检查点/验证/迭代闭环）
  //
  // 注意：不重构 executeGoalPlan，只新增 resumeGoalPlan
  /**
   * 从持久化的 PersistedGoal 恢复执行
   *
   * @param persistedGoal 持久化的 goal 数据（含已完成步骤状态）
   * @throws 当 PersistedGoal 数据无效时抛出 Error
   */
  async function resumeGoalPlan(persistedGoal: PersistedGoal): Promise<void> {
    setIsProcessing(true);

    // 校验 PersistedGoal 数据完整性
    if (!persistedGoal || !persistedGoal.plan || !Array.isArray(persistedGoal.plan.steps)) {
      throw new Error('resumeGoalPlan: PersistedGoal.plan.steps 无效');
    }
    if (persistedGoal.plan.steps.length === 0) {
      addSystemMessage('❌ 恢复失败：goal 无步骤');
      setIsProcessing(false);
      return;
    }

    // 从 PersistedGoal 重建 GoalPlan
    // - 保留原 id/createdAt，便于执行结果回写同一份持久化记录
    // - 过滤掉 status='completed' 的步骤（已完成的不再跑）
    // - 其他状态（in_progress/pending/failed/skipped）全部置为 pending 重新执行
    const remainingSteps: GoalStep[] = persistedGoal.plan.steps
      .filter(s => s.status !== 'completed')
      .map(s => ({
        id: Number(s.id),
        description: s.description,
        status: 'pending' as GoalStep['status'],
        dependencies: s.dependencies.map(d => Number(d)),
        domain: 'general' as GoalStep['domain'],
      }));

    if (remainingSteps.length === 0) {
      addSystemMessage('✅ 该 goal 的所有步骤已完成，无需恢复');
      setIsProcessing(false);
      return;
    }

    const plan: GoalPlan = {
      id: persistedGoal.id,
      description: persistedGoal.spec?.goal ?? '(resumed goal)',
      verificationCriteria: persistedGoal.spec?.doneWhen?.join('; '),
      steps: remainingSteps,
      status: 'pending',
      createdAt: persistedGoal.createdAt,
      attestation: persistedGoal.plan.attestation,
      archivedVersions: persistedGoal.plan.archivedVersions,
    };

    addSystemMessage(`🔄 Phase77 恢复目标: ${plan.description}`);
    addSystemMessage(`📊 剩余步骤 ${remainingSteps.length}/${persistedGoal.plan.steps.length}，已用 token ${persistedGoal.tokenUsed}/${persistedGoal.tokenBudget}`);

    attestPlan(plan, 'resume_from_persistence');

    // 持久化 goal 状态恢复为 executing（覆盖原 paused/executing 状态）
    if (goalPersistence) {
      try {
        await goalPersistence.save({
          ...persistedGoal,
          status: 'executing',
          updatedAt: Date.now(),
        });
      } catch (err) {
        logger.warn('Phase77 resumeGoalPlan: goalPersistence.save failed (non-blocking)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await ctx.executeGoalPlan(plan);
  }

  return { verifyPlan, runCompletionGate, executeRemediationStep, legacyIterativeLoop, runDualLoopPlan, getReviewerResult, resumeGoalPlan };
}

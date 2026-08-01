// src/runtime/goal-runner-confirm.ts
// 目标运行器·用户确认模块：计划编辑交互、目标澄清、修订历史
// 从原 goal-runner.ts 拆分（Phase 79 Task 2），行为不变仅文件拆分
//
// 职责：
//   - savePlanRevision：保存 plan 修订历史到 JSONL 文件
//   - clarifyGoalIfNeeded：检测目标描述中的模糊参数，通过 ask_user 澄清
//   - handleGoalCommand：处理 /goal 命令——解析目标、分解步骤、请求用户确认、触发执行

import type { GoalRunnerCtx } from './goal-runner-types.js';
import type { ILLMClient } from '../router/types.js';
import type { GoalPlan, GoalStep } from '../agent/goal-types.js';
// Phase 54 Task 5：自主度行为映射（auto/semi/manual → 具体行为开关）
import { AUTONOMY_BEHAVIOR, type AutonomyMode } from '../config/schema.js';
import { DifficultyAssessor } from '../agent/difficulty-assessor.js';
import { GoalParser } from '../agent/goal-parser.js';
import { archiveCurrentPlan, attestPlan } from '../agent/plan-attestation.js';
import { gatesFromSteps } from '../agent/goal-gates.js';
// Phase 71：Plan diff + 遗漏点分析——保存 plan 修订历史
import { toDiffPlanStep } from '../agent/plan-diff.js';
import { renderGoalProgressText } from './components/goal-progress.js';
import { notifyRoutingFallback } from './notification.js';
import { logger } from '../utils/logger.js';
// Phase 30 P1-1：goal 路径补 profiler.persistSession，需 path 解析输出目录
import * as path from 'node:path';
import { mkdir, appendFile } from 'node:fs/promises';

/**
 * 创建确认模块函数
 *
 * @param ctx 共享上下文（由 createGoalRunner 创建并传入）
 * @returns { savePlanRevision, clarifyGoalIfNeeded, handleGoalCommand }
 */
export function createConfirmFunctions(ctx: GoalRunnerCtx) {
  const {
    classifier, modelRouter, clientManager,
    config, systemPromptRef, conversationHistoryRef,
    pendingConfirmRef, currentPlanRef,
    addSystemMessage, requestPlanEdit, setIsProcessing,
    onToolConfirmRequest,
    nextId,
    goalId: depsGoalId,
  } = ctx.deps;
  const { emit, gid, gateManager, goalCfg } = ctx;

  /**
   * Phase 71：保存 plan 修订历史到 JSONL 文件
   * 路径来自 config.plan.revisionHistoryPath（默认 '.routedev/plan-revisions/'），
   * 文件名 <goalId>.jsonl，每行一个 revision（before/after/timestamp）
   * fail-open：写入失败只记日志，不阻塞 goal 流程
   */
  async function savePlanRevision(
    beforeSteps: GoalStep[],
    afterSteps: GoalStep[],
    reason: string,
  ): Promise<void> {
    try {
      const revisionDir = config.plan?.revisionHistoryPath ?? '.routedev/plan-revisions/';
      // F-003 修复：拒绝绝对路径，防止 revisionHistoryPath 越界到任意目录
      if (path.isAbsolute(revisionDir)) {
        logger.warn('[goal-runner] revisionHistoryPath 不允许绝对路径', { revisionDir });
        return;
      }
      const cwdResolved = path.resolve(process.cwd());
      const absDir = path.resolve(cwdResolved, revisionDir);
      // F-003 修复：边界校验——解析后路径必须位于 cwd 之内
      if (!absDir.startsWith(cwdResolved + path.sep) && absDir !== cwdResolved) {
        logger.warn('[goal-runner] revisionHistoryPath 越界', { absDir });
        return;
      }
      await mkdir(absDir, { recursive: true });
      const filePath = path.join(absDir, `${gid}.jsonl`);
      const revision = {
        revisedAt: new Date().toISOString(),
        reason,
        before: beforeSteps.map(s => toDiffPlanStep(s)),
        after: afterSteps.map(s => toDiffPlanStep(s)),
      };
      await appendFile(filePath, JSON.stringify(revision) + '\n', 'utf-8');
      logger.debug('[goal-runner] plan 修订历史已保存', { filePath, reason, beforeCount: beforeSteps.length, afterCount: afterSteps.length });
    } catch (err) {
      logger.warn('[goal-runner] 保存 plan 修订历史失败（fail-open）', {
        error: err instanceof Error ? err.message : String(err),
        reason,
      });
    }
  }

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
      // M2 修复：无引号时取 /goal 后的剩余整段（去掉 --verify 等选项），
      // 而非只取第一个非空白 token，避免多词目标被截断
      const noQuoteMatch = text.match(/^\/goal\s+(.+?)(?:\s+--verify\s+"[^"]*")?\s*$/);
      if (!noQuoteMatch) {
        addSystemMessage('❌ 用法: /goal "目标描述" [--verify "验证条件"]');
        setIsProcessing(false);
        return;
      }
      description = noQuoteMatch[1].trim();
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
    // 用澄清后的描述替换原描述（后续 parser 都用 clarifiedDescription）
    description = clarifiedDescription;

    // Phase 59：GoalPromptBuilder 已删除（批次1 无价值 Integration），enrichedDescription 直接用 description
    const enrichedDescription = description;

    const difficultyRoutingConfig = config.goal?.difficultyRouting;
    const difficultyAssessment = difficultyRoutingConfig?.enabled
      ? await new DifficultyAssessor({
          llmClient: client,
          modelId: routeDecision.model.id,
          confidenceThreshold: difficultyRoutingConfig.confidenceThreshold,
        }).assess(enrichedDescription)
      : undefined;

    const plan = await parser.parse(enrichedDescription, {
      verificationCriteria,
      routeDecision,
      llmClient: client,
      // Phase 55 修复：goal 分解是复杂任务，30s 默认超时不足，提升到 120s
      // 修复前：默认 30s，复杂目标分解易超时（OpenAI SDK "Request timed out."）
      timeoutMs: 120000,
    });
    if (difficultyAssessment) {
      plan.difficultyAssessment = difficultyRoutingConfig?.refineLevelAtExecution === false
        ? difficultyAssessment
        : new DifficultyAssessor().refineAssessment(difficultyAssessment, plan);
    }

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

      if (plan.attestation) {
        archiveCurrentPlan(plan, 'user_edit');
      }
      // Phase 71：保存修订历史（before=修订前 steps，after=用户编辑后 steps）
      savePlanRevision(plan.steps, editedSteps, 'user_edit');
      plan.steps = editedSteps;
    } else {
      // Phase 54 Task 5：auto 模式跳过确认时给出提示
      addSystemMessage(`⚙️ 自主度模式: ${autonomyMode}，跳过计划确认直接执行`);
    }

    attestPlan(plan, skipPlanConfirmation ? 'auto_confirm' : 'user_confirm');
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

    await ctx.executeGoalPlan(plan);
  }

  return { savePlanRevision, clarifyGoalIfNeeded, handleGoalCommand };
}

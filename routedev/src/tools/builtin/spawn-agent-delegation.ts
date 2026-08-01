// src/tools/builtin/spawn-agent-delegation.ts
// 子 Agent 生成工具：委托体系包装器
// 从 spawn-agent.ts 拆分（Phase 92 / TD-10），保持功能完全等价
//
// Phase 50 Task 3：子 Agent 委托体系接入

import type { AgentRole } from '../../agents/profiles/types.js';
import { DelegationContractManager, type DelegationContract } from '../../agents/delegation-contract.js';
import { DelegationEnforcer } from '../../agents/delegation-enforcer.js';
import type { DelegationTask, ParentAgent, ContextPackageInfo } from '../../agents/delegation-gate.js';
import { AntiAbuseDetector } from '../../agents/sub-agent-lifecycle.js';
import type { SubAgentScoreCard } from '../../agents/sub-agent-score-card.js';
// Phase 51 Task 2 / Task 4：委托四维约束 + call-scoped overlay
import { decideDelegation, createDelegationGuard } from '../../agents/delegation-policy.js';
// CR-4b：接入 result-schemas（子 Agent 结构化返回校验/格式化）
import { validateSubAgentResult, formatResultForParent, RESULT_SCHEMAS } from '../../agents/result-schemas.js';
// TD-01：validateSubAgentResult 的 schema 参数类型（替代 as any）
import type { ZodType } from 'zod';
// CR-4b：接入 activity-store（子 Agent 活动面板追踪）
import { truncatePreview, buildLineage } from '../../agents/activity-store.js';
// Phase 97 Part I Task I3：从 trace spans 提取 tool 序列（流程沉淀建议）
import { extractToolSequence } from '../../skills/coach.js';
import { logger } from '../../utils/logger.js';
import type {
  SubagentType,
  SpawnAgentFunction,
  SpawnAgentParams,
  SpawnResult,
  DelegationIntegrationDeps,
} from './spawn-agent-types.js';
import {
  resolveProfileForSubagent,
  createDetachedSessionContext,
  extractDetachedSessionAnswer,
} from './spawn-agent-utils.js';

/** SubagentType → AgentRole 映射（用于 ContextPacker，TD-01：统一为 AgentRole） */
function subagentTypeToPackerRole(subagentType: SubagentType): AgentRole {
  switch (subagentType) {
    case 'researcher': return 'researcher';
    case 'coder': return 'executor';
    case 'reviewer': return 'reviewer';
    // Phase 75-A4：review-plan 复用 reviewer 的上下文打包策略（只读审查类）
    case 'review-plan': return 'reviewer';
    // ReviewChain：planner 复用 planner 角色的上下文打包策略
    case 'planner': return 'planner';
    default: return 'custom';
  }
}

/**
 * Phase 97 Part E：按子 Agent 类型推断权限天花板
 * - researcher / reviewer / review-plan：只读（禁写禁执行）
 * - coder：沙箱写（可写文件，禁 shell/git 执行）
 * - general / planner / advisor：full（继承父权限）
 */
export function inferPermissionCeiling(subagentType: SubagentType): 'read_only' | 'sandboxed_write' | 'full' {
  switch (subagentType) {
    case 'researcher':
    case 'reviewer':
    case 'review-plan':
      return 'read_only';
    case 'coder':
      return 'sandboxed_write';
    default:
      return 'full';
  }
}

/**
 * Phase 97 Part E：批量等待完成语义判定
 * 多个子任务并行返回后，根据 completionMode 判定整体成败
 * - 'all'（默认）：全部成功才通过
 * - 'anyOf'：至少一个成功即通过
 * - 'minSucceed'：成功数 >= minCount 才通过
 * @returns { ok, succeeded, failed } 判定结果与成功/失败计数
 */
export function evaluateBatchCompletion(
  results: SpawnResult[],
  completionMode: 'all' | 'anyOf' | 'minSucceed' = 'all',
  minCount?: number,
): { ok: boolean; succeeded: number; failed: number } {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  switch (completionMode) {
    case 'anyOf':
      return { ok: succeeded >= 1, succeeded, failed };
    case 'minSucceed':
      return { ok: succeeded >= Math.max(1, minCount ?? 1), succeeded, failed };
    case 'all':
    default:
      return { ok: failed === 0, succeeded, failed };
  }
}

/**
 * Phase 50 Task 3：用委托体系包装 SpawnAgentFunction
 *
 * 包装行为（每步均 try/catch 降级，不阻塞 spawn）：
 *   1. contextPackerEnabled：用 ContextPacker.pack 按角色打包上下文，附加到 prompt
 *   2. delegationGateEnabled：用 DelegationGate.checkDelegationEligibility 检查资格
 *   3. delegationEnforcerEnabled：用 DelegationContractManager + DelegationEnforcer 创建契约并校验 spawn 调用
 *   4. lifecycleEnabled：用 SubAgentLifecycle 注册/转换状态 + AntiAbuseDetector 反滥用
 *   5. scoreCardEnabled：执行后用 SubAgentScoreCardCollector 记录评分卡
 *
 * 所有开关默认 false，未开启时 wrapper 是 passthrough（零开销）
 */
export function wrapSpawnAgentWithDelegation(
  innerFn: SpawnAgentFunction,
  deps: DelegationIntegrationDeps,
): SpawnAgentFunction {
  // 契约管理器（enforcer 接入时自动激活，解除死链）
  const contractManager = deps.delegationEnforcerEnabled ? new DelegationContractManager() : null;

  return async (params, options) => {
    const normalizedParams: SpawnAgentParams = typeof params === 'string'
      ? { description: params, prompt: params, model: 'inherit' }
      : params;
    const subagentType: SubagentType = normalizedParams.subagentType ?? 'general';
    const role = subagentTypeToPackerRole(subagentType);
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const profileId = `profile-${subagentType}`;
    let enrichedPrompt = normalizedParams.prompt;
    let contextTokens = 0;

    // CR-4b Step 0：委托三态策略——decideDelegation 决策 + createDelegationGuard 守卫
    // 未开启时 passthrough；refuse 直接拒绝 spawn，delegate 仅记录（spawn 本身即委派机制）
    if (deps.delegationPolicyEnabled && deps.delegationPolicy) {
      try {
        const decision = decideDelegation(normalizedParams.description, deps.delegationPolicy);
        if (decision.mode === 'refuse') {
          logger.warn('CR-4b: decideDelegation 拒绝 spawn', { reason: decision.reason });
          return { success: false, result: '', error: `委托策略拒绝: ${decision.reason}${decision.nextStep ? `；${decision.nextStep}` : ''}` };
        }
        if (decision.mode === 'delegate') {
          logger.debug('CR-4b: decideDelegation 建议委派', { targetRole: decision.targetRole });
        }
        // 用 createDelegationGuard 创建守卫并校验 spawn_agent 调用本身
        const guard = createDelegationGuard(deps.delegationPolicy);
        const guardResult = guard('spawn_agent', normalizedParams.description);
        if (guardResult.block) {
          logger.warn('CR-4b: delegationGuard 阻止 spawn', { reason: guardResult.reason });
          return { success: false, result: '', error: `委托守卫拦截: ${guardResult.reason}` };
        }
      } catch (error) {
        logger.warn('decideDelegation/createDelegationGuard failed (non-blocking)', { error: String(error) });
      }
    }

    // 1. ContextPacker：按角色打包上下文
    if (deps.contextPackerEnabled && deps.contextPacker) {
      try {
        const contextPackage = await deps.contextPacker.pack({
          role,
          taskId,
          sources: {
            taskBoundary: {
              designDoc: normalizedParams.description,
              readFiles: [],
              writeFiles: [],
              goal: normalizedParams.description,
              constraints: [],
            },
          },
          budgetTokens: 4000,
        });
        contextTokens = contextPackage.metadata.estimatedTokens;
        // 将打包后的上下文 sections 附加到 prompt
        const contextText = contextPackage.sections
          .map(s => `## ${s.title}\n${s.content}`)
          .join('\n\n');
        enrichedPrompt = `${normalizedParams.prompt}\n\n--- 上下文包 ---\n${contextText}`;
        logger.debug('Phase 50: ContextPacker packed context', {
          agentId,
          role,
          sections: contextPackage.sections.length,
          tokens: contextTokens,
        });
      } catch (error) {
        logger.warn('ContextPacker.pack failed (non-blocking)', { error: String(error) });
      }
    }

    // 2. DelegationGate：检查委托资格
    if (deps.delegationGateEnabled && deps.delegationGate) {
      try {
        const task: DelegationTask = {
          id: taskId,
          description: normalizedParams.description,
          taskDescription: normalizedParams.prompt,
        };
        const contextPkgInfo: ContextPackageInfo = {
          metadata: { estimatedTokens: Math.max(contextTokens, 200) },
        };
        const parent: ParentAgent = deps.parentAgent ?? { id: 'parent', activeSubAgents: [] };
        const gateResult = deps.delegationGate.checkDelegationEligibility(
          parent,
          role,
          task,
          contextPkgInfo,
        );
        if (!gateResult.ok) {
          logger.warn('Phase 50: DelegationGate rejected spawn', { reason: gateResult.reason });
          return { success: false, result: '', error: `委托门控拒绝: ${gateResult.reason}` };
        }
      } catch (error) {
        logger.warn('DelegationGate.checkDelegationEligibility failed (non-blocking)', { error: String(error) });
      }
    }

    // 3. DelegationEnforcer：创建契约 + 校验（enforcer 接入自动激活 contractManager）
    let enforcer: DelegationEnforcer | null = null;
    if (deps.delegationEnforcerEnabled && contractManager) {
      try {
        // Phase 97 Part E：权限天花板按子 Agent 类型推断（子权限不能高于父）
        //   researcher/reviewer 只读；coder 可写不可执行；general/planner full
        const ceiling = inferPermissionCeiling(subagentType);
        const contract: DelegationContract = {
          taskId,
          parentAgentId: 'parent',
          childAgentId: agentId,
          profileId,
          grant: {
            readFiles: [],
            allowedTools: ['file_read', 'file_write', 'file_edit', 'shell_exec', 'spawn_agent'],
            maxTokens: 10000,
            maxSteps: normalizedParams.maxIterations ?? 20,
            canChallenge: true,
            permissionCeiling: ceiling,
          },
          obligation: {
            mustFollowDesign: true,
            mustReportProgress: true,
            mustNotAlterGoal: true,
            challengeChannel: 'parent_only',
          },
          deliverable: {
            format: 'text',
            successCriteria: ['任务完成'],
            failureCriteria: ['超时', '错误'],
          },
        };
        contractManager.createContract(contract);
        enforcer = new DelegationEnforcer(contract);
        // 校验 spawn 调用本身是否被契约允许
        const check = enforcer.beforeToolCall('spawn_agent', {});
        if (!check.allowed) {
          logger.warn('Phase 50: DelegationEnforcer blocked spawn', { reason: check.reason });
          return { success: false, result: '', error: `委托执行拦截: ${check.reason}` };
        }
      } catch (error) {
        logger.warn('DelegationEnforcer setup failed (non-blocking)', { error: String(error) });
      }
    }

    // 4. Lifecycle：注册 + 转 running
    if (deps.lifecycleEnabled && deps.lifecycle) {
      try {
        deps.lifecycle.register(agentId, taskId, role, profileId);
        deps.lifecycle.transition(agentId, 'running');
      } catch (error) {
        logger.warn('SubAgentLifecycle register/transition failed (non-blocking)', { error: String(error) });
      }
    }

    // Phase 51 Task 4：detached session（call-scoped overlay）
    // 启用时为子 Agent 创建独立 session 作用域，仅最终答案返回父上下文
    let detachedScope: import('../../agents/subagent-session.js').SubAgentSessionScope | null = null;
    if (deps.detachedSessionEnabled && deps.profileManager) {
      try {
        const detachedProfile = resolveProfileForSubagent(deps.profileManager, subagentType);
        detachedScope = createDetachedSessionContext(
          deps.parentSessionId ?? agentId,
          role,
          detachedProfile,
          deps.parentAgent?.activeSubAgents.length ?? 0,
          {
            enabled: true,
            fullContextIsolation: true,
            subAgentMaxContextTokens: 4000,
            propagateToolCallsToParent: false,
          },
        );
        if (detachedScope) {
          logger.debug('Phase 51: detached session created', { agentId, role });
        }
      } catch (error) {
        logger.warn('createDetachedSessionContext failed (non-blocking)', { error: String(error) });
      }
    }

    // CR-4b：活动面板——启动活动记录（未开启时跳过）
    let activityId: string | undefined;
    if (deps.activityStoreEnabled && deps.activityStore) {
      try {
        activityId = deps.activityStore.startActivity({
          id: agentId,
          lineage: buildLineage(deps.parentRole, role),
          depth: deps.currentDepth ?? 0,
          role,
          taskPreview: truncatePreview(normalizedParams.description),
        });
      } catch (error) {
        logger.warn('activityStore.startActivity failed (non-blocking)', { error: String(error) });
      }
    }

    // 执行子 Agent
    let result: SpawnResult;
    try {
      result = await innerFn(
        { ...normalizedParams, prompt: enrichedPrompt },
        options,
      );
    } catch (error) {
      result = {
        success: false,
        result: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Phase 97 Part E：批量等待语义——部分失败时已成功子任务保留并返回部分结果
    // 单个 spawn 的成败已由 result 表达；completionMode/minCount 由父 Agent 在批量并行时
    // 通过 evaluateBatchCompletion 判定整体成败，此处用同一判定器评估本次 spawn 并记录日志（不吞失败）。
    if (normalizedParams.completionMode) {
      // Phase 97 Part E 接线：生产消费 evaluateBatchCompletion（单次 spawn 按批量语义评估）
      const batchEval = evaluateBatchCompletion(
        [result],
        normalizedParams.completionMode,
        normalizedParams.minCount,
      );
      logger.debug('Phase 97: spawn completion mode', {
        agentId,
        mode: normalizedParams.completionMode,
        minCount: normalizedParams.minCount,
        success: result.success,
        batchOk: batchEval.ok,
        succeeded: batchEval.succeeded,
        failed: batchEval.failed,
      });
    }

    // CR-4b：活动面板——完成活动记录
    if (activityId && deps.activityStore) {
      try {
        deps.activityStore.finishActivity(activityId, result.success ? 'success' : 'error', result.error);
      } catch (error) {
        logger.warn('activityStore.finishActivity failed (non-blocking)', { error: String(error) });
      }
    }

    // Phase 51 Task 4：从 detached session 提取最终答案（仅 scope 存在且执行成功时）
    if (detachedScope && result.success) {
      try {
        const finalAnswer = extractDetachedSessionAnswer(detachedScope);
        if (finalAnswer) {
          result.result = finalAnswer;
        }
      } catch (error) {
        logger.warn('extractDetachedSessionAnswer failed (non-blocking)', { error: String(error) });
      }
    }

    // CR-4b：子 Agent 结构化返回校验——validateSubAgentResult 校验 + formatResultForParent 格式化
    // 未开启时跳过；非 JSON 返回视为纯文本跳过；strict 模式校验失败置结果失败
    if (deps.resultSchemaEnabled && result.success && result.result) {
      try {
        let parsed: unknown = undefined;
        try {
          parsed = JSON.parse(result.result);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined && typeof parsed === 'object') {
          const roleStr = role as string;
          // TD-01：用 ZodType 替代 unknown，消除 schema as any
          const schemas = RESULT_SCHEMAS as Record<string, ZodType>;
          const schema = schemas[roleStr] ?? schemas.custom;
          const validated = validateSubAgentResult(parsed, schema);
          if (validated.success) {
            // 校验通过：用 formatResultForParent 格式化为父 Agent 可读文本
            result.result = formatResultForParent(parsed, roleStr);
          } else {
            // 校验失败：strict 置失败；否则按 fallbackToText 决定保留原文或返回校验错误
            const errMsg = `[子 Agent 返回值校验失败]\n${validated.errors.join('\n')}`;
            if (deps.resultSchemaStrict) {
              result.success = false;
              result.error = errMsg;
              result.result = '';
            } else if (!deps.resultSchemaFallbackToText) {
              result.result = errMsg;
            }
          }
        }
      } catch (error) {
        logger.warn('resultSchema validate/format failed (non-blocking)', { error: String(error) });
      }
    }

    // 5. Lifecycle：转 completed/failed + 累计 token + 反滥用检测
    if (deps.lifecycleEnabled && deps.lifecycle) {
      try {
        deps.lifecycle.transition(agentId, result.success ? 'completed' : 'failed', result.error);
        if (result.tokenUsage) {
          const totalTokens = (result.tokenUsage.inputTokens ?? 0) + (result.tokenUsage.outputTokens ?? 0);
          deps.lifecycle.addTokens(agentId, totalTokens);
          deps.lifecycle.incrementStep(agentId);
        }
        // AntiAbuseDetector：检测活跃子 Agent 的频繁 challenge / 高 token 低效果
        const activeAgents = deps.lifecycle.getActive();
        const abuseChallenges = AntiAbuseDetector.detectFrequentChallenges(activeAgents);
        const abuseLowEff = AntiAbuseDetector.detectLowEfficiency(activeAgents);
        if (abuseChallenges.length > 0 || abuseLowEff.length > 0) {
          logger.warn('Phase 50: AntiAbuseDetector detected issues', {
            frequentChallenges: abuseChallenges.length,
            lowEfficiency: abuseLowEff.length,
          });
        }
      } catch (error) {
        logger.warn('SubAgentLifecycle post-execution failed (non-blocking)', { error: String(error) });
      }
    }

    // 6. ScoreCard：收集评分卡
    if (deps.scoreCardEnabled && deps.scoreCardCollector) {
      try {
        const totalTokens = result.tokenUsage
          ? (result.tokenUsage.inputTokens ?? 0) + (result.tokenUsage.outputTokens ?? 0)
          : 0;
        const card: SubAgentScoreCard = {
          taskId,
          agentId,
          role,
          profileId,
          modelId: 'spawn-agent',
          tokenUsage: {
            input: result.tokenUsage?.inputTokens ?? 0,
            output: result.tokenUsage?.outputTokens ?? 0,
            total: totalTokens,
          },
          contextTokens,
          redundantReads: 0,
          challengeCount: 0,
          contractViolations: enforcer ? (enforcer.getStepCount() > (normalizedParams.maxIterations ?? 20) ? 1 : 0) : 0,
          deliverableQuality: result.success ? 80 : 0,
          parentSatisfaction: result.success ? 'accepted' : 'rejected',
          durationMs: 0,
        };
        deps.scoreCardCollector.record(card);
      } catch (error) {
        logger.warn('SubAgentScoreCardCollector.record failed (non-blocking)', { error: String(error) });
      }
    }

    // 7. Phase 52 Task 1：SkillLifecycleManager 记录本次 spawn 执行（fail-open）
    // 把 spawn_agent 调用视为一次"技能执行"，用 spawn:{role} 作为合成 skillId，
    // 累积记忆供未来 checkCreationTrigger/proposeRefinement 消费
    if (deps.skillLifecycleManager) {
      try {
        deps.skillLifecycleManager.recordExecution(`spawn:${role}`, {
          timestamp: Date.now(),
          taskDescription: normalizedParams.description,
          stepsTaken: [role],
          outcome: result.success ? 'success' : 'failure',
          failurePoint: result.success ? undefined : (result.error ?? 'unknown'),
          durationMs: 0,
        });
      } catch (error) {
        logger.warn('SkillLifecycleManager.recordExecution failed (non-blocking)', { error: String(error) });
      }

      // Phase 97 Part I Task I3：任务完成后基于 trace tool 序列检测重复工作流，生成沉淀建议
      // 建议不自动落盘——仅记录日志；用户批准后由上层走 SkillMarketManager.publish 落盘
      try {
        const spans = deps.trace?.getSpans() ?? [];
        const toolSequence = extractToolSequence(spans);
        const suggestion = deps.skillLifecycleManager.suggestSkillFromWorkflows(
          toolSequence,
          [normalizedParams.description],
        );
        if (suggestion) {
          logger.info('SkillLifecycleManager: workflow sedimentation suggestion', {
            suggestedName: suggestion.suggestedName,
            reason: suggestion.reason,
            occurrences: suggestion.similarTaskCount,
          });
        }
      } catch (error) {
        logger.warn('SkillLifecycleManager.suggestSkillFromWorkflows failed (non-blocking)', { error: String(error) });
      }
    }

    return result;
  };
}

// src/tools/builtin/spawn-agent.ts
// 子 Agent 生成工具：并行处理独立子任务
// P1-6：Codex/Claude Code 都有子 Agent 能力，RouteDev 缺失
//
// 设计：
//   1. 工具本身不直接创建 AgentLoop（需要 LLM client 等运行时参数）
//   2. 通过注入的 spawnAgent 函数执行子任务
//   3. app-init.ts 负责创建 spawnAgent 函数并注入
//   4. 支持同步等待结果或返回任务 ID（未来扩展）
//
// Phase 38 Task 2：签名增强
//   - 新增 SpawnResult 类型（含 modifiedFiles）
//   - SpawnAgentFunction 改为对象参数：description/prompt/subagentType/maxIterations/isolated
//   - 向后兼容：旧 taskDescription 字符串参数自动转换为 { description, prompt }
//   - 防递归：通过 ToolRegistry.clone() + 移除 spawn_agent 实现（在 app-init.ts 中处理）

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { ToolRegistry } from '../registry.js';
// Phase 48 Task 4：仅引入类型，避免运行时循环依赖
import type { AgentProfileManager } from '../../agents/profiles/manager.js';
import type { AgentProfile, AgentRole } from '../../agents/profiles/types.js';
// Phase 50 Task 3：接入子 Agent 委托体系核心模块（默认 enabled: false，开关在 config.delegationIntegration）
import { ContextPacker, type AgentRole as PackerAgentRole } from '../../agents/context-packer.js';
import { DelegationGate, type DelegationTask, type ParentAgent, type ContextPackageInfo } from '../../agents/delegation-gate.js';
import { DelegationEnforcer } from '../../agents/delegation-enforcer.js';
import { DelegationContractManager, type DelegationContract } from '../../agents/delegation-contract.js';
import { SubAgentLifecycle, AntiAbuseDetector } from '../../agents/sub-agent-lifecycle.js';
import { SubAgentScoreCardCollector, type SubAgentScoreCard } from '../../agents/sub-agent-score-card.js';
import { logger } from '../../utils/logger.js';

/** 子 Agent 类型：决定可用工具集（白名单在 app-init.ts 中维护） */
export type SubagentType = 'general' | 'researcher' | 'coder' | 'reviewer' | 'advisor';

/**
 * SubagentType → AgentRole 映射
 * Phase 48 Task 4：用于在 AgentProfileManager 中查找对应的 profile
 *
 * 映射规则：
 *   - 'researcher' → 'researcher'
 *   - 'coder' → 'executor'（coder 在 Agent 体系中对应 executor 角色）
 *   - 'reviewer' → 'reviewer'
 *   - 'general' / 'advisor'：无对应 role，不使用 profile
 */
const SUBAGENT_TYPE_TO_ROLE: Partial<Record<SubagentType, AgentRole>> = {
  researcher: 'researcher',
  coder: 'executor',
  reviewer: 'reviewer',
};

/**
 * 子 Agent 角色到工具集白名单的映射
 * Phase 38 Task 2：角色工具集隔离
 *   - general：空集 = 全部工具（除 spawn_agent）
 *   - researcher：只读检索工具
 *   - coder：读写执行工具
 *   - reviewer：只读审查工具
 *   - advisor：空集 = 无工具权限（用于 /BTW 临时问答，仅做单次 LLM 调用）
 */
export const SUBAGENT_TOOL_WHITELIST: Record<SubagentType, Set<string>> = {
  general: new Set<string>(),  // 空集 = 全部工具（除 spawn_agent）
  researcher: new Set(['file_read', 'code_search', 'web_search', 'web_fetch', 'list_directory']),
  coder: new Set(['file_read', 'file_write', 'file_edit', 'shell_exec', 'git_op']),
  reviewer: new Set(['file_read', 'code_search', 'list_directory']),
  advisor: new Set<string>(),  // 空集 = 无工具权限（createChildRegistry 中特殊处理）
};

/**
 * 根据子 Agent 类型解析对应的 AgentProfile
 * Phase 48 Task 4
 *
 * 行为：
 *   1. 未传 profileManager 或 subagentType 无对应 role（general/advisor）→ 返回 null
 *   2. 调用 profileManager.resolveProfileForTask(role) 同步查询
 *      （调用方应先 await profileManager.loadAll()，否则回退到内置模板）
 *
 * @param profileManager AgentProfileManager 实例（可选，未传时返回 null）
 * @param subagentType 子 Agent 类型
 * @returns 匹配的 AgentProfile 副本，或 null
 */
export function resolveProfileForSubagent(
  profileManager: AgentProfileManager | undefined,
  subagentType: SubagentType,
): AgentProfile | null {
  if (!profileManager) return null;
  const role = SUBAGENT_TYPE_TO_ROLE[subagentType];
  if (!role) return null;
  // 同步方法：依赖 profileManager 已加载缓存
  return profileManager.resolveProfileForTask(role);
}

/**
 * 创建子 Agent 用的 ToolRegistry（防递归 + 角色白名单过滤）
 * Phase 38 Task 2
 *
 * 步骤：
 *   1. clone 父 registry（浅拷贝，工具对象共享引用）
 *   2. 移除 spawn_agent（防递归：子 Agent 物理上不能再派遣孙子 Agent）
 *   3. 若 subagentType 有非空白名单，只保留白名单中的工具
 *
 * Phase 48 Task 4：接入 AgentProfileManager
 *   - 新增可选参数 profileManager
 *   - 若 profileManager 提供了 profile 且 profile.allowedTools 非空，
 *     优先使用 profile 的工具白名单（覆盖硬编码 SUBAGENT_TOOL_WHITELIST）
 *   - 未传 profileManager 或未匹配到 profile 时行为不变（向后兼容）
 *
 * @param parentRegistry 父 Agent 的 registry
 * @param subagentType 子 Agent 类型（默认 general）
 * @param profileManager AgentProfileManager 实例（可选）
 * @returns 新的 ToolRegistry，已移除 spawn_agent 并按白名单过滤
 */
export function createChildRegistry(
  parentRegistry: ToolRegistry,
  subagentType: SubagentType = 'general',
  profileManager?: AgentProfileManager,
): ToolRegistry {
  const child = parentRegistry.clone();
  // 防递归：子 Agent 不能再派遣孙子 Agent
  child.unregister('spawn_agent');
  // general 类型：空集 = 全部工具（除 spawn_agent），直接返回
  if (subagentType === 'general') {
    return child;
  }
  // advisor 类型：无工具权限，移除所有工具
  if (subagentType === 'advisor') {
    for (const tool of child.list()) {
      child.unregister(tool.definition.name);
    }
    return child;
  }
  // Phase 48 Task 4：优先使用 profileManager 提供的 profile 工具白名单
  // 未传 profileManager 或未匹配到 profile 时回退到硬编码白名单（向后兼容）
  const profile = resolveProfileForSubagent(profileManager, subagentType);
  const hardcodedWhitelist = SUBAGENT_TOOL_WHITELIST[subagentType];
  const whitelist = (profile && profile.allowedTools.length > 0)
    ? new Set(profile.allowedTools)
    : hardcodedWhitelist;
  if (whitelist && whitelist.size > 0) {
    const namesToRemove: string[] = [];
    for (const tool of child.list()) {
      if (!whitelist.has(tool.definition.name)) {
        namesToRemove.push(tool.definition.name);
      }
    }
    for (const name of namesToRemove) {
      child.unregister(name);
    }
  }
  return child;
}

/**
 * 并行上限包装器：限制同时执行的子 Agent 数量
 * Phase 38 Task 2
 *
 * @param innerFn 原始 spawn 函数
 * @param maxConcurrent 最大并行数（默认 3）
 * @returns 带并行限制的 spawn 函数（附带 getActiveCount() 用于测试）
 */
export function createConcurrencyLimitedSpawnFn(
  innerFn: SpawnAgentFunction,
  maxConcurrent: number = 3,
): SpawnAgentFunction & { getActiveCount(): number } {
  let active = 0;
  const wrapped = (async (params: SpawnAgentParams | string, options?: { systemPrompt?: string; maxIterations?: number }) => {
    if (active >= maxConcurrent) {
      return {
        success: false,
        result: '',
        error: `已达到最大并行子 Agent 数 (${maxConcurrent})，请等待当前任务完成`,
      };
    }
    active++;
    try {
      return await innerFn(params, options);
    } finally {
      active--;
    }
  }) as SpawnAgentFunction & { getActiveCount(): number };
  wrapped.getActiveCount = () => active;
  return wrapped;
}

/** 子 Agent 执行结果 */
export interface SpawnResult {
  success: boolean;
  result: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** 子 Agent 修改的文件列表（可选，由执行器填充） */
  modifiedFiles?: string[];
  error?: string;
}

/** SpawnAgentFunction 参数对象 */
export interface SpawnAgentParams {
  /** 短标签（UI 显示用） */
  description: string;
  /** 给子 Agent 的详细指令 */
  prompt: string;
  /** 子 Agent 类型，默认 general */
  subagentType?: SubagentType;
  /** 子 Agent 最大迭代次数，默认 20 */
  maxIterations?: number;
  /** 是否使用独立上下文，默认 true */
  isolated?: boolean;
}

/**
 * 子 Agent 执行函数签名（由 app-init.ts 注入）
 * Phase 38 Task 2：增强为对象参数 + SpawnResult 返回类型
 *
 * 向后兼容：调用方可传入字符串（旧 taskDescription），自动转换为
 *   { description: taskDescription, prompt: taskDescription }
 */
export type SpawnAgentFunction = (
  params: SpawnAgentParams | string,
  options?: {
    /** 旧字段：子 Agent 系统提示（保留向后兼容） */
    systemPrompt?: string;
    /** 旧字段：最大迭代次数（保留向后兼容，新调用方应使用 params.maxIterations） */
    maxIterations?: number;
  },
) => Promise<SpawnResult>;

// ============================================================
// Phase 50 Task 3：子 Agent 委托体系接入
// ============================================================

/**
 * Phase 50 Task 3：委托体系集成依赖（由 app-init.ts 在开关开启时创建并注入）
 * 所有字段可选，未注入时回退到原行为（passthrough）
 */
export interface DelegationIntegrationDeps {
  /** contextPackerEnabled：ContextPacker 按角色打包上下文 */
  contextPackerEnabled?: boolean;
  contextPacker?: ContextPacker;
  /** delegationGateEnabled：DelegationGate 委托前检查资格 */
  delegationGateEnabled?: boolean;
  delegationGate?: DelegationGate;
  /** delegationEnforcerEnabled：DelegationEnforcer 执行中校验工具调用 */
  delegationEnforcerEnabled?: boolean;
  /** 注入的父 Agent 状态（用于门控并行计数与生命周期跟踪） */
  parentAgent?: ParentAgent;
  /** lifecycleEnabled：SubAgentLifecycle + AntiAbuseDetector 生命周期与反滥用 */
  lifecycleEnabled?: boolean;
  lifecycle?: SubAgentLifecycle;
  /** scoreCardEnabled：SubAgentScoreCardCollector 执行后收集评分 */
  scoreCardEnabled?: boolean;
  scoreCardCollector?: SubAgentScoreCardCollector;
}

/** SubagentType → PackerAgentRole 映射（用于 ContextPacker） */
function subagentTypeToPackerRole(subagentType: SubagentType): PackerAgentRole {
  switch (subagentType) {
    case 'researcher': return 'researcher';
    case 'coder': return 'executor';
    case 'reviewer': return 'reviewer';
    default: return 'custom';
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
      ? { description: params, prompt: params }
      : params;
    const subagentType: SubagentType = normalizedParams.subagentType ?? 'general';
    const role = subagentTypeToPackerRole(subagentType);
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const profileId = `profile-${subagentType}`;
    let enrichedPrompt = normalizedParams.prompt;
    let contextTokens = 0;

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
        const contract: DelegationContract = {
          taskId,
          parentAgentId: 'parent',
          childAgentId: agentId,
          profileId,
          grant: {
            readFiles: [],
            allowedTools: ['spawn_agent', 'file_read', 'file_write', 'file_edit', 'shell_exec'],
            maxTokens: 10000,
            maxSteps: normalizedParams.maxIterations ?? 20,
            canChallenge: true,
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

    return result;
  };
}

export class SpawnAgentTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'spawn_agent',
    description: '当用户需要并行处理多个独立子任务、隔离上下文提高专注度时，使用此工具生成子 Agent。子 Agent 有独立的迭代空间，结果返回给主 Agent。',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '短标签（UI 显示用，< 60 字符）',
        },
        prompt: {
          type: 'string',
          description: '给子 Agent 的详细指令（清晰、独立的任务，不依赖主 Agent 当前上下文）',
        },
        subagentType: {
          type: 'string',
          enum: ['general', 'researcher', 'coder', 'reviewer', 'advisor'],
          description: '子 Agent 类型，决定可用工具集。general=全部工具（除 spawn_agent），researcher=只读检索，coder=读写执行，reviewer=只读审查，advisor=无工具（仅单次 LLM 调用，用于 /BTW 临时问答）。默认 general。',
        },
        maxIterations: {
          type: 'number',
          description: '子 Agent 最大迭代次数（可选，默认 20）',
        },
        isolated: {
          type: 'boolean',
          description: '是否使用独立上下文（默认 true）',
        },
      },
      required: ['description', 'prompt'],
    },
    requiresApproval: true,
    category: 'system',
  };

  private spawnFn: SpawnAgentFunction;

  constructor(spawnFn: SpawnAgentFunction) {
    this.spawnFn = spawnFn;
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    // 向后兼容：旧 taskDescription 字符串参数
    const hasLegacy = typeof args.taskDescription === 'string';
    const hasDescription = typeof args.description === 'string';
    const hasPrompt = typeof args.prompt === 'string';

    if (!hasLegacy && !hasDescription) {
      errors.push('缺少必需参数: description');
    }
    if (!hasLegacy && !hasPrompt) {
      errors.push('缺少必需参数: prompt');
    }
    if (hasDescription && (args.description as string).length < 3) {
      errors.push('description 至少需要 3 个字符');
    }
    if (hasPrompt && (args.prompt as string).length < 10) {
      errors.push('prompt 至少需要 10 个字符，确保任务描述足够清晰');
    }
    // 旧字段长度校验（向后兼容）
    if (hasLegacy && (args.taskDescription as string).length < 10) {
      errors.push('taskDescription 至少需要 10 个字符，确保任务描述足够清晰');
    }
    if (args.maxIterations !== undefined && typeof args.maxIterations !== 'number') {
      errors.push('maxIterations 必须是数字');
    }
    if (args.subagentType !== undefined && !['general', 'researcher', 'coder', 'reviewer', 'advisor'].includes(args.subagentType as string)) {
      errors.push('subagentType 必须是 general/researcher/coder/reviewer/advisor 之一');
    }
    if (args.isolated !== undefined && typeof args.isolated !== 'boolean') {
      errors.push('isolated 必须是布尔值');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    // 向后兼容：旧 taskDescription 字符串参数 → 转换为新签名
    const legacyTaskDesc = args.taskDescription;
    const description = typeof args.description === 'string'
      ? (args.description as string)
      : (legacyTaskDesc as string);
    const prompt = typeof args.prompt === 'string'
      ? (args.prompt as string)
      : (legacyTaskDesc as string);

    const params: SpawnAgentParams = {
      description,
      prompt,
    };
    if (args.subagentType !== undefined) {
      params.subagentType = args.subagentType as SubagentType;
    }
    if (args.maxIterations !== undefined) {
      params.maxIterations = args.maxIterations as number;
    }
    if (args.isolated !== undefined) {
      params.isolated = args.isolated as boolean;
    }

    // 兼容旧 options.systemPrompt（保留透传，由 app-init.ts 处理）
    const options: { systemPrompt?: string; maxIterations?: number } = {};
    if (args.systemPrompt !== undefined) {
      options.systemPrompt = args.systemPrompt as string;
    }

    try {
      const result = await this.spawnFn(params, options);

      if (!result.success) {
        return {
          success: false,
          output: '',
          error: `子 Agent 执行失败: ${result.error ?? '未知错误'}`,
          durationMs: 0,
          metadata: {
            tokenUsage: result.tokenUsage,
            modifiedFiles: result.modifiedFiles,
          },
        };
      }

      return {
        success: true,
        output: result.result,
        durationMs: 0,
        metadata: {
          tokenUsage: result.tokenUsage,
          modifiedFiles: result.modifiedFiles,
          description: description.slice(0, 100),
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `子 Agent 生成失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}

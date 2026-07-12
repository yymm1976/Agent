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
import { ContextPacker } from '../../agents/context-packer.js';
import { DelegationGate, type DelegationTask, type ParentAgent, type ContextPackageInfo } from '../../agents/delegation-gate.js';
import { DelegationEnforcer } from '../../agents/delegation-enforcer.js';
import { DelegationContractManager, type DelegationContract } from '../../agents/delegation-contract.js';
import { SubAgentLifecycle, AntiAbuseDetector } from '../../agents/sub-agent-lifecycle.js';
import { SubAgentScoreCardCollector, type SubAgentScoreCard } from '../../agents/sub-agent-score-card.js';
// Phase 51 Task 2 / Task 4：委托四维约束 + call-scoped overlay
import { canDelegate, decideDelegation, createDelegationGuard, type DelegationPermission } from '../../agents/delegation-policy.js';
import { createSubAgentSession, extractFinalAnswer, type SubAgentSessionScope } from '../../agents/subagent-session.js';
// CR-4b：接入 result-schemas（子 Agent 结构化返回校验/格式化）
import { validateSubAgentResult, formatResultForParent, RESULT_SCHEMAS } from '../../agents/result-schemas.js';
// TD-01：validateSubAgentResult 的 schema 参数类型（替代 as any）
import type { ZodType } from 'zod';
// CR-4b：接入 activity-store（子 Agent 活动面板追踪）
import { AgentActivityStore, truncatePreview, buildLineage } from '../../agents/activity-store.js';
// Phase 52 Task 1：Skill 生命周期管理（spawn 完成后记录执行，仅类型引入避免循环依赖）
import type { SkillLifecycleManager } from '../../skills/skill-lifecycle.js';
import { logger } from '../../utils/logger.js';

/** 子 Agent 类型：决定可用工具集（白名单在 app-init.ts 中维护） */
export type SubagentType = 'general' | 'researcher' | 'coder' | 'reviewer' | 'advisor' | 'review-plan';

/**
 * SubagentType → AgentRole 映射
 * Phase 48 Task 4：用于在 AgentProfileManager 中查找对应的 profile
 *
 * 映射规则：
 *   - 'researcher' → 'researcher'
 *   - 'coder' → 'executor'（coder 在 Agent 体系中对应 executor 角色）
 *   - 'reviewer' → 'reviewer'
 *   - 'review-plan' → 'review-planner'（Phase 75-A4：Pre-flight plan review，扫 plan 内部冲突）
 *   - 'general' / 'advisor'：无对应 role，不使用 profile
 */
const SUBAGENT_TYPE_TO_ROLE: Partial<Record<SubagentType, AgentRole>> = {
  researcher: 'researcher',
  coder: 'executor',
  reviewer: 'reviewer',
  'review-plan': 'review-planner',
};

/**
 * 子 Agent 角色到工具集白名单的映射
 * Phase 38 Task 2：角色工具集隔离
 *   - general：空集 = 全部工具（除 spawn_agent）
 *   - researcher：只读检索工具
 *   - coder：读写执行工具
 *   - reviewer：只读审查工具
 *   - advisor：空集 = 无工具权限（用于 /BTW 临时问答，仅做单次 LLM 调用）
 *   - review-plan：只读审查工具（Phase 75-A4：Pre-flight plan review，主要读 plan + 文件）
 */
export const SUBAGENT_TOOL_WHITELIST: Record<SubagentType, Set<string>> = {
  general: new Set<string>(),  // 空集 = 全部工具（除 spawn_agent）
  researcher: new Set(['file_read', 'code_search', 'web_search', 'web_fetch', 'list_directory']),
  coder: new Set(['file_read', 'file_write', 'file_edit', 'shell_exec', 'git_op']),
  reviewer: new Set(['file_read', 'code_search', 'list_directory']),
  advisor: new Set<string>(),  // 空集 = 无工具权限（createChildRegistry 中特殊处理）
  'review-plan': new Set(['file_read', 'code_search', 'list_directory']),
};

// ============================================================
// 安全加固常量（V3-026 / spawn-agent 安全加固）
// ============================================================
/** model 字段白名单正则：仅允许字母、数字、点、下划线、短横线，长度 1-64 */
const ALLOWED_MODEL_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
/** task description / prompt 长度上限（防止超大 prompt 导致 token 耗尽） */
const MAX_TASK_LENGTH = 10_000;
/** allowedTools 数组长度上限 */
const MAX_TOOLS = 50;
/** 工具名格式：小写字母开头，仅含小写字母/数字/下划线 */
const TOOL_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

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
 * 委托上下文（Phase 51 Task 2）
 * I-3 修复：新增 currentRole 字段，原 currentRole 缺失导致 canDelegate
 * 把 currentRole 和 targetRole 都设为 targetRole，破坏目标合法性检查
 */
export interface DelegationContext {
  currentDepth: number;
  /** 当前 Agent 角色（I-3 修复：原缺失导致 canDelegate 参数错误） */
  currentRole: AgentRole;
  policy: {
    maxDepth: number;
    delegationTargets: Record<AgentRole, AgentRole[]>;
  };
  targetRole: AgentRole;
}

/**
 * 创建子 Agent 用的 ToolRegistry（防递归 + 角色白名单过滤 + 四维约束）
 * Phase 38 Task 2 / Phase 51 Task 2
 *
 * 改造点（Phase 51 Task 2）：
 *   - 旧模式：物理移除 spawn_agent 实现 1 层硬限制
 *   - 新模式：根据 delegationContext 的四维约束决定是否保留 spawn_agent
 *   - 未传 delegationContext 时退回物理移除（向后兼容）
 *
 * @param parentRegistry 父 Agent 的 registry
 * @param subagentType 子 Agent 类型（默认 general）
 * @param profileManager AgentProfileManager 实例（可选）
 * @param delegationContext 委托上下文（可选，Phase 51 Task 2）
 * @returns 新的 ToolRegistry
 */
export function createChildRegistry(
  parentRegistry: ToolRegistry,
  subagentType: SubagentType = 'general',
  profileManager?: AgentProfileManager,
  delegationContext?: DelegationContext,
): ToolRegistry {
  const child = parentRegistry.clone();

  // 旧模式：无 delegationContext 时退回物理移除（向后兼容）
  if (!delegationContext) {
    child.unregister('spawn_agent');
  } else {
    // 新模式：根据四维约束决定是否保留 spawn_agent
    // I-3 修复：原把 currentRole 和 targetRole 都设为 targetRole，破坏目标合法性检查
    // CR-4a：currentRole 缺失时默认 custom 角色，确保 canDelegate 不收到 undefined
    // TD-01：DelegationContext 字段已统一为 AgentRole 类型，无需 as any
    const currentRole: AgentRole = delegationContext.currentRole || 'custom';
    const permission = canDelegate(
      delegationContext.currentDepth,
      currentRole,
      delegationContext.targetRole,
      delegationContext.policy,
    );
    if (!permission.ok || (permission.nextDepth ?? 0) >= delegationContext.policy.maxDepth) {
      // 深度用尽或不可委派，移除 spawn_agent
      child.unregister('spawn_agent');
    }
    // 否则保留 spawn_agent，子 Agent 调用时会再次校验 canDelegate
  }

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
 * Phase 38 Task 2 / Phase 51 Task 2
 *
 * 改造点（Phase 51 Task 2）：
 *   - maxConcurrent 默认值从硬编码 3 改为从 config 读取（未传时仍用 3 保持兼容）
 *   - 消除 schema.ts:666(5) / spawn-agent.ts:159(3) / orchestrator-strategy.ts:26(3) 的 5/3/3 不一致
 *
 * @param innerFn 原始 spawn 函数
 * @param maxConcurrent 最大并行数（默认 3，建议从 config.agent.maxConcurrentSubAgents 传入）
 * @returns 带并行限制的 spawn 函数（附带 getActiveCount() 用于测试）
 */
export function createConcurrencyLimitedSpawnFn(
  innerFn: SpawnAgentFunction,
  maxConcurrent: number = 3,  // 保持默认 3 向后兼容；调用方应从 config 传入
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

// ============================================================
// Phase 51 Task 4：detached session 支持（call-scoped overlay）
// ============================================================

/**
 * 是否启用 detached session（Phase 51 Task 4）
 * 借鉴 Flue 的 call-scoped overlay——子 Agent 独立上下文作用域
 *
 * 未启用时（默认）：子 Agent 共享父上下文（旧行为）
 * 启用时：子 Agent 拥有独立 session，仅最终答案返回父上下文
 */
export interface DetachedSessionOptions {
  enabled: boolean;
  fullContextIsolation: boolean;
  subAgentMaxContextTokens: number;
  propagateToolCallsToParent: boolean;
}

/**
 * 创建 detached session 执行上下文
 * Phase 51 Task 4
 */
export function createDetachedSessionContext(
  parentSessionId: string,
  role: AgentRole,
  profile: AgentProfile | null,
  depth: number,
  options: DetachedSessionOptions,
): SubAgentSessionScope | null {
  if (!options.enabled || !profile) return null;
  return createSubAgentSession(
    parentSessionId,
    role,
    profile,
    depth,
  );
}

/**
 * 从 detached session 提取最终答案
 * Phase 51 Task 4
 */
export function extractDetachedSessionAnswer(scope: SubAgentSessionScope): string {
  return extractFinalAnswer(scope);
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
  /**
   * 指定 subagent 使用的模型 ID。必填，强制 dispatch 时写明 model，
   * 避免静默继承最贵模型（借鉴 Superpowers v6：一次 26 个 reviewer 全跑顶配的惨痛教训）。
   *
   * 取值语义：
   *   - 'inherit'：明确选择继承 AgentProfile.modelId（推荐写法）
   *   - 其他字符串：指定具体的 model id（如 'gpt-4o-mini'）
   *
   * Phase 75-A3 第二阶段已落地：字段强制必填，未传将由 Zod schema 拒绝工具调用。
   */
  model: string;
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
    /**
     * P0-4：父 Agent 已渲染的 system prompt 字节（借鉴 Claude Code forkSubagent）
     *
     * 当提供此字段时：
     *   1. 子 Agent 直接复用此 system prompt，不再重新渲染（保证 prompt cache 字节一致前缀）
     *   2. 调用方应同时通过 buildForkedMessages 构造字节一致的消息前缀
     *   3. 父 Agent 的 assistant 消息 + 占位 tool_result 保持完整，仅在末尾追加 per-child directive
     *
     * 未提供时（默认）：使用 systemPrompt 或回退默认提示，不影响现有行为
     */
    renderedSystemPrompt?: string;
    /**
     * P0-4：可选的预构造对话历史（与 renderedSystemPrompt 配合）
     * 由 buildForkedMessages 生成，确保 prompt cache 命中
     */
    forkedConversationHistory?: import('../../router/types.js').LLMMessage[];
  },
) => Promise<SpawnResult>;

/**
 * P0-4：构造 fork 子 Agent 的字节一致消息前缀（借鉴 Claude Code buildForkedMessages）
 *
 * 目标：让多个子 Agent 共享同一 prompt cache 前缀，仅末尾 directive 不同。
 *
 * 做法：
 *   1. 保留父 Agent 完整的 assistant 消息（含 tool_use blocks）
 *   2. 为每个 tool_use 生成完全相同的 placeholder tool_result（"[forked placeholder]"）
 *      —— 这是关键：tool_use 与 tool_result 必须配对，否则 LLM API 报错
 *   3. 在末尾追加 user 消息：per-child directive（子任务描述）
 *
 * @example
 * const forked = buildForkedMessages(parentAssistantMessage, '研究 X 库的 API');
 * // forked 可作为 conversationHistory 传给 spawnAgent
 *
 * @param parentAssistantContent 父 Agent 的 assistant 消息内容（含 tool_use）
 * @param childDirective 子任务指令（每个子 Agent 不同）
 * @returns 构造好的消息前缀，可作为 conversationHistory 传入
 */
export function buildForkedMessages(
  parentAssistantContent: string,
  childDirective: string,
): import('../../router/types.js').LLMMessage[] {
  // 简化实现：父 assistant + 占位 tool_result + 子 directive
  // 真实场景中 parentAssistantContent 应为 JSON 序列化的 tool_use blocks
  // 此处保留接口形状，未来可扩展为完整 tool_use/tool_result 配对
  return [
    {
      role: 'assistant',
      content: parentAssistantContent,
    },
    {
      role: 'user',
      content: '[forked tool_result placeholder]\n\n' + childDirective,
    },
  ];
}

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
  /** Phase 51 Task 4：detached session（call-scoped overlay），未开启时 passthrough */
  detachedSessionEnabled?: boolean;
  /** profileManager：detached session 创建时解析子 Agent profile */
  profileManager?: AgentProfileManager;
  /** 父 session id（detached session 创建用，默认用 agentId） */
  parentSessionId?: string;
  // CR-4b：委托三态策略（decideDelegation/createDelegationGuard），未开启时 passthrough
  delegationPolicyEnabled?: boolean;
  /** 委托策略对象（hardDelegationTypes/refuseIfSpecialistUnavailable/specialistAvailability） */
  delegationPolicy?: {
    hardDelegationTypes: Array<'frontend' | 'research' | 'review'>;
    refuseIfSpecialistUnavailable: boolean;
    specialistAvailability: Record<string, boolean>;
  };
  // CR-4b：子 Agent 结构化返回校验（validateSubAgentResult/formatResultForParent）
  resultSchemaEnabled?: boolean;
  /** 严格校验：校验失败时把 spawn 结果置为失败 */
  resultSchemaStrict?: boolean;
  /** 校验失败时是否回退为纯文本（true=保留原文，false=返回校验错误） */
  resultSchemaFallbackToText?: boolean;
  // CR-4b：子 Agent 活动面板（AgentActivityStore.startActivity/finishActivity）
  activityStoreEnabled?: boolean;
  activityStore?: AgentActivityStore;
  /** 当前委托深度（活动记录 lineage 与 depth 用） */
  currentDepth?: number;
  /** 父 Agent 角色（活动记录 lineage 用） */
  parentRole?: string;
  /** Phase 52 Task 1：SkillLifecycleManager，spawn 完成后记录执行（未注入时跳过） */
  skillLifecycleManager?: SkillLifecycleManager;
}

/** SubagentType → AgentRole 映射（用于 ContextPacker，TD-01：统一为 AgentRole） */
function subagentTypeToPackerRole(subagentType: SubagentType): AgentRole {
  switch (subagentType) {
    case 'researcher': return 'researcher';
    case 'coder': return 'executor';
    case 'reviewer': return 'reviewer';
    // Phase 75-A4：review-plan 复用 reviewer 的上下文打包策略（只读审查类）
    case 'review-plan': return 'reviewer';
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
        const contract: DelegationContract = {
          taskId,
          parentAgentId: 'parent',
          childAgentId: agentId,
          profileId,
          grant: {
            readFiles: [],
            allowedTools: ['file_read', 'file_write', 'file_edit', 'shell_exec'],
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

    // Phase 51 Task 4：detached session（call-scoped overlay）
    // 启用时为子 Agent 创建独立 session 作用域，仅最终答案返回父上下文
    let detachedScope: SubAgentSessionScope | null = null;
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
          enum: ['general', 'researcher', 'coder', 'reviewer', 'advisor', 'review-plan'],
          description: '子 Agent 类型，决定可用工具集。general=全部工具（除 spawn_agent），researcher=只读检索，coder=读写执行，reviewer=只读审查，advisor=无工具（仅单次 LLM 调用，用于 /BTW 临时问答），review-plan=Pre-flight plan review（执行 Task 1 前扫 plan 内部冲突，Phase 75-A4）。默认 general。',
        },
        maxIterations: {
          type: 'number',
          description: '子 Agent 最大迭代次数（可选，默认 20）',
        },
        isolated: {
          type: 'boolean',
          description: '是否使用独立上下文（默认 true）',
        },
        model: {
          type: 'string',
          description: '必填。指定 subagent 使用的模型 ID（Phase 75-A3）。传 "inherit"=继承 AgentProfile.modelId；传具体 model id（如 "gpt-4o-mini"）=使用该模型。强制必填以避免静默继承最贵模型。',
        },
      },
      required: ['description', 'prompt', 'model'],
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
    // 安全加固：task description / prompt / legacy taskDescription 长度上限
    if (hasDescription && (args.description as string).length > MAX_TASK_LENGTH) {
      errors.push(`description 过长 (上限 ${MAX_TASK_LENGTH} 字符)`);
    }
    if (hasPrompt && (args.prompt as string).length > MAX_TASK_LENGTH) {
      errors.push(`prompt 过长 (上限 ${MAX_TASK_LENGTH} 字符)`);
    }
    if (hasLegacy && (args.taskDescription as string).length > MAX_TASK_LENGTH) {
      errors.push(`taskDescription 过长 (上限 ${MAX_TASK_LENGTH} 字符)`);
    }
    if (args.maxIterations !== undefined) {
      if (typeof args.maxIterations !== 'number') {
        errors.push('maxIterations 必须是数字');
      } else if (!Number.isInteger(args.maxIterations) || args.maxIterations <= 0 || args.maxIterations > 100) {
        errors.push('maxIterations 必须是 1 到 100 之间的整数');
      }
    }
    if (args.subagentType !== undefined && !['general', 'researcher', 'coder', 'reviewer', 'advisor', 'review-plan'].includes(args.subagentType as string)) {
      errors.push('subagentType 必须是 general/researcher/coder/reviewer/advisor/review-plan 之一');
    }
    if (args.isolated !== undefined && typeof args.isolated !== 'boolean') {
      errors.push('isolated 必须是布尔值');
    }
    // Phase 75-A3：model 字段校验（必填，字符串）
    if (args.model === undefined) {
      errors.push('缺少必需参数: model（必须显式指定 model id 或 "inherit"）');
    } else if (typeof args.model !== 'string') {
      errors.push('model 必须是字符串（model id 或 "inherit"）');
    } else if (!ALLOWED_MODEL_PATTERN.test(args.model)) {
      // 安全加固：model 字段白名单校验，防止注入非法字符
      errors.push('model 格式非法（仅允许字母、数字、点、下划线、短横线，长度 1-64）');
    }
    // 安全加固：allowedTools 数组校验（若调用方提供，校验格式与数量）
    if (args.allowedTools !== undefined) {
      if (!Array.isArray(args.allowedTools)) {
        errors.push('allowedTools 必须是字符串数组');
      } else if (args.allowedTools.length > MAX_TOOLS) {
        errors.push(`allowedTools 数量过多 (上限 ${MAX_TOOLS} 个)`);
      } else {
        for (const tool of args.allowedTools) {
          if (typeof tool !== 'string' || !TOOL_NAME_PATTERN.test(tool)) {
            errors.push(`allowedTools 中存在非法工具名: ${String(tool)}`);
            break;
          }
        }
      }
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
      // Phase 75-A3：model 必填，schema 已强制校验，未传会在 validateArgs 被拒绝
      model: args.model as string,
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
    // P0-4：扩展 options 以支持 renderedSystemPrompt + forkedConversationHistory
    const options: {
      systemPrompt?: string;
      maxIterations?: number;
      renderedSystemPrompt?: string;
      forkedConversationHistory?: import('../../router/types.js').LLMMessage[];
    } = {};
    if (args.systemPrompt !== undefined) {
      options.systemPrompt = args.systemPrompt as string;
    }

    // P0-4：若调用方提供 parentAssistantContent（父 Agent 当前 assistant 消息内容），
    // 调用 buildForkedMessages 构造字节一致前缀，启用 prompt cache 共享。
    // 未提供时跳过，保持现有行为（子 Agent 独立上下文）。
    if (typeof args.parentAssistantContent === 'string' && args.parentAssistantContent.length > 0) {
      options.forkedConversationHistory = buildForkedMessages(
        args.parentAssistantContent,
        prompt,
      );
      // renderedSystemPrompt 透传：若调用方同时提供，则一并传递
      if (typeof args.renderedSystemPrompt === 'string') {
        options.renderedSystemPrompt = args.renderedSystemPrompt as string;
      }
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

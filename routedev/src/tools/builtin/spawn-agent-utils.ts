// src/tools/builtin/spawn-agent-utils.ts
// 子 Agent 生成工具：工具函数（归一化 / profile 解析 / 子 registry / 并行限制 / detached session / fork 消息）
// 从 spawn-agent.ts 拆分（Phase 92 / TD-10），保持功能完全等价

import type { AgentProfileManager } from '../../agents/profiles/manager.js';
import type { AgentProfile, AgentRole } from '../../agents/profiles/types.js';
import { ToolRegistry } from '../registry.js';
// Phase 51 Task 2 / Task 4：委托四维约束 + call-scoped overlay
import { canDelegate } from '../../agents/delegation-policy.js';
import { createSubAgentSession, extractFinalAnswer, type SubAgentSessionScope } from '../../agents/subagent-session.js';
import type {
  SubagentType,
  DelegationContext,
  DetachedSessionOptions,
  SpawnAgentFunction,
  SpawnAgentParams,
  SpawnResult,
} from './spawn-agent-types.js';
import {
  SUBAGENT_TYPE_TO_ROLE,
  SUBAGENT_TOOL_WHITELIST,
  TOOL_NAME_ALIASES,
} from './spawn-agent-types.js';

/** 将工具名归一化为运行时注册名 */
export function normalizeToolName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) return name;
  return TOOL_NAME_ALIASES[name] ?? name;
}

/** 批量归一化工具名（去重） */
export function normalizeToolNames(names: string[]): string[] {
  if (!Array.isArray(names)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const n = normalizeToolName(raw);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

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
  // 修复：profile.allowedTools 可能含历史别名（read_file/execute_command），必须归一化后再过滤
  const profile = resolveProfileForSubagent(profileManager, subagentType);
  const hardcodedWhitelist = SUBAGENT_TOOL_WHITELIST[subagentType];
  const profileAllowed = profile && profile.allowedTools.length > 0
    ? normalizeToolNames(profile.allowedTools)
    : [];
  const profileForbidden = profile && profile.forbiddenTools.length > 0
    ? new Set(normalizeToolNames(profile.forbiddenTools))
    : new Set<string>();
  const whitelist = profileAllowed.length > 0
    ? new Set(profileAllowed)
    : hardcodedWhitelist;
  if (whitelist && whitelist.size > 0) {
    const namesToRemove: string[] = [];
    for (const tool of child.list()) {
      const toolName = tool.definition.name;
      // 黑名单优先：显式禁止的工具始终移除
      if (profileForbidden.has(toolName)) {
        namesToRemove.push(toolName);
        continue;
      }
      if (!whitelist.has(toolName)) {
        namesToRemove.push(toolName);
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

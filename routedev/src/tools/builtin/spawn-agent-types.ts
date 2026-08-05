// src/tools/builtin/spawn-agent-types.ts
// 子 Agent 生成工具：类型定义、接口与纯数据常量
// 从 spawn-agent.ts 拆分（Phase 92 / TD-10），保持功能完全等价
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

// Phase 48 Task 4：仅引入类型，避免运行时循环依赖
import type { AgentProfileManager } from '../../agents/profiles/manager.js';
import type { AgentProfile, AgentRole } from '../../agents/profiles/types.js';
// Phase 50 Task 3：接入子 Agent 委托体系核心模块（默认 enabled: false，开关在 config.delegationIntegration）
import type { ContextPacker } from '../../agents/context-packer.js';
import type { DelegationGate, ParentAgent } from '../../agents/delegation-gate.js';
import type { SubAgentLifecycle } from '../../agents/sub-agent-lifecycle.js';
import type { SubAgentScoreCardCollector } from '../../agents/sub-agent-score-card.js';
// Phase 52 Task 1：Skill 生命周期管理（spawn 完成后记录执行，仅类型引入避免循环依赖）
import type { SkillLifecycleManager } from '../../skills/skill-lifecycle.js';
// CR-4b：接入 activity-store（子 Agent 活动面板追踪）
import type { AgentActivityStore } from '../../agents/activity-store.js';
// Phase 97 Part I Task I3：TraceCollector（提取 tool 序列生成流程沉淀建议）
import type { TraceCollector } from '../../harness/trace-collector.js';

/** 子 Agent 类型：决定可用工具集（白名单在 app-init.ts 中维护） */
/**
 * B-05A：对外暴露 3 个稳定角色 explore/implement/review；
 * 旧 7 角色（general/researcher/coder/reviewer/advisor/review-plan/planner）保留兼容映射。
 */
export type SubagentType =
  | 'explore' | 'implement' | 'review'
  | 'general' | 'researcher' | 'coder' | 'reviewer' | 'advisor' | 'review-plan' | 'planner';

/**
 * SubagentType → AgentRole 映射
 * Phase 48 Task 4：用于在 AgentProfileManager 中查找对应的 profile
 *
 * 映射规则：
 *   - 'researcher' → 'researcher'
 *   - 'coder' → 'executor'（coder 在 Agent 体系中对应 executor 角色）
 *   - 'reviewer' → 'reviewer'
 *   - 'review-plan' → 'review-planner'（Phase 75-A4：Pre-flight plan review，扫 plan 内部冲突）
 *   - 'planner' → 'planner'（ReviewChain：PM/架构师，拆需求 + 出设计方案，可写 context/ 文件）
 *   - 'general' / 'advisor'：无对应 role，不使用 profile
 */
export const SUBAGENT_TYPE_TO_ROLE: Partial<Record<SubagentType, AgentRole>> = {
  // B-05A 稳定角色 → 既有 role 映射
  explore: 'researcher',
  implement: 'executor',
  review: 'reviewer',
  researcher: 'researcher',
  coder: 'executor',
  reviewer: 'reviewer',
  'review-plan': 'review-planner',
  planner: 'planner',
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
  // B-05A 稳定角色：explore 默认只读（无 ask_user、无写入工具），implement 读写执行，review 只读审查+写审查报告
  explore: new Set(['file_read', 'file_search', 'code_search', 'list_directory', 'web_search', 'web_fetch']),
  implement: new Set(['file_read', 'file_write', 'file_edit', 'shell_exec', 'git_op']),
  review: new Set(['file_read', 'code_search', 'list_directory', 'file_write']),
  researcher: new Set(['file_read', 'code_search', 'web_search', 'web_fetch', 'list_directory']),
  coder: new Set(['file_read', 'file_write', 'file_edit', 'shell_exec', 'git_op']),
  reviewer: new Set(['file_read', 'code_search', 'list_directory', 'file_write']),
  advisor: new Set<string>(),  // 空集 = 无工具权限（createChildRegistry 中特殊处理）
  'review-plan': new Set(['file_read', 'code_search', 'list_directory']),
  planner: new Set(['file_read', 'file_write', 'list_directory']),
};

/**
 * 历史/文档遗留工具名 → 运行时真实工具名
 * 防止 profile.allowedTools 写 read_file 却对不上 registry 的 file_read
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  read_file: 'file_read',
  execute_command: 'shell_exec',
  run_tests: 'shell_exec',
  diff_view: 'git_op',
  code_map_explore: 'code_graph_query',
  find_callers: 'code_graph_query',
  find_callees: 'code_graph_query',
  analyze_impact: 'code_graph_query',
  search_code: 'code_search',
  bash: 'shell_exec',
  Read: 'file_read',
  Write: 'file_write',
  Edit: 'file_edit',
  Bash: 'shell_exec',
  Grep: 'code_search',
  Glob: 'list_directory',
};

// ============================================================
// 安全加固常量（V3-026 / spawn-agent 安全加固）
// ============================================================
/** model 字段白名单正则：仅允许字母、数字、点、下划线、短横线，长度 1-64 */
export const ALLOWED_MODEL_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
/** task description / prompt 长度上限（防止超大 prompt 导致 token 耗尽） */
export const MAX_TASK_LENGTH = 10_000;
/** allowedTools 数组长度上限 */
export const MAX_TOOLS = 50;
/** 工具名格式：小写字母开头，仅含小写字母/数字/下划线 */
export const TOOL_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

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

/** 子 Agent 执行结果 */
export interface SpawnResult {
  success: boolean;
  result: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** 子 Agent 修改的文件列表（可选，由执行器填充） */
  modifiedFiles?: string[];
  error?: string;
  /** Phase 97 Part E：子会话 ID（登记到 SubagentRegistry，UI 可检查/停止） */
  childSessionId?: string;
}

/** 批量等待完成模式（Phase 97 Part E：父 Agent 并行 spawn 多个子任务时的等待语义） */
export type CompletionMode = 'all' | 'anyOf' | 'minSucceed';

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
   * 指定 subagent 使用的模型 ID。B-05A 起改为可选（缺省 = 'inherit' 继承父 Agent 模型），
   * 降低 Flash 模型的调用摩擦；显式传具体 model id 仍生效（如 'gpt-4o-mini'）。
   *
   * 取值语义：
   *   - 'inherit'：继承父 Agent / AgentProfile 的模型（推荐写法）
   *   - 其他字符串：指定具体的 model id
   */
  model: string;
  /**
   * Phase 97 Part E：批量等待完成模式
   * - 'all'（默认）：全部成功才算整体成功
   * - 'anyOf'：任一成功即可
   * - 'minSucceed'：至少 minCount 个成功
   * 部分失败时已成功的子任务保留，不孤儿。
   */
  completionMode?: CompletionMode;
  /** 与 completionMode: 'minSucceed' 配合：最少成功数 */
  minCount?: number;
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
  /** Phase 97 Part I Task I3：TraceCollector，spawn 完成后提取 tool 序列生成流程沉淀建议（未注入时跳过） */
  trace?: TraceCollector;
}

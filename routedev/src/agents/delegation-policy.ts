// src/agents/delegation-policy.ts
// 智能委托策略——三态 allow / delegate / refuse
//
// 借鉴来源：
//   - ohmypi No Generic Backend Worker：通用任务主 Agent 自己做，不盲目派 specialist
//   - ohmypi Hard Delegation Policy：三态策略 + 专家不可用时拒绝而非静默降级
//   - ohmypi isFrontendUiTask 关键词双命中规则：action 与 artifact 必须同时命中
//
// 设计目标：
//   1. 纯函数实现，无副作用，便于测试与组合
//   2. 软提示（系统提示）+ 硬拦截（tool_call guard）双层防线
//   3. 与 Task 2 的 canDelegate 四维约束解耦，但可被其复用

import type { AgentRole } from './profiles/types.js';

// ============================================================
// 类型定义
// ============================================================

/** 委托三态模式 */
export type DelegationMode = 'allow' | 'delegate' | 'refuse';

/** 委托决策结果 */
export interface DelegationDecision {
  /** 决策模式 */
  mode: DelegationMode;
  /** 决策原因（供日志与提示） */
  reason: string;
  /** mode=delegate 时必填：目标 specialist 角色 */
  targetRole?: AgentRole;
  /** mode=refuse 时给用户的下一步提示 */
  nextStep?: string;
}

/** 委托权限判定结果（Task 2 纯函数部分） */
export interface DelegationPermission {
  /** 是否允许委派 */
  ok: boolean;
  /** 拒绝原因（ok=false 时填充） */
  reason?: string;
  /** 通过时的下一层深度（ok=true 时填充） */
  nextDepth?: number;
}

/** 任务类型（与 TASK_TYPE_KEYWORDS 的 key 一一对应） */
export type TaskType = 'frontend' | 'research' | 'review';

// ============================================================
// 关键词双命中配置
// ============================================================

/**
 * 任务类型关键词表
 * 借鉴 ohmypi isFrontendUiTask 的双组命中设计：
 *   - actions：动作类关键词（build / search / review 等）
 *   - artifacts：产物类关键词（component / codebase / diff 等）
 *
 * 双命中规则：action 与 artifact 必须同时命中才返回对应类型，
 * 单组命中不算，避免"review the architecture"等误触发委派。
 */
export const TASK_TYPE_KEYWORDS: Record<TaskType, {
  actions: string[];
  artifacts: string[];
}> = {
  // 前端任务：构建/设计 UI 组件、页面、布局
  frontend: {
    actions: ['build', 'create', 'implement', 'style', 'design', 'refactor'],
    artifacts: ['component', 'page', 'dashboard', 'layout', 'widget', 'modal'],
  },
  // 调研任务：搜索/分析代码库、架构、依赖
  research: {
    actions: ['search', 'investigate', 'explore', 'analyze', 'survey'],
    artifacts: ['codebase', 'architecture', 'dependency', 'pattern', 'convention'],
  },
  // 审查任务：审查/校验代码、变更、PR
  review: {
    actions: ['review', 'audit', 'check', 'verify', 'inspect'],
    artifacts: ['code', 'change', 'pull-request', 'diff', 'commit'],
  },
};

// ============================================================
// 纯函数实现
// ============================================================

/**
 * 任务类型识别——关键词双命中规则
 *
 * 借鉴 ohmypi isFrontendUiTask：
 *   action 与 artifact 必须同时命中才返回对应 TaskType，
 *   否则返回 'general'。
 *
 * 示例：
 *   - "build a component" → frontend（action=build, artifact=component）
 *   - "review the architecture" → general（仅 artifact 命中，action 未命中）
 *   - "search the codebase" → research（action=search, artifact=codebase）
 *
 * @param taskDescription 任务描述文本
 * @returns TaskType 或 'general'
 */
export function classifyTask(taskDescription: string): TaskType | 'general' {
  const lower = taskDescription.toLowerCase();
  // 遍历所有任务类型，找到第一个双命中的即返回
  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    const actionHit = keywords.actions.some((a) => lower.includes(a));
    const artifactHit = keywords.artifacts.some((a) => lower.includes(a));
    if (actionHit && artifactHit) {
      return type as TaskType;
    }
  }
  return 'general';
}

/**
 * 委托权限判定（Task 2 纯函数部分）
 *
 * 借鉴 ohmypi canDelegate：深度检查 + 目标合法性检查。
 *
 * 校验顺序：
 *   1. 深度检查：currentDepth + 1 是否超过 maxDepth
 *   2. 目标合法性：targetRole 是否在 delegationTargets[currentRole] 列表中
 *
 * @param currentDepth 当前深度（0 = 顶层主 Agent）
 * @param currentRole 当前发起委派的角色
 * @param targetRole 委派目标角色
 * @param policy 策略对象：maxDepth + delegationTargets
 * @returns DelegationPermission
 */
export function canDelegate(
  currentDepth: number,
  currentRole: AgentRole,
  targetRole: AgentRole,
  policy: {
    maxDepth: number;
    delegationTargets: Record<AgentRole, AgentRole[]>;
  },
): DelegationPermission {
  // 1. 深度检查
  const nextDepth = currentDepth + 1;
  if (nextDepth > policy.maxDepth) {
    return {
      ok: false,
      reason: `已达到最大委托深度 ${policy.maxDepth}（当前 ${currentDepth}）`,
    };
  }

  // 2. 目标合法性检查：当前角色是否允许委派给目标角色
  const allowedTargets = policy.delegationTargets[currentRole] ?? [];
  if (!allowedTargets.includes(targetRole)) {
    return {
      ok: false,
      reason: `角色 ${currentRole} 不允许委派给 ${targetRole}（允许：${allowedTargets.join(', ') || '无'}）`,
    };
  }

  return { ok: true, nextDepth };
}

/**
 * 任务类型到 specialist 角色的映射
 * frontend → executor（前端实现交由执行者）
 * research  → researcher
 * review    → reviewer
 */
function taskTypeToRole(taskType: TaskType): AgentRole {
  switch (taskType) {
    case 'frontend':
      return 'executor';
    case 'research':
      return 'researcher';
    case 'review':
      return 'reviewer';
  }
}

/**
 * 委托决策——三态 allow / delegate / refuse
 *
 * 借鉴 ohmypi 的 Hard Delegation Policy：
 *   - general 任务：主 Agent 自己做（No Generic Backend Worker）
 *   - 硬委派类型 + 专家可用：delegate
 *   - 硬委派类型 + 专家不可用 + refuseIfSpecialistUnavailable=true：refuse
 *   - 硬委派类型 + 专家不可用 + refuseIfSpecialistUnavailable=false：降级 allow
 *   - 非硬委派类型：主 Agent 自己做
 *
 * @param taskDescription 任务描述文本
 * @param policy 策略对象
 * @returns DelegationDecision
 */
export function decideDelegation(
  taskDescription: string,
  policy: {
    /** 必须委派的类型列表 */
    hardDelegationTypes: TaskType[];
    /** 专家不可用时拒绝而非降级 */
    refuseIfSpecialistUnavailable: boolean;
    /** 各角色专家是否可用 */
    specialistAvailability: Record<AgentRole, boolean>;
  },
): DelegationDecision {
  const taskType = classifyTask(taskDescription);

  // 通用任务：主 Agent 自己做（No Generic Backend Worker）
  if (taskType === 'general') {
    return { mode: 'allow', reason: '通用任务，主 Agent 直接执行' };
  }

  // 硬委派类型检查
  if (policy.hardDelegationTypes.includes(taskType)) {
    const targetRole = taskTypeToRole(taskType);
    const specialistAvailable = policy.specialistAvailability[targetRole];

    if (specialistAvailable) {
      // 专家可用：强制委派
      return {
        mode: 'delegate',
        reason: `${taskType} 任务，硬委派给 ${targetRole} specialist`,
        targetRole,
      };
    }

    // 专家不可用
    if (policy.refuseIfSpecialistUnavailable) {
      // 拒绝并提示用户补齐配置
      return {
        mode: 'refuse',
        reason: `${taskType} 任务需要 ${targetRole} specialist，但专家不可用`,
        nextStep: `请在设置页面配置 ${targetRole} specialist 的模型和凭证`,
      };
    }

    // 降级允许（非推荐：主模型可能不具备该领域专精）
    return {
      mode: 'allow',
      reason: `${taskType} 任务，但 ${targetRole} specialist 不可用，降级为主 Agent 执行`,
    };
  }

  // 非硬委派类型：主 Agent 自己做
  return { mode: 'allow', reason: `${taskType} 任务未标记为硬委派，主 Agent 执行` };
}

// ============================================================
// 软提示 + 硬拦截双层防线
// ============================================================

/** 写操作工具集合——硬拦截范围 */
const WRITE_OPERATION_TOOLS = new Set(['edit', 'write', 'bash']);

/**
 * 创建委托守卫拦截器
 *
 * 借鉴 ohmypi 的 tool_call 事件硬拦截：
 *   - 只拦截写操作工具（edit / write / bash）
 *   - delegate 模式：阻止直接写，提示用 spawn_agent
 *   - refuse 模式：阻止并给出拒绝原因
 *   - allow 模式：放行
 *
 * 返回的拦截器函数为纯函数，不持有可变状态，
 * 可在 tool_call 事件钩子中安全调用。
 *
 * @param policy 策略对象（与 decideDelegation 一致）
 * @returns 拦截器函数 (toolName, taskContext) => { block, reason? }
 */
export function createDelegationGuard(
  policy: {
    hardDelegationTypes: TaskType[];
    refuseIfSpecialistUnavailable: boolean;
    specialistAvailability: Record<AgentRole, boolean>;
  },
): (toolName: string, taskContext: string) => { block: boolean; reason?: string } {
  return (toolName: string, taskContext: string): { block: boolean; reason?: string } => {
    // 只拦截写操作类工具，读操作放行
    if (!WRITE_OPERATION_TOOLS.has(toolName)) {
      return { block: false };
    }

    const decision = decideDelegation(taskContext, policy);

    // refuse 模式：硬阻止
    if (decision.mode === 'refuse') {
      return {
        block: true,
        reason: `委托策略拦截：${decision.reason}`,
      };
    }

    // delegate 模式：阻止直接写，提示走 spawn_agent
    if (decision.mode === 'delegate') {
      return {
        block: true,
        reason: `此任务应委派给 ${decision.targetRole} specialist，请使用 spawn_agent 工具`,
      };
    }

    // allow 模式：放行
    return { block: false };
  };
}

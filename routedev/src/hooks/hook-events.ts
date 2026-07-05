// src/hooks/hook-events.ts
// P0-15：Hook 事件分类法（27 种事件）
//
// 借鉴 Claude Code `src/entrypoints/sdk/coreTypes.ts` 的 HOOK_EVENTS：
//   27 种事件覆盖工具调用前后、会话生命周期、压缩、权限、子 Agent、任务、配置变更
//
// RouteDev 现状（src/agent/hooks.ts）：
//   仅 9 种事件（pre-step/post-step/on-error/on-complete/pre-tool-call/post-tool-call/
//   on-session-start/on-session-end/on-model-call）
//
// 改造：
//   1. 定义完整的 27 种 HookEventType（按类别组织）
//   2. 提供事件元数据（描述、负载字段、是否可取消）
//   3. 与现有 HookEvent 兼容（提供 legacyToNewEvent 映射）
//   4. 不破坏现有 HookRunner 实现，仅作为新事件类型的参考定义
//
// 事件分类（6 类）：
//   A. 工具调用（5 种）：PreToolUse / PostToolUse / PostToolUseFailure / PreModelCall / PostModelCall
//   B. 会话生命周期（4 种）：SessionStart / SessionEnd / Stop / StopFailure
//   C. 上下文压缩（2 种）：PreCompact / PostCompact
//   D. 权限与通知（4 种）：PermissionRequest / PermissionDenied / Notification / UserPromptSubmit
//   E. 子 Agent 与任务（6 种）：SubagentStart / SubagentStop / TeammateIdle / TaskCreated / TaskCompleted / Elicitation
//   F. 配置与环境（6 种）：Setup / ConfigChange / CwdChanged / FileChanged / WorktreeCreate / WorktreeRemove

// ============================================================
// A. 完整 27 种 Hook 事件类型
// ============================================================

/**
 * P0-15：完整的 Hook 事件类型（对齐 Claude Code 27 种）
 *
 * 命名规则：使用 PascalCase 与 Claude Code 对齐，便于跨工具对照
 */
export type HookEventType =
  // ===== A. 工具调用（5 种）=====
  | 'PreToolUse'           // 工具调用前（可取消/修改参数）
  | 'PostToolUse'          // 工具调用成功后（可修改结果）
  | 'PostToolUseFailure'   // 工具调用失败后
  | 'PreModelCall'         // LLM 调用前（可注入系统提示）
  | 'PostModelCall'        // LLM 调用后（可修改响应）
  // ===== B. 会话生命周期（4 种）=====
  | 'SessionStart'         // 会话开始
  | 'SessionEnd'           // 会话结束
  | 'Stop'                 // Agent 主动停止
  | 'StopFailure'          // Agent 停止失败
  // ===== C. 上下文压缩（2 种）=====
  | 'PreCompact'           // 上下文压缩前（可注入压缩规则）
  | 'PostCompact'          // 上下文压缩后（可恢复关键信息）
  // ===== D. 权限与通知（4 种）=====
  | 'PermissionRequest'    // 权限请求（可允许/拒绝/询问）
  | 'PermissionDenied'     // 权限被拒绝
  | 'Notification'         // 通知（系统消息）
  | 'UserPromptSubmit'     // 用户输入提交前（可预处理/取消）
  // ===== E. 子 Agent 与任务（6 种）=====
  | 'SubagentStart'        // 子 Agent 启动
  | 'SubagentStop'         // 子 Agent 停止
  | 'TeammateIdle'         // 队友 Agent 空闲
  | 'TaskCreated'          // 任务创建
  | 'TaskCompleted'        // 任务完成
  | 'Elicitation'          // 主动询问（向用户索取信息）
  // ===== F. 配置与环境（6 种）=====
  | 'Setup'                // 初始化设置
  | 'ConfigChange'         // 配置变更
  | 'CwdChanged'           // 工作目录变更
  | 'FileChanged'          // 文件变更
  | 'WorktreeCreate'       // Worktree 创建
  | 'WorktreeRemove';      // Worktree 移除

/** P0-15：所有 Hook 事件常量列表（用于校验和迭代） */
export const ALL_HOOK_EVENTS: readonly HookEventType[] = [
  // A. 工具调用
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreModelCall', 'PostModelCall',
  // B. 会话生命周期
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  // C. 上下文压缩
  'PreCompact', 'PostCompact',
  // D. 权限与通知
  'PermissionRequest', 'PermissionDenied', 'Notification', 'UserPromptSubmit',
  // E. 子 Agent 与任务
  'SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation',
  // F. 配置与环境
  'Setup', 'ConfigChange', 'CwdChanged', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
] as const;

// ============================================================
// B. 事件元数据
// ============================================================

/** 事件类别 */
export type HookEventCategory =
  | 'tool'           // 工具调用
  | 'session'        // 会话生命周期
  | 'compact'        // 上下文压缩
  | 'permission'     // 权限与通知
  | 'subagent'       // 子 Agent 与任务
  | 'config';        // 配置与环境

/** 事件元数据 */
export interface HookEventMetadata {
  /** 事件类型 */
  type: HookEventType;
  /** 类别 */
  category: HookEventCategory;
  /** 简短描述 */
  description: string;
  /** 负载字段（事件触发时携带的数据字段名） */
  payloadFields: string[];
  /** 是否可取消（true = hook 可阻止事件继续） */
  cancelable: boolean;
  /** 是否可修改负载（true = hook 可修改事件数据） */
  mutable: boolean;
}

/** P0-15：27 种事件的元数据表 */
export const HOOK_EVENT_METADATA: Record<HookEventType, HookEventMetadata> = {
  // ===== A. 工具调用 =====
  PreToolUse: {
    type: 'PreToolUse', category: 'tool',
    description: '工具调用前触发（可取消/修改参数）',
    payloadFields: ['toolName', 'args', 'context'],
    cancelable: true, mutable: true,
  },
  PostToolUse: {
    type: 'PostToolUse', category: 'tool',
    description: '工具调用成功后触发（可修改结果）',
    payloadFields: ['toolName', 'args', 'result', 'durationMs'],
    cancelable: false, mutable: true,
  },
  PostToolUseFailure: {
    type: 'PostToolUseFailure', category: 'tool',
    description: '工具调用失败后触发',
    payloadFields: ['toolName', 'args', 'error'],
    cancelable: false, mutable: false,
  },
  PreModelCall: {
    type: 'PreModelCall', category: 'tool',
    description: 'LLM 调用前触发（可注入系统提示）',
    payloadFields: ['messages', 'model', 'systemPrompt'],
    cancelable: true, mutable: true,
  },
  PostModelCall: {
    type: 'PostModelCall', category: 'tool',
    description: 'LLM 调用后触发（可修改响应）',
    payloadFields: ['response', 'model', 'tokenUsage'],
    cancelable: false, mutable: true,
  },

  // ===== B. 会话生命周期 =====
  SessionStart: {
    type: 'SessionStart', category: 'session',
    description: '会话开始时触发',
    payloadFields: ['sessionId', 'cwd', 'config'],
    cancelable: false, mutable: false,
  },
  SessionEnd: {
    type: 'SessionEnd', category: 'session',
    description: '会话结束时触发',
    payloadFields: ['sessionId', 'reason', 'stats'],
    cancelable: false, mutable: false,
  },
  Stop: {
    type: 'Stop', category: 'session',
    description: 'Agent 主动停止时触发',
    payloadFields: ['agentId', 'reason'],
    cancelable: false, mutable: false,
  },
  StopFailure: {
    type: 'StopFailure', category: 'session',
    description: 'Agent 停止失败时触发',
    payloadFields: ['agentId', 'error'],
    cancelable: false, mutable: false,
  },

  // ===== C. 上下文压缩 =====
  PreCompact: {
    type: 'PreCompact', category: 'compact',
    description: '上下文压缩前触发（可注入压缩规则）',
    payloadFields: ['goal', 'completed', 'blocked', 'nextStep', 'constraints'],
    cancelable: true, mutable: true,
  },
  PostCompact: {
    type: 'PostCompact', category: 'compact',
    description: '上下文压缩后触发（可恢复关键信息）',
    payloadFields: ['compactedMessages', 'summary', 'removedCount'],
    cancelable: false, mutable: true,
  },

  // ===== D. 权限与通知 =====
  PermissionRequest: {
    type: 'PermissionRequest', category: 'permission',
    description: '权限请求时触发（可允许/拒绝/询问）',
    payloadFields: ['resource', 'action', 'context'],
    cancelable: true, mutable: false,
  },
  PermissionDenied: {
    type: 'PermissionDenied', category: 'permission',
    description: '权限被拒绝时触发',
    payloadFields: ['resource', 'action', 'reason'],
    cancelable: false, mutable: false,
  },
  Notification: {
    type: 'Notification', category: 'permission',
    description: '系统通知时触发',
    payloadFields: ['level', 'message', 'details'],
    cancelable: false, mutable: false,
  },
  UserPromptSubmit: {
    type: 'UserPromptSubmit', category: 'permission',
    description: '用户输入提交前触发（可预处理/取消）',
    payloadFields: ['prompt', 'sessionId'],
    cancelable: true, mutable: true,
  },

  // ===== E. 子 Agent 与任务 =====
  SubagentStart: {
    type: 'SubagentStart', category: 'subagent',
    description: '子 Agent 启动时触发',
    payloadFields: ['subagentId', 'parentAgentId', 'task', 'profile'],
    cancelable: true, mutable: false,
  },
  SubagentStop: {
    type: 'SubagentStop', category: 'subagent',
    description: '子 Agent 停止时触发',
    payloadFields: ['subagentId', 'result', 'durationMs'],
    cancelable: false, mutable: false,
  },
  TeammateIdle: {
    type: 'TeammateIdle', category: 'subagent',
    description: '队友 Agent 空闲时触发',
    payloadFields: ['teammateId', 'lastTaskAt'],
    cancelable: false, mutable: false,
  },
  TaskCreated: {
    type: 'TaskCreated', category: 'subagent',
    description: '任务创建时触发',
    payloadFields: ['taskId', 'description', 'assignee'],
    cancelable: false, mutable: false,
  },
  TaskCompleted: {
    type: 'TaskCompleted', category: 'subagent',
    description: '任务完成时触发',
    payloadFields: ['taskId', 'result', 'durationMs'],
    cancelable: false, mutable: false,
  },
  Elicitation: {
    type: 'Elicitation', category: 'subagent',
    description: '主动询问用户时触发（向用户索取信息）',
    payloadFields: ['question', 'schema', 'context'],
    cancelable: false, mutable: true,
  },

  // ===== F. 配置与环境 =====
  Setup: {
    type: 'Setup', category: 'config',
    description: '初始化设置时触发',
    payloadFields: ['configPath', 'firstRun'],
    cancelable: false, mutable: false,
  },
  ConfigChange: {
    type: 'ConfigChange', category: 'config',
    description: '配置变更时触发',
    payloadFields: ['changes', 'oldConfig', 'newConfig'],
    cancelable: false, mutable: false,
  },
  CwdChanged: {
    type: 'CwdChanged', category: 'config',
    description: '工作目录变更时触发',
    payloadFields: ['oldCwd', 'newCwd'],
    cancelable: false, mutable: false,
  },
  FileChanged: {
    type: 'FileChanged', category: 'config',
    description: '文件变更时触发（由文件监视器触发）',
    payloadFields: ['path', 'changeType', 'content'],
    cancelable: false, mutable: false,
  },
  WorktreeCreate: {
    type: 'WorktreeCreate', category: 'config',
    description: 'Worktree 创建时触发',
    payloadFields: ['worktreePath', 'branch'],
    cancelable: false, mutable: false,
  },
  WorktreeRemove: {
    type: 'WorktreeRemove', category: 'config',
    description: 'Worktree 移除时触发',
    payloadFields: ['worktreePath'],
    cancelable: false, mutable: false,
  },
};

// ============================================================
// C. 与现有 HookEvent 的兼容映射
// ============================================================

/**
 * P0-15：旧 HookEvent（src/agent/hooks.ts）→ 新 HookEventType 映射
 *
 * 用于渐进迁移：现有 HookRunner 触发旧事件时，可同时触发新事件
 */
export const LEGACY_HOOK_EVENT_MAP: Record<string, HookEventType> = {
  'pre-step': 'TaskCreated',          // 旧 pre-step ≈ 新 TaskCreated
  'post-step': 'TaskCompleted',       // 旧 post-step ≈ 新 TaskCompleted
  'on-error': 'StopFailure',          // 旧 on-error ≈ 新 StopFailure
  'on-complete': 'Stop',              // 旧 on-complete ≈ 新 Stop
  'pre-tool-call': 'PreToolUse',      // 旧 pre-tool-call → 新 PreToolUse
  'post-tool-call': 'PostToolUse',    // 旧 post-tool-call → 新 PostToolUse
  'on-session-start': 'SessionStart', // 旧 on-session-start → 新 SessionStart
  'on-session-end': 'SessionEnd',     // 旧 on-session-end → 新 SessionEnd
  'on-model-call': 'PreModelCall',    // 旧 on-model-call → 新 PreModelCall
};

/**
 * P0-15：旧事件名 → 新事件名（找不到时返回 null）
 */
export function legacyToNewEvent(legacyName: string): HookEventType | null {
  return LEGACY_HOOK_EVENT_MAP[legacyName] ?? null;
}

/**
 * P0-15：判断字符串是否为合法的 HookEventType
 */
export function isValidHookEventType(s: string): s is HookEventType {
  return ALL_HOOK_EVENTS.includes(s as HookEventType);
}

/**
 * P0-15：获取事件元数据
 *
 * @param type 事件类型
 * @returns 事件元数据（不存在时抛错）
 */
export function getHookEventMetadata(type: HookEventType): HookEventMetadata {
  const meta = HOOK_EVENT_METADATA[type];
  if (!meta) {
    throw new Error(`Unknown HookEventType: ${type}`);
  }
  return meta;
}

/**
 * P0-15：按类别列出事件
 *
 * @param category 类别
 * @returns 该类别下的所有事件类型
 */
export function listEventsByCategory(category: HookEventCategory): HookEventType[] {
  return ALL_HOOK_EVENTS.filter(t => HOOK_EVENT_METADATA[t].category === category);
}

/**
 * P0-15：Hook 处理器签名
 *
 * 与现有 HookCallback 区别：
 *   - 现有 HookCallback 接收 HookContext（步骤级上下文）
 *   - 新 HookHandler 接收 HookPayload（事件级负载，结构化）
 *   - 返回 HookResult 控制事件流（continue/cancel/modify）
 */
export interface HookPayload {
  /** 事件类型 */
  type: HookEventType;
  /** 触发时间戳 */
  timestamp: number;
  /** 事件数据（结构因事件类型而异，见 HOOK_EVENT_METADATA.payloadFields） */
  data: Record<string, unknown>;
  /** 会话 ID */
  sessionId?: string;
  /** Agent ID（工具/任务类事件） */
  agentId?: string;
}

/** Hook 处理器返回结果 */
export type HookResult =
  | { action: 'continue' }                              // 继续事件流
  | { action: 'cancel'; reason: string }                // 取消事件（仅 cancelable 事件有效）
  | { action: 'modify'; newData: Record<string, unknown> }; // 修改事件数据（仅 mutable 事件有效）

/** Hook 处理器函数签名 */
export type HookHandler = (payload: HookPayload) => Promise<HookResult> | HookResult;

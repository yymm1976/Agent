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
//   2. 与现有 HookEvent 兼容（提供 legacyToNewEvent 映射）
//   3. 不破坏现有 HookRunner 实现，仅作为新事件类型的参考定义
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

// ============================================================
// B. 与现有 HookEvent 的兼容映射
// ============================================================

/**
 * P0-15：旧 HookEvent（src/agent/hooks.ts）→ 新 HookEventType 映射
 *
 * 用于渐进迁移：现有 HookRunner 触发旧事件时，可同时触发新事件
 */
const LEGACY_HOOK_EVENT_MAP: Record<string, HookEventType> = {
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
  /** 事件数据（结构因事件类型而异） */
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

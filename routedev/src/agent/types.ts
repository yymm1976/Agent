// src/agent/types.ts
// Agent 层核心类型定义（Phase 5 可用）
// 包含：Agent 状态、ReAct 步骤、记忆、目标等

import type { LLMMessage, ToolCallRequest, ToolCallResult, TokenUsageInfo } from '../router/types.js';

// ============================================================
// Agent 状态
// ============================================================

/** Agent 运行状态 */
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting_approval' | 'done' | 'error';

/** Agent 配置 */
export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  maxSteps: number;
  maxTokensPerStep: number;
  autonomyMode: 'auto' | 'semi' | 'manual';
}

// ============================================================
// ReAct 循环步骤
// ============================================================

/** ReAct 步骤类型 */
export type StepType = 'thought' | 'action' | 'observation' | 'final_answer';

/** 单个 ReAct 步骤 */
export interface ReActStep {
  id: string;
  type: StepType;
  timestamp: number;
  // thought 步骤
  thought?: string;
  // action 步骤（工具调用）
  action?: {
    toolName: string;
    arguments: Record<string, unknown>;
    toolCallId: string;
  };
  // observation 步骤（工具结果）
  observation?: {
    toolCallId: string;
    content: string;
    isError: boolean;
  };
  // final_answer 步骤
  finalAnswer?: string;
  // Token 使用
  usage?: TokenUsageInfo;
}

/** Agent 执行结果 */
export interface AgentResult {
  success: boolean;
  answer: string;
  steps: ReActStep[];
  totalUsage: TokenUsageInfo;
  error?: string;
}

// ============================================================
// 记忆系统
// ============================================================

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  type: 'conversation' | 'checkpoint' | 'goal';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** 对话历史（简化版，完整实现在 Phase 5） */
export interface ConversationHistory {
  messages: LLMMessage[];
  maxTokens: number;
  currentTokens: number;
}

// 注：CheckpointData 类型已统一至 src/agent/memory/types.ts（11 字段版本）
// 此处不再重复定义，所有引用应从 '../memory/types.js' 导入

// ============================================================
// 目标系统
// ============================================================

/** 目标状态 */
export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** 用户目标 */
export interface Goal {
  id: string;
  description: string;
  status: GoalStatus;
  createdAt: number;
  completedAt?: number;
  verificationResult?: GoalVerification;
}

/** 目标验证结果 */
export interface GoalVerification {
  passed: boolean;
  confidence: number;
  reasoning: string;
  timestamp: number;
}

// ============================================================
// Agent 事件（用于 UI 订阅）
// ============================================================

/** Agent 事件类型 */
export type AgentEvent =
  | { type: 'step_start'; step: ReActStep }
  | { type: 'step_complete'; step: ReActStep }
  | { type: 'tool_call_start'; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool_call_complete'; toolName: string; result: string; isError: boolean }
  | { type: 'approval_required'; toolName: string; arguments: Record<string, unknown> }
  | { type: 'status_change'; status: AgentStatus }
  | { type: 'error'; error: string }
  | { type: 'complete'; result: AgentResult };

/** Agent 事件订阅器 */
export type AgentEventListener = (event: AgentEvent) => void;

// ============================================================
// 自主度控制
// ============================================================

/** 工具执行权限 */
export type ToolPermission = 'auto' | 'confirm' | 'deny';

/** 权限检查请求 */
export interface PermissionRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
}

/** 权限检查结果 */
export interface PermissionResult {
  granted: boolean;
  permission: ToolPermission;
  reason?: string;
}

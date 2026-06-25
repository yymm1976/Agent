// src/harness/trace-types.ts
// Trace 与 Audit 系统类型定义（Phase 15）

import type { TokenUsageInfo } from '../router/types.js';

/** Trace 会话 */
export interface TraceSession {
  id: string;
  startTime: number;
  endTime?: number;
  goalId?: string;
  userInput: string;
  routeDecision?: {
    modelId: string;
    tier: string;
    fallbackUsed: boolean;
  };
  totalUsage?: TokenUsageInfo;
  spanCount: number;
  completed: boolean;
}

/** Trace Span 类型 */
export type TraceSpanType =
  | 'react_iteration'
  | 'tool_call'
  | 'llm_call'
  | 'worker_task'
  | 'goal_step'
  | 'compose_phase'
  | 'hook';

/** Span 负载 */
export type TraceSpanPayload =
  | {
      type: 'react_iteration';
      iteration: number;
      thought?: string;
      action?: { toolName: string; args: Record<string, unknown> };
      observation?: { result: string; isError: boolean };
    }
  | {
      type: 'tool_call';
      toolName: string;
      toolCallId: string;
      args?: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      approvalRequired?: boolean;
      approved?: boolean;
    }
  | {
      type: 'llm_call';
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      responseLength: number;
      toolCallCount: number;
    }
  | {
      type: 'worker_task';
      role: string;
      description: string;
      modifiedFiles: string[];
      conclusion?: string;
    }
  | {
      type: 'goal_step';
      stepId: number;
      description: string;
      totalSteps: number;
    }
  | {
      type: 'compose_phase';
      /** span 名称（如 'compose:requirements'） */
      name: string;
      /** Compose 阶段名 */
      phase: string;
    }
  | {
      type: 'hook';
      /** span 名称（如 'hook:pre-step:myHook'） */
      name: string;
      /** 钩子事件类型 */
      event: string;
      /** 钩子名称 */
      hookName: string;
    };

/** Trace Span */
export interface TraceSpan {
  id: number;
  sessionId: string;
  type: TraceSpanType;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  stepId?: number;
  workerRole?: string;
  payload: TraceSpanPayload;
  status: 'running' | 'completed' | 'error' | 'aborted';
  error?: string;
}

/** Trace 事件（JSONL 一行） */
export interface TraceRecord {
  timestamp: string;
  sessionId: string;
  spanId?: number;
  event: string;
  data: Record<string, unknown>;
}

/** 审计事件类型 */
export type AuditAction =
  | 'file_write'
  | 'file_delete'
  | 'shell_exec'
  | 'user_confirm'
  | 'user_deny'
  | 'route_decision'
  | 'goal_start'
  | 'goal_complete'
  | 'goal_fail'
  | 'rollback'
  | 'checkpoint_create'
  | 'blackboard_write'
  | 'channel_message_in'
  | 'channel_message_out'
  | 'permission_change'
  | 'config_change'
  | 'notification'
  // Phase 34：过程评测指标汇总
  | 'trajectory_summary'
  // Phase 35 Task 2：会话生命周期事件（内置钩子写入）
  | 'session_start'
  | 'session_end';

/** 审计记录 */
export interface AuditRecord {
  timestamp: string;
  sessionId: string;
  action: AuditAction;
  agentId: string;
  target: string;
  details: Record<string, unknown>;
  result: 'success' | 'failure' | 'denied' | 'skipped';
  confirmation?: {
    requested: boolean;
    approved: boolean;
    reason?: string;
  };
}

/** Phase 34：Trajectory 级过程评测汇总 */
export interface TrajectorySummary {
  /** 任务/会话标识 */
  taskId: string;
  /** 总输入 token */
  totalInputTokens: number;
  /** 总输出 token */
  totalOutputTokens: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 估算成本（美元，未配置价格时为 0） */
  totalCost: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** LLM 调用次数 */
  llmCallCount: number;
  /** 重试次数（基于 error 事件或 react_iteration 中 consecutiveErrors 语义） */
  retryCount: number;
  /** 首次成功率（无 retry 即成功 = 1，否则按 1/(retry+1) 估算） */
  firstAttemptSuccessRate: number;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 是否成功完成 */
  success: boolean;
  /** 终止原因：completed / error / cancelled / max_iterations */
  terminationReason: 'completed' | 'error' | 'cancelled' | 'max_iterations';
  /** 使用的模型 id */
  modelId?: string;
  /** 场景等级 */
  tier?: string;
}

/** TraceCollector 配置 */
export interface TraceCollectorConfig {
  enabled: boolean;
  maxSpansPerSession: number;
  storageDir?: string;
}

/** AuditLogger 配置 */
export interface AuditLoggerConfig {
  enabled: boolean;
  retentionDays: number;
  storageDir?: string;
}
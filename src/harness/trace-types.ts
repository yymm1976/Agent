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
  | 'goal_step';

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
  | 'config_change';

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
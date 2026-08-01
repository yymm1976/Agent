// src/harness/event-types.ts
// Phase 97 Part A：EngineEventV1 统一事件协议
//
// 设计目的：
//   在现有 ReActEvent（loop-config.ts）之上补全 agent/turn/message 生命周期，
//   并为每个事件附加公共游标字段（id/sessionId/turnId/messageId/sequence/timestamp）。
//   桌面 IPC、远程 SSE、历史存储共用同一结构：UI 只需按 sequence 追加事件，
//   即可还原真实时间顺序，无需按类别猜测拼接。
//
// 与现有类型的关系：
//   - ReActEvent 是 loop 内部的事件（thinking/text_delta/tool_call_* 等）
//   - EngineEventV1 是统一对外协议，ReActEvent 可经转换映射为 EngineEventV1
//   - TraceRecord（trace-types.ts）是持久化记录，本类型是其内存态协议

/** EngineEventV1 事件类型 */
export type EngineEventType =
  | 'agent_start'
  | 'agent_end'
  | 'turn_start'
  | 'turn_end'
  | 'message_start'
  | 'message_delta'
  | 'message_end'
  | 'tool_start'
  | 'tool_delta'
  | 'tool_end'
  | 'approval_requested'
  | 'approval_resolved'
  | 'todo_snapshot'
  | 'runtime_status'
  | 'runtime_error';

/** EngineEventV1 公共字段 */
export interface EngineEventBase {
  /** 全局唯一事件 id */
  id: string;
  /** 会话 id */
  sessionId: string;
  /** turn id（同一用户输入到 agent 稳定结束） */
  turnId?: string;
  /** message id（assistant 消息实体） */
  messageId?: string;
  /** 同一 turn 内单调递增的序号，重连后不重复不丢失 */
  sequence: number;
  /** 事件发生时间（毫秒时间戳） */
  timestamp: number;
  /** 触发来源 */
  triggerSource?: 'user' | 'automation' | 'remote' | 'delegation';
}

/** 具体事件负载 */
export interface AgentStartEvent extends EngineEventBase { type: 'agent_start'; payload: { kernel: string; model?: string } }
export interface AgentEndEvent extends EngineEventBase { type: 'agent_end'; payload: { reason: 'completed' | 'error' | 'cancelled' | 'max_iterations' } }
export interface TurnStartEvent extends EngineEventBase { type: 'turn_start'; payload: { input: string } }
export interface TurnEndEvent extends EngineEventBase { type: 'turn_end'; payload: { outputLength: number } }
export interface MessageStartEvent extends EngineEventBase { type: 'message_start'; payload: { role: 'assistant' } }
export interface MessageDeltaEvent extends EngineEventBase { type: 'message_delta'; payload: { text: string; kind: 'text' | 'reasoning' } }
export interface MessageEndEvent extends EngineEventBase { type: 'message_end'; payload: { contentLength: number } }
export interface ToolStartEvent extends EngineEventBase { type: 'tool_start'; payload: { toolName: string; toolCallId: string } }
export interface ToolDeltaEvent extends EngineEventBase { type: 'tool_delta'; payload: { toolName: string; toolCallId: string; chunk: string } }
export interface ToolEndEvent extends EngineEventBase { type: 'tool_end'; payload: { toolName: string; toolCallId: string; isError: boolean } }
export interface ApprovalRequestedEvent extends EngineEventBase { type: 'approval_requested'; payload: { toolName: string; toolCallId: string; reason: string } }
export interface ApprovalResolvedEvent extends EngineEventBase { type: 'approval_resolved'; payload: { toolName: string; toolCallId: string; approved: boolean } }
export interface TodoSnapshotEvent extends EngineEventBase { type: 'todo_snapshot'; payload: { todos: unknown } }
export interface RuntimeStatusEvent extends EngineEventBase { type: 'runtime_status'; payload: { status: string } }
export interface RuntimeErrorEvent extends EngineEventBase { type: 'runtime_error'; payload: { error: string } }

/** EngineEventV1 联合类型 */
export type EngineEventV1 =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageEndEvent
  | ToolStartEvent
  | ToolDeltaEvent
  | ToolEndEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | TodoSnapshotEvent
  | RuntimeStatusEvent
  | RuntimeErrorEvent;

/**
 * 序列计数器：同一 turn 内 sequence 单调递增
 * 用法：turn 开始时 newSequenceCounter()，每个事件 seq.next()
 */
export class SequenceCounter {
  private value = 0;
  next(): number {
    this.value += 1;
    return this.value;
  }
}

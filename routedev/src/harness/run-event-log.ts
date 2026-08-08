// src/harness/run-event-log.ts
// TD-21 Phase 1：Authoritative Run Event Log（append-only）
//
// 目标：为 Run 核心轨迹提供权威的 append-only 事件流——
//   user request → LLM（含 provider retry）→ tool request → tool result → final。
// 事件按 sequence 单调追加，replay 可重建投影（RunProjection），
// 与 live state 一致（replay consistency test 验证）。
//
// 存储：${storageDir}/runs/<runId>.events.jsonl（每行一个事件，纯追加）

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAppDataDir } from '../utils/paths.js';

/** Run 事件类型——覆盖 TD-21 关键路径 + provider retry 可观测性 */
export type RunEventType =
  | 'run_started'     // 运行开始（user request 受理）
  | 'llm_requested'   // LLM 请求发起（attempt=1..N；attempt>1 即前次失败后的重试）
  | 'llm_retry'       // provider retry（重试策略决定重试时记录——可观测性）
  | 'llm_succeeded'   // LLM 请求成功（含 finishReason/usage）
  | 'llm_failed'      // LLM 请求失败（含类型化 errorKind）
  | 'tool_requested'  // 工具调用发起
  | 'tool_completed'  // 工具调用完成（isError 区分成功/失败）
  | 'run_completed'   // 运行正常完成
  | 'run_interrupted'; // 运行中断（取消/连续错误/溢出）

/** RunEvent 公共 envelope */
export interface RunEventBase {
  /** 全局唯一事件 id */
  id: string;
  /** 所属 run id */
  runId: string;
  /** 同一 run 内单调递增（重放时校验，防丢失/重复） */
  sequence: number;
  /** 事件发生时间（毫秒） */
  timestamp: number;
  type: RunEventType;
}

export interface RunStartedEvent extends RunEventBase { type: 'run_started'; payload: { input: string; model: string } }
export interface LlmRequestedEvent extends RunEventBase { type: 'llm_requested'; payload: { model: string; attempt: number } }
export interface LlmRetryEvent extends RunEventBase { type: 'llm_retry'; payload: { model: string; attempt: number; errorKind: string; error: string } }
export interface LlmSucceededEvent extends RunEventBase {
  type: 'llm_succeeded';
  payload: { model: string; attempt: number; finishReason?: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } };
}
export interface LlmFailedEvent extends RunEventBase { type: 'llm_failed'; payload: { model: string; attempt: number; errorKind: string; error: string } }
export interface ToolRequestedEvent extends RunEventBase { type: 'tool_requested'; payload: { toolName: string; toolCallId: string } }
export interface ToolCompletedEvent extends RunEventBase { type: 'tool_completed'; payload: { toolName: string; toolCallId: string; isError: boolean; outputPreview: string } }
export interface RunCompletedEvent extends RunEventBase { type: 'run_completed'; payload: { outputLength: number; toolCallCount: number; retryCount: number } }
export interface RunInterruptedEvent extends RunEventBase { type: 'run_interrupted'; payload: { reason: string } }

/** Run 事件联合类型 */
export type RunEvent =
  | RunStartedEvent
  | LlmRequestedEvent
  | LlmRetryEvent
  | LlmSucceededEvent
  | LlmFailedEvent
  | ToolRequestedEvent
  | ToolCompletedEvent
  | RunCompletedEvent
  | RunInterruptedEvent;

/** 重放投影——由事件流重建的 run 状态（与 live state 一致） */
export interface RunProjection {
  runId: string;
  input: string;
  model: string;
  /** LLM 请求总次数 */
  llmAttempts: number;
  /** provider retry 次数（llm_retry 事件数） */
  retryCount: number;
  /** 工具调用序列 */
  toolCalls: Array<{ toolName: string; toolCallId: string; isError: boolean }>;
  /** 最终输出长度（run_completed） */
  outputLength: number;
  completed: boolean;
  interruptedReason?: string;
  /** 最后一次 LLM 失败的类型化 kind */
  lastErrorKind?: string;
}

/**
 * TD-21 Phase 1：Run 事件日志（append-only）
 *
 * - append：sequence 单调递增，JSONL 纯追加
 * - replay：读回事件流，校验 sequence 连续性，重建 RunProjection
 * - 供 ReActAgentLoop 在关键路径（LLM/tool/完成）记录
 */
export class RunEventLog {
  constructor(
    private readonly runId: string,
    private readonly storageDir?: string,
  ) {}

  private sequence = 0;
  private readonly events: RunEvent[] = []; // 内存态（replay consistency 比对基准）

  /** 追加事件（内存 + 磁盘 JSONL append-only） */
  record<E extends RunEvent>(type: E['type'], payload: E['payload']): void {
    this.sequence += 1;
    const event = {
      id: `${this.runId}-${this.sequence}-${randomBytes(3).toString('hex')}`,
      runId: this.runId,
      sequence: this.sequence,
      timestamp: Date.now(),
      type,
      payload,
    } as E;
    this.events.push(event);
    try {
      const dir = this.eventsDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${this.runId}.events.jsonl`), JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      // 事件日志写入失败 fail-open（不阻断 run 主流程）
      // eslint-disable-next-line no-console
      console.warn('[run-event-log] append failed (non-blocking)', err instanceof Error ? err.message : String(err));
    }
  }

  /** 内存事件流（测试/比对用） */
  getEvents(): readonly RunEvent[] {
    return this.events;
  }

  /**
   * 重放：读回磁盘事件流，校验 sequence 连续（1..N 无缺失无重复），
   * 重建 RunProjection。sequence 断裂 = 日志不完整（append-only 被破坏），返回 null。
   */
  static replay(storageDir: string | undefined, runId: string): { projection: RunProjection | null; events: RunEvent[] } {
    const dir = storageDir ? join(storageDir, 'runs') : join(getAppDataDir(), 'run-events', 'runs');
    const filePath = join(dir, `${runId}.events.jsonl`);
    if (!existsSync(filePath)) return { projection: null, events: [] };
    const events: RunEvent[] = [];
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch {
        return { projection: null, events }; // 损坏行 = 日志不完整
      }
    }
    // sequence 连续性校验（append-only 不变量）
    for (let i = 0; i < events.length; i += 1) {
      if (events[i]!.sequence !== i + 1) return { projection: null, events };
    }
    return { projection: RunEventLog.project(events), events };
  }

  /** 事件流 → RunProjection（replay 投影；与 live state 一致性由测试验证） */
  static project(events: readonly RunEvent[]): RunProjection {
    const projection: RunProjection = {
      runId: events[0]?.runId ?? '',
      input: '',
      model: '',
      llmAttempts: 0,
      retryCount: 0,
      toolCalls: [],
      outputLength: 0,
      completed: false,
    };
    for (const event of events) {
      switch (event.type) {
        case 'run_started':
          projection.input = event.payload.input;
          projection.model = event.payload.model;
          break;
        case 'llm_requested':
          projection.llmAttempts = Math.max(projection.llmAttempts, event.payload.attempt);
          break;
        case 'llm_retry':
          projection.retryCount += 1;
          break;
        case 'llm_failed':
          projection.lastErrorKind = event.payload.errorKind;
          break;
        case 'tool_requested':
          projection.toolCalls.push({ toolName: event.payload.toolName, toolCallId: event.payload.toolCallId, isError: false });
          break;
        case 'tool_completed':
          const tc = projection.toolCalls.find((t) => t.toolCallId === event.payload.toolCallId);
          if (tc) tc.isError = event.payload.isError;
          break;
        case 'run_completed':
          projection.outputLength = event.payload.outputLength;
          projection.completed = true;
          break;
        case 'run_interrupted':
          projection.completed = false;
          projection.interruptedReason = event.payload.reason;
          break;
      }
    }
    return projection;
  }

  private eventsDir(): string {
    return this.storageDir
      ? join(this.storageDir, 'runs')
      : join(getAppDataDir(), 'run-events', 'runs');
  }
}

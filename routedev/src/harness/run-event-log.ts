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
import { RouteDevError } from '../utils/errors.js';

/**
 * Closure 6（durability contract）：append 失败——日志已失效。
 * 调用方（loop）捕获后必须停用该日志（不再产生静默分歧）；
 * 该 run 的 replay 因磁盘不完整返回 null（fail-closed）。
 */
export class RunEventLogDurabilityError extends RouteDevError {
  readonly runId: string;

  constructor(runId: string, reason: string) {
    super(
      `RunEventLog append 失败，日志已失效（该 run 的 replay 将不可用）：${reason}`,
      'RUN_EVENT_LOG_DURABILITY',
      { details: `runId: ${runId}` },
    );
    this.runId = runId;
  }
}

/** Run 事件类型——覆盖 TD-21 关键路径 + provider retry 可观测性 + denial lifecycle */
export type RunEventType =
  | 'run_started'     // 运行开始（user request 受理）
  | 'llm_requested'   // LLM 请求发起（attempt=1..N；attempt>1 即前次失败后的重试）
  | 'llm_retry'       // provider retry（重试策略决定重试时记录——可观测性）
  | 'llm_succeeded'   // LLM 请求成功（含 finishReason/usage）
  | 'llm_failed'      // LLM 请求失败（含类型化 errorKind）
  | 'tool_requested'  // 工具调用发起
  | 'tool_completed'  // 工具调用完成（isError 区分成功/失败）
  | 'tool_rejected'   // Closure 6：工具被拒（权限 deny / 用户拒绝 / pre-tool deny）——denial lifecycle
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
export interface ToolRejectedEvent extends RunEventBase { type: 'tool_rejected'; payload: { toolName: string; toolCallId: string; reason: string } }
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
  | ToolRejectedEvent
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
  private sequence = 0;
  private readonly events: RunEvent[] = []; // 内存态（replay consistency 比对基准）
  /** Closure 6：日志是否已失效（append 失败后 fail-closed——不再静默写内存/磁盘不一致） */
  private failed = false;
  private readonly inputTruncateChars: number;
  private readonly outputPreviewChars: number;

  constructor(
    private readonly runId: string,
    private readonly storageDir?: string,
    options: { inputTruncateChars?: number; outputPreviewChars?: number } = {},
  ) {
    // Closure 6（redaction policy）：默认不持久化完整原文——input/outputPreview 截断，
    // 防止用户输入与工具输出原文无限落盘（隐私/retention 契约）
    this.inputTruncateChars = options.inputTruncateChars ?? 200;
    this.outputPreviewChars = options.outputPreviewChars ?? 200;
  }

  /**
   * 追加事件（authoritative commit：disk 先行，成功后提交 memory sequence）。
   * Closure-2：构造候选事件 → appendFileSync（authoritative commit point）→
   * 成功后才推进 sequence 并 push memory——绝不出现"内存有 event N、磁盘没有
   * event N"；append 失败 = 日志失效（fail-closed），抛 RunEventLogDurabilityError，
   * 调用方必须让当前 Run 停止（不得产生新的 LLM/tool 副作用）。
   */
  record<E extends RunEvent>(type: E['type'], payload: E['payload']): void {
    if (this.failed) throw new RunEventLogDurabilityError(this.runId, '日志已因先前的 append 失败而失效');
    // Closure-2：候选事件（sequence 尚未提交）
    const nextSequence = this.sequence + 1;
    const event = {
      id: `${this.runId}-${nextSequence}-${randomBytes(3).toString('hex')}`,
      runId: this.runId,
      sequence: nextSequence,
      timestamp: Date.now(),
      type,
      // Closure 6：redaction——run_started 原文输入截断
      payload: this.redactPayload(type, payload),
    } as E;
    try {
      const dir = this.eventsDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${this.runId}.events.jsonl`), JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      // fail-closed：磁盘未提交 → memory 也不推进；日志立即失效，Run 必须停止
      this.failed = true;
      throw new RunEventLogDurabilityError(
        this.runId,
        err instanceof Error ? err.message : String(err),
      );
    }
    // authoritative commit point 之后：提交 memory 状态
    this.sequence = nextSequence;
    this.events.push(event);
  }

  /** 日志是否已失效（append 失败后为 true） */
  isFailed(): boolean {
    return this.failed;
  }

  /** 当前 runId（Closure-2：每 Run 唯一，测试/审计用） */
  getRunId(): string {
    return this.runId;
  }

  /** Closure 6：redaction——输入/输出按契约截断，不落盘完整原文 */
  private redactPayload(type: RunEventType, payload: Record<string, unknown>): Record<string, unknown> {
    if (type === 'run_started' && typeof payload.input === 'string' && payload.input.length > this.inputTruncateChars) {
      return { ...payload, input: payload.input.slice(0, this.inputTruncateChars) + '…' };
    }
    if (type === 'tool_completed' && typeof payload.outputPreview === 'string' && payload.outputPreview.length > this.outputPreviewChars) {
      return { ...payload, outputPreview: payload.outputPreview.slice(0, this.outputPreviewChars) + '…' };
    }
    return payload;
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
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return { projection: null, events }; // 读取失败（目录占位/权限）= 日志不完整，fail-closed
    }
    for (const line of raw.split('\n')) {
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

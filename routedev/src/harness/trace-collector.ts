// src/harness/trace-collector.ts
// Trace 收集器：被动记录 Agent 执行过程的事件流

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ReActEvent } from '../agent/loop-config.js';
import type { TokenUsageInfo, RoutingResult } from '../router/types.js';
import type {
  TraceSession,
  TraceSpan,
  TraceRecord,
  TraceSpanPayload,
  TraceCollectorConfig,
} from './trace-types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

const DEFAULT_CONFIG: TraceCollectorConfig = {
  enabled: true,
  maxSpansPerSession: 500,
};

export class TraceCollector {
  private config: TraceCollectorConfig;
  private currentSession: TraceSession | null = null;
  private spans: TraceSpan[] = [];
  private spanCounter = 0;

  constructor(config?: Partial<TraceCollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 开始新的 Trace 会话 */
  startSession(userInput: string, routeDecision?: RoutingResult): string {
    const id = crypto.randomUUID().slice(0, 8);
    this.currentSession = {
      id,
      startTime: Date.now(),
      userInput: userInput.slice(0, 200),
      routeDecision: routeDecision
        ? {
            modelId: routeDecision.model.id,
            tier: routeDecision.model.tier,
            fallbackUsed: routeDecision.fallbackUsed,
          }
        : undefined,
      spanCount: 0,
      completed: false,
    };
    this.spans = [];
    this.spanCounter = 0;
    logger.debug('Trace session started', { sessionId: id });
    return id;
  }

  /** 记录 ReAct 事件 */
  recordEvent(event: ReActEvent): void {
    if (!this.config.enabled || !this.currentSession) return;

    try {
      const record: TraceRecord = {
        timestamp: new Date().toISOString(),
        sessionId: this.currentSession.id,
        event: event.type,
        data: this.extractEventData(event),
      };

      switch (event.type) {
        case 'thinking':
          this.createSpan('react_iteration', {
            type: 'react_iteration',
            iteration: this.spans.filter(s => s.type === 'react_iteration').length + 1,
            thought: event.message,
          });
          break;
        case 'tool_call_start':
          this.createSpan('tool_call', {
            type: 'tool_call',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: {},
          });
          break;
        case 'tool_call_result':
          this.completeCurrentSpan('tool_call', {
            result: event.result.slice(0, 500),
            isError: event.isError,
          });
          break;
        case 'done':
          this.recordUsage(event.usage);
          break;
        case 'error':
          this.failCurrentSpan(event.error);
          break;
      }

      this.writeRecord(record);
    } catch (err) {
      logger.warn('TraceCollector: failed to record event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 记录工具调用 */
  recordToolCall(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    approvalRequired: boolean,
  ): TraceSpan | null {
    if (!this.config.enabled || !this.currentSession) return null;

    const span = this.createSpan('tool_call', {
      type: 'tool_call',
      toolName,
      toolCallId,
      args,
      approvalRequired,
    });

    this.writeRecord({
      timestamp: new Date().toISOString(),
      sessionId: this.currentSession.id,
      spanId: span.id,
      event: 'tool_call_start',
      data: { toolName, args, approvalRequired },
    });

    return span;
  }

  /** 记录工具结果 */
  recordToolResult(
    toolName: string,
    toolCallId: string,
    result: string,
    isError: boolean,
    approved?: boolean,
  ): void {
    if (!this.config.enabled || !this.currentSession) return;

    this.completeCurrentSpan('tool_call', {
      result: result.slice(0, 500),
      isError,
      approved,
    });

    this.writeRecord({
      timestamp: new Date().toISOString(),
      sessionId: this.currentSession.id,
      event: 'tool_call_end',
      data: { toolName, toolCallId, isError, approved },
    });
  }

  /** 记录 LLM 调用 */
  recordLLMCall(
    modelId: string,
    usage: TokenUsageInfo,
    responseLength: number,
    toolCallCount: number,
  ): void {
    if (!this.config.enabled || !this.currentSession) return;

    const span = this.createSpan('llm_call', {
      type: 'llm_call',
      modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      responseLength,
      toolCallCount,
    });
    this.completeSpan(span.id, 'completed');
  }

  /** 记录 Worker 任务 */
  recordWorkerTask(
    role: string,
    description: string,
    stepId: number,
  ): number {
    if (!this.config.enabled || !this.currentSession) return -1;

    const span = this.createSpan('worker_task', {
      type: 'worker_task',
      role,
      description: description.slice(0, 200),
      modifiedFiles: [],
    });
    span.stepId = stepId;
    span.workerRole = role;
    return span.id;
  }

  /** 完成 Worker 任务记录 */
  completeWorkerTask(
    spanId: number,
    success: boolean,
    conclusion: string,
    modifiedFiles: string[],
  ): void {
    if (!this.config.enabled || !this.currentSession) return;

    const span = this.spans.find(s => s.id === spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = success ? 'completed' : 'error';
    if (span.payload.type === 'worker_task') {
      span.payload.conclusion = conclusion.slice(0, 300);
      span.payload.modifiedFiles = modifiedFiles;
    }
  }

  /** 记录 Goal 步骤 */
  recordGoalStep(stepId: number, description: string, totalSteps: number): number {
    if (!this.config.enabled || !this.currentSession) return -1;

    const span = this.createSpan('goal_step', {
      type: 'goal_step',
      stepId,
      description: description.slice(0, 200),
      totalSteps,
    });
    span.stepId = stepId;
    return span.id;
  }

  /**
   * 开始命名 span（公共 API，供 ComposePipeline / HookRunner 等使用）
   * @param options.name span 名称（如 'compose:requirements'）
   * @param options.type span 类型（如 'compose-phase' 或 'hook'）
   * @returns span ID；若 Trace 未启用或无会话则返回 -1
   */
  startSpan(options: { name: string; type: string }): number {
    if (!this.config.enabled || !this.currentSession) return -1;

    // 将 type 字符串映射到 TraceSpanType
    const spanType = this.mapSpanType(options.type);
    const payload = this.buildNamedSpanPayload(options);
    const span = this.createSpan(spanType, payload);
    return span.id;
  }

  /**
   * 结束 span（公共 API）
   * @param spanId 指定 span ID；未指定时结束最近的 running span
   */
  endSpan(spanId?: number): void {
    if (!this.config.enabled || !this.currentSession) return;

    if (spanId !== undefined) {
      const span = this.spans.find(s => s.id === spanId);
      if (!span) return;
      span.endTime = Date.now();
      span.durationMs = span.endTime - span.startTime;
      span.status = 'completed';
      return;
    }

    // 未指定 ID：结束最近的 running span
    for (let i = this.spans.length - 1; i >= 0; i--) {
      if (this.spans[i].status === 'running') {
        this.spans[i].endTime = Date.now();
        this.spans[i].durationMs = this.spans[i].endTime! - this.spans[i].startTime;
        this.spans[i].status = 'completed';
        return;
      }
    }
  }

  /** 将外部 type 字符串映射到 TraceSpanType */
  private mapSpanType(type: string): TraceSpan['type'] {
    if (type === 'compose-phase' || type === 'compose_phase') return 'compose_phase';
    if (type === 'hook') return 'hook';
    // 未知类型回退为 react_iteration（不应发生）
    return 'react_iteration';
  }

  /** 构造命名 span 的 payload */
  private buildNamedSpanPayload(
    options: { name: string; type: string },
  ): TraceSpanPayload {
    if (options.type === 'compose-phase' || options.type === 'compose_phase') {
      // name 形如 'compose:requirements'，提取 phase
      const phase = options.name.includes(':')
        ? options.name.split(':').slice(1).join(':')
        : options.name;
      return {
        type: 'compose_phase',
        name: options.name,
        phase,
      };
    }
    if (options.type === 'hook') {
      // name 形如 'hook:pre-step:myHook'
      const parts = options.name.split(':');
      const event = parts[1] ?? '';
      const hookName = parts.slice(2).join(':') ?? '';
      return {
        type: 'hook',
        name: options.name,
        event,
        hookName,
      };
    }
    // 回退（不应发生）
    return {
      type: 'react_iteration',
      iteration: 0,
      thought: options.name,
    };
  }

  /** 结束会话并持久化 */
  async endSession(totalUsage?: TokenUsageInfo): Promise<void> {
    if (!this.currentSession) return;

    this.currentSession.endTime = Date.now();
    this.currentSession.completed = true;
    this.currentSession.spanCount = this.spans.length;
    if (totalUsage) this.currentSession.totalUsage = totalUsage;

    try {
      await this.flushToDisk();
      logger.debug('Trace session ended', {
        sessionId: this.currentSession.id,
        spans: this.spans.length,
      });
    } catch (err) {
      logger.warn('TraceCollector: failed to flush session', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.currentSession = null;
    this.spans = [];
  }

  getSessionId(): string | null {
    return this.currentSession?.id ?? null;
  }

  getSpans(): TraceSpan[] {
    return [...this.spans];
  }

  /** 列出磁盘上的会话 */
  async listSessions(limit = 20): Promise<TraceSession[]> {
    const dir = this.getStorageDir();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dayDir = path.join(dir, today);
      const files = await fs.readdir(dayDir);
      const sessions: TraceSession[] = [];

      for (const file of files) {
        if (!file.endsWith('.session.json')) continue;
        try {
          const content = await fs.readFile(path.join(dayDir, file), 'utf-8');
          sessions.push(JSON.parse(content));
        } catch {
          // 跳过损坏文件
        }
      }

      return sessions
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** 读取指定会话的记录 */
  async readSessionRecords(sessionId: string): Promise<TraceRecord[]> {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, today, `${sessionId}.trace.jsonl`);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  // ===== 内部方法 =====

  private createSpan(type: TraceSpan['type'], payload: TraceSpanPayload): TraceSpan {
    this.spanCounter++;

    if (this.spans.length >= this.config.maxSpansPerSession) {
      this.spans.shift();
    }

    const span: TraceSpan = {
      id: this.spanCounter,
      sessionId: this.currentSession!.id,
      type,
      startTime: Date.now(),
      payload,
      status: 'running',
    };
    this.spans.push(span);
    return span;
  }

  private completeCurrentSpan(
    type: TraceSpan['type'],
    payloadUpdate: Partial<TraceSpanPayload>,
  ): void {
    const span = [...this.spans]
      .reverse()
      .find(s => s.type === type && s.status === 'running');
    if (!span) return;

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = 'completed';
    Object.assign(span.payload, payloadUpdate);
  }

  private completeSpan(spanId: number, status: TraceSpan['status']): void {
    const span = this.spans.find(s => s.id === spanId);
    if (!span) return;
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
  }

  private failCurrentSpan(error: string): void {
    const span = [...this.spans]
      .reverse()
      .find(s => s.status === 'running');
    if (!span) return;
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = 'error';
    span.error = error;
  }

  private recordUsage(usage: TokenUsageInfo): void {
    if (this.currentSession) {
      this.currentSession.totalUsage = usage;
    }
  }

  private extractEventData(event: ReActEvent): Record<string, unknown> {
    switch (event.type) {
      case 'text_delta':
        return { textLength: event.text.length };
      case 'thinking':
        return { message: event.message.slice(0, 300) };
      case 'tool_call_start':
        return { toolName: event.toolName, toolCallId: event.toolCallId };
      case 'tool_call_result':
        return { toolName: event.toolName, isError: event.isError, resultLength: event.result.length };
      case 'approval_required':
        return { toolName: event.toolName, reason: event.reason };
      case 'error':
        return { error: event.error };
      case 'done':
        return { contentLength: event.content.length };
      default:
        return {};
    }
  }

  private writeRecord(record: TraceRecord): void {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    const filePath = path.join(dayDir, `${record.sessionId}.trace.jsonl`);
    ensureDir(dayDir);
    fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8').catch(err => {
      logger.warn('TraceCollector: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async flushToDisk(): Promise<void> {
    if (!this.currentSession) return;

    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    ensureDir(dayDir);

    const sessionPath = path.join(dayDir, `${this.currentSession.id}.session.json`);
    await fs.writeFile(
      sessionPath,
      JSON.stringify(this.currentSession, null, 2),
      'utf-8',
    );

    const spansPath = path.join(dayDir, `${this.currentSession.id}.spans.json`);
    await fs.writeFile(
      spansPath,
      JSON.stringify(this.spans, null, 2),
      'utf-8',
    );
  }

  private getStorageDir(): string {
    return this.config.storageDir
      ?? path.join(getAppDataDir(), 'traces');
  }
}
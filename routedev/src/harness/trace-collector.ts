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
  TrajectorySummary,
} from './trace-types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

const DEFAULT_CONFIG: TraceCollectorConfig = {
  enabled: true,
  maxSpansPerSession: 500,
};

/** P4：低优先级事件类型（背压时优先丢弃） */
const LOW_PRIORITY_EVENTS = new Set(['text_delta', 'stream_chunk']);

/** P4：写入队列批量 flush 的阈值（条数或时间间隔） */
const FLUSH_BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 100;

export class TraceCollector {
  private config: TraceCollectorConfig;
  private currentSession: TraceSession | null = null;
  private spans: TraceSpan[] = [];
  private spanCounter = 0;

  /** GUI 桥接：span 创建/更新时的回调 */
  private spanCallback: ((span: TraceSpan) => void) | null = null;

  /** P4：写入队列（批量 flush，避免每条 record 一次 appendFile 系统调用） */
  private writeQueue: TraceRecord[] = [];
  /** P4：flush 定时器 */
  private flushTimer: NodeJS.Timeout | null = null;
  /** P4：背压统计——丢弃的低优先级事件计数 */
  private droppedCount = 0;
  /** P4：队列水位上限（超过则丢弃低优先级事件） */
  private readonly queueHighWatermark = 1000;
  /** P4：跟踪未完成的异步写入，供 flush() 等待 */
  private pendingWrites: Promise<void>[] = [];

  /** Phase 77：sessionId → trace.jsonl 文件路径缓存，避免每次读取都扫描全部日期目录 */
  private sessionPathCache: Map<string, string> = new Map();

  /** 敏感字段名正则（不区分大小写） */
  private static readonly SENSITIVE_KEYS = /^(authorization|cookie|token|apikey|api_key|secret|password)$/i;

  constructor(config?: Partial<TraceCollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 设置 span 回调（GUI 桥接用） */
  onSpan(callback: ((span: TraceSpan) => void) | null): void {
    this.spanCallback = callback;
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

  /** 记录统一引擎事件（EngineEventV1，携带 sequence/turnId——Phase 97 Part A Task A3 消费点） */
  recordEngineEvent(event: import('./event-types.js').EngineEventV1): void {
    if (!this.config.enabled || !this.currentSession) return;
    this.writeRecord({
      timestamp: new Date(event.timestamp).toISOString(),
      sessionId: this.currentSession.id,
      event: `engine:${event.type}`,
      data: {
        sequence: event.sequence,
        turnId: event.turnId,
        triggerSource: event.triggerSource,
        payload: event.payload,
      },
    });
  }

  /** 记录工具调用 */
  recordToolCall(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    approvalRequired: boolean,
  ): TraceSpan | null {
    if (!this.config.enabled || !this.currentSession) return null;

    const sanitizedArgs = this.sanitizeArgs(args);

    const span = this.createSpan('tool_call', {
      type: 'tool_call',
      toolName,
      toolCallId,
      args: sanitizedArgs,
      approvalRequired,
    });

    this.writeRecord({
      timestamp: new Date().toISOString(),
      sessionId: this.currentSession.id,
      spanId: span.id,
      event: 'tool_call_start',
      data: { toolName, args: sanitizedArgs, approvalRequired },
    });

    return span;
  }

  /** 递归脱敏工具参数中的敏感字段 */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (TraceCollector.SENSITIVE_KEYS.test(k)) {
        cleaned[k] = '****';
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        cleaned[k] = this.sanitizeArgs(v as Record<string, unknown>);
      } else {
        cleaned[k] = v;
      }
    }
    return cleaned;
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

  /**
   * P4：强制 flush 所有待写入记录到磁盘并等待完成
   * 测试或进程退出前可调用，避免异步写入丢失
   */
  async flush(): Promise<void> {
    this.flushWriteQueue();
    if (this.pendingWrites.length > 0) {
      await Promise.all(this.pendingWrites);
    }
  }

  /**
   * G-F022 修复：释放资源——清除 flush 定时器并刷新待写入队列
   * 进程退出或引擎销毁前调用，避免定时器泄漏与异步写入丢失
   */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flush();
    } catch (err) {
      // 静默处理，避免 dispose 抛错
      logger.debug('TraceCollector dispose: flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Phase 34：计算当前会话的 trajectory 级汇总指标
   * @param options.taskId 任务标识（默认使用 sessionId）
   * @param options.success 是否成功完成
   * @param options.terminationReason 终止原因
   * @param options.modelId 使用模型 id
   * @param options.tier 场景等级
   */
  summarizeTrajectory(options?: {
    taskId?: string;
    success?: boolean;
    terminationReason?: TrajectorySummary['terminationReason'];
    modelId?: string;
    tier?: string;
  }): TrajectorySummary {
    const taskId = options?.taskId ?? this.currentSession?.id ?? 'unknown';
    const startTime = this.currentSession?.startTime ?? Date.now();
    const endTime = this.currentSession?.endTime ?? Date.now();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let llmCallCount = 0;
    let toolCallCount = 0;
    let retryCount = 0;
    let hasError = false;

    for (const span of this.spans) {
      if (span.payload.type === 'llm_call') {
        llmCallCount++;
        totalInputTokens += span.payload.inputTokens ?? 0;
        totalOutputTokens += span.payload.outputTokens ?? 0;
        totalTokens += (span.payload.inputTokens ?? 0) + (span.payload.outputTokens ?? 0);
      } else if (span.payload.type === 'tool_call') {
        toolCallCount++;
        if (span.status === 'error' || span.payload.isError) {
          hasError = true;
        }
      } else if (span.payload.type === 'react_iteration') {
        // react_iteration 中若包含错误观察，则计为一次重试意图
        if (span.payload.observation?.isError) {
          retryCount++;
        }
      }
    }

    // 若 session 上记录了总用量，以其为准（更准确）
    if (this.currentSession?.totalUsage) {
      totalInputTokens = this.currentSession.totalUsage.inputTokens ?? totalInputTokens;
      totalOutputTokens = this.currentSession.totalUsage.outputTokens ?? totalOutputTokens;
      totalTokens = this.currentSession.totalUsage.totalTokens ?? totalTokens;
    }

    const success = options?.success ?? !hasError;
    const terminationReason = options?.terminationReason ?? (success ? 'completed' : 'error');
    const durationMs = Math.max(0, endTime - startTime);
    const firstAttemptSuccessRate = retryCount === 0 ? 1 : Math.max(0, 1 / (retryCount + 1));

    return {
      taskId,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCost: this.estimateCost(totalTokens, options?.modelId),
      toolCallCount,
      llmCallCount,
      retryCount,
      firstAttemptSuccessRate,
      durationMs,
      success,
      terminationReason,
      modelId: options?.modelId,
      tier: options?.tier,
    };
  }

  /**
   * Phase 34：根据 token 数和模型 id 估算成本（美元）
   * 未配置价格时返回 0，避免依赖外部价格表
   */
  private estimateCost(totalTokens: number, modelId?: string): number {
    // 常见模型每 1K token 价格映射（输入+输出均价，仅作估算）
    const priceMap: Record<string, number> = {
      'gpt-4o': 0.005,
      'gpt-4o-mini': 0.0003,
      'gpt-4': 0.03,
      'claude-3-5-sonnet': 0.003,
      'claude-3-opus': 0.015,
      'kimi-k2.7': 0.002,
      'deepseek-v4': 0.0005,
      'deepseek-v4-flash': 0.0001,
      'qwen3.7-plus': 0.001,
      'minimax-m3': 0.0005,
    };
    const price = modelId ? priceMap[modelId] : undefined;
    if (!price) return 0;
    return Number(((totalTokens / 1000) * price).toFixed(6));
  }

  /**
   * 列出磁盘上的会话
   * Phase 77 修复：扫描所有 YYYY-MM-DD 日期子目录（不再只读当天），合并后按 startTime 降序取 limit 条
   */
  async listSessions(limit = 20): Promise<TraceSession[]> {
    const dir = this.getStorageDir();
    const sessions: TraceSession[] = [];
    try {
      const entries = await fs.readdir(dir);
      // F-009：对日期目录倒序排序（最新日期先扫描），累计达到 limit*2 条时提前 break
      const sortedEntries = entries.filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort().reverse();
      for (const entry of sortedEntries) {
        const dayDir = path.join(dir, entry);
        let files: string[];
        try {
          files = await fs.readdir(dayDir);
        } catch (e) {
          // 日期目录读取失败（可能是 ENOENT 或权限问题），跳过该目录
          logger.warn('[trace-collector] 读取日期目录失败，跳过', {
            dayDir,
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        for (const file of files) {
          if (!file.endsWith('.session.json')) continue;
          try {
            const content = await fs.readFile(path.join(dayDir, file), 'utf-8');
            const session: TraceSession = JSON.parse(content);
            sessions.push(session);
            // 顺带预热路径缓存（sessionId → trace.jsonl 路径）
            if (session.id && !this.sessionPathCache.has(session.id)) {
              this.sessionPathCache.set(session.id, path.join(dayDir, `${session.id}.trace.jsonl`));
            }
          } catch (e) {
            // session.json 读取或解析失败，跳过该损坏文件
            logger.warn('[trace-collector] session.json 解析失败，跳过', {
              file: path.join(dayDir, file),
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        // F-009：累计达到 limit*2 条时提前终止扫描（多读一些用于排序后裁剪）
        if (sessions.length >= limit * 2) break;
      }

      return sessions
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, limit);
    } catch (e) {
      // 存储根目录读取失败，降级返回空列表
      logger.warn('[trace-collector] 列出会话失败', {
        dir,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  /**
   * 读取指定会话的记录
   * Phase 77 修复：扫描所有日期目录查找 `${sessionId}.trace.jsonl`，找到后读取并缓存路径
   */
  async readSessionRecords(sessionId: string): Promise<TraceRecord[]> {
    const filePath = await this.locateSessionFile(sessionId, 'trace.jsonl');
    if (!filePath) return [];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch (e) {
      // trace.jsonl 读取或解析失败，降级返回空数组
      logger.warn('[trace-collector] 读取会话记录失败', {
        sessionId,
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  /**
   * Phase 77：读取指定会话的元数据（${sessionId}.session.json）
   * 供 scorecard 获取 goalId / totalUsage / startTime / endTime
   */
  async readSession(sessionId: string): Promise<TraceSession | null> {
    const filePath = await this.locateSessionFile(sessionId, 'session.json');
    if (!filePath) return null;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as TraceSession;
    } catch (e) {
      // session.json 读取或解析失败，降级返回 null
      logger.warn('[trace-collector] 读取会话元数据失败', {
        sessionId,
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Phase 77：读取指定会话的 spans（${sessionId}.spans.json）
   * 供 replayer 识别 goal_step 边界与 scorecard 统计 llm_call / retryCount
   */
  async readSessionSpans(sessionId: string): Promise<TraceSpan[]> {
    const filePath = await this.locateSessionFile(sessionId, 'spans.json');
    if (!filePath) return [];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as TraceSpan[]) : [];
    } catch (e) {
      // spans.json 读取或解析失败，降级返回空数组
      logger.warn('[trace-collector] 读取会话 spans 失败', {
        sessionId,
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  // ===== 内部方法 =====

  private createSpan(type: TraceSpan['type'], payload: TraceSpanPayload): TraceSpan {
    this.spanCounter++;

    // P4：改用 shift 改为环形缓冲区策略——超过上限时覆盖最旧元素
    // shift() 是 O(n)，改用 length 检查 + 直接索引覆盖避免数组移动开销
    if (this.spans.length >= this.config.maxSpansPerSession) {
      // 覆盖最旧元素（环形缓冲区语义）
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
    this.spanCallback?.(span);
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
    this.spanCallback?.(span);
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
    this.spanCallback?.(span);
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
    // P4：背压控制——队列超过水位时丢弃低优先级事件
    if (this.writeQueue.length >= this.queueHighWatermark) {
      if (LOW_PRIORITY_EVENTS.has(record.event)) {
        this.droppedCount++;
        // 每 100 次丢弃记录一次日志，避免日志刷屏
        if (this.droppedCount % 100 === 1) {
          logger.warn('TraceCollector: backpressure, dropping low-priority events', {
            dropped: this.droppedCount,
            queueSize: this.writeQueue.length,
          });
        }
        return;
      }
      // 高优先级事件不丢弃，但记录告警
      logger.warn('TraceCollector: queue full, high-priority event queued', {
        event: record.event,
        queueSize: this.writeQueue.length,
      });
    }

    // P4：入队而非直接写盘
    this.writeQueue.push(record);

    // 达到批量阈值时立即 flush
    if (this.writeQueue.length >= FLUSH_BATCH_SIZE) {
      this.flushWriteQueue();
      return;
    }

    // 启动定时 flush（如果尚未启动）
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushWriteQueue(), FLUSH_INTERVAL_MS);
      // flush 定时器不阻止进程退出
      this.flushTimer.unref?.();
    }
  }

  /** P4：批量 flush 写入队列到磁盘 */
  private flushWriteQueue(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.writeQueue.length === 0) return;

    // 取出当前队列内容，清空队列（允许新 record 并发入队）
    const batch = this.writeQueue.splice(0);
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    ensureDir(dayDir);

    // 按 sessionId 分组，合并为单次 appendFile 调用
    const bySession = new Map<string, TraceRecord[]>();
    for (const rec of batch) {
      const arr = bySession.get(rec.sessionId) ?? [];
      arr.push(rec);
      bySession.set(rec.sessionId, arr);
    }

    for (const [sessionId, records] of bySession) {
      const filePath = path.join(dayDir, `${sessionId}.trace.jsonl`);
      const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
      const write = fs.appendFile(filePath, content, 'utf-8')
        .catch(err => {
          logger.warn('TraceCollector: batch write failed', {
            error: err instanceof Error ? err.message : String(err),
            count: records.length,
          });
        })
        .finally(() => {
          this.pendingWrites = this.pendingWrites.filter(p => p !== write);
        });
      this.pendingWrites.push(write);
    }
  }

  private async flushToDisk(): Promise<void> {
    if (!this.currentSession) return;

    // P4：先 flush 写入队列，确保所有 record 落盘
    this.flushWriteQueue();

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

  /**
   * Phase 77：定位指定会话的某个产物文件（trace.jsonl / session.json / spans.json）
   * 优先查 sessionPathCache；未命中时扫描所有日期目录查找 `${sessionId}.trace.jsonl` 作为锚点并缓存。
   * @returns 完整文件路径；未找到返回 null
   */
  private async locateSessionFile(sessionId: string, suffix: 'trace.jsonl' | 'session.json' | 'spans.json'): Promise<string | null> {
    // 缓存中以 trace.jsonl 路径为锚，可派生出同目录下的其他文件
    const cached = this.sessionPathCache.get(sessionId);
    if (cached) {
      const derived = path.join(path.dirname(cached), `${sessionId}.${suffix}`);
      return derived;
    }
    // 扫描所有日期目录，定位 trace.jsonl（或目标 suffix）作为锚点
    const dir = this.getStorageDir();
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
        const dayDir = path.join(dir, entry);
        const tracePath = path.join(dayDir, `${sessionId}.trace.jsonl`);
        try {
          await fs.access(tracePath);
          // 命中：缓存 trace.jsonl 路径，返回目标 suffix 的完整路径
          this.sessionPathCache.set(sessionId, tracePath);
          return path.join(dayDir, `${sessionId}.${suffix}`);
        } catch (e) {
          // 该日期目录下无此会话，继续扫描下一个目录（正常控制流）
          logger.debug('[trace-collector] 定位会话文件：当前日期目录无此会话', {
            sessionId,
            dayDir: entry,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      // 存储根目录不存在或读取失败
      logger.warn('[trace-collector] 定位会话文件失败：存储根目录不可读', {
        sessionId,
        dir,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  }
}
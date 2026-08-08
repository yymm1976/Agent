// src/agent/context-manager.ts
// Loop 上下文管理器——从 loop.ts 抽取的上下文相关职责
// 负责：消息窗口管理、工具结果净化、token 监控、预算监控、队列管理、LLM 流处理

import type {
  LLMMessage,
  LLMStreamEvent,
  LLMRequestOptions,
  TokenUsageInfo,
  ToolCallRequest,
  ContentPart,
} from '../router/types.js';
import type { ReActEvent } from './loop-config.js';
import { DEFAULT_REACT_CONFIG } from './loop-config.js';
import { logger } from '../utils/logger.js';
// Closure-2：K2 post-finish 只吞 transport termination
import { isTransportTermination } from '../router/llm/k2-transport.js';
import type { TokenProfiler, TokenProfileSnapshot } from './token-profiler.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import type { ToolResultSanitizer } from '../tools/result-sanitizer.js';
import type { ToolOutputPipeline } from './context/tool-output-pipeline.js';
import type { BudgetMonitor } from './budget-monitor.js';
import type { BudgetAlert } from './budget-monitor.js';
import type { FollowUpMessage } from './message-types.js';
import { trimToolResult, CONCISE_THINKING_BLOCK, shouldSkipConcise } from './concise-thinking.js';
import type { SystemBlock } from './loop.js';

/** Token Profile 输入参数（与 token-profiler.ts 的 ProfileParams 结构兼容） */
interface ProfileInput {
  systemPrompt?: string;
  messages: LLMMessage[];
  tools?: unknown[];
  userMessage: string;
  iterationIndex: number;
  modelId: string;
  routeDecision: string;
}

/** LLM 流式调用的内部结果 */
export interface LLMStreamResult {
  content: string;
  toolCalls: ToolCallRequest[];
  usage: TokenUsageInfo;
  /**
   * F-012：终态传播——provider 的 finishReason 透传到 Agent 层。
   * complete=false = 协议不完整（done(error) 或流中断）——调用方不得视为成功。
   */
  finishReason?: 'stop' | 'tool_use' | 'length' | 'error';
  /** F-012：true = 完整终态（stop/tool_use/length）；false = 协议不完整 */
  complete: boolean;
  /**
   * K2（GA Hardening）：usage-only 尾块丢失标志。
   * complete=true 时区分两类情形：
   * - usageIncomplete=false —— usage 事件完整到达，token 记账可信
   * - usageIncomplete=true —— finish 已到（语义完成）但 usage 尾块丢失
   *   （流在 finish chunk 之后、usage-only 尾块之前中断）。
   *   本轮仍为**成功 turn**，绝不重执行；仅 token 记账会低估。
   */
  usageIncomplete: boolean;
  /**
   * Phase 96+：本轮 LLM 的推理内容（DeepSeek R1 类模型的 reasoning_content）
   * 工具调用修复 pipeline 的 scavenge 工序会从中捞回被吃掉的 tool-call JSON
   * 无推理能力的模型为空字符串
   */
  reasoning?: string;
}

/**
 * Loop 上下文管理器
 *
 * 从 ReActAgentLoop 抽取的上下文管理职责：
 * - 消息窗口截断与 tool_use/tool_result 对偶清理
 * - 工具结果净化（Sanitizer + Concise Thinking + Pipeline）
 * - Token Profiling 与预算监控
 * - Steering 队列与 Follow-up 队列管理
 * - LLM 流式响应解析
 */
export class LoopContextManager {
  private sanitizer: ToolResultSanitizer | null = null;
  private toolOutputPipeline: ToolOutputPipeline | null = null;
  private conciseThinkingEnabled = false;
  private profiler: TokenProfiler | null = null;
  private budgetMonitor: BudgetMonitor | null = null;
  private steeringConsumer: (() => { content: string; mode: string }[] | null) | null = null;
  private followUpQueue: FollowUpMessage[] = [];
  private followUpMode: 'all' | 'one-at-a-time' = 'one-at-a-time';
  private trace: TraceCollector | null = null;

  // ===== Setters =====

  /** 注入工具结果净化器 */
  setSanitizer(sanitizer: ToolResultSanitizer | null): void {
    this.sanitizer = sanitizer;
  }

  /** 注入工具输出统一处理 pipeline */
  setToolOutputPipeline(pipeline: ToolOutputPipeline | null): void {
    this.toolOutputPipeline = pipeline;
  }

  /** 设置简洁思考约束开关 */
  setConciseThinking(enabled: boolean): void {
    this.conciseThinkingEnabled = enabled;
  }

  /** 注入 Token Profiler */
  setProfiler(profiler: TokenProfiler | null): void {
    this.profiler = profiler;
  }

  /** 注入预算监控器 */
  setBudgetMonitor(monitor: BudgetMonitor | null): void {
    this.budgetMonitor = monitor;
  }

  /** 注入 Steering Queue 消费者 */
  setSteeringConsumer(consumer: (() => { content: string; mode: string }[] | null) | null): void {
    this.steeringConsumer = consumer;
  }

  /** 注入 TraceCollector */
  setTraceCollector(trace: TraceCollector | null): void {
    this.trace = trace;
  }

  // ===== Getters =====

  get traceCollector(): TraceCollector | null {
    return this.trace;
  }

  get hasBudgetMonitor(): boolean {
    return this.budgetMonitor !== null;
  }

  get followUpQueueLength(): number {
    return this.followUpQueue.length;
  }

  // ===== Follow-up 队列管理 =====

  /** 排队 follow-up 消息 */
  followUp(content: string): void {
    // 队列深度上限：防止异常积压导致上下文超限
    const MAX_FOLLOWUP_QUEUE = 50;
    if (this.followUpQueue.length >= MAX_FOLLOWUP_QUEUE) {
      logger.warn('Follow-up 队列已满，淘汰最旧条目', { queueSize: this.followUpQueue.length });
      this.followUpQueue.shift();
    }
    this.followUpQueue.push({ role: 'follow_up', content, enqueuedAt: Date.now() });
    logger.debug('Follow-up message enqueued', { queueSize: this.followUpQueue.length });
  }

  /** 设置 follow-up 出队模式 */
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): void {
    this.followUpMode = mode;
  }

  /** 查询 follow-up 队列内容（只读快照） */
  getFollowUpQueue(): FollowUpMessage[] {
    return [...this.followUpQueue];
  }

  /** 删除指定索引的 follow-up 消息 */
  removeFollowUp(index: number): boolean {
    if (index < 0 || index >= this.followUpQueue.length) return false;
    this.followUpQueue.splice(index, 1);
    return true;
  }

  /** 清空所有队列 */
  clearAllQueues(): void {
    this.followUpQueue = [];
  }

  /** 查询队列状态 */
  getQueueStatus(): { followUp: number } {
    return { followUp: this.followUpQueue.length };
  }

  /** 取出 follow-up 队列消息（供外层循环注入） */
  drainFollowUpQueue(): FollowUpMessage[] {
    if (this.followUpQueue.length === 0) return [];
    if (this.followUpMode === 'all') {
      const drained = this.followUpQueue;
      this.followUpQueue = [];
      return drained;
    }
    return [this.followUpQueue.shift()!];
  }

  // ===== 消息窗口管理 =====

  /**
   * 安全地截断 messages 窗口，保证 assistant tool_use 与对应 tool_result 成对出现。
   * 简单 splice 会在工具调用轮次中间切断，导致 OpenAI/DeepSeek 报
   * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
   */
  trimMessagesWindow(messages: LLMMessage[], maxMessages: number): void {
    if (messages.length <= maxMessages) return;

    let removeCount = messages.length - maxMessages;

    // 1. 安全边界：截断后第一条保留消息不能是孤立的 tool_result user 消息
    while (removeCount < messages.length) {
      const msg = messages[removeCount];
      if (
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        msg.content.every((p) => p.type === 'tool_result')
      ) {
        removeCount++;
        continue;
      }
      break;
    }

    // I1 修复：保护至少保留一条消息，避免 trimMessagesWindow 清空所有消息
    if (removeCount >= messages.length) {
      removeCount = messages.length - 1;
    }

    messages.splice(0, removeCount);

    // 2. 截断后必须双向清理：tool_use 和 tool_result 必须成对出现
    this.sanitizeToolMessages(messages);
  }

  /**
   * 双向清理 tool_use / tool_result 对偶关系。
   * OpenAI/DeepSeek 要求：
   *   - assistant 消息中的 tool_use 必须有后续对应的 tool_result
   *   - user 消息中的 tool_result 必须有前面对应的 tool_use
   * 任一方向出现孤立都会导致 400 错误。
   */
  sanitizeToolMessages(messages: LLMMessage[]): void {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_use') toolUseIds.add(part.id);
        }
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_result') toolResultIds.add(part.toolUseId);
        }
      }
    }

    const toDelete = new Set<number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const hadToolUse = msg.content.some((p) => p.type === 'tool_use');
        msg.content = msg.content.filter((part) => {
          if (part.type !== 'tool_use') return true;
          if (toolResultIds.has(part.id)) return true;
          logger.warn('Removing orphaned tool_use without matching tool_result', { toolUseId: part.id });
          return false;
        });
        // 如果 assistant 消息原本只包含 tool_use 且全部被移除，删除整条消息
        if (hadToolUse && msg.content.length === 0) {
          toDelete.add(i);
        }
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content = msg.content.filter((part) => {
          if (part.type !== 'tool_result') return true;
          if (toolUseIds.has(part.toolUseId)) return true;
          logger.warn('Removing orphaned tool_result without matching tool_use', { toolUseId: part.toolUseId });
          return false;
        });
      }
    }

    // 倒序删除被标记的 assistant 空消息
    for (let i = messages.length - 1; i >= 0; i--) {
      if (toDelete.has(i)) {
        messages.splice(i, 1);
      }
    }
  }

  // ===== 工具结果净化 =====

  /**
   * 净化工具结果——如果设置了 sanitizer 则调用，否则原样返回
   * 在 4 个工具结果注入点（并行/串行 × 结果/拒绝）统一调用
   * 任务3：简洁思考约束启用时，额外调用 trimToolResult 裁剪过长工具返回
   *
   * Phase 72 Task B2：改为 async 以支持 ContentRouter 内部的 AST 提取（async WASM 调用）
   * toolArgs 可选，传入时供 ContentRouter 提取 filePath 做 AST 提取
   */
  async sanitizeToolResult(
    toolName: string,
    result: string,
    toolArgs?: Record<string, unknown>,
  ): Promise<string> {
    // Phase 71 Task D3：优先走 ToolOutputPipeline（收拢 Sanitizer / Concise Thinking / Budget Offload）
    if (this.toolOutputPipeline) {
      const r = await this.toolOutputPipeline.process(toolName, result, toolArgs);
      return r.output;
    }
    // 回退：pipeline 未注入时走原逻辑（零回归保护）
    let processed = result;
    if (this.sanitizer) {
      try {
        const sanitized = this.sanitizer.sanitize(toolName, processed);
        if (sanitized.injectionDetected) {
          logger.warn('Injection detected in tool result, warning prefix added', {
            toolName,
            patterns: sanitized.patterns,
          });
        }
        processed = sanitized.content;
      } catch (err) {
        // 净化失败不阻断工具执行，返回原始结果
        logger.warn('ToolResultSanitizer failed, returning raw result', { toolName, error: String(err) });
      }
    }
    // 任务3：简洁思考约束——裁剪过长的工具返回（> 2000 字符时 800 首 + 标记 + 800 尾）
    // 未启用时原样返回，与 ContextCompactor L1 取两者较小裁剪结果
    processed = trimToolResult(processed, this.conciseThinkingEnabled);
    return processed;
  }

  // ===== Steering 队列 =====

  /**
   * 从 Steering Queue 取出消息并注入 messages
   * 来源为 steeringConsumer 返回的外部队列消息（接入 TaskOrchestrator 时，生产路径）。
   *
   * @param modeFilter 筛选模式（'next_iteration' / 'immediate' / 'after_current_step'）；不传则取出全部
   * @returns 是否注入了消息
   */
  drainSteeringIntoMessages(
    messages: LLMMessage[],
    modeFilter?: string,
  ): boolean {
    const externalDrained = this.steeringConsumer ? (this.steeringConsumer() ?? []) : [];
    if (externalDrained.length === 0) return false;
    const filtered = modeFilter
      ? externalDrained.filter((m) => m.mode === modeFilter)
      : externalDrained;
    if (filtered.length === 0) return false;
    for (const msg of filtered) {
      messages.push({ role: 'user', content: `[用户转向指令] ${msg.content}` });
      logger.debug('Steering message injected into messages', { mode: msg.mode });
    }
    return true;
  }

  // ===== Token 监控 =====

  /**
   * 生成 Token Profile 快照（Phase 30：可观测性，可选）
   * @returns 快照或 null（profiler 未注入时）
   */
  profile(input: ProfileInput): TokenProfileSnapshot | null {
    if (!this.profiler) return null;
    return this.profiler.profile(input);
  }

  /**
   * 预算监控——每次迭代结束后检查本轮工具调用与 token 消耗（fail-open）
   * 记录本轮 token 消耗 + 所有工具调用，然后检查告警（同 alertId 不重复返回）
   */
  checkBudget(usage: TokenUsageInfo, toolCalls: ToolCallRequest[]): void {
    if (!this.budgetMonitor) return;
    try {
      this.budgetMonitor.recordToken(usage.totalTokens);
      for (const tc of toolCalls) {
        this.budgetMonitor.recordToolCall(tc.name);
      }
      const alerts: BudgetAlert[] = this.budgetMonitor.check();
      const availableBudget = this.budgetMonitor.getAvailableBudget();
      const reserveRatio = this.budgetMonitor.getReserveRatio();
      for (const a of alerts) {
        logger.warn('BudgetMonitor alert', {
          type: a.type,
          severity: a.severity,
          message: a.message,
          current: a.current,
          threshold: a.threshold,
          availableBudget,
          reserveRatio,
        });
      }
    } catch (budgetErr) {
      // fail-open：监控异常不影响主流程
      logger.warn('BudgetMonitor check failed, continuing (fail-open)', {
        error: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
      });
    }
  }

  // ===== 简洁思考注入 =====

  /**
   * 简洁思考约束——用户未请求详细输出时，追加输出纪律到系统提示词
   * Phase 55：systemBlocks 模式下追加为独立 block（不缓存，每次都可能变化）
   * @returns 更新后的 { systemPrompt, systemBlocks }
   */
  injectConciseThinking(
    systemPrompt: string | undefined,
    systemBlocks: SystemBlock[] | undefined,
    userMessage: string,
  ): { systemPrompt: string | undefined; systemBlocks: SystemBlock[] | undefined } {
    if (!this.conciseThinkingEnabled || shouldSkipConcise(userMessage)) {
      return { systemPrompt, systemBlocks };
    }
    if (systemBlocks) {
      return { systemPrompt, systemBlocks: [...systemBlocks, { type: 'text', text: CONCISE_THINKING_BLOCK }] };
    }
    return { systemPrompt: (systemPrompt ?? '') + '\n\n' + CONCISE_THINKING_BLOCK, systemBlocks };
  }

  // ===== LLM 流式响应解析 =====

  /**
   * 解析 LLM 流式响应，yield text_delta/reasoning_delta 事件，返回完整的工具调用和 usage
   * 从 callLLMStream 抽取的流处理逻辑，保持 yield 语义一致
   */
  async *processLLMStream(
    stream: AsyncGenerator<LLMStreamEvent, void, unknown>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ReActEvent, LLMStreamResult> {
    let fullContent = '';
    let fullReasoning = '';
    const toolCalls: ToolCallRequest[] = [];
    let usage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finishReason: 'stop' | 'tool_use' | 'length' | 'error' | undefined;

    // 工具调用参数累积缓冲
    // M3：__argsBuffer 为临时字段，用于累积 JSON 片段，end/done 时解析后删除
    const toolCallBuffers = new Map<string, { id: string; name: string; arguments: Record<string, unknown>; __argsBuffer?: string }>();
    // 用于按顺序追踪当前的工具调用
    const toolCallOrder: string[] = [];
    // K2：usage 事件是否到达——流结束时仍为 false = usage-only 尾块丢失
    let usageSeen = false;

    try {
      for await (const event of stream) {
        // 检查取消
        if (signal?.aborted) break;

        switch (event.type) {
          case 'text_delta':
            fullContent += event.text;
            yield { type: 'text_delta', text: event.text };
            break;

        case 'reasoning_delta':
          fullReasoning += event.text;
          yield { type: 'reasoning_delta', text: event.text };
          break;

        case 'tool_call_start': {
          const tcId = event.toolCall.id;
          const tcName = event.toolCall.name;
          toolCallBuffers.set(tcId, { id: tcId, name: tcName, arguments: {} });
          toolCallOrder.push(tcId);
          break;
        }

        case 'tool_call_delta': {
          // 累积工具调用参数
          const buffer = toolCallBuffers.get(event.toolCallId);
          if (buffer) {
            // argumentsDelta 是 JSON 字符串片段，需要累积后在 end 时解析
            const existing = (buffer as Record<string, unknown>).__argsBuffer;
            const argsBuffer = (typeof existing === 'string' ? existing : '') + event.argumentsDelta;
            (buffer as Record<string, unknown>).__argsBuffer = argsBuffer;
          }
          break;
        }

        case 'tool_call_end': {
          const buffer = toolCallBuffers.get(event.toolCallId);
          if (buffer) {
            // 解析累积的参数 JSON
            const argsBuffer = (buffer as Record<string, unknown>).__argsBuffer;
            if (typeof argsBuffer === 'string' && argsBuffer.trim()) {
              try {
                buffer.arguments = JSON.parse(argsBuffer);
              } catch {
                logger.warn('Failed to parse tool call arguments', { argsBuffer });
                buffer.arguments = {};
              }
            }
            // 清理临时字段
            delete (buffer as Record<string, unknown>).__argsBuffer;
            // 加入最终列表
            toolCalls.push({
              id: buffer.id,
              name: buffer.name,
              arguments: buffer.arguments,
            });
          }
          break;
        }

        case 'usage':
          usage = event.usage;
          usageSeen = true;
          break;

        case 'done':
          // F-012：终态传播——done(error) = 协议不完整，partial tool buffers
          // 绝不产生可执行 ToolCallRequest（残缺参数执行 = 危险副作用）
          finishReason = event.finishReason;
          if (event.finishReason !== 'error') {
            this.flushToolCallBuffers(toolCallBuffers, toolCalls);
          } else {
            logger.warn('LLM stream done(error): partial tool calls discarded', {
              pendingBuffers: toolCallBuffers.size,
            });
            toolCallBuffers.clear();
          }
          break;
      }
      }
    } catch (error) {
      // K2 Transport Terminal（Closure 1）：done(non-error) 已收到后 transport exception →
      // 语义完成——计费尾块传输失败绝不能把已成功 turn 变成失败（否则重执行）。
      // 已 flush 的完整工具调用保留（tool 只执行一次）；usage 缺失 → usageIncomplete=true。
      // Closure-2：仅吞 transport termination——内部程序异常（TypeError 等）不得伪装成功。
      // 用户取消不在此列（signal.aborted → 重抛，取消语义优先）。
      if (finishReason !== undefined && finishReason !== 'error' && !signal?.aborted && isTransportTermination(error)) {
        logger.warn('K2: stream transport error after done received——语义完成，usage 可能不完整', {
          finishReason,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        throw error;
      }
    }

    // F-012：取消中断时同样丢弃 partial tool buffers（不执行残缺工具调用）
    if (signal?.aborted) {
      toolCallBuffers.clear();
    }

    // 返回（AsyncGenerator return value）
    const complete = finishReason !== undefined && finishReason !== 'error';
    // K2：finish 已到（语义完成）但 usage 尾块从未到达 → usageIncomplete=true。
    // 本轮仍为成功 turn（complete=true），调用方不得重执行——仅 token 记账低估。
    const usageIncomplete = complete && !usageSeen;
    return {
      content: fullContent,
      toolCalls,
      usage,
      reasoning: fullReasoning,
      finishReason,
      complete,
      usageIncomplete,
    };
  }

  /**
   * M1 修复：flush 工具调用缓冲区，将未收到 tool_call_end 的 buffer 解析并加入 toolCalls
   * 被 done 事件和 abort 中断后共用，保证工具参数完整性
   */
  private flushToolCallBuffers(
    toolCallBuffers: Map<string, { id: string; name: string; arguments: Record<string, unknown>; __argsBuffer?: string }>,
    toolCalls: ToolCallRequest[],
  ): void {
    for (const [id, buffer] of toolCallBuffers) {
      if (!toolCalls.some((tc) => tc.id === id)) {
        const argsBuffer = (buffer as Record<string, unknown>).__argsBuffer;
        if (typeof argsBuffer === 'string' && argsBuffer.trim()) {
          try {
            buffer.arguments = JSON.parse(argsBuffer);
          } catch {
            buffer.arguments = {};
          }
        }
        delete (buffer as Record<string, unknown>).__argsBuffer;
        toolCalls.push({ id: buffer.id, name: buffer.name, arguments: buffer.arguments });
      }
    }
  }
}

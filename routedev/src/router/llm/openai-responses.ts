// src/router/llm/openai-responses.ts
// OpenAI Responses API 协议客户端实现
// 与 Chat Completions API 不同，Responses API 使用 input/output items + instructions 模型
// 支持：非流式、流式、工具调用、推理增量

import OpenAI from 'openai';
import type {
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseFunctionToolCall,
  ResponseStreamEvent,
  ResponseUsage,
  ResponseCreateParamsBase,
  FunctionTool,
} from 'openai/resources/responses/responses';
import { BaseLLMClient } from './base.js';
import type {
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  LLMToolDefinition,
  ToolCallRequest,
  TokenUsageInfo,
} from '../types.js';
import { LLMError } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * OpenAI Responses API 协议客户端
 *
 * 与 OpenAIClient（Chat Completions）的关键差异：
 * - system prompt 通过 `instructions` 字段传递，不放入 input
 * - 历史消息通过 `input` 数组传递，每条消息用 ResponseInputItem 表示
 * - user 消息内容用 `input_text`，assistant 消息用 EasyInputMessage（content: string）
 * - 工具调用作为独立的 `function_call` item，工具结果作为 `function_call_output` item
 * - 工具定义格式：`{ type: 'function', name, description, parameters }`（name 提到外层，无 function 嵌套）
 * - 流式事件类型丰富，需要跟踪 item_id → call_id 映射（arguments.delta 只携带 item_id）
 */
export class OpenAIResponsesClient extends BaseLLMClient {
  readonly protocol = 'openai-responses' as const;
  private readonly client: OpenAI | null;
  /** 客户端是否就绪（apiKey 已配置） */
  private readonly _isReady: boolean;

  constructor(config: {
    providerId: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    super(config);
    // 安全策略：与 OpenAIClient 一致，apiKey 为空时不构造客户端，避免 401
    if (!config.apiKey) {
      this.client = null;
      this._isReady = false;
      logger.warn(`${config.providerId} API Key 未配置，客户端不可用`);
    } else {
      this.client = new OpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        timeout: config.timeoutMs ?? 30000,
      });
      this._isReady = true;
    }
  }

  /** 检查客户端是否就绪（apiKey 已配置且客户端已构造） */
  override isReady(): boolean {
    return this._isReady;
  }

  /**
   * 非流式调用
   * 使用 client.responses.create() + stream:false
   */
  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    if (!this.client) {
      throw new LLMError(`${this.providerId} 客户端未就绪（API Key 未配置）`, undefined, options.model);
    }
    const startTime = Date.now();
    this.logRequest(options.model, false, options.messages.length);

    try {
      const params = this.buildRequestParams(options, false);
      const requestOptions = this.buildRequestOptions(options);
      // P0-10：用 withRetry 包装实际 API 调用
      // TD-21 Phase 1：透传 options.onRetry（provider retry 可观测性）
      const response = await this.withRetry(
        () => this.client!.responses.create(params, requestOptions) as Promise<Response>,
        options.onRetry,
      );

      const { content, toolCalls } = this.extractOutput(response.output);
      const usage = this.extractUsage(response.usage);
      const finishReason = this.mapFinishReason(response.status, toolCalls.length > 0);

      this.logResponse(options.model, usage, Date.now() - startTime);

      return {
        content,
        toolCalls,
        usage,
        finishReason,
        model: response.model,
      };
    } catch (err) {
      throw this.normalizeError(err, options.model);
    }
  }

  /**
   * 流式调用
   * 使用 client.responses.create() + stream:true，返回 AsyncIterable<ResponseStreamEvent>
   */
  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown> {
    if (!this.client) {
      throw new LLMError(`${this.providerId} 客户端未就绪（API Key 未配置）`, undefined, options.model);
    }
    const startTime = Date.now();
    this.logRequest(options.model, true, options.messages.length);

    // K2 Transport Terminal（Closure 1）：done 已发出 = 语义完成——
    // 声明在 try 外：catch 需要读取（done 已发出判定）
    let doneEmitted = false;

    try {
      const params = this.buildRequestParams(options, true);
      const requestOptions = this.buildRequestOptions(options);
      // Closure 6（TD-21）：流式 create 也接入 withRetry（请求阶段 5xx 重试安全；
      // 流开始后的异常由 K2 Transport Terminal 处理）
      const stream = await this.withRetry(
        () => this.client!.responses.create(params, requestOptions) as Promise<unknown>,
        options.onRetry,
      ) as unknown as AsyncIterable<ResponseStreamEvent>;

      // 跟踪 item_id → call_id 映射
      // 关键：response.function_call_arguments.delta 事件只携带 item_id，不含 call_id
      // 需要从 response.output_item.added 事件中记录 item_id 对应的 call_id
      const itemIdToCallId = new Map<string, string>();
      // 跟踪已结束的 call_id，用于在 completed 事件中补发未触发的 tool_call_end
      const endedCallIds = new Set<string>();
      let hasToolCalls = false;
      let doneEmitted = false;

      for await (const event of stream) {
        switch (event.type) {
          // ---- 文本增量 ----
          case 'response.output_text.delta': {
            yield { type: 'text_delta', text: event.delta };
            break;
          }

          // ---- 推理增量（reasoning summary / reasoning text） ----
          case 'response.reasoning_summary_text.delta': {
            yield { type: 'reasoning_delta', text: event.delta };
            break;
          }
          case 'response.reasoning_text.delta': {
            yield { type: 'reasoning_delta', text: event.delta };
            break;
          }

          // ---- 工具调用：新增 output_item ----
          case 'response.output_item.added': {
            const item = event.item;
            if (item.type === 'function_call') {
              const fc = item as ResponseFunctionToolCall;
              const callId = fc.call_id;
              hasToolCalls = true;
              // 记录 item_id → call_id 映射，供后续 arguments.delta 事件查询
              // 注意：event 没有独立 item_id 字段，使用 item.id 作为 key
              if (fc.id) {
                itemIdToCallId.set(fc.id, callId);
              }
              yield {
                type: 'tool_call_start',
                toolCall: { id: callId, name: fc.name },
              };
            }
            break;
          }

          // ---- 工具调用：参数增量 ----
          case 'response.function_call_arguments.delta': {
            // event 只携带 item_id，不含 call_id；从映射表中查询
            const callId = itemIdToCallId.get(event.item_id);
            if (callId) {
              yield {
                type: 'tool_call_delta',
                toolCallId: callId,
                argumentsDelta: event.delta,
              };
            }
            break;
          }

          // ---- 工具调用：output_item 完成 ----
          case 'response.output_item.done': {
            const item = event.item;
            if (item.type === 'function_call') {
              const fc = item as ResponseFunctionToolCall;
              const callId = fc.call_id;
              if (callId && !endedCallIds.has(callId)) {
                endedCallIds.add(callId);
                yield { type: 'tool_call_end', toolCallId: callId };
              }
            }
            break;
          }

          // ---- 完成 ----
          case 'response.completed': {
            // 兜底：若 output_item.done 未触发但 completed 携带了完整 output，补发 tool_call_end
            for (const item of event.response.output) {
              if (item.type === 'function_call') {
                const fc = item as ResponseFunctionToolCall;
                hasToolCalls = true;  // 防御性更新，确保 finishReason 正确
                if (fc.call_id && !endedCallIds.has(fc.call_id)) {
                  endedCallIds.add(fc.call_id);
                  yield { type: 'tool_call_end', toolCallId: fc.call_id };
                }
              }
            }
            const usage = this.extractUsage(event.response.usage);
            // 与 OpenAIClient 流式一致：在 done 前 yield usage 事件
            yield { type: 'usage', usage };
            doneEmitted = true;
            yield {
              type: 'done',
              finishReason: this.mapFinishReason(event.response.status, hasToolCalls),
            };
            this.logResponse(options.model, usage, Date.now() - startTime);
            return;
          }

          // ---- 失败 ----
          case 'response.failed': {
            doneEmitted = true;
            yield { type: 'done', finishReason: 'error' };
            this.logResponse(
              options.model,
              { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              Date.now() - startTime,
            );
            return;
          }

          // ---- 不完整（多数因 max_output_tokens 截断） ----
          case 'response.incomplete': {
            const usage = this.extractUsage(event.response.usage);
            yield { type: 'usage', usage };
            doneEmitted = true;
            yield { type: 'done', finishReason: 'length' };
            this.logResponse(options.model, usage, Date.now() - startTime);
            return;
          }

          // ---- SDK 级 error 事件 ----
          case 'error': {
            doneEmitted = true;
            yield { type: 'done', finishReason: 'error' };
            this.logResponse(
              options.model,
              { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              Date.now() - startTime,
            );
            return;
          }

          default:
            // 其他事件类型（web_search/code_interpreter/mcp 等）暂不处理
            break;
        }
      }

      // 流自然结束但未收到 completed/failed/incomplete 事件：保守补发 done
      yield { type: 'done', finishReason: 'error' };
    } catch (err) {
      // K2 Transport Terminal（Closure 1）：done 已发出 → 语义完成，
      // 后续 transport exception 不得把已成功 turn 变成失败（usage 缺失由消费方标记）。
      // 用户取消不在此列。
      if (doneEmitted && !options.signal?.aborted) {
        logger.warn('K2: openai-responses stream transport error after done emitted——语义完成', {
          model: options.model,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      throw this.normalizeError(err, options.model);
    }
  }

  /**
   * 构建请求参数
   * 返回 ResponseCreateParamsBase（含 stream 字段），由调用方传入 SDK
   */
  private buildRequestParams(
    options: LLMRequestOptions,
    stream: boolean,
  ): ResponseCreateParamsBase {
    const input = this.convertMessages(options.messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    // 交集 Record<string, unknown> 允许写入 SDK 未声明的厂商扩展字段
    const params: ResponseCreateParamsBase & Record<string, unknown> = {
      model: options.model,
      input,
      stream,
    };

    // system prompt 走 instructions，不放入 input
    if (options.systemPrompt) {
      params.instructions = options.systemPrompt;
    }

    if (options.maxTokens !== undefined) {
      params.max_output_tokens = options.maxTokens;
    }

    if (options.temperature !== undefined) {
      params.temperature = options.temperature;
    }

    if (tools) {
      params.tools = tools;
    }

    // P2-10：OpenAI Responses API 通过 prompt_cache_key 启用 Prompt 缓存
    if (options.enableCache) {
      params.prompt_cache_key = `routedev-${options.model}`;
    }

    // 默认不存储响应（store: false），避免服务端累积状态
    params.store = false;

    return params;
  }

  /**
   * 构建 SDK RequestOptions（透传 timeoutMs 和 signal）
   * 与 OpenAIClient 保持一致的行为
   */
  private buildRequestOptions(
    options: LLMRequestOptions,
  ): { timeout?: number; signal?: AbortSignal } | undefined {
    if (options.timeoutMs || options.signal) {
      return {
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
    }
    return undefined;
  }

  /**
   * 转换消息格式（统一格式 → Responses API input items）
   *
   * 关键差异（与 Chat Completions 不同）：
   * - system 消息不放入 input，由调用方通过 instructions 字段传递
   * - user 消息内容用 `input_text` 类型
   * - assistant 消息用 EasyInputMessage（content: string）形式
   *   （ResponseInputItem.Message 的 role 不支持 'assistant'；
   *    ResponseOutputMessage 需要必填 id/status 字段，故使用简化形式）
   * - tool_use（assistant 发起的工具调用）作为独立 `function_call` item
   * - tool_result（user 返回的工具结果）作为独立 `function_call_output` item
   * - 混合内容（text + tool_use/tool_result）拆分为多个 items
   */
  private convertMessages(messages: LLMMessage[]): ResponseInputItem[] {
    const result: ResponseInputItem[] = [];

    for (const msg of messages) {
      // system 消息由 instructions 单独处理，跳过
      if (msg.role === 'system') {
        continue;
      }

      if (typeof msg.content === 'string') {
        // 纯文本消息
        if (msg.role === 'user') {
          // user + text → { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
          result.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: msg.content }],
          } as ResponseInputItem);
        } else if (msg.role === 'assistant') {
          // assistant + text → EasyInputMessage 形式（content: string）
          result.push({
            role: 'assistant',
            content: msg.content,
          } as ResponseInputItem);
        }
        continue;
      }

      // 数组内容：分离 text / tool_use / tool_result
      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      const toolResults: Array<{ toolUseId: string; content: string }> = [];

      for (const part of msg.content) {
        switch (part.type) {
          case 'text':
            textParts.push(part.text);
            break;
          case 'tool_use':
            toolCalls.push({
              id: part.id,
              name: part.name,
              arguments: part.arguments,
            });
            break;
          case 'tool_result':
            toolResults.push({
              toolUseId: part.toolUseId,
              content: part.content,
            });
            break;
          case 'image':
            // Responses API 支持 input_image，但当前统一格式 ImageContent 与 SDK 格式不同
            // 暂不处理，避免类型不匹配；如需多模态支持，可在此扩展
            logger.warn('[openai-responses] image content 暂不支持，已跳过');
            break;
        }
      }

      // 1) 文本部分：作为 message item
      if (textParts.length > 0) {
        const text = textParts.join('\n');
        if (msg.role === 'user') {
          result.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          } as ResponseInputItem);
        } else if (msg.role === 'assistant') {
          result.push({
            role: 'assistant',
            content: text,
          } as ResponseInputItem);
        }
      }

      // 2) tool_use：作为独立的 function_call item（assistant 发起）
      // Responses API 的 function_call arguments 是 JSON 字符串
      for (const tc of toolCalls) {
        result.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        } as ResponseInputItem);
      }

      // 3) tool_result：作为独立的 function_call_output item（user 返回）
      for (const tr of toolResults) {
        result.push({
          type: 'function_call_output',
          call_id: tr.toolUseId,
          output: tr.content,
        } as ResponseInputItem);
      }
    }

    return result;
  }

  /**
   * 转换工具定义
   *
   * Chat Completions 格式：{ type: 'function', function: { name, description, parameters } }
   * Responses API 格式：{ type: 'function', name, description, parameters, strict }
   * 关键差异：name 提到外层，无 function 嵌套；strict 默认为 null（非严格模式）
   */
  private convertTools(tools: LLMToolDefinition[]): FunctionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // Phase 96 P1-6：透传 strict 字段（OpenAI Responses API Structured Outputs）
      // 上层未指定时默认 null（非严格模式，允许模型生成 schema 之外的参数）
      strict: tool.strict ?? null,
    }));
  }

  /**
   * 从 response.output 中提取文本内容和工具调用
   *
   * output 是 ResponseOutputItem 数组，可能包含：
   * - ResponseOutputMessage（type: 'message'）：含 output_text 内容
   * - ResponseFunctionToolCall（type: 'function_call'）：含 call_id / name / arguments
   * - 其他类型（reasoning / file_search / web_search 等）暂不处理
   */
  private extractOutput(output: ResponseOutputItem[]): {
    content: string;
    toolCalls: ToolCallRequest[];
  } {
    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];

    for (const item of output) {
      if (item.type === 'message') {
        // 提取 output_text 内容
        const msg = item as { content: Array<{ type: string; text?: string; refusal?: string }> };
        for (const part of msg.content) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            textParts.push(part.text);
          } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
            // 拒绝回答：将 refusal 文本加入 content，让上层感知
            textParts.push(`[refusal] ${part.refusal}`);
          }
        }
      } else if (item.type === 'function_call') {
        const fc = item as ResponseFunctionToolCall;
        // 解析 arguments JSON（与 OpenAIClient 一致的容错：非法 JSON 降级为空对象）
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(fc.arguments || '{}');
        } catch (e) {
          logger.warn('[openai-responses] function_call.arguments JSON 解析失败，降级为空对象', {
            toolName: fc.name,
            callId: fc.call_id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        toolCalls.push({
          id: fc.call_id,
          name: fc.name,
          arguments: parsedArgs,
        });
      }
      // 其他类型（reasoning / file_search / web_search / computer_call 等）暂不提取
    }

    return {
      content: textParts.join('\n'),
      toolCalls,
    };
  }

  /**
   * 提取 Token 使用信息
   * Responses API 的 usage 字段：input_tokens / output_tokens / total_tokens
   */
  private extractUsage(usage: ResponseUsage | undefined | null): TokenUsageInfo {
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    };
  }

  /**
   * 映射结束原因
   *
   * Responses API 的 status：
   * - 'completed'：正常完成；若有工具调用则映射为 'tool_use'，否则 'stop'
   * - 'incomplete'：未完成（多数因 max_output_tokens 截断）→ 'length'
   * - 'failed' / 'cancelled' / 其他 → 'error'
   */
  private mapFinishReason(
    status: string | undefined,
    hasToolCalls: boolean,
  ): 'stop' | 'tool_use' | 'length' | 'error' {
    switch (status) {
      case 'completed':
        // 有工具调用 → tool_use；纯文本 → stop
        return hasToolCalls ? 'tool_use' : 'stop';
      case 'incomplete':
        return 'length';
      case 'failed':
      case 'cancelled':
      default:
        return 'error';
    }
  }
}

// src/router/llm/openai.ts
// OpenAI 协议客户端实现
// 支持：非流式、流式、工具调用

import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionCreateParams,
  ChatCompletionTool,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import { BaseLLMClient } from './base.js';
import type {
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  ToolCallRequest,
  TokenUsageInfo,
  LLMToolDefinition,
} from '../types.js';
import { LLMError } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * OpenAI 协议客户端
 * 兼容所有 OpenAI 兼容的 API（OpenAI、Azure、本地模型等）
 */
export class OpenAIClient extends BaseLLMClient {
  readonly protocol = 'openai' as const;
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
    // 安全策略：apiKey 为空时不构造假客户端，避免运行时用 'placeholder' 调用 API 导致 401
    // 调用方应在调用前检查 isReady()，未就绪时跳过该客户端
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
   */
  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    if (!this.client) {
      throw new LLMError(`${this.providerId} 客户端未就绪（API Key 未配置）`, undefined, options.model);
    }
    const startTime = Date.now();
    this.logRequest(options.model, false, options.messages.length);

    try {
      const params = this.buildRequestParams(options, false);
      // Phase 55 修复：透传 options.timeoutMs 到 SDK RequestOptions
      // 修复前：SDK 仅用构造时的 defaultTimeoutMs（30s），requestOptions.timeoutMs 不生效
      // 修复后：requestOptions.timeoutMs 优先于构造时 defaultTimeoutMs
      // V2-021 修复：透传 options.signal 到 SDK RequestOptions，支持取消请求
      const requestOptions: { timeout?: number; signal?: AbortSignal } | undefined =
        options.timeoutMs || options.signal
          ? {
              ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            }
          : undefined;
      // P0-10：用 withRetry 包装实际 API 调用，启用 querySource-aware 差异化重试
      const response = await this.withRetry(() =>
        this.client!.chat.completions.create(params, requestOptions) as Promise<ChatCompletion>,
      );

      const usage = this.extractUsage(response);
      const toolCalls = this.extractToolCalls(response.choices[0]?.message);
      const content = response.choices[0]?.message?.content || '';
      const finishReason = this.mapFinishReason(response.choices[0]?.finish_reason);

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
   */
  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown> {
    if (!this.client) {
      throw new LLMError(`${this.providerId} 客户端未就绪（API Key 未配置）`, undefined, options.model);
    }
    const startTime = Date.now();
    this.logRequest(options.model, true, options.messages.length);

    try {
      const params = this.buildRequestParams(options, true);
      // Phase 55 修复：透传 options.timeoutMs 到 SDK RequestOptions（与 complete 一致）
      // V2-021 修复：透传 options.signal 到 SDK RequestOptions，支持流式取消
      const requestOptions: { timeout?: number; signal?: AbortSignal } | undefined =
        options.timeoutMs || options.signal
          ? {
              ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            }
          : undefined;
      const stream = await this.client.chat.completions.create(params, requestOptions) as AsyncIterable<ChatCompletionChunk>;

      // B-06：并行工具调用按 tool_call index 分别累积（OpenAI 流式规范：
      // 增量分片与首片共享同一 index）。旧实现用单一 currentToolId 状态机，
      // 并行工具的分片交错到达时会把后一工具的参数追加到前一工具，且 finish 只 end 最后一个。
      const toolAccum = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        const finishReason = chunk.choices[0]?.finish_reason;

        // 文本增量
        if (delta?.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        const reasoningDelta = (delta as Record<string, unknown>).reasoning_content
          ?? (delta as Record<string, unknown>).reasoning
          ?? (delta as Record<string, unknown>).thinking;
        if (typeof reasoningDelta === 'string' && reasoningDelta) {
          yield { type: 'reasoning_delta', text: reasoningDelta };
        }

        // 工具调用增量（B-06：index-keyed 合并）
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = (toolCall as { index?: number }).index ?? 0;
            const acc = toolAccum.get(index) ?? { id: '', name: '', args: '' };
            toolAccum.set(index, acc);
            if (toolCall.id) {
              // B-06：重复 id（同 index 续片）不重复发射 start，保证幂等
              const isNew = acc.id === '' || acc.id !== toolCall.id;
              acc.id = toolCall.id;
              acc.name = toolCall.function?.name || acc.name;
              if (isNew) {
                yield {
                  type: 'tool_call_start',
                  toolCall: { id: acc.id, name: acc.name },
                };
              }
            }
            if (toolCall.function?.arguments) {
              acc.args += toolCall.function.arguments;
              yield {
                type: 'tool_call_delta',
                toolCallId: acc.id,
                argumentsDelta: toolCall.function.arguments,
              };
            }
          }
        }

        // Usage（需要 stream_options: { include_usage: true }）
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            },
          };
        }

        // 结束（B-06：遍历全部累积工具发送 tool_call_end，而非只发最后一个）
        if (finishReason) {
          for (const acc of toolAccum.values()) {
            if (acc.id) {
              yield { type: 'tool_call_end', toolCallId: acc.id };
            }
          }
          yield {
            type: 'done',
            finishReason: this.mapFinishReason(finishReason),
          };
          this.logResponse(
            options.model,
            chunk.usage
              ? {
                  inputTokens: chunk.usage.prompt_tokens,
                  outputTokens: chunk.usage.completion_tokens,
                  totalTokens: chunk.usage.total_tokens,
                }
              : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            Date.now() - startTime,
          );
          return;
        }
      }
    } catch (err) {
      throw this.normalizeError(err, options.model);
    }
  }

  /**
   * 构建请求参数
   */
  private buildRequestParams(
    options: LLMRequestOptions,
    stream: boolean,
  ): ChatCompletionCreateParams {
    // B4：优先使用 systemBlocks（拼接为字符串），未传时回退到 systemPrompt
    // OpenAI 协议不支持 per-block cache_control，但 prompt_cache_key 会让 API 自动识别稳定前缀
    // 通过固定前缀在前 + 可变后缀在后，最大化前缀缓存命中
    let effectiveSystemPrompt = options.systemPrompt;
    if (options.systemBlocks && options.systemBlocks.length > 0) {
      effectiveSystemPrompt = options.systemBlocks.map(b => b.text).join('\n\n');
    }
    const messages = this.convertMessages(options.messages, effectiveSystemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    // 交集 Record<string, unknown> 允许写入 SDK 未声明的厂商扩展字段（prompt_cache_key 等），
    // 避免 as unknown as Record<string, unknown> 双重断言
    const params: ChatCompletionCreateParams & Record<string, unknown> = {
      model: options.model,
      messages,
      max_tokens: this.getMaxTokens(options),
      stream,
    };

    if (options.temperature !== undefined) {
      params.temperature = options.temperature;
    }

    if (tools) {
      params.tools = tools;
    }

    // P2-10：OpenAI 通过 prompt_cache_key 启用 Prompt 缓存
    // 同一 cache_key 的请求会复用前缀缓存，降低 token 消耗
    if (options.enableCache) {
      // 使用 model 名作为 cache key 的基础，确保同模型的请求复用缓存
      params.prompt_cache_key = `routedev-${options.model}`;
    }

    // P2-11：结构化输出（response_format json_schema）
    // OpenAI 支持通过 response_format 强制模型输出符合 JSON Schema 的内容
    if (options.responseFormat && options.responseFormat.type === 'json_schema') {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: options.responseFormat.jsonSchema.name,
          schema: options.responseFormat.jsonSchema.schema,
          strict: options.responseFormat.jsonSchema.strict ?? false,
        },
      };
    }

    // 流式时需要 stream_options 才能获取 usage
    if (stream) {
      params.stream_options = { include_usage: true };
    }

    return params;
  }

  /**
   * 转换消息格式（统一格式 → OpenAI 格式）
   *
   * OpenAI/DeepSeek API 对消息格式的要求：
   * - tool_use（工具调用请求）：必须作为 role: assistant 消息的 tool_calls 字段
   * - 注意：tool_result 必须作为独立 role: tool 消息，不能嵌套在其他消息的 content 里
   */
  private convertMessages(
    messages: LLMMessage[],
    systemPrompt?: string,
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    // 系统 prompt
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content } as ChatCompletionMessageParam);
      } else if (Array.isArray(msg.content)) {
        // 多模态内容：分离 tool_use / tool_result / text / image
        const textParts: string[] = [];
        const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
        const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
        const toolResults: Array<{ tool_call_id: string; content: string }> = [];

        for (const part of msg.content) {
          switch (part.type) {
            case 'text':
              textParts.push(part.text);
              break;
            case 'tool_use':
              toolCalls.push({
                id: part.id,
                type: 'function',
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.arguments),
                },
              });
              break;
            case 'tool_result':
              // tool_result 必须作为独立的 role: tool 消息，不能嵌套在 content 里
              toolResults.push({
                tool_call_id: part.toolUseId,
                content: part.content,
              });
              break;
            case 'image':
              imageParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${part.source.mediaType};base64,${part.source.data}`,
                },
              });
              break;
          }
        }

        // 1) 如果有 tool_calls：生成 role: assistant 消息（含 tool_calls）
        if (toolCalls.length > 0) {
          // OpenAI 要求 assistant 消息有 content 字段（可为 null）
          const assistantContent = textParts.length > 0 ? textParts.join('\n') : null;
          const assistantMsg = {
            role: 'assistant' as const,
            content: assistantContent,
            tool_calls: toolCalls,
          };
          result.push(assistantMsg as ChatCompletionMessageParam);
        } else if (textParts.length > 0 || imageParts.length > 0) {
          // 2) 普通多模态消息（text + image）
          const content: unknown[] = [];
          for (const t of textParts) content.push({ type: 'text', text: t });
          for (const img of imageParts) content.push(img);
          result.push({ role: msg.role, content } as ChatCompletionMessageParam);
        }

        // 3) tool_result 作为独立的 role: tool 消息（每个 tool_result 一条消息）
        for (const tr of toolResults) {
          result.push({ role: 'tool', ...tr } as ChatCompletionMessageParam);
        }
      }
    }

    return result;
  }

  /**
   * 转换工具定义
   */
  private convertTools(tools: LLMToolDefinition[]): ChatCompletionTool[] {
    return tools.map((tool) => {
      const fn: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
      } = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
      // Phase 96 P1-6：透传 strict 字段（OpenAI Structured Outputs）
      // strict=true 时模型输出严格遵循 parameters 的 JSON Schema
      if (tool.strict !== undefined) {
        fn.strict = tool.strict;
      }
      return {
        type: 'function' as const,
        function: fn,
      };
    });
  }

  /**
   * 提取 Token 使用信息
   */
  private extractUsage(response: ChatCompletion): TokenUsageInfo {
    const usage = response.usage;
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }

  /**
   * 提取工具调用
   */
  private extractToolCalls(message: ChatCompletionMessage | undefined): ToolCallRequest[] {
    if (!message?.tool_calls) return [];

    return message.tool_calls.map((tc) => {
      // OpenAI SDK 6.x: tool_calls 可能是 function 类型或 custom 类型
      // 安全访问 function 属性
      const fn = (tc as { function?: { name: string; arguments?: string } }).function;
      // Minor 修复：LLM 返回非法 JSON 时优雅降级为空对象，而非整个请求失败
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(fn?.arguments || '{}');
      } catch (e) {
        // 非法 JSON 降级为空对象，让上层工具执行时报参数错误（比整个请求崩溃更优雅）
        logger.warn('[openai] tool_calls.arguments JSON 解析失败，降级为空对象', {
          toolName: fn?.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return {
        id: tc.id,
        name: fn?.name || '',
        arguments: parsedArgs,
      };
    });
  }

  /**
   * 映射结束原因
   */
  private mapFinishReason(
    reason: string | null | undefined,
  ): 'stop' | 'tool_use' | 'length' | 'error' {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'length';
      default:
        return 'error';
    }
  }
}

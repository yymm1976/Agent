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
      const response = await this.client.chat.completions.create(params) as ChatCompletion;

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
      const stream = await this.client.chat.completions.create(params) as AsyncIterable<ChatCompletionChunk>;

      let currentToolId = '';
      let currentToolName = '';
      let currentToolArgs = '';

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

        // 工具调用增量
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.id) {
              // 新工具调用开始
              if (currentToolId) {
                yield { type: 'tool_call_end', toolCallId: currentToolId };
              }
              currentToolId = toolCall.id;
              currentToolName = toolCall.function?.name || '';
              currentToolArgs = '';
              yield {
                type: 'tool_call_start',
                toolCall: { id: toolCall.id, name: currentToolName },
              };
            }
            if (toolCall.function?.arguments) {
              currentToolArgs += toolCall.function.arguments;
              yield {
                type: 'tool_call_delta',
                toolCallId: currentToolId,
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

        // 结束
        if (finishReason) {
          if (currentToolId) {
            yield { type: 'tool_call_end', toolCallId: currentToolId };
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
    const messages = this.convertMessages(options.messages, options.systemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const params: ChatCompletionCreateParams = {
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
      (params as unknown as Record<string, unknown>).prompt_cache_key = `routedev-${options.model}`;
    }

    // P2-11：结构化输出（response_format json_schema）
    // OpenAI 支持通过 response_format 强制模型输出符合 JSON Schema 的内容
    if (options.responseFormat && options.responseFormat.type === 'json_schema') {
      (params as unknown as Record<string, unknown>).response_format = {
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
   * - tool_result（工具调用结果）：必须作为独立的 role: tool 消息，不能嵌套在其他消息的 content 里
   *
   * 修复前 bug：tool_result 被错误地 push 到 content 数组里，导致 DeepSeek 报
   * "missing field type" 错误（400 Bad Request）
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
  private convertTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
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
      } catch {
        // 非法 JSON 降级为空对象，让上层工具执行时报参数错误（比整个请求崩溃更优雅）
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

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
  ContentPart,
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

    // 流式时需要 stream_options 才能获取 usage
    if (stream) {
      params.stream_options = { include_usage: true };
    }

    return params;
  }

  /**
   * 转换消息格式（统一格式 → OpenAI 格式）
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
        // 多模态内容
        const converted = this.convertContentParts(msg.content, msg.role);
        result.push(converted as ChatCompletionMessageParam);
      }
    }

    return result;
  }

  /**
   * 转换内容块
   */
  private convertContentParts(
    parts: ContentPart[],
    role: 'user' | 'assistant' | 'system',
  ): { role: string; content: unknown[] } | { role: string; tool_calls: unknown[] } {
    const content: unknown[] = [];
    const toolCalls: unknown[] = [];

    for (const part of parts) {
      switch (part.type) {
        case 'text':
          content.push({ type: 'text', text: part.text });
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
          content.push({
            role: 'tool',
            tool_call_id: part.toolUseId,
            content: part.content,
          });
          break;
        case 'image':
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.source.mediaType};base64,${part.source.data}`,
            },
          });
          break;
      }
    }

    if (toolCalls.length > 0) {
      return { role: 'assistant', tool_calls: toolCalls };
    }
    return { role, content };
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
      return {
        id: tc.id,
        name: fn?.name || '',
        arguments: JSON.parse(fn?.arguments || '{}'),
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

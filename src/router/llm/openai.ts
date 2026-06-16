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
  private readonly client: OpenAI;

  constructor(config: {
    providerId: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    super(config);
    // 注：OpenAI SDK 的 baseURL 不要包含 /chat/completions，SDK 会自动拼接
    // 注：OpenAI SDK 6.x 严格要求 apiKey，空字符串会抛错。使用占位符避免构造失败
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'placeholder',
      timeout: config.timeoutMs ?? 30000,
    });
  }

  /**
   * 非流式调用
   */
  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    this.logRequest(options.model, false, options.messages.length);

    try {
      const params = this.buildRequestParams(options, false);
      const response = await this.client.chat.completions.create(params);

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
    const startTime = Date.now();
    this.logRequest(options.model, true, options.messages.length);

    try {
      const params = this.buildRequestParams(options, true);
      const stream = await this.client.chat.completions.create(params);

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

    return message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
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

// src/router/llm/anthropic.ts
// Anthropic 协议客户端实现
// 支持：非流式、流式、工具调用、system prompt 分离

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParams,
  MessageParam,
  Tool,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
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
 * Anthropic 协议客户端
 * 兼容 Anthropic Claude 系列模型
 */
export class AnthropicClient extends BaseLLMClient {
  readonly protocol = 'anthropic' as const;
  private readonly client: Anthropic | null;
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
      this.client = new Anthropic({
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
      const params = await this.buildRequestParams(options, false);
      const response = await this.client.messages.create(params) as Message;

      const usage = this.extractUsage(response);
      const { content, toolCalls } = this.extractContent(response.content);
      const finishReason = this.mapStopReason(response.stop_reason);

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
      const params = await this.buildRequestParams(options, true);
      const stream = this.client.messages.stream(params);

      let currentToolId = '';
      let currentToolName = '';
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            // 消息开始，获取 input tokens
            inputTokens = event.message.usage.input_tokens;
            break;

          case 'content_block_start':
            // 内容块开始
            if (event.content_block.type === 'text') {
              // 文本块开始，无需特殊处理
            } else if (event.content_block.type === 'tool_use') {
              currentToolId = event.content_block.id;
              currentToolName = event.content_block.name;
              yield {
                type: 'tool_call_start',
                toolCall: { id: currentToolId, name: currentToolName },
              };
            }
            break;

          case 'content_block_delta':
            // 内容块增量
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              yield {
                type: 'tool_call_delta',
                toolCallId: currentToolId,
                argumentsDelta: event.delta.partial_json,
              };
            }
            break;

          case 'content_block_stop':
            // 内容块结束
            if (currentToolId) {
              yield { type: 'tool_call_end', toolCallId: currentToolId };
              currentToolId = '';
              currentToolName = '';
            }
            break;

          case 'message_delta':
            // 消息增量（output tokens + stop reason）
            outputTokens = event.usage.output_tokens;
            if (event.delta.stop_reason) {
              yield {
                type: 'done',
                finishReason: this.mapStopReason(event.delta.stop_reason),
              };
            }
            break;

          case 'message_stop':
            // 消息结束
            yield {
              type: 'usage',
              usage: {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
              },
            };
            this.logResponse(
              options.model,
              { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
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
  private async buildRequestParams(
    options: LLMRequestOptions,
    stream: boolean,
  ): Promise<MessageCreateParams> {
    const messages = await this.convertMessages(options.messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const params: MessageCreateParams = {
      model: options.model,
      messages,
      max_tokens: this.getMaxTokens(options), // Anthropic 强制要求 max_tokens
      stream,
    };

    // Anthropic 的 system prompt 是独立参数，不在 messages 中
    // Phase 55：优先使用 systemBlocks（结构化 blocks，支持 per-block cache_control）
    // - systemBlocks 传入时直接透传，cache_control 由调用方在 block 上指定（固定前缀打、可变后缀不打）
    // - 未传时回退到 systemPrompt 字符串（向后兼容；enableCache 时整体打 cache_control）
    // 字段结构与 Anthropic SDK 的 TextBlockParam 兼容（type/text/cache_control）
    if (options.systemBlocks && options.systemBlocks.length > 0) {
      params.system = options.systemBlocks as MessageCreateParams['system'] as Array<{
        type: 'text';
        text: string;
        cache_control?: { type: 'ephemeral' } | null;
      }>;
    } else if (options.systemPrompt) {
      if (options.enableCache) {
        // 带缓存的 system prompt：使用文本块数组 + cache_control
        params.system = [
          {
            type: 'text',
            text: options.systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ];
      } else {
        params.system = options.systemPrompt;
      }
    }

    if (options.temperature !== undefined) {
      params.temperature = options.temperature;
    }

    if (tools) {
      // Phase 32 Task 2.2：tools 定义也加 cache_control 标记，最大化 Anthropic 缓存命中
      // system prompt 和 tools 是会话级稳定的，加 cache_control 后可跨请求复用
      if (options.enableCache) {
        params.tools = tools.map(tool => ({
          ...tool,
          cache_control: { type: 'ephemeral' },
        }));
      } else {
        params.tools = tools;
      }
    }

    return params;
  }

  /**
   * 转换消息格式（统一格式 → Anthropic 格式）
   * 注：Anthropic 的 system prompt 是独立参数，这里只处理 user/assistant 消息
   */
  private async convertMessages(messages: LLMMessage[]): Promise<MessageParam[]> {
    const result: MessageParam[] = [];

    for (const msg of messages) {
      // 跳过 system 消息（已在 params.system 中处理）
      if (msg.role === 'system') continue;

      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const converted = await this.convertContentParts(msg.content, msg.role);
        result.push(converted);
      }
    }

    return result;
  }

  /**
   * 转换内容块
   */
  private async convertContentParts(
    parts: ContentPart[],
    role: 'user' | 'assistant' | 'system',
  ): Promise<MessageParam> {
    // 使用 MessageParam['content'] 类型以兼容 Anthropic SDK 的变化
    const content: MessageParam['content'] = [];

    for (const part of parts) {
      switch (part.type) {
        case 'text':
          (content as Array<{ type: 'text'; text: string }>).push({ type: 'text', text: part.text });
          break;
        case 'tool_use':
          (content as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>).push({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.arguments,
          });
          break;
        case 'tool_result':
          (content as Array<ToolResultBlockParam>).push({
            type: 'tool_result',
            tool_use_id: part.toolUseId,
            content: part.content,
            is_error: part.isError,
          });
          break;
        case 'image':
          // Anthropic 图片格式
          (content as Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>).push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.source.mediaType,
              data: part.source.data,
            },
          });
          break;
      }
    }

    return { role, content };
  }

  /**
   * 转换工具定义
   */
  private convertTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Tool.InputSchema,
    }));
  }

  /**
   * 提取 Token 使用信息
   */
  private extractUsage(message: Message): TokenUsageInfo {
    return {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      totalTokens: message.usage.input_tokens + message.usage.output_tokens,
    };
  }

  /**
   * 提取内容和工具调用
   */
  private extractContent(content: ContentBlock[]): {
    content: string;
    toolCalls: ToolCallRequest[];
  } {
    let textContent = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return { content: textContent, toolCalls };
  }

  /**
   * 映射停止原因
   */
  private mapStopReason(
    reason: string | null | undefined,
  ): 'stop' | 'tool_use' | 'length' | 'error' {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'length';
      default:
        return 'error';
    }
  }
}

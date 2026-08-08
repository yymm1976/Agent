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
  LLMToolDefinition,
} from '../types.js';
import { LLMError, THINKING_BUDGET_TOKENS } from '../types.js';
import { logger } from '../../utils/logger.js';
// Closure-2：K2 post-finish 只吞 transport termination
import { isTransportTermination } from './k2-transport.js';

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
   * Phase 96 P1-4：Anthropic list models 使用 x-api-key + anthropic-version header
   * 覆盖基类的 Bearer 认证方式
   */
  protected override buildListModelsHeaders(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
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
      // Phase 55 修复：透传 options.timeoutMs 到 SDK RequestOptions（与 openai.ts 一致）
      // V2-021 修复：透传 options.signal 到 SDK RequestOptions，支持取消请求
      const requestOptions: { timeout?: number; signal?: AbortSignal } | undefined =
        options.timeoutMs || options.signal
          ? {
              ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            }
          : undefined;
      const response = await this.client.messages.create(params, requestOptions) as Message;

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

    // K2 Transport Terminal（Closure 1）：done（stop_reason）已发出 = 语义完成——
    // 此后 message_stop 前的 transport exception 不得再把 turn 变成失败。
    // 声明在 try 外：catch 需要读取（done 已发出判定）
    let doneEmitted = false;

    try {
      const params = await this.buildRequestParams(options, true);
      // V2-021 修复：透传 options.signal / timeoutMs 到 SDK stream() 的 RequestOptions，支持流式取消
      const requestOptions: { timeout?: number; signal?: AbortSignal } | undefined =
        options.timeoutMs || options.signal
          ? {
              ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            }
          : undefined;
      const stream = this.client.messages.stream(params, requestOptions);

      let currentToolId = '';
      let currentToolName = '';
      let inputTokens = 0;
      let outputTokens = 0;
      // Phase 96 P1-2：当前是否在 thinking block 内（用于 signature_delta 路由）
      let inThinkingBlock = false;

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
            } else if (event.content_block.type === 'thinking') {
              // Phase 96 P1-2：thinking 块开始，标记进入 thinking 状态
              // thinking 增量通过 thinking_delta 事件产出，签名通过 signature_delta 产出
              inThinkingBlock = true;
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
            } else if (event.delta.type === 'thinking_delta') {
              // Phase 96 P1-2：extended thinking 增量，转发为 reasoning_delta 事件
              // 与 OpenAI 客户端的 reasoning_delta 事件类型对齐，UI 层统一订阅
              yield { type: 'reasoning_delta', text: event.delta.thinking };
            } else if (event.delta.type === 'signature_delta') {
              // thinking 块的加密签名增量，目前不暴露给上层（保留以备未来验签需求）
              // 不 yield，仅记录 debug 日志
              logger.debug('anthropic: thinking signature_delta received', {
                signatureLength: event.delta.signature?.length ?? 0,
              });
            }
            break;

          case 'content_block_stop':
            // 内容块结束
            if (currentToolId) {
              yield { type: 'tool_call_end', toolCallId: currentToolId };
              currentToolId = '';
              currentToolName = '';
            }
            if (inThinkingBlock) {
              // Phase 96 P1-2：thinking 块结束，重置标记
              inThinkingBlock = false;
            }
            break;

          case 'message_delta':
            // 消息增量（output tokens + stop reason）
            outputTokens = event.usage.output_tokens;
            if (event.delta.stop_reason) {
              doneEmitted = true;
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
      // K2 Transport Terminal（Closure 1）：done（stop_reason）已发出 → 语义完成。
      // 等待 message_stop/usage 期间的 transport exception 不得把已成功 turn 变成失败；
      // Closure-2：仅吞 transport termination——内部程序异常不得伪装成功。
      // 消费方因 usage 事件缺失自动标记 usageIncomplete=true。用户取消不在此列。
      if (doneEmitted && !options.signal?.aborted && isTransportTermination(err)) {
        logger.warn('K2: anthropic stream transport error after done emitted——语义完成，usage 可能不完整', {
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

    // Phase 96 P1-2：Anthropic extended thinking 支持
    // 仅在 thinkingLevel 设置且非 'off' 时启用；其他 provider 客户端忽略此字段
    // 注意：thinking 启用时 max_tokens 必须 > budget_tokens，否则 API 报错
    if (options.thinkingLevel && options.thinkingLevel !== 'off') {
      const budgetTokens = THINKING_BUDGET_TOKENS[options.thinkingLevel];
      // 确保 max_tokens 足够容纳 thinking budget + 输出
      const currentMax = typeof params.max_tokens === 'number' ? params.max_tokens : 4096;
      if (currentMax <= budgetTokens) {
        // max_tokens 不够容纳 thinking budget，自动上调
        // 推荐 max_tokens = budget_tokens + 至少 4k 输出空间
        params.max_tokens = budgetTokens + 4096;
      }
      // thinking 字段类型在 Anthropic SDK 中为 ThinkingConfigParam，
      // 这里用 as unknown as 绕过 SDK 类型定义的版本差异（不同版本字段名略有差异）
      (params as unknown as { thinking?: { type: 'enabled'; budget_tokens: number } }).thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens,
      };
      // thinking 启用时 temperature 必须设为 1（Anthropic API 限制）
      params.temperature = 1;
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
   *
   * Phase 96 P1-6：Anthropic 协议无 strict 字段，input_schema 本身即 JSON Schema 约束。
   * tool.strict 字段在此被忽略（不报错，保持向后兼容）。
   * 如需更强制约束，可在 tool_choice 上设置 'tool' 强制模型调用指定工具。
   */
  private convertTools(tools: LLMToolDefinition[]): Tool[] {
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
   *
   * Phase 96 P1-2：thinking block 不计入 content（避免 LLM 把 thinking 当作回复）
   * 但通过 logger 记录以便调试；未来如需暴露给上层，可在 LLMResponse 新增 thinking 字段
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
      } else if (block.type === 'thinking') {
        // Phase 96 P1-2：非流式 thinking block，记录日志不暴露给上层
        // thinking 内容是模型的内部推理，不应作为最终回复返回给用户
        const thinkingBlock = block as { type: 'thinking'; thinking: string; signature?: string };
        logger.debug('anthropic: non-stream thinking block received', {
          thinkingLength: thinkingBlock.thinking.length,
          hasSignature: !!thinkingBlock.signature,
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

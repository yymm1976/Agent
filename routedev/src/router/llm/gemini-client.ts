// src/router/llm/gemini-client.ts
// Google Gemini 原生协议客户端实现
// API: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// 认证：x-goog-api-key header
// 支持：非流式 generateContent、流式 streamGenerateContent (SSE)、system_instruction

import { BaseLLMClient } from './base.js';
import type {
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  TokenUsageInfo,
} from '../types.js';
import { LLMError } from '../types.js';

/** Gemini API 默认 base URL */
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini content part（文本） */
interface GeminiPart {
  text: string;
}

/** Gemini content（一条消息） */
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Gemini 非流式响应 */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

/**
 * Google Gemini 协议客户端
 * 使用 Gemini 原生格式（contents/parts/candidates），不依赖 OpenAI 兼容接口
 */
export class GeminiClient extends BaseLLMClient {
  readonly protocol = 'gemini' as const;

  constructor(config: {
    providerId: string;
    baseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    super({
      providerId: config.providerId,
      baseUrl: config.baseUrl || DEFAULT_GEMINI_BASE_URL,
      apiKey: config.apiKey || process.env.GEMINI_API_KEY || '',
      timeoutMs: config.timeoutMs,
    });
  }

  /** 检查客户端是否就绪（apiKey 已配置） */
  override isReady(): boolean {
    return !!this.apiKey && this.apiKey.length > 0 && this.apiKey !== 'placeholder';
  }

  /**
   * 非流式调用
   */
  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    if (!this.isReady()) {
      throw new LLMError(`${this.providerId} 客户端未就绪（API Key 未配置）`, undefined, options.model);
    }
    const startTime = Date.now();
    this.logRequest(options.model, false, options.messages.length);

    try {
      const url = `${this.baseUrl}/models/${encodeURIComponent(options.model)}:generateContent`;
      const body = this.buildRequestBody(options);
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
        },
        this.getTimeout(options),
      );

      const data = await this.parseJsonResponse<GeminiResponse>(response, options.model);
      const content = this.extractText(data);
      const usage = this.extractUsage(data);
      const finishReason = this.mapFinishReason(data.candidates?.[0]?.finishReason);

      this.logResponse(options.model, usage, Date.now() - startTime);

      return {
        content,
        toolCalls: [],
        usage,
        finishReason,
        model: options.model,
      };
    } catch (err) {
      throw this.normalizeError(err, options.model);
    }
  }

  /**
   * 流式调用（SSE）
   */
  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown> {
    if (!this.isReady()) {
      throw new LLMError(`${this.providerId} 客户端未就绪（API Key 未配置）`, undefined, options.model);
    }
    const startTime = Date.now();
    this.logRequest(options.model, true, options.messages.length);

    try {
      const url = `${this.baseUrl}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;
      const body = this.buildRequestBody(options);
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
        },
        this.getTimeout(options),
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new LLMError(
          `Gemini API error: ${response.status} ${response.statusText} - ${errorText}`,
          response.status,
          options.model,
        );
      }

      if (!response.body) {
        throw new LLMError('Gemini stream response has no body', undefined, options.model);
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let lastFinishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';

      // 解析 SSE 流：每条消息以 "data: " 开头，以空行分隔
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 按行处理 SSE
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后未完成的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6); // 去掉 "data: " 前缀
          try {
            const chunk = JSON.parse(jsonStr) as GeminiResponse;

            // 提取文本增量
            const text = this.extractText(chunk);
            if (text) {
              yield { type: 'text_delta', text };
            }

            // 提取 token 使用量（最后一个 chunk 通常包含 usageMetadata）
            if (chunk.usageMetadata) {
              inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
              outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
            }

            // 提取 finishReason
            const fr = chunk.candidates?.[0]?.finishReason;
            if (fr) {
              lastFinishReason = this.mapFinishReason(fr);
            }
          } catch {
            // 跳过无法解析的 chunk（可能是心跳或部分数据）
          }
        }
      }

      // 处理缓冲区剩余数据
      if (buffer.trim().startsWith('data: ')) {
        try {
          const chunk = JSON.parse(buffer.trim().slice(6)) as GeminiResponse;
          const text = this.extractText(chunk);
          if (text) {
            yield { type: 'text_delta', text };
          }
          if (chunk.usageMetadata) {
            inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
            outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
          }
        } catch {
          // 忽略解析错误
        }
      }

      // 输出 usage 事件
      const usage: TokenUsageInfo = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
      yield { type: 'usage', usage };

      this.logResponse(options.model, usage, Date.now() - startTime);

      // 输出 done 事件
      yield { type: 'done', finishReason: lastFinishReason };
    } catch (err) {
      throw this.normalizeError(err, options.model);
    }
  }

  /**
   * 构建请求体（Gemini 原生格式）
   */
  private buildRequestBody(options: LLMRequestOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: this.convertMessages(options.messages),
    };

    // system instruction（Gemini 用 system_instruction 字段，不在 contents 中）
    if (options.systemPrompt) {
      body.system_instruction = {
        parts: [{ text: options.systemPrompt }],
      };
    }

    // generationConfig
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: this.getMaxTokens(options),
    };
    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }
    body.generationConfig = generationConfig;

    return body;
  }

  /**
   * 转换消息格式（统一格式 → Gemini contents）
   * - system → system_instruction（在 buildRequestBody 中处理）
   * - user → role: 'user'
   * - assistant → role: 'model'
   */
  private convertMessages(messages: LLMMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      // system 消息由 system_instruction 处理，跳过
      if (msg.role === 'system') continue;

      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      const text = this.extractMessageText(msg.content);

      if (text) {
        contents.push({ role, parts: [{ text }] });
      }
    }

    return contents;
  }

  /**
   * 从 LLMMessage.content 提取纯文本（支持 string 和 ContentPart[]）
   */
  private extractMessageText(content: string | LLMMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('\n');
    }
    return '';
  }

  /**
   * 从响应中提取文本
   */
  private extractText(data: GeminiResponse): string {
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) return '';
    return parts.map((p) => p.text).join('');
  }

  /**
   * 提取 token 使用信息
   */
  private extractUsage(data: GeminiResponse): TokenUsageInfo {
    const meta = data.usageMetadata;
    if (!meta) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    return {
      inputTokens: meta.promptTokenCount ?? 0,
      outputTokens: meta.candidatesTokenCount ?? 0,
      totalTokens: meta.totalTokenCount ?? 0,
    };
  }

  /**
   * 映射 Gemini finishReason 到统一格式
   */
  private mapFinishReason(reason: string | undefined): 'stop' | 'tool_use' | 'length' | 'error' {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
        return 'error';
      default:
        return reason ? 'stop' : 'stop';
    }
  }
}

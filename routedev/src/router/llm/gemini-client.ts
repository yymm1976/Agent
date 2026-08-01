// src/router/llm/gemini-client.ts
// Google Gemini 原生协议客户端实现
// API: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// 认证：x-goog-api-key header
// 支持：非流式 generateContent、流式 streamGenerateContent (SSE)、system_instruction、工具调用 (function calling)

import { BaseLLMClient } from './base.js';
import type {
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  TokenUsageInfo,
  ToolCallRequest,
} from '../types.js';
import { LLMError } from '../types.js';
import { logger } from '../../utils/logger.js';

/** Gemini API 默认 base URL */
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini content part（文本或函数调用/响应） */
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
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

/** 工具调用 ID 计数器（Gemini 不返回 call ID，自动生成） */
let toolCallCounter = 0;

/** 生成唯一工具调用 ID */
function nextToolCallId(): string {
  return `gemini-call-${Date.now()}-${++toolCallCounter}`;
}

/**
 * Google Gemini 协议客户端
 * 使用 Gemini 原生格式（contents/parts/candidates），不依赖 OpenAI 兼容接口
 * 支持工具调用（function calling）
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
   * Phase 96 P1-4：Gemini list models 使用 x-goog-api-key header
   * 覆盖基类的 Bearer 认证方式
   */
  protected override buildListModelsHeaders(): Record<string, string> {
    return { 'x-goog-api-key': this.apiKey };
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
        options.signal,
      );

      const data = await this.parseJsonResponse<GeminiResponse>(response, options.model);
      const content = this.extractText(data);
      const toolCalls = this.extractToolCalls(data);
      const usage = this.extractUsage(data);
      // 有工具调用时 finishReason 强制为 tool_use
      const finishReason = toolCalls.length > 0
        ? 'tool_use'
        : this.mapFinishReason(data.candidates?.[0]?.finishReason);

      this.logResponse(options.model, usage, Date.now() - startTime);

      return {
        content,
        toolCalls,
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
        options.signal,
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
      let hasToolCalls = false;

      // 解析 SSE 流
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          try {
            const chunk = JSON.parse(jsonStr) as GeminiResponse;

            // 提取文本增量
            const text = this.extractText(chunk);
            if (text) {
              yield { type: 'text_delta', text };
            }

            // 提取工具调用（Gemini 流式中 functionCall 整体返回，非增量）
            const toolCalls = this.extractToolCalls(chunk);
            for (const tc of toolCalls) {
              hasToolCalls = true;
              yield { type: 'tool_call_start', toolCall: { id: tc.id, name: tc.name } };
              yield { type: 'tool_call_delta', toolCallId: tc.id, argumentsDelta: JSON.stringify(tc.arguments) };
              yield { type: 'tool_call_end', toolCallId: tc.id };
            }

            // token 使用量
            if (chunk.usageMetadata) {
              inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
              outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
            }

            // finishReason
            const fr = chunk.candidates?.[0]?.finishReason;
            if (fr) {
              lastFinishReason = this.mapFinishReason(fr);
            }
          } catch (e) {
            logger.warn('跳过无法解析的 chunk', { error: e instanceof Error ? e.message : String(e) });
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
          const toolCalls = this.extractToolCalls(chunk);
          for (const tc of toolCalls) {
            hasToolCalls = true;
            yield { type: 'tool_call_start', toolCall: { id: tc.id, name: tc.name } };
            yield { type: 'tool_call_delta', toolCallId: tc.id, argumentsDelta: JSON.stringify(tc.arguments) };
            yield { type: 'tool_call_end', toolCallId: tc.id };
          }
          if (chunk.usageMetadata) {
            inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
            outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
          }
        } catch (e) {
          logger.warn('缓冲区剩余数据解析失败', { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // 有工具调用时 finishReason 强制为 tool_use
      if (hasToolCalls) {
        lastFinishReason = 'tool_use';
      }

      const usage: TokenUsageInfo = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
      yield { type: 'usage', usage };

      this.logResponse(options.model, usage, Date.now() - startTime);

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

    // system instruction
    if (options.systemPrompt) {
      body.system_instruction = {
        parts: [{ text: options.systemPrompt }],
      };
    }

    // 工具声明（Gemini function calling）
    // Phase 96 P1-6：Gemini functionDeclarations 协议无 strict 字段，
    // parameters 本身即 OpenAPI 3.0 schema 约束，t.strict 字段被忽略。
    if (options.tools && options.tools.length > 0) {
      body.tools = [{
        functionDeclarations: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
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
   * - tool_use → functionCall part（model 角色）
   * - tool_result → functionResponse part（user 角色）
   */
  private convertMessages(messages: LLMMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    // 维护 toolUseId → toolName 映射，用于 functionResponse 匹配
    const toolIdToName = new Map<string, string>();

    for (const msg of messages) {
      // system 消息由 system_instruction 处理，跳过
      if (msg.role === 'system') continue;

      // 先扫描 tool_use，建立 id → name 映射
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_use') {
            toolIdToName.set(part.id, part.name);
          }
        }
      }

      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCallParts: GeminiPart[] = [];
        const toolResultParts: GeminiPart[] = [];

        for (const part of msg.content) {
          if (part.type === 'text') {
            textParts.push(part.text);
          } else if (part.type === 'tool_use') {
            // 工具调用 → functionCall part
            toolCallParts.push({
              functionCall: { name: part.name, args: part.arguments },
            });
          } else if (part.type === 'tool_result') {
            // 工具结果 → functionResponse part
            const toolName = toolIdToName.get(part.toolUseId) || part.toolUseId;
            let responseObj: Record<string, unknown>;
            try {
              responseObj = JSON.parse(part.content);
            } catch {
              responseObj = { result: part.content };
            }
            toolResultParts.push({
              functionResponse: { name: toolName, response: responseObj },
            });
          }
        }

        // 文本内容
        if (textParts.length > 0) {
          contents.push({ role, parts: [{ text: textParts.join('\n') }] });
        }
        // 工具调用（model 角色）
        if (toolCallParts.length > 0) {
          contents.push({ role: 'model', parts: toolCallParts });
        }
        // 工具结果（user 角色，Gemini 用 functionResponse part）
        if (toolResultParts.length > 0) {
          contents.push({ role: 'user', parts: toolResultParts });
        }
      }
    }

    return contents;
  }

  /**
   * 从响应中提取纯文本（仅 text part）
   */
  private extractText(data: GeminiResponse): string {
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) return '';
    return parts.filter((p) => p.text).map((p) => p.text!).join('');
  }

  /**
   * 从响应中提取工具调用（functionCall parts）
   */
  private extractToolCalls(data: GeminiResponse): ToolCallRequest[] {
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return [];

    const toolCalls: ToolCallRequest[] = [];
    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          id: nextToolCallId(),
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        });
      }
    }
    return toolCalls;
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
        return 'stop';
    }
  }
}

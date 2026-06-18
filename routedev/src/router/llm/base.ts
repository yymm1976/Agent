// src/router/llm/base.ts
// LLM 客户端基类：提供公共逻辑（超时、错误标准化、重试）

import type {
  ILLMClient,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMToolDefinition,
  TokenUsageInfo,
} from '../types.js';
import { LLMError } from '../types.js';
import { logger } from '../../utils/logger.js';
import type { Protocol } from '../../config/schema.js';

/** 默认超时时间（30 秒） */
const DEFAULT_TIMEOUT_MS = 30000;

/** 默认最大 token 数 */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * LLM 客户端抽象基类
 * 提供：超时控制、错误标准化、日志记录
 */
export abstract class BaseLLMClient implements ILLMClient {
  readonly abstract protocol: Protocol;
  readonly providerId: string;

  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly defaultTimeoutMs: number;

  constructor(config: {
    providerId: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
  }) {
    this.providerId = config.providerId;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 检查客户端是否就绪 */
  isReady(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  /** 非流式调用（子类实现） */
  abstract complete(options: LLMRequestOptions): Promise<LLMResponse>;

  /** 流式调用（子类实现） */
  abstract stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown>;

  /**
   * 带超时的 fetch 包装
   * 注：Node.js 20+ 的 fetch 原生支持 AbortSignal.timeout，但为兼容性手动实现
   */
  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError(
          `LLM request timeout after ${timeoutMs}ms`,
          undefined,
          undefined,
          err,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 标准化错误处理
   * 将各种 SDK 错误统一为 LLMError
   */
  protected normalizeError(err: unknown, model: string): LLMError {
    if (err instanceof LLMError) {
      return err;
    }

    if (err instanceof Error) {
      // 检查是否是 fetch 错误
      if ('status' in err) {
        const status = (err as { status: number }).status;
        return new LLMError(err.message, status, model, err);
      }

      // 检查是否是 AbortError（超时）
      if (err.name === 'AbortError') {
        return new LLMError(
          `LLM request timeout after ${this.defaultTimeoutMs}ms`,
          undefined,
          model,
          err,
        );
      }

      // 其他错误
      return new LLMError(err.message, undefined, model, err);
    }

    return new LLMError(String(err), undefined, model);
  }

  /**
   * 解析 HTTP 响应的 JSON
   */
  protected async parseJsonResponse<T>(response: Response, model: string): Promise<T> {
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new LLMError(
        `LLM API error: ${response.status} ${response.statusText} - ${errorText}`,
        response.status,
        model,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new LLMError(
        'Failed to parse LLM response JSON',
        response.status,
        model,
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * 记录请求日志
   */
  protected logRequest(model: string, stream: boolean, messageCount: number): void {
    logger.debug('LLM request', {
      provider: this.providerId,
      protocol: this.protocol,
      model,
      stream,
      messages: messageCount,
    });
  }

  /**
   * 记录响应日志
   */
  protected logResponse(model: string, usage: TokenUsageInfo, durationMs: number): void {
    logger.debug('LLM response', {
      provider: this.providerId,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
    });
  }

  /**
   * 将工具定义转换为 JSON Schema 格式（供子类使用）
   */
  protected formatToolsForAPI(tools: LLMToolDefinition[] | undefined): unknown[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * 获取超时时间
   */
  protected getTimeout(options: LLMRequestOptions): number {
    return options.timeoutMs ?? this.defaultTimeoutMs;
  }

  /**
   * 获取最大 token 数
   */
  protected getMaxTokens(options: LLMRequestOptions): number {
    return options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }
}

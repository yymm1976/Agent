// src/utils/retry.ts
// 重试 + 熔断工具（仅用于 LLM 调用，不用于不可重试的工具执行）
//
// P0-10 改造（2026-07-05）：新增 querySource-aware 重试策略
//   借鉴 Claude Code `src/services/api/withRetry.ts`：
//   - FOREGROUND_RETRY_SOURCES 白名单：用户阻塞型任务全力重试
//   - 后台任务（summary/title/suggestion/classifier）529 时直接 bail
//   - 避免后台任务重试引发级联风暴（一个慢后台任务拖垮前台体验）
//
// GA Hardening 第4项：重试判定类型化——AgentError 用 retryable 字段，
// 不再用消息字符串正则驱动核心控制流（外部 SDK 错误仍保留消息兜底）；
// 401/403（AuthError）任何场景都不得重试。

import { AgentError, isRetryableError, isAuthError } from '../errors/agent-errors.js';

interface RetryPolicyOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryable?: (error: unknown) => boolean;
}

/** TD-21 Phase 1：重试观察者——每次实际重试前触发（provider retry 可观测性） */
export interface RetryObserver {
  (info: { error: unknown; attempt: number; querySource?: string }): void;
}

/** 单次 execute 的重试观察选项（per-request，不污染策略实例） */
export interface RetryExecuteOptions {
  onRetry?: RetryObserver;
}

export class RetryPolicy {
  private maxRetries: number;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private retryable: (error: unknown) => boolean;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
    this.retryable =
      options.retryable ??
      // GA Hardening 第4项：类型化优先（AgentError.retryable），
      // 认证错误（401/403）绝不在任何匹配路径上被重试
      ((error) => {
        if (isAuthError(error)) return false;
        return isRetryableError(error);
      });
  }

  async execute<T>(fn: () => Promise<T>, options?: RetryExecuteOptions): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries || !this.retryable(error)) {
          throw error;
        }
        // TD-21 Phase 1：重试前通知观察者（attempt+1 = 即将进行的第几次请求）
        options?.onRetry?.({ error, attempt: attempt + 1 });
        const delay = Math.min(
          this.baseDelayMs * 2 ** attempt,
          this.maxDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }
}

// ============================================================
// P0-10：querySource-aware 重试
// ============================================================

/**
 * P0-10：LLM 调用来源标签
 *
 * 借鉴 Claude Code withRetry.ts 的 querySource 分类：
 *   - foreground：用户阻塞型任务（用户在等结果），529 时全力重试
 *   - background：后台任务（summary/title/suggestion/classifier），529 时直接 bail
 *
 * 命名规则：使用 snake_case 与 Claude Code 对齐，便于跨工具对照
 */
export type QuerySource =
  // ===== foreground 类（全力重试）=====
  | 'repl_main_thread'        // 用户主对话
  | 'sdk'                     // SDK 调用
  | 'agent_custom'            // 自定义 Agent
  | 'compact'                 // 上下文压缩
  | 'verification_agent'      // 验证 Agent
  // ===== background 类（快速失败）=====
  | 'summary'                 // 对话摘要
  | 'title'                   // 标题生成
  | 'suggestion'              // 建议生成
  | 'classifier'              // 意图分类
  | 'background_other';       // 其他后台任务

/** P0-10：foreground 类 querySource 白名单（529 时全力重试） */
export const FOREGROUND_RETRY_SOURCES: ReadonlySet<QuerySource> = new Set<QuerySource>([
  'repl_main_thread',
  'sdk',
  'agent_custom',
  'compact',
  'verification_agent',
]);

/** P0-10：判断 querySource 是否为 foreground 类 */
export function isForegroundQuerySource(source: QuerySource): boolean {
  return FOREGROUND_RETRY_SOURCES.has(source);
}

/** P0-10：HTTP 529（服务过载）检测——GA Hardening 第4项：类型化优先，外部错误消息兜底 */
function is529Error(error: unknown): boolean {
  // RateLimitError（含 LLMError type=rate_limit，覆盖 429/529 状态码）类型化判定
  if (error instanceof AgentError && error.kind === 'rate_limit') return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // 覆盖常见 529 表现形式
    return msg.includes('529') || msg.includes('overloaded') || msg.includes('service overloaded');
  }
  return false;
}

/** P0-10：querySource-aware 重试策略选项 */
export interface QuerySourceRetryOptions extends RetryPolicyOptions {
  /** 调用来源标签（必填） */
  querySource: QuerySource;
  /** 后台任务最大重试次数（默认 0 = 不重试，529 直接 bail） */
  backgroundMaxRetries?: number;
  /** 后台任务最大延迟（默认 1000ms，避免长延迟拖垮后台队列） */
  backgroundMaxDelayMs?: number;
}

/**
 * P0-10：querySource-aware 重试策略
 *
 * 行为分桶：
 *   1. foreground 类（repl_main_thread/sdk/agent_custom/compact/verification_agent）：
 *      - 使用 maxRetries/baseDelayMs/maxDelayMs 全力重试
 *      - 529 错误同样重试
 *   2. background 类（summary/title/suggestion/classifier）：
 *      - 529 错误直接 bail（不重试）
 *      - 其他可重试错误用 backgroundMaxRetries/backgroundMaxDelayMs 保守重试
 *
 * 使用方式：
 *   const policy = new QuerySourceAwareRetryPolicy({ querySource: 'summary' });
 *   await policy.execute(() => llmClient.complete(...));
 */
export class QuerySourceAwareRetryPolicy {
  private readonly inner: RetryPolicy;
  private readonly querySource: QuerySource;
  private readonly isForeground: boolean;
  private readonly backgroundMaxRetries: number;
  private readonly backgroundMaxDelayMs: number;
  private readonly baseDelayMs: number;

  constructor(options: QuerySourceRetryOptions) {
    this.querySource = options.querySource;
    this.isForeground = isForegroundQuerySource(options.querySource);
    this.backgroundMaxRetries = options.backgroundMaxRetries ?? 0;
    this.backgroundMaxDelayMs = options.backgroundMaxDelayMs ?? 1000;
    this.baseDelayMs = options.baseDelayMs ?? 500;

    if (this.isForeground) {
      // foreground：用调用方传入的 maxRetries/maxDelayMs 全力重试
      this.inner = new RetryPolicy({
        maxRetries: options.maxRetries ?? 5,    // 默认 5 次（比通用 3 次更激进）
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: options.maxDelayMs ?? 16000,
        retryable: options.retryable,
      });
    } else {
      // background：保守重试，529 直接 bail
      this.inner = new RetryPolicy({
        maxRetries: this.backgroundMaxRetries,
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: this.backgroundMaxDelayMs,
        retryable: (error) => {
          // GA Hardening 第4项：认证错误（401/403）任何场景不得重试
          if (isAuthError(error)) return false;
          // 529/429 错误：后台任务直接 bail，不重试
          if (is529Error(error)) return false;
          // 其他错误：使用调用方提供的 retryable 或默认逻辑
          if (options.retryable) return options.retryable(error);
          // 类型化判定优先（AgentError.retryable），外部 SDK 错误消息兜底
          return isRetryableError(error);
        },
      });
    }
  }

  /** 当前 querySource（用于日志/审计） */
  getQuerySource(): QuerySource {
    return this.querySource;
  }

  /** 是否为前台任务（用于日志/审计） */
  isForegroundTask(): boolean {
    return this.isForeground;
  }

  async execute<T>(fn: () => Promise<T>, options?: RetryExecuteOptions): Promise<T> {
    return this.inner.execute(fn, options);
  }
}

interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private state: CircuitState = 'closed';
  private failures = 0;
  private nextAttempt = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'half-open';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

/** 组合：重试 + 熔断 */
export async function resilientExecute<T>(
  fn: () => Promise<T>,
  retry: RetryPolicy,
  circuit: CircuitBreaker,
): Promise<T> {
  return circuit.execute(() => retry.execute(fn));
}

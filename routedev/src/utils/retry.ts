// src/utils/retry.ts
// 重试 + 熔断工具（仅用于 LLM 调用，不用于不可重试的工具执行）

export interface RetryPolicyOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryable?: (error: unknown) => boolean;
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
      ((error) => {
        if (error instanceof Error) {
          const msg = error.message.toLowerCase();
          return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('rate limit');
        }
        return false;
      });
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries || !this.retryable(error)) {
          throw error;
        }
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

export interface CircuitBreakerOptions {
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

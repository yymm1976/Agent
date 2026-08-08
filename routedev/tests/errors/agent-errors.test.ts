// tests/errors/agent-errors.test.ts
// GA Hardening 第4项：类型化错误体系测试
//
// 覆盖：
// 1. AgentError 层级——kind/retryable/name/RouteDevError 统一基类
// 2. isRetryableError 类型化判定 + 外部错误消息兜底
// 3. LLMError 集成——401/403 不重试、429/529/超时可重试、unknown 保守不重试
// 4. RetryPolicy 类型化行为——AuthError 绝不重试、RateLimitError 重试

import { describe, it, expect } from 'vitest';
import {
  AgentError,
  AuthError,
  RateLimitError,
  ProviderUnavailableError,
  ProtocolError,
  ToolExecutionError,
  ToolRejectedError,
  VerificationError,
  CancellationError,
  TimeoutError,
  InternalInvariantError,
  isRetryableError,
  isAuthError,
} from '../../src/errors/agent-errors.js';
import { RouteDevError } from '../../src/utils/errors.js';
import { LLMError } from '../../src/router/types.js';
import { RetryPolicy, QuerySourceAwareRetryPolicy } from '../../src/utils/retry.js';

describe('AgentError 层级', () => {
  it.each([
    [new AuthError('401 Unauthorized'), 'auth', false, 'AuthError', 'AUTH_ERROR'],
    [new RateLimitError('429 too many'), 'rate_limit', true, 'RateLimitError', 'RATE_LIMIT_ERROR'],
    [new ProviderUnavailableError('ECONNREFUSED'), 'provider_unavailable', true, 'ProviderUnavailableError', 'PROVIDER_UNAVAILABLE_ERROR'],
    [new ProtocolError('stream incomplete'), 'protocol', false, 'ProtocolError', 'PROTOCOL_ERROR'],
    [new ToolExecutionError('cmd failed'), 'tool_execution', false, 'ToolExecutionError', 'TOOL_EXECUTION_ERROR'],
    [new ToolRejectedError('denied by policy'), 'tool_rejected', false, 'ToolRejectedError', 'TOOL_REJECTED_ERROR'],
    [new VerificationError('tests failed'), 'verification', false, 'VerificationError', 'VERIFICATION_ERROR'],
    [new CancellationError('user interrupted'), 'cancelled', false, 'CancellationError', 'CANCELLED_ERROR'],
    [new TimeoutError('request timed out'), 'timeout', true, 'TimeoutError', 'TIMEOUT_ERROR'],
    [new InternalInvariantError('impossible state'), 'internal_invariant', false, 'InternalInvariantError', 'INTERNAL_INVARIANT_ERROR'],
  ])('%s：kind/retryable/name/code 正确', (err, kind, retryable, name, code) => {
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
    expect(err.isRetryable).toBe(retryable);
    expect(err.name).toBe(name);
    expect(err.code).toBe(code);
    expect(err instanceof AgentError).toBe(true);
    expect(err instanceof RouteDevError).toBe(true); // 与既有错误体系统一基类
    expect(err instanceof Error).toBe(true);
  });

  it('cause 透传', () => {
    const cause = new Error('root');
    const err = new AuthError('bad key', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('isRetryableError / isAuthError（类型化判定）', () => {
  it('AgentError 用 retryable 字段，不碰消息字符串', () => {
    // 消息含 'timeout' 的 AuthError 也绝不能重试——类型优先于消息
    expect(isRetryableError(new AuthError('request timeout with auth'))).toBe(false);
    expect(isRetryableError(new RateLimitError('rate limited'))).toBe(true);
    expect(isRetryableError(new TimeoutError('timeout'))).toBe(true);
    expect(isRetryableError(new ProtocolError('timeout-like message'))).toBe(false);
  });

  it('外部 SDK 错误（非 AgentError）保留消息兜底', () => {
    expect(isRetryableError(new Error('ECONNRESET timeout'))).toBe(true);
    expect(isRetryableError(new Error('529 service overloaded'))).toBe(true);
    expect(isRetryableError(new Error('fatal'))).toBe(false);
    expect(isRetryableError('not an error')).toBe(false);
  });

  it('isAuthError 识别 auth kind', () => {
    expect(isAuthError(new AuthError('x'))).toBe(true);
    expect(isAuthError(new RateLimitError('x'))).toBe(false);
    expect(isAuthError(new Error('401 Unauthorized'))).toBe(false); // 外部错误不猜
  });
});

describe('LLMError 集成（继承 AgentError）', () => {
  it('401/403 → auth kind，retryable=false（停止 provider 重试）', () => {
    for (const status of [401, 403]) {
      const err = new LLMError('Unauthorized', status, 'm');
      expect(err.type).toBe('auth_error');
      expect(err.kind).toBe('auth');
      expect(err.retryable).toBe(false);
      expect(isAuthError(err)).toBe(true);
      expect(err instanceof AgentError).toBe(true);
    }
  });

  it('429/529 → rate_limit kind，retryable=true', () => {
    for (const status of [429, 529]) {
      const err = new LLMError('Too Many Requests', status, 'm');
      expect(err.type).toBe('rate_limit');
      expect(err.retryable).toBe(true);
    }
  });

  it('408 与 timeout 消息 → timeout kind，retryable=true', () => {
    const err1 = new LLMError('timeout', 408, 'm');
    expect(err1.retryable).toBe(true);
    const err2 = new LLMError('LLM request timeout after 30000ms', undefined, 'm');
    expect(err2.kind).toBe('timeout');
    expect(err2.retryable).toBe(true);
  });

  it('Closure 3：500/502/503/504 → provider_unavailable，retryable=true（有限退避重试）', () => {
    for (const status of [500, 502, 503, 504]) {
      const err = new LLMError('Internal Server Error', status, 'm');
      expect(err.type).toBe('network_error');
      expect(err.kind).toBe('provider_unavailable');
      expect(err.retryable).toBe(true);
    }
  });

  it('Closure 3：ECONNRESET/EPIPE → provider_unavailable，retryable=true（normalizeError 包装后不丢失）', () => {
    for (const msg of ['ECONNRESET socket hang up', 'write EPIPE', 'ECONNREFUSED connect', 'ENOTFOUND host']) {
      const err = new LLMError(msg, undefined, 'm');
      expect(err.kind).toBe('provider_unavailable');
      expect(err.retryable).toBe(true);
    }
  });

  it('Closure 3：用户 Abort 绝不误分类为 transient（unknown → retryable=false）', () => {
    const err = new LLMError('LLM request aborted by user', undefined, 'm');
    expect(err.type).toBe('unknown');
    expect(err.retryable).toBe(false);
    expect(isRetryableError(err)).toBe(false);
  });

  it('Closure 3：401/403/Protocol/Cancellation 绝不重试（终态语义）', () => {
    expect(isRetryableError(new AuthError('401'))).toBe(false);
    expect(isRetryableError(new ProtocolError('stream broken'))).toBe(false);
    expect(isRetryableError(new CancellationError('user cancel'))).toBe(false);
    expect(isRetryableError(new LLMError('Unauthorized', 401, 'm'))).toBe(false);
  });

  it('既有 API 兼容：type/isRateLimited/isAuthError/isTimeout/cause 保留', () => {
    const err = new LLMError('rate limited', 429, 'm', new Error('root'));
    expect(err.type).toBe('rate_limit');
    expect(err.isRateLimited).toBe(true);
    expect(err.isAuthError).toBe(false);
    expect(err.isTimeout).toBe(false);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(429);
    expect(err.model).toBe('m');
    expect(err.name).toBe('LLMError');
  });
});

describe('RetryPolicy 类型化重试行为', () => {
  it('AuthError（401/403）绝不重试——即使消息含 timeout', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    await expect(retry.execute(async () => {
      attempts++;
      throw new AuthError('request timeout during auth');
    })).rejects.toBeInstanceOf(AuthError);
    expect(attempts).toBe(1);
  });

  it('RateLimitError 重试后成功', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    const result = await retry.execute(async () => {
      attempts++;
      if (attempts < 2) throw new RateLimitError('429');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('TimeoutError（类型化）重试', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    await expect(retry.execute(async () => {
      attempts++;
      throw new TimeoutError('timeout');
    })).rejects.toBeInstanceOf(TimeoutError);
    expect(attempts).toBe(4); // 1 + 3 次重试
  });

  it('LLMError(401) 不重试、LLMError(429) 重试（路由层真实类型）', async () => {
    let authAttempts = 0;
    const authRetry = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    await expect(authRetry.execute(async () => {
      authAttempts++;
      throw new LLMError('Unauthorized', 401, 'm');
    })).rejects.toBeInstanceOf(LLMError);
    expect(authAttempts).toBe(1);

    let rateAttempts = 0;
    const rateRetry = new RetryPolicy({ maxRetries: 2, baseDelayMs: 1 });
    await expect(rateRetry.execute(async () => {
      rateAttempts++;
      throw new LLMError('rate limited', 429, 'm');
    })).rejects.toBeInstanceOf(LLMError);
    expect(rateAttempts).toBe(3);
  });

  it('Closure 3：LLMError(500) 有限退避重试（不把第一次 500 当 terminal）', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 2, baseDelayMs: 1 });
    const result = await retry.execute(async () => {
      attempts++;
      if (attempts < 2) throw new LLMError('Internal Server Error', 500, 'm');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('Closure 3：LLMError(ECONNRESET) 重试（normalizeError 包装后不丢可重试性）', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 2, baseDelayMs: 1 });
    const result = await retry.execute(async () => {
      attempts++;
      if (attempts < 2) throw new LLMError('ECONNRESET socket hang up', undefined, 'm');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('Closure 3：用户 Abort 的 LLMError 不重试（即使消息含其他关键词）', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    await expect(retry.execute(async () => {
      attempts++;
      throw new LLMError('LLM request aborted by user', undefined, 'm');
    })).rejects.toBeInstanceOf(LLMError);
    expect(attempts).toBe(1);
  });
});

describe('QuerySourceAwareRetryPolicy 类型化行为', () => {
  it('foreground + AuthError → 不重试（401/403 停止 provider retry）', async () => {
    let attempts = 0;
    const policy = new QuerySourceAwareRetryPolicy({ querySource: 'repl_main_thread', maxRetries: 3, baseDelayMs: 1 });
    await expect(policy.execute(async () => {
      attempts++;
      throw new LLMError('Invalid API key', 401, 'm');
    })).rejects.toBeInstanceOf(LLMError);
    expect(attempts).toBe(1);
  });

  it('background + RateLimitError（529）→ 直接 bail 不重试', async () => {
    let attempts = 0;
    const policy = new QuerySourceAwareRetryPolicy({ querySource: 'summary', baseDelayMs: 1 });
    await expect(policy.execute(async () => {
      attempts++;
      throw new LLMError('overloaded', 529, 'm');
    })).rejects.toBeInstanceOf(LLMError);
    expect(attempts).toBe(1);
  });

  it('background + 非 529 可重试错误（timeout）→ 保守重试', async () => {
    let attempts = 0;
    const policy = new QuerySourceAwareRetryPolicy({ querySource: 'summary', backgroundMaxRetries: 1, baseDelayMs: 1 });
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) throw new LLMError('timeout', undefined, 'm');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('foreground + timeout 消息的外部错误 → 消息兜底仍重试（兼容外部 SDK）', async () => {
    let attempts = 0;
    const policy = new QuerySourceAwareRetryPolicy({ querySource: 'repl_main_thread', maxRetries: 2, baseDelayMs: 1 });
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) throw new Error('socket timeout');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});

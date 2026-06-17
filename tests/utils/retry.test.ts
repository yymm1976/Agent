// tests/utils/retry.test.ts

import { describe, it, expect, vi } from 'vitest';
import { RetryPolicy, CircuitBreaker, resilientExecute } from '../../src/utils/retry.js';

describe('RetryPolicy', () => {
  it('returns result on first success', async () => {
    const retry = new RetryPolicy({ maxRetries: 2 });
    const result = await retry.execute(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('retries then succeeds', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 2, baseDelayMs: 10 });
    const result = await retry.execute(async () => {
      attempts++;
      if (attempts < 2) throw new Error('timeout');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws after max retries', async () => {
    const retry = new RetryPolicy({ maxRetries: 1, baseDelayMs: 10 });
    await expect(retry.execute(async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    const retry = new RetryPolicy({ maxRetries: 3 });
    await expect(retry.execute(async () => {
      attempts++;
      throw new Error('fatal');
    })).rejects.toThrow('fatal');
    expect(attempts).toBe(1);
  });
});

describe('CircuitBreaker', () => {
  it('allows calls when closed', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('closed');
  });

  it('opens after threshold failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');
    await expect(cb.execute(async () => 'ok')).rejects.toThrow('OPEN');
  });

  it('resets after reset timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
    await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
    await new Promise(r => setTimeout(r, 20));
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('resilientExecute', () => {
  it('combines retry and circuit breaker', async () => {
    const retry = new RetryPolicy({ maxRetries: 1, baseDelayMs: 10 });
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const result = await resilientExecute(async () => 'ok', retry, cb);
    expect(result).toBe('ok');
  });
});

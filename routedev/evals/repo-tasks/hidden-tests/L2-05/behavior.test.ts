// hidden/behavior.test.ts
// withRetry 精确语义：attempts 次尝试、错误传播正确
import { describe, it, expect } from 'vitest';
import { withRetry } from '../src/retry-helper.js';

describe('withRetry 精确语义（hidden）', () => {
  it('attempts=3 时最多尝试 3 次（不多不少）', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new Error('always fail');
    }, 3)).rejects.toThrow('always fail');
    expect(calls).toBe(3);
  });

  it('抛出的错误是最后一次尝试的错误', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new Error(`err-${calls}`);
    }, 2)).rejects.toThrow('err-2');
  });

  it('attempts=1 只尝试一次', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new Error('x');
    }, 1)).rejects.toThrow('x');
    expect(calls).toBe(1);
  });
});

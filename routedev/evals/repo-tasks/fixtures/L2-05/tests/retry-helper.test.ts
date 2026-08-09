// tests/retry-helper.test.ts
import { describe, it, expect } from 'vitest';
import { withRetry } from '../src/retry-helper.js';

describe('withRetry', () => {
  it('首次成功只调用一次', async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls += 1; return 'ok'; }, 3);
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('失败后重试成功', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
      return 'ok';
    }, 3);
    expect(r).toBe('ok');
    expect(calls).toBe(2);
  });
});

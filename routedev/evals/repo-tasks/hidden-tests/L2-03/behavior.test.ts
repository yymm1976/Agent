// hidden/behavior.test.ts
// maskSecret 行为（实现后通过；TDD 任务要求 agent 先写测试再实现）
import { describe, it, expect } from 'vitest';
import { maskSecret } from '../src/secrets.js';

describe('maskSecret（hidden）', () => {
  it('长密钥只保留末尾 4 位', () => {
    // Eval Fix 2：'sk-abcdef1234567890' 长 19，保留 4 → 15 个 `*`（旧 oracle 少 1 个）
    expect(maskSecret('sk-abcdef1234567890')).toBe('***************7890');
  });

  it('短于 visibleEnd+2 时原样返回', () => {
    expect(maskSecret('abc')).toBe('abc');
    expect(maskSecret('abcd')).toBe('abcd');
    expect(maskSecret('abcde')).toBe('abcde'); // 5 < 6 → 原样
  });

  it('等于 visibleEnd+2 时开始打码', () => {
    // Eval Fix 2：prompt 语义是 shorter than visibleEnd+2 才原样——
    // 6 == 4+2 → 不短于 → 必须打码：'*'.repeat(6-4) + 'cdef' = '**cdef'
    expect(maskSecret('abcdef')).toBe('**cdef');
  });

  it('恰好可见位长度时全遮罩后保留可见位', () => {
    expect(maskSecret('abcdefgh', 4)).toBe('****efgh');
  });

  it('自定义 visibleEnd 生效', () => {
    expect(maskSecret('abcdef', 2)).toBe('****ef');
  });
});

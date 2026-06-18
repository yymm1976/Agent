// tests/utils/token-estimate.test.ts

import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../src/utils/token-estimate.js';

describe('estimateTokens', () => {
  it('估算纯英文文本（约 4 字符/token）', () => {
    // 'hello world' = 11 字符 / 4 = 2.75 → 3
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('估算纯中文文本（约 1.5 token/字）', () => {
    // '你好世界' = 4 字 * 1.5 = 6
    expect(estimateTokens('你好世界')).toBe(6);
  });

  it('估算中英混合文本', () => {
    // 'hello 你好' = 2 CJK * 1.5 + 6 非 CJK / 4 = 3 + 1.5 = 4.5 → 5
    expect(estimateTokens('hello 你好')).toBe(5);
  });

  it('空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

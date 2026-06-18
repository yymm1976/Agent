// tests/cli/components/StatusBar.test.ts
// StatusBar 状态栏辅助函数测试（Phase 25 Task 7）

import { describe, it, expect } from 'vitest';
import { formatTokenCount } from '../../../src/cli/components/StatusBar.js';

describe('StatusBar: formatTokenCount', () => {
  it('小于 1000 直接显示', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('1000 以上显示为 K', () => {
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(999500)).toBe('999.5K');
  });

  it('100万 以上显示为 M', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
    expect(formatTokenCount(10_000_000)).toBe('10.0M');
  });
});

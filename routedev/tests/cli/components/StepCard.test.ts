// tests/cli/components/StepCard.test.ts
// StepCard 组件测试（Phase 20 Task 3 + Phase 25 图标/耗时增强）

import { describe, it, expect } from 'vitest';
import { STATUS_ICON, STATUS_COLOR, truncateDescription } from '../../../src/cli/components/StepCard.js';
import { formatDuration } from '../../../src/cli/components/goal-progress.js';

describe('StepCard 组件', () => {
  it('5 种状态各自映射到正确的图标和颜色', () => {
    // Phase 25：图标已切换为更直观的 emoji/符号
    expect(STATUS_ICON.pending).toBe('⬚');
    expect(STATUS_ICON.in_progress).toBe('🔄');
    expect(STATUS_ICON.completed).toBe('✅');
    expect(STATUS_ICON.failed).toBe('❌');
    expect(STATUS_ICON.skipped).toBe('[-]');

    // 颜色映射保持不变
    expect(STATUS_COLOR.pending).toBe('gray');
    expect(STATUS_COLOR.in_progress).toBe('yellow');
    expect(STATUS_COLOR.completed).toBe('green');
    expect(STATUS_COLOR.failed).toBe('red');
    expect(STATUS_COLOR.skipped).toBe('gray');
  });

  it('描述截断到 60 字符 + ...', () => {
    expect(truncateDescription('短描述')).toBe('短描述');
    expect(truncateDescription('a'.repeat(60))).toBe('a'.repeat(60));

    const long = 'a'.repeat(80);
    const result = truncateDescription(long);
    expect(result.length).toBe(63);
    expect(result.endsWith('...')).toBe(true);
    expect(result.slice(0, 60)).toBe('a'.repeat(60));
  });

  it('formatDuration 格式化耗时', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(125000)).toBe('2m05s');
    expect(formatDuration(-100)).toBe('0s');
  });
});

// tests/cli/components/ConfirmDialog.test.ts
// ConfirmDialog 确认对话框辅助函数测试（Phase 25 Task 2）

import { describe, it, expect } from 'vitest';
import { riskLabel, riskColor, formatRemainingSeconds } from '../../../src/cli/components/ConfirmDialog.js';

describe('ConfirmDialog: riskLabel', () => {
  it('low 风险返回 低', () => {
    expect(riskLabel('low')).toBe('低');
  });

  it('medium 风险返回 中等', () => {
    expect(riskLabel('medium')).toBe('中等');
  });

  it('high 风险返回 高', () => {
    expect(riskLabel('high')).toBe('高');
  });
});

describe('ConfirmDialog: riskColor', () => {
  it('low 风险使用 success 语义色', () => {
    expect(riskColor('low')).toBe('success');
  });

  it('medium 风险使用 warning 语义色', () => {
    expect(riskColor('medium')).toBe('warning');
  });

  it('high 风险使用 error 语义色', () => {
    expect(riskColor('high')).toBe('error');
  });
});

describe('ConfirmDialog: formatRemainingSeconds', () => {
  it('0 毫秒返回 0', () => {
    expect(formatRemainingSeconds(0)).toBe('0');
  });

  it('不足 1 秒按 1 秒进位', () => {
    expect(formatRemainingSeconds(500)).toBe('1');
  });

  it('30 秒返回 30', () => {
    expect(formatRemainingSeconds(30000)).toBe('30');
  });

  it('负值按 0 处理', () => {
    expect(formatRemainingSeconds(-100)).toBe('0');
  });
});

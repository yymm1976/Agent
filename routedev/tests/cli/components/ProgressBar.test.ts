// tests/cli/components/ProgressBar.test.ts
// ProgressBar 通用进度条组件测试（Phase 25 Task 4）

import { describe, it, expect } from 'vitest';
import { renderProgressBar } from '../../../src/cli/components/ProgressBar.js';

describe('ProgressBar: renderProgressBar', () => {
  it('空进度时返回全空条', () => {
    const bar = renderProgressBar(0, 10, 10);
    expect(bar).toBe('░░░░░░░░░░');
  });

  it('满进度时返回全实条', () => {
    const bar = renderProgressBar(10, 10, 10);
    expect(bar).toBe('██████████');
  });

  it('50% 进度在宽度 10 时显示 5 个实块', () => {
    const bar = renderProgressBar(5, 10, 10);
    const filled = bar.split('█').length - 1;
    expect(filled).toBe(5);
    expect(bar.length).toBe(10);
  });

  it('总进度为 0 时回退为全实条', () => {
    const bar = renderProgressBar(0, 0, 8);
    expect(bar).toBe('████████');
  });

  it('current 超过 total 时按 100% 截断', () => {
    const bar = renderProgressBar(15, 10, 10);
    expect(bar).toBe('██████████');
  });

  it('current 为负数时按 0% 处理', () => {
    const bar = renderProgressBar(-3, 10, 10);
    expect(bar).toBe('░░░░░░░░░░');
  });

  it('默认宽度为 35', () => {
    const bar = renderProgressBar(0, 1);
    expect(bar.length).toBe(35);
  });
});

// desktop/renderer/src/components/__tests__/StatsBar.test.tsx
// Phase 96+ A3.4：StatsBar 组件单元测试
// 验证空态隐藏、IPC 数据拉取后渲染、超限预算标红、卸载清理等行为

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

import { StatsBar } from '../StatsBar.js';
import type { StatsSnapshot } from '../../../../shared/ipc-types.js';

/** 构造测试快照的辅助函数 */
function makeSnapshot(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { totalUsd: 0, byModel: {} },
    cache: {
      session: { hit: 0, miss: 0, total: 0, hitRate: 0 },
      turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
    },
    budgetUsagePercent: 0,
    activeModels: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 注入 window.routedev.stats.getSnapshot mock */
function injectStatsApi(getSnapshot: () => Promise<StatsSnapshot>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).routedev = { stats: { getSnapshot } };
}

/** 清除 window.routedev */
function clearStatsApi() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).routedev = undefined;
}

describe('StatsBar 组件', () => {
  beforeEach(() => {
    // 用 real timers 避免与 fake timers + async/await + setInterval 兼容问题
    // 测试用极短 idleInterval / activeInterval 让轮询立即触发
  });

  afterEach(() => {
    cleanup();
    clearStatsApi();
  });

  it('无数据时返回 null（不渲染）', async () => {
    const empty = makeSnapshot();
    injectStatsApi(async () => empty);

    const { container } = render(<StatsBar idleInterval={50} />);
    // 等待 useEffect 中 fetchSnapshot 完成（real timer）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.firstChild).toBeNull();
  });

  it('有 token 消耗时显示统计条', async () => {
    const snap = makeSnapshot({
      tokens: { inputTokens: 1500, outputTokens: 800, totalTokens: 2300 },
      cost: { totalUsd: 0.0342, byModel: { 'gpt-4': 0.0342 } },
      cache: {
        session: { hit: 1200, miss: 300, total: 1500, hitRate: 0.8 },
        turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
      },
      budgetUsagePercent: 0.12,
      activeModels: ['gpt-4'],
      updatedAt: new Date().toISOString(),
    });
    injectStatsApi(async () => snap);

    const { container } = render(<StatsBar idleInterval={50} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // 应该出现 1.5k（输入 token）
    expect(container.textContent).toContain('1.5k');
    // 费用 0.0342 ≥ 0.01，显示 2 位小数 $0.03
    expect(container.textContent).toContain('$0.03');
    // 缓存命中率 80%
    expect(container.textContent).toContain('80%');
    // 预算 12%
    expect(container.textContent).toContain('12%');
  });

  it('费用小于 0.01 时显示 4 位小数', async () => {
    const snap = makeSnapshot({
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      cost: { totalUsd: 0.005, byModel: {} },
      cache: {
        session: { hit: 0, miss: 100, total: 100, hitRate: 0 },
        turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
      },
      budgetUsagePercent: 0,
      activeModels: [],
      updatedAt: new Date().toISOString(),
    });
    injectStatsApi(async () => snap);

    const { container } = render(<StatsBar idleInterval={50} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain('$0.0050');
  });

  it('预算超限时标红显示', async () => {
    const snap = makeSnapshot({
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      cost: { totalUsd: 1.5, byModel: {} },
      cache: {
        session: { hit: 0, miss: 100, total: 100, hitRate: 0 },
        turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
      },
      budgetUsagePercent: 1.25, // 超限 125%
      activeModels: [],
      updatedAt: new Date().toISOString(),
    });
    injectStatsApi(async () => snap);

    const { container } = render(<StatsBar idleInterval={50} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // 125% 应出现
    expect(container.textContent).toContain('125%');
    // 应有 danger 着色元素
    const dangerEl = container.querySelector('.text-rd-danger');
    expect(dangerEl).not.toBeNull();
  });

  it('多模型时显示模型计数', async () => {
    const snap = makeSnapshot({
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      cost: { totalUsd: 0.5, byModel: { 'gpt-4': 0.3, 'claude': 0.2 } },
      cache: {
        session: { hit: 0, miss: 100, total: 100, hitRate: 0 },
        turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
      },
      budgetUsagePercent: 0,
      activeModels: ['gpt-4', 'claude'],
      updatedAt: new Date().toISOString(),
    });
    injectStatsApi(async () => snap);

    const { container } = render(<StatsBar idleInterval={50} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // 模型计数 ×2
    expect(container.textContent).toContain('×2');
  });

  it('预算为 0 时不渲染 budget 区块', async () => {
    const snap = makeSnapshot({
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      cost: { totalUsd: 0.5, byModel: {} },
      cache: {
        // 命中率非 0，避免与 0% 字面量冲突
        session: { hit: 50, miss: 50, total: 100, hitRate: 0.5 },
        turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
      },
      budgetUsagePercent: 0,
      activeModels: [],
      updatedAt: new Date().toISOString(),
    });
    injectStatsApi(async () => snap);

    const { container } = render(<StatsBar idleInterval={50} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // 缓存命中率 50% 应出现
    expect(container.textContent).toContain('50%');
    // budget 块的 title 含「日预算使用率」，不应存在
    const budgetEl = container.querySelector('[title*="日预算"]');
    expect(budgetEl).toBeNull();
  });

  it('无 window.routedev API 时安全挂载（IPC 调用 no-op）', async () => {
    clearStatsApi();
    expect(() => render(<StatsBar idleInterval={50} />)).not.toThrow();
    // 等待一段时间不应抛错
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  });

  it('组件卸载时清理定时器无副作用', async () => {
    const snap = makeSnapshot({
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      cost: { totalUsd: 0.5, byModel: {} },
      cache: {
        session: { hit: 0, miss: 100, total: 100, hitRate: 0 },
        turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
      },
      budgetUsagePercent: 0,
      activeModels: [],
      updatedAt: new Date().toISOString(),
    });
    injectStatsApi(async () => snap);

    const { unmount } = render(<StatsBar idleInterval={50} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(() => unmount()).not.toThrow();
  });

  it('空闲轮询按 idleInterval 间隔拉取', async () => {
    const getSnapshot = vi.fn(async () => makeSnapshot({
      tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    injectStatsApi(getSnapshot);

    render(<StatsBar idleInterval={30} activeInterval={20} />);
    // 等待首次拉取
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    // 推进 30ms 应触发第二次
    await act(async () => {
      await new Promise((r) => setTimeout(r, 35));
    });
    expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);

    // 再推进 30ms 应触发第三次
    await act(async () => {
      await new Promise((r) => setTimeout(r, 35));
    });
    expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('isProcessing 切换时按 activeInterval 频率拉取', async () => {
    const getSnapshot = vi.fn(async () => makeSnapshot({
      tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    injectStatsApi(getSnapshot);

    const { rerender } = render(
      <StatsBar isProcessing={false} idleInterval={200} activeInterval={20} />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    // 切换到生成中：重置定时器，20ms 后应触发
    rerender(<StatsBar isProcessing={true} idleInterval={200} activeInterval={20} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // 至少触发了第二次
    expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

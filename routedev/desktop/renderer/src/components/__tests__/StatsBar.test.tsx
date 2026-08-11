// desktop/renderer/src/components/__tests__/StatsBar.test.tsx
// Phase 96+ A3.4：StatsBar 组件单元测试
// 验证空态隐藏、IPC 数据拉取后渲染、超限预算标红、卸载清理等行为
//
// GA Release Hygiene（Task 1）：全部使用 vi.useFakeTimers + vi.advanceTimersByTimeAsync
// 确定性推进——不再用 wall-clock sleep（CI 慢时 setTimeout(5) 实际可能 >30ms，
// interval 提前触发导致 `expected calls = 1 actual = 2` 的 timer scheduling flaky）。

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

/** flush mount 时的首次 fetch（microtask + effect 时序） */
async function flushMount() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('StatsBar 组件', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    clearStatsApi();
  });

  it('无数据时返回 null（不渲染）', async () => {
    const empty = makeSnapshot();
    injectStatsApi(async () => empty);

    const { container } = render(<StatsBar idleInterval={50} />);
    await flushMount();

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
    await flushMount();

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
    await flushMount();

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
    await flushMount();

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
    await flushMount();

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
    await flushMount();

    // 缓存命中率 50% 应出现
    expect(container.textContent).toContain('50%');
    // budget 块的 title 含「日预算使用率」，不应存在
    const budgetEl = container.querySelector('[title*="日预算"]');
    expect(budgetEl).toBeNull();
  });

  it('无 window.routedev API 时安全挂载（IPC 调用 no-op）', async () => {
    clearStatsApi();
    expect(() => render(<StatsBar idleInterval={50} />)).not.toThrow();
    // flush 定时器与 microtask 不应抛错
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
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
    await flushMount();

    expect(() => unmount()).not.toThrow();
  });

  it('空闲轮询按 idleInterval 间隔拉取（确定性 fake timers）', async () => {
    const getSnapshot = vi.fn(async () => makeSnapshot({
      tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    injectStatsApi(getSnapshot);

    render(<StatsBar idleInterval={30} activeInterval={20} />);
    // 首次 mount fetch——精确 1 次（fake timers 下无 wall-clock race）
    await flushMount();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    // 推进 30ms（idleInterval）→ 第二次
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    // 再推进 30ms → 第三次
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });

  it('isProcessing 切换时按 activeInterval 频率拉取（确定性 fake timers）', async () => {
    const getSnapshot = vi.fn(async () => makeSnapshot({
      tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    injectStatsApi(getSnapshot);

    const { rerender } = render(
      <StatsBar isProcessing={false} idleInterval={200} activeInterval={20} />
    );
    await flushMount();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    // 切换到生成中：effect 重跑（依赖 isProcessing）→ 立即 fetch 一次 + 重建 interval(20ms)
    rerender(<StatsBar isProcessing={true} idleInterval={200} activeInterval={20} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getSnapshot).toHaveBeenCalledTimes(2); // mount fetch + rerender effect fetch

    // 推进 20ms（activeInterval）→ interval 触发第三次
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(getSnapshot).toHaveBeenCalledTimes(3);
  });
});

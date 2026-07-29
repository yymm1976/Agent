// tests/router/tracker.test.ts
// Token 追踪器单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenTracker } from '../../src/router/tracker.js';
import type { TokenBudget, TokenUsageInfo } from '../../src/router/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('TokenTracker', () => {
  let tracker: TokenTracker;
  let tmpDir: string;
  const budget: TokenBudget = {
    mode: 'enforce',
    dailyLimit: 10000,
    degradationThreshold: 0.8,
  };

  beforeEach(() => {
    // 使用独立临时目录作为持久化路径，避免与其他测试并行时互相污染
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-tracker-test-'));
    tracker = new TokenTracker(budget, { persistPath: path.join(tmpDir, 'token-usage.json') });
  });

  afterEach(() => {
    tracker.destroy();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  it('should record token usage', () => {
    const usage: TokenUsageInfo = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };
    tracker.record(usage, { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' });

    const stats = tracker.getStats();
    expect(stats.total.inputTokens).toBe(100);
    expect(stats.total.outputTokens).toBe(50);
    expect(stats.total.totalTokens).toBe(150);
  });

  it('should aggregate by model', () => {
    tracker.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' });
    tracker.record({ inputTokens: 200, outputTokens: 100, totalTokens: 300 }, { modelId: 'claude-3', agentId: 'main', stepId: 'step-2' });

    const stats = tracker.getStats();
    expect(stats.byModel['gpt-4o'].totalTokens).toBe(150);
    expect(stats.byModel['claude-3'].totalTokens).toBe(300);
  });

  it('should aggregate by agent', () => {
    tracker.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, { modelId: 'gpt-4o', agentId: 'agent-a', stepId: 'step-1' });
    tracker.record({ inputTokens: 200, outputTokens: 100, totalTokens: 300 }, { modelId: 'gpt-4o', agentId: 'agent-b', stepId: 'step-2' });

    const stats = tracker.getStats();
    expect(stats.byAgent['agent-a'].totalTokens).toBe(150);
    expect(stats.byAgent['agent-b'].totalTokens).toBe(300);
  });

  it('should check budget - within limit', () => {
    tracker.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' });
    expect(tracker.checkBudget()).toBe(true);
  });

  it('should check budget - exceeded', () => {
    tracker.record({ inputTokens: 5000, outputTokens: 6000, totalTokens: 11000 }, { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' });
    expect(tracker.checkBudget()).toBe(false);
  });

  it('should get usage percent', () => {
    tracker.record({ inputTokens: 500, outputTokens: 500, totalTokens: 1000 }, { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' });
    expect(tracker.getUsagePercent()).toBe(0.1); // 1000 / 10000 = 0.1
  });

  it('should reset statistics', () => {
    tracker.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' });
    tracker.reset();
    const stats = tracker.getStats();
    expect(stats.total.totalTokens).toBe(0);
  });

  it('should work in track_only mode', () => {
    const trackOnlyBudget: TokenBudget = { ...budget, mode: 'track_only' };
    const trackOnlyTracker = new TokenTracker(trackOnlyBudget);
    trackOnlyTracker.record({ inputTokens: 50000, outputTokens: 50000, totalTokens: 100000 }, { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' });
    // track_only 模式总是返回 true
    expect(trackOnlyTracker.checkBudget()).toBe(true);
    trackOnlyTracker.destroy();
  });

  // ===== Phase 96+ A3.2：getSessionCost 测试 =====
  describe('getSessionCost (Phase 96+ A3.2)', () => {
    it('未传入 resolver 时返回 0', () => {
      tracker.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, { modelId: 'gpt-4o', agentId: 'main', stepId: 's1' });
      const result = tracker.getSessionCost();
      expect(result.totalUsd).toBe(0);
      expect(Object.keys(result.byModel)).toHaveLength(0);
    });

    it('resolver 未命中模型时跳过该记录', () => {
      tracker.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, { modelId: 'unknown-model', agentId: 'main', stepId: 's1' });
      const resolver = (id: string) => (id === 'gpt-4o' ? { input: 2.5, output: 10 } : undefined);
      const result = tracker.getSessionCost(resolver);
      expect(result.totalUsd).toBe(0);
      expect(Object.keys(result.byModel)).toHaveLength(0);
    });

    it('单次调用按 input/output 单价正确计费', () => {
      // gpt-4o: input $2.5/M, output $10/M, cacheRead $1.25/M
      // 1000 input + 500 output = 0.0025 + 0.005 = 0.0075
      tracker.record(
        { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        { modelId: 'gpt-4o', agentId: 'main', stepId: 's1' },
      );
      const resolver = (id: string) =>
        id === 'gpt-4o' ? { input: 2.5, output: 10, cacheRead: 1.25 } : undefined;
      const result = tracker.getSessionCost(resolver);
      expect(result.totalUsd).toBeCloseTo(0.0075, 6);
      expect(result.byModel['gpt-4o']).toBeCloseTo(0.0075, 6);
    });

    it('cacheReadInputTokens 按 cacheRead 单价计费', () => {
      // gpt-4o: 1000 input (cached=800) + 500 output
      // = (1000 × 2.5 + 800 × 1.25 + 500 × 10) / 1M = (2500 + 1000 + 5000) / 1M = 0.0085
      tracker.record(
        {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          cacheReadInputTokens: 800,
        },
        { modelId: 'gpt-4o', agentId: 'main', stepId: 's1' },
      );
      const resolver = (id: string) =>
        id === 'gpt-4o' ? { input: 2.5, output: 10, cacheRead: 1.25 } : undefined;
      const result = tracker.getSessionCost(resolver);
      // cacheRead 是 input 子集，calculateCallCost 视 input 与 cacheRead 独立计费
      // 故 (1000 × 2.5 + 800 × 1.25 + 500 × 10) / 1M = 0.0085
      expect(result.totalUsd).toBeCloseTo(0.0085, 6);
    });

    it('多模型按模型聚合', () => {
      tracker.record(
        { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
        { modelId: 'gpt-4o', agentId: 'main', stepId: 's1' },
      );
      tracker.record(
        { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
        { modelId: 'claude-3-5-sonnet', agentId: 'main', stepId: 's2' },
      );
      const resolver = (id: string) => {
        if (id === 'gpt-4o') return { input: 2.5, output: 10 };
        if (id === 'claude-3-5-sonnet') return { input: 3, output: 15 };
        return undefined;
      };
      const result = tracker.getSessionCost(resolver);
      expect(result.byModel['gpt-4o']).toBeCloseTo(0.0025, 6);
      expect(result.byModel['claude-3-5-sonnet']).toBeCloseTo(0.003, 6);
      expect(result.totalUsd).toBeCloseTo(0.0055, 6);
    });

    it('reset 后费用归零', () => {
      tracker.record(
        { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        { modelId: 'gpt-4o', agentId: 'main', stepId: 's1' },
      );
      const resolver = () => ({ input: 2.5, output: 10 });
      expect(tracker.getSessionCost(resolver).totalUsd).toBeGreaterThan(0);
      tracker.reset();
      expect(tracker.getSessionCost(resolver).totalUsd).toBe(0);
    });
  });
});

// tests/router/tracker.test.ts
// Token 追踪器单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenTracker } from '../../src/router/tracker.js';
import type { TokenBudget, TokenUsageInfo } from '../../src/router/types.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { getAppDataDir } from '../../src/utils/paths.js';

describe('TokenTracker', () => {
  let tracker: TokenTracker;
  const budget: TokenBudget = {
    mode: 'enforce',
    dailyLimit: 10000,
    degradationThreshold: 0.8,
  };

  beforeEach(() => {
    // 清理持久化文件以确保测试隔离
    const persistPath = join(getAppDataDir(), 'token-usage.json');
    if (existsSync(persistPath)) {
      try {
        unlinkSync(persistPath);
      } catch {
        // 忽略
      }
    }
    tracker = new TokenTracker(budget);
  });

  afterEach(() => {
    tracker.destroy();
    // 再次清理文件，防止影响其他测试
    const persistPath = join(getAppDataDir(), 'token-usage.json');
    if (existsSync(persistPath)) {
      try {
        unlinkSync(persistPath);
      } catch {
        // 忽略
      }
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
});

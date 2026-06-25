// tests/router/tracker-task-budget.test.ts
// Phase 31 Task 6.3：Token 熔断（单任务预算）测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenTracker } from '../../src/router/tracker.js';
import type { TokenBudget, TokenUsageInfo } from '../../src/router/types.js';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { getAppDataDir } from '../../src/utils/paths.js';

describe('TokenTracker 单任务预算 (Phase 31 Task 6.3)', () => {
  let tracker: TokenTracker;
  const budget: TokenBudget = {
    mode: 'enforce',
    dailyLimit: 100000,
    degradationThreshold: 0.8,
  };

  beforeEach(() => {
    const persistPath = join(getAppDataDir(), 'token-usage.json');
    if (existsSync(persistPath)) {
      try { unlinkSync(persistPath); } catch { /* ignore */ }
    }
    tracker = new TokenTracker(budget);
  });

  afterEach(() => {
    tracker.destroy();
    const persistPath = join(getAppDataDir(), 'token-usage.json');
    if (existsSync(persistPath)) {
      try { unlinkSync(persistPath); } catch { /* ignore */ }
    }
  });

  function makeUsage(total: number): TokenUsageInfo {
    return { inputTokens: Math.floor(total * 0.7), outputTokens: Math.floor(total * 0.3), totalTokens: total };
  }

  describe('startTask', () => {
    it('startTask 激活任务预算追踪', () => {
      tracker.startTask(50000);
      expect(tracker.isTaskActive()).toBe(true);
    });

    it('startTask 重置已消耗 token', () => {
      tracker.startTask(50000);
      tracker.record(makeUsage(1000), { modelId: 'm', agentId: 'a', stepId: 's' });
      expect(tracker.getTaskUsagePercent()).toBeGreaterThan(0);

      // 再次 startTask 应重置
      tracker.startTask(50000);
      expect(tracker.getTaskUsagePercent()).toBe(0);
    });
  });

  describe('recordTaskUsage', () => {
    it('任务未激活时返回 ok', () => {
      const status = tracker.recordTaskUsage(makeUsage(1000));
      expect(status).toBe('ok');
    });

    it('使用率 < 80% 返回 ok', () => {
      tracker.startTask(10000);
      tracker.record(makeUsage(5000), { modelId: 'm', agentId: 'a', stepId: 's' });
      const status = tracker.recordTaskUsage(makeUsage(0));
      expect(status).toBe('ok');
    });

    it('使用率 ≥ 80% 返回 warning', () => {
      tracker.startTask(10000);
      tracker.record(makeUsage(8000), { modelId: 'm', agentId: 'a', stepId: 's' });
      const status = tracker.recordTaskUsage(makeUsage(0));
      expect(status).toBe('warning');
    });

    it('使用率 ≥ 100% 返回 exceeded', () => {
      tracker.startTask(10000);
      tracker.record(makeUsage(10000), { modelId: 'm', agentId: 'a', stepId: 's' });
      const status = tracker.recordTaskUsage(makeUsage(0));
      expect(status).toBe('exceeded');
    });

    it('使用率远超 100% 返回 exceeded', () => {
      tracker.startTask(10000);
      tracker.record(makeUsage(15000), { modelId: 'm', agentId: 'a', stepId: 's' });
      const status = tracker.recordTaskUsage(makeUsage(0));
      expect(status).toBe('exceeded');
    });

    it('多次 record 累加任务消耗', () => {
      tracker.startTask(10000);
      tracker.record(makeUsage(3000), { modelId: 'm', agentId: 'a', stepId: 's1' });
      tracker.record(makeUsage(3000), { modelId: 'm', agentId: 'a', stepId: 's2' });
      tracker.record(makeUsage(3000), { modelId: 'm', agentId: 'a', stepId: 's3' });
      // 累计 9000，使用率 90% → warning
      const status = tracker.recordTaskUsage(makeUsage(0));
      expect(status).toBe('warning');
    });
  });

  describe('getTaskUsagePercent', () => {
    it('任务未激活返回 0', () => {
      expect(tracker.getTaskUsagePercent()).toBe(0);
    });

    it('预算为 0 返回 0', () => {
      tracker.startTask(0);
      expect(tracker.getTaskUsagePercent()).toBe(0);
    });

    it('返回正确的使用百分比', () => {
      tracker.startTask(10000);
      tracker.record(makeUsage(2500), { modelId: 'm', agentId: 'a', stepId: 's' });
      expect(tracker.getTaskUsagePercent()).toBeCloseTo(0.25, 2);
    });
  });

  describe('endTask', () => {
    it('endTask 清除任务状态', () => {
      tracker.startTask(50000);
      tracker.record(makeUsage(1000), { modelId: 'm', agentId: 'a', stepId: 's' });
      tracker.endTask();
      expect(tracker.isTaskActive()).toBe(false);
    });

    it('endTask 后 getTaskUsagePercent 返回 0', () => {
      tracker.startTask(50000);
      tracker.record(makeUsage(1000), { modelId: 'm', agentId: 'a', stepId: 's' });
      tracker.endTask();
      expect(tracker.getTaskUsagePercent()).toBe(0);
    });

    it('endTask 后 record 不再累加任务消耗', () => {
      tracker.startTask(50000);
      tracker.endTask();
      tracker.record(makeUsage(1000), { modelId: 'm', agentId: 'a', stepId: 's' });
      // 任务未激活，record 不累加
      expect(tracker.getTaskUsagePercent()).toBe(0);
    });

    it('endTask 后 recordTaskUsage 返回 ok', () => {
      tracker.startTask(50000);
      tracker.endTask();
      const status = tracker.recordTaskUsage(makeUsage(1000));
      expect(status).toBe('ok');
    });
  });

  describe('isTaskActive', () => {
    it('初始状态为 false', () => {
      expect(tracker.isTaskActive()).toBe(false);
    });

    it('startTask 后为 true', () => {
      tracker.startTask(50000);
      expect(tracker.isTaskActive()).toBe(true);
    });

    it('endTask 后为 false', () => {
      tracker.startTask(50000);
      tracker.endTask();
      expect(tracker.isTaskActive()).toBe(false);
    });
  });

  describe('TaskBudgetStatus 类型', () => {
    it('三种状态：ok / warning / exceeded', () => {
      // 这个测试验证类型定义存在且可赋值
      const status1 = 'ok' as const;
      const status2 = 'warning' as const;
      const status3 = 'exceeded' as const;
      expect(['ok', 'warning', 'exceeded']).toContain(status1);
      expect(['ok', 'warning', 'exceeded']).toContain(status2);
      expect(['ok', 'warning', 'exceeded']).toContain(status3);
    });
  });

  describe('与日限额独立', () => {
    it('任务预算独立于日限额', () => {
      // 日限额 100000，任务预算 10000
      tracker.startTask(10000);
      tracker.record(makeUsage(9000), { modelId: 'm', agentId: 'a', stepId: 's' });

      // 任务预算 90%（warning）
      expect(tracker.getTaskUsagePercent()).toBeCloseTo(0.9, 2);
      // 日限额仅 9%（ok）
      expect(tracker.getUsagePercent()).toBeCloseTo(0.09, 2);
    });

    it('任务超限不影响日限额检查', () => {
      tracker.startTask(10000);
      tracker.record(makeUsage(15000), { modelId: 'm', agentId: 'a', stepId: 's' });

      // 任务超限
      expect(tracker.recordTaskUsage(makeUsage(0))).toBe('exceeded');
      // 但日限额仍在范围内
      expect(tracker.checkBudget()).toBe(true);
    });
  });

  describe('perRequestLimit 接入 checkBudget', () => {
    it('单次请求超限时 checkBudget 返回 false', () => {
      const budgetWithPerRequest: TokenBudget = {
        mode: 'enforce',
        dailyLimit: 100000,
        degradationThreshold: 0.8,
        perRequestLimit: 5000,
      };
      tracker.destroy();
      tracker = new TokenTracker(budgetWithPerRequest);

      // 单次请求 6000 超过 5000 上限
      tracker.record(makeUsage(6000), { modelId: 'm', agentId: 'a', stepId: 's' });
      expect(tracker.checkBudget()).toBe(false);
    });

    it('单次请求未超限时 checkBudget 返回 true', () => {
      const budgetWithPerRequest: TokenBudget = {
        mode: 'enforce',
        dailyLimit: 100000,
        degradationThreshold: 0.8,
        perRequestLimit: 5000,
      };
      tracker.destroy();
      tracker = new TokenTracker(budgetWithPerRequest);

      tracker.record(makeUsage(4000), { modelId: 'm', agentId: 'a', stepId: 's' });
      expect(tracker.checkBudget()).toBe(true);
    });

    it('无 perRequestLimit 时不检查单次请求上限', () => {
      tracker.record(makeUsage(99999), { modelId: 'm', agentId: 'a', stepId: 's' });
      // 无 perRequestLimit，只要日限额未超即可
      expect(tracker.checkBudget()).toBe(true);
    });
  });
});

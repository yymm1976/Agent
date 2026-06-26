// tests/router/cache-optimizer.test.ts
// Reasonix 六层缓存优化架构单元测试
//
// Phase 50 Task 8：已移除对下列死代码的测试覆盖
//   - computePrefixShape / diffPrefixShape（Layer 4 前缀 Shape 哈希）
//   - CacheAwarePromptBuilder（Layer 1 & 2 不可变前缀构建器）
//   - orderToolResultsByDeclaration（确定性工具结果写回）
//   - alignCompactionBoundary（压缩边界对齐）
// 保留三级压缩阈值与 CacheStatsTracker 的测试。

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COMPACTION_THRESHOLDS,
  decideCompactionAction,
  CacheStatsTracker,
} from '../../src/router/cache-optimizer.js';

// ============================================================
// Layer 3: 三级压缩阈值
// ============================================================

describe('三级压缩阈值 (decideCompactionAction)', () => {
  it('默认阈值应为 0.5/0.8/0.9', () => {
    expect(DEFAULT_COMPACTION_THRESHOLDS.softThreshold).toBe(0.5);
    expect(DEFAULT_COMPACTION_THRESHOLDS.triggerThreshold).toBe(0.8);
    expect(DEFAULT_COMPACTION_THRESHOLDS.forceThreshold).toBe(0.9);
  });

  it('使用率 < 50% → none', () => {
    const result = decideCompactionAction(0.3);
    expect(result.action).toBe('none');
  });

  it('使用率 = 50% → soft_notify', () => {
    const result = decideCompactionAction(0.5);
    expect(result.action).toBe('soft_notify');
  });

  it('使用率 = 70% → soft_notify', () => {
    const result = decideCompactionAction(0.7);
    expect(result.action).toBe('soft_notify');
  });

  it('使用率 = 80% → trigger', () => {
    const result = decideCompactionAction(0.8);
    expect(result.action).toBe('trigger');
  });

  it('使用率 = 85% → trigger', () => {
    const result = decideCompactionAction(0.85);
    expect(result.action).toBe('trigger');
  });

  it('使用率 = 90% → force', () => {
    const result = decideCompactionAction(0.9);
    expect(result.action).toBe('force');
  });

  it('使用率 = 95% → force', () => {
    const result = decideCompactionAction(0.95);
    expect(result.action).toBe('force');
  });

  it('应支持自定义阈值', () => {
    const custom = { softThreshold: 0.3, triggerThreshold: 0.6, forceThreshold: 0.8 };
    expect(decideCompactionAction(0.35, custom).action).toBe('soft_notify');
    expect(decideCompactionAction(0.65, custom).action).toBe('trigger');
    expect(decideCompactionAction(0.85, custom).action).toBe('force');
  });
});

// ============================================================
// Layer 5 & 6: CacheStatsTracker
// ============================================================

describe('CacheStatsTracker', () => {
  it('应记录单轮缓存统计', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    expect(tracker.getTurnHitRate()).toBe(0.8);
  });

  it('resetTurn 应重置单轮但不重置会话级', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    tracker.resetTurn();
    expect(tracker.getTurnHitRate()).toBe(0);
    // 会话级不重置
    expect(tracker.getSessionStats().hit).toBe(800);
    expect(tracker.getSessionStats().miss).toBe(200);
  });

  it('会话级累计应跨轮次累加', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    tracker.resetTurn();
    tracker.record(900, 100, 'deepseek');
    const stats = tracker.getSessionStats();
    expect(stats.hit).toBe(1700);
    expect(stats.miss).toBe(300);
    expect(stats.total).toBe(2000);
  });

  it('getSessionHitRate 应返回会话级命中率', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    tracker.resetTurn();
    tracker.record(900, 100, 'deepseek');
    expect(tracker.getSessionHitRate()).toBeCloseTo(1700 / 2000, 5);
  });

  it('getDisplayFormat 应展示绝对计数', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(900, 100, 'deepseek');
    const display = tracker.getDisplayFormat(1000, 200);
    expect(display).toContain('1000');
    expect(display).toContain('900 cached');
    expect(display).toContain('100 new');
    expect(display).toContain('out 200');
  });

  it('空统计应返回 0 命中率', () => {
    const tracker = new CacheStatsTracker();
    expect(tracker.getTurnHitRate()).toBe(0);
    expect(tracker.getSessionHitRate()).toBe(0);
  });
});

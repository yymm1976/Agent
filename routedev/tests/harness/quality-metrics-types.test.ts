// tests/harness/quality-metrics-types.test.ts
// Phase 67 Task 6：质量指标元数据类型 + 记录器单元测试
//
// 覆盖蓝图 Task 6 测试要求：
//   1. logWithMetrics 附加 qualityMetrics 字段
//   2. logWorkerDispatchWithRV 记录 rewardVariance + retained
//   3. logMIProxySnapshot 记录完整 MI 快照
//   4. logEpistemicIntegrity 记录 epistemic 统计
//   5. qualityMetrics 字段持久化（getRecords 可读取）
//   6. 哈希包含 qualityMetrics 字段（篡改后 hash 不匹配）

import { describe, it, expect, beforeEach } from 'vitest';
import {
  QualityMetricsRecorder,
  DEFAULT_QUALITY_METRICS_RECORDER_CONFIG,
  type MetricsAuditRecord,
} from '../../src/harness/quality-metrics-types.js';
import crypto from 'node:crypto';

// ============================================================
// 辅助函数
// ============================================================

/**
 * 重新计算记录的 hash（用于验证防篡改）
 *
 * hash = SHA-256(type + action + timestamp + JSON.stringify(qualityMetrics ?? {}))
 */
function recomputeHash(record: MetricsAuditRecord): string {
  const data = `${record.type}${record.action}${record.timestamp}${JSON.stringify(record.qualityMetrics ?? {})}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ============================================================
// 测试套件
// ============================================================

describe('QualityMetricsRecorder (Phase 67 Task 6)', () => {
  let recorder: QualityMetricsRecorder;

  beforeEach(() => {
    recorder = new QualityMetricsRecorder({ enabled: true });
  });

  // ============================================================
  // 测试 1：logWithMetrics 附加 qualityMetrics 字段
  // ============================================================
  it('1. logWithMetrics 应附加 qualityMetrics 字段', () => {
    const record = recorder.logWithMetrics({
      type: 'test_event',
      action: 'test_action',
      qualityMetrics: {
        rewardVariance: 0.42,
      },
    });

    expect(record.type).toBe('test_event');
    expect(record.action).toBe('test_action');
    expect(record.timestamp).toBeGreaterThan(0);
    expect(record.qualityMetrics).toBeDefined();
    expect(record.qualityMetrics?.rewardVariance).toBe(0.42);
    expect(record.hash).toBeDefined();
    expect(record.hash).toHaveLength(64); // SHA-256 hex 长度
  });

  // ============================================================
  // 测试 2：logWorkerDispatchWithRV 记录 rewardVariance + retained
  // ============================================================
  it('2. logWorkerDispatchWithRV 应记录 rewardVariance 和 retained', () => {
    const record = recorder.logWorkerDispatchWithRV('task-123', 0.56, true);

    expect(record.type).toBe('worker_dispatch');
    expect(record.action).toContain('task-123');
    expect(record.action).toContain('retained=true');
    expect(record.qualityMetrics?.rewardVariance).toBe(0.56);
    expect(record.hash).toBeDefined();

    // 验证 retained=false 的场景
    const record2 = recorder.logWorkerDispatchWithRV('task-456', 0.01, false);
    expect(record2.action).toContain('retained=false');
    expect(record2.qualityMetrics?.rewardVariance).toBe(0.01);
  });

  // ============================================================
  // 测试 3：logMIProxySnapshot 记录完整 MI 快照
  // ============================================================
  it('3. logMIProxySnapshot 应记录完整的 MI 代理快照', () => {
    const record = recorder.logMIProxySnapshot({
      avgRetrievalAcc: 0.85,
      miZScoreEma: 2.1,
      collapseWarning: false,
    });

    expect(record.type).toBe('mi_proxy_snapshot');
    expect(record.qualityMetrics?.miProxy).toBeDefined();
    expect(record.qualityMetrics?.miProxy?.avgRetrievalAcc).toBe(0.85);
    expect(record.qualityMetrics?.miProxy?.miZScoreEma).toBe(2.1);
    expect(record.qualityMetrics?.miProxy?.collapseWarning).toBe(false);
    expect(record.hash).toBeDefined();

    // 验证 collapseWarning=true 的场景
    const record2 = recorder.logMIProxySnapshot({
      avgRetrievalAcc: 0.3,
      miZScoreEma: 0.5,
      collapseWarning: true,
    });
    expect(record2.qualityMetrics?.miProxy?.collapseWarning).toBe(true);
    expect(record2.action).toContain('collapseWarning=true');
  });

  // ============================================================
  // 测试 4：logEpistemicIntegrity 记录 epistemic 统计
  // ============================================================
  it('4. logEpistemicIntegrity 应记录认知完整性统计', () => {
    const record = recorder.logEpistemicIntegrity({
      originalFrequency: 0.1,
      reviewedFrequency: 0.04,
      frequencyDropRatio: 0.6,
    });

    expect(record.type).toBe('epistemic_integrity');
    expect(record.qualityMetrics?.epistemicStats).toBeDefined();
    expect(record.qualityMetrics?.epistemicStats?.originalFrequency).toBe(0.1);
    expect(record.qualityMetrics?.epistemicStats?.reviewedFrequency).toBe(0.04);
    expect(record.qualityMetrics?.epistemicStats?.frequencyDropRatio).toBe(0.6);
    expect(record.action).toContain('frequencyDropRatio=');
    expect(record.hash).toBeDefined();
  });

  // ============================================================
  // 测试 5：qualityMetrics 字段持久化（getRecords 可读取）
  // ============================================================
  it('5. getRecords 应返回所有已记录的记录（qualityMetrics 持久化）', () => {
    // 记录 3 条事件
    recorder.logWorkerDispatchWithRV('task-1', 0.4, true);
    recorder.logMIProxySnapshot({ avgRetrievalAcc: 0.8, miZScoreEma: 1.5, collapseWarning: false });
    recorder.logEpistemicIntegrity({
      originalFrequency: 0.1,
      reviewedFrequency: 0.05,
      frequencyDropRatio: 0.5,
    });

    const records = recorder.getRecords();
    expect(records.length).toBe(3);

    // 验证每条记录的 qualityMetrics 都已持久化
    expect(records[0].qualityMetrics?.rewardVariance).toBe(0.4);
    expect(records[1].qualityMetrics?.miProxy?.avgRetrievalAcc).toBe(0.8);
    expect(records[2].qualityMetrics?.epistemicStats?.frequencyDropRatio).toBe(0.5);

    // 验证每条记录都有 hash
    expect(records.every(r => r.hash !== undefined && r.hash.length === 64)).toBe(true);
  });

  // ============================================================
  // 测试 6：哈希包含 qualityMetrics 字段（篡改后 hash 不匹配）
  // ============================================================
  it('6. 哈希应包含 qualityMetrics 字段（篡改后 hash 不匹配）', () => {
    const record = recorder.logWorkerDispatchWithRV('task-tamper', 0.5, true);
    const originalHash = record.hash!;

    // 验证原始 hash 与重新计算的 hash 一致
    const recomputedOriginal = recomputeHash(record);
    expect(recomputedOriginal).toBe(originalHash);

    // 篡改 qualityMetrics.rewardVariance
    const tamperedRecord: MetricsAuditRecord = {
      ...record,
      qualityMetrics: { rewardVariance: 0.99 }, // 篡改 rewardVariance
    };
    const tamperedHash = recomputeHash(tamperedRecord);
    expect(tamperedHash).not.toBe(originalHash);

    // 篡改 qualityMetrics（移除字段）
    const tamperedRecord2: MetricsAuditRecord = {
      ...record,
      qualityMetrics: undefined, // 移除 qualityMetrics
    };
    const tamperedHash2 = recomputeHash(tamperedRecord2);
    expect(tamperedHash2).not.toBe(originalHash);

    // 篡改 action
    const tamperedRecord3: MetricsAuditRecord = {
      ...record,
      action: 'tampered action',
    };
    const tamperedHash3 = recomputeHash(tamperedRecord3);
    expect(tamperedHash3).not.toBe(originalHash);
  });

  // ============================================================
  // 额外测试 7：配置关闭时返回最小记录（不带 qualityMetrics 和 hash）
  // ============================================================
  it('7. 配置关闭时应返回最小记录（不带 qualityMetrics 和 hash）', () => {
    const disabledRecorder = new QualityMetricsRecorder({
      ...DEFAULT_QUALITY_METRICS_RECORDER_CONFIG,
      enabled: false,
    });

    const record = disabledRecorder.logWorkerDispatchWithRV('task-1', 0.5, true);

    expect(record.type).toBe('worker_dispatch');
    expect(record.timestamp).toBeGreaterThan(0);
    // 配置关闭时不附加 qualityMetrics 和 hash
    expect(record.qualityMetrics).toBeUndefined();
    expect(record.hash).toBeUndefined();

    // getRecords 应为空（未持久化）
    expect(disabledRecorder.getRecords().length).toBe(0);
  });

  // ============================================================
  // 额外测试 8：不带 qualityMetrics 的记录也能正常 hash
  // ============================================================
  it('8. 不带 qualityMetrics 的记录也应能正常计算 hash', () => {
    const record = recorder.logWithMetrics({
      type: 'plain_event',
      action: 'plain_action',
      // 不提供 qualityMetrics
    });

    expect(record.qualityMetrics).toBeUndefined();
    expect(record.hash).toBeDefined();
    expect(record.hash).toHaveLength(64);

    // 验证 hash 可重新计算
    const recomputed = recomputeHash(record);
    expect(recomputed).toBe(record.hash);
  });
});

// tests/memory/reputation-deriver.test.ts
// Phase 66 Task 5：ReputationDeriver 测试
//
// 覆盖：
//   1. 无引用事件→credibility=0.5
//   2. 全部 approved→1.0
//   3. 全部 denied→0.0
//   4. 混合→successCount/totalCount
//   5. 缓存命中（连续调用返回同一对象）
//   6. 缓存失效后重算
//   7. 批量派生正确性

import { describe, it, expect, beforeEach } from 'vitest';
import { ReputationDeriver } from '../../src/memory/reputation-deriver.js';

describe('ReputationDeriver (Phase 66 Task 5)', () => {
  let deriver: ReputationDeriver;

  beforeEach(() => {
    deriver = new ReputationDeriver({ enabled: true, maxCacheAgeMs: 60000 });
  });

  // ============================================================
  // credibility 计算
  // ============================================================

  it('1. 无引用事件→credibility=0.5', () => {
    const rep = deriver.deriveReputation('topic-1', []);
    expect(rep.credibility).toBe(0.5);
    expect(rep.successRefCount).toBe(0);
    expect(rep.rejectedRefCount).toBe(0);
    expect(rep.topicId).toBe('topic-1');
    expect(rep.computedAt).toBeGreaterThan(0);
  });

  it('2. 全部 approved→credibility=1.0', () => {
    const refs = [
      { topicId: 'topic-1', outcome: 'approved' as const },
      { topicId: 'topic-1', outcome: 'approved' as const },
      { topicId: 'topic-1', outcome: 'approved' as const },
    ];
    const rep = deriver.deriveReputation('topic-1', refs);
    expect(rep.credibility).toBe(1.0);
    expect(rep.successRefCount).toBe(3);
    expect(rep.rejectedRefCount).toBe(0);
  });

  it('3. 全部 denied→credibility=0.0', () => {
    const refs = [
      { topicId: 'topic-1', outcome: 'denied' as const },
      { topicId: 'topic-1', outcome: 'denied' as const },
    ];
    const rep = deriver.deriveReputation('topic-1', refs);
    expect(rep.credibility).toBe(0.0);
    expect(rep.successRefCount).toBe(0);
    expect(rep.rejectedRefCount).toBe(2);
  });

  it('4. 混合→successCount/totalCount', () => {
    const refs = [
      { topicId: 'topic-1', outcome: 'approved' as const },
      { topicId: 'topic-1', outcome: 'denied' as const },
      { topicId: 'topic-1', outcome: 'approved' as const },
      { topicId: 'topic-1', outcome: 'denied' as const },
    ];
    const rep = deriver.deriveReputation('topic-1', refs);
    expect(rep.credibility).toBe(0.5);
    expect(rep.successRefCount).toBe(2);
    expect(rep.rejectedRefCount).toBe(2);
  });

  it('只过滤当前 topicId 的引用', () => {
    const refs = [
      { topicId: 'topic-1', outcome: 'approved' as const },
      { topicId: 'topic-2', outcome: 'denied' as const },
      { topicId: 'topic-1', outcome: 'denied' as const },
    ];
    const rep = deriver.deriveReputation('topic-1', refs);
    // 只算 topic-1 的两条引用：1 approved + 1 denied = 0.5
    expect(rep.credibility).toBe(0.5);
    expect(rep.successRefCount).toBe(1);
    expect(rep.rejectedRefCount).toBe(1);
  });

  // ============================================================
  // 缓存
  // ============================================================

  it('5. 缓存命中（连续调用返回同一对象）', () => {
    const refs = [{ topicId: 'topic-1', outcome: 'approved' as const }];
    const r1 = deriver.deriveReputation('topic-1', refs);
    const r2 = deriver.deriveReputation('topic-1', refs);
    // 同一对象引用（缓存命中）
    expect(r2).toBe(r1);
  });

  it('6. 缓存失效后重算', () => {
    const refs1 = [{ topicId: 'topic-1', outcome: 'approved' as const }];
    const r1 = deriver.deriveReputation('topic-1', refs1);
    expect(r1.credibility).toBe(1.0);

    deriver.invalidate('topic-1');

    const refs2 = [{ topicId: 'topic-1', outcome: 'denied' as const }];
    const r2 = deriver.deriveReputation('topic-1', refs2);
    expect(r2.credibility).toBe(0.0);
    expect(r2).not.toBe(r1);
  });

  it('缓存过期后重算（maxCacheAgeMs=0 立即过期）', () => {
    const shortCacheDeriver = new ReputationDeriver({
      enabled: true,
      maxCacheAgeMs: 0, // 立即过期
    });
    const refs = [{ topicId: 'topic-1', outcome: 'approved' as const }];
    const r1 = shortCacheDeriver.deriveReputation('topic-1', refs);
    const r2 = shortCacheDeriver.deriveReputation('topic-1', refs);
    // 缓存立即过期，应重算（不同对象）
    expect(r2).not.toBe(r1);
    expect(r2.credibility).toBe(1.0);
  });

  // ============================================================
  // 批量派生
  // ============================================================

  it('7. 批量派生正确性', () => {
    const refs = [
      { topicId: 't1', outcome: 'approved' as const },
      { topicId: 't1', outcome: 'denied' as const },
      { topicId: 't2', outcome: 'approved' as const },
      { topicId: 't2', outcome: 'approved' as const },
    ];
    const batch = deriver.deriveBatch(['t1', 't2', 't3'], refs);
    expect(batch.size).toBe(3);
    expect(batch.get('t1')!.credibility).toBe(0.5);
    expect(batch.get('t2')!.credibility).toBe(1.0);
    expect(batch.get('t3')!.credibility).toBe(0.5); // 无引用
  });

  // ============================================================
  // queryTopicReferences
  // ============================================================

  it('queryTopicReferences 从 audit records 查询引用', () => {
    const auditRecords = [
      { topicId: 't1', result: 'success' },
      { topicId: 't1', result: 'denied' },
      { topicId: 't2', result: 'success' },
      { topicId: 't1', result: 'unknown' }, // 未知结果跳过
    ];
    const refs = deriver.queryTopicReferences('t1', auditRecords);
    expect(refs).toHaveLength(2);
    expect(refs[0].outcome).toBe('approved');
    expect(refs[1].outcome).toBe('denied');
  });

  it('queryTopicReferences 兼容 details 嵌套结构', () => {
    const auditRecords = [
      { details: { topicId: 't1', result: 'success' } },
      { details: { topicId: 't1', result: 'failure' } },
    ];
    const refs = deriver.queryTopicReferences('t1', auditRecords);
    expect(refs).toHaveLength(2);
    expect(refs[0].outcome).toBe('approved');
    expect(refs[1].outcome).toBe('denied');
  });

  it('queryTopicReferences + deriveReputation 端到端', () => {
    const auditRecords = [
      { topicId: 't1', result: 'success' },
      { topicId: 't1', result: 'success' },
      { topicId: 't1', result: 'denied' },
    ];
    const refs = deriver.queryTopicReferences('t1', auditRecords);
    const rep = deriver.deriveReputation('t1', refs);
    expect(rep.credibility).toBeCloseTo(2 / 3);
    expect(rep.successRefCount).toBe(2);
    expect(rep.rejectedRefCount).toBe(1);
  });
});

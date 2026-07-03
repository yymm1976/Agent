// tests/memory/rejected-alternative-store.test.ts
// Phase 65 Task 5 测试：RejectedAlternativeStore

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { RejectedAlternativeStore } from '../../src/memory/rejected-alternative-store.js';

const storeConfig = {
  enabled: true,
  dbPath: ':memory:',
  backend: 'sqlite' as const,
  embeddingProvider: 'hash' as const,
};

describe('Phase 65 Task 5: RejectedAlternativeStore', () => {
  let store: MemoryStore;
  let rejected: RejectedAlternativeStore;

  beforeEach(async () => {
    store = new MemoryStore(storeConfig);
    await store.initialize();
    rejected = new RejectedAlternativeStore(store);
  });

  it('1. recordRejection 落库（type=rejected_alternative）', async () => {
    const id = await rejected.recordRejection({
      proposal: '使用 MongoDB 作为主数据库',
      rejectionReason: '不支持事务',
      issues: [{ severity: 'critical', description: 'ACID 事务支持不完整' }],
      topics: ['database'],
      source: 'review',
    });
    expect(id).toBeTruthy();
    const entry = await store.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe('rejected_alternative');
    expect(entry!.source).toBe('review');
    expect(entry!.topics).toEqual(['database']);
  });

  it('2. 原文保留不摘要', async () => {
    const proposal = '详细方案：使用 Redis 作为消息队列，通过 List 数据结构实现 FIFO 队列，配合 BRPOP 命令实现阻塞消费';
    const id = await rejected.recordRejection({
      proposal,
      rejectionReason: '消息可靠性不足',
      issues: [{ severity: 'high', description: '可能丢消息' }],
      topics: ['queue'],
      source: 'review',
    });
    const entry = await store.read(id);
    expect(entry!.content).toBe(proposal);
    // 不应被摘要化
    expect(entry!.content.length).toBe(proposal.length);
  });

  it('3. findSimilarRejections 相似检索', async () => {
    await rejected.recordRejection({
      proposal: 'use mongodb as main database for storage',
      rejectionReason: 'no transaction support',
      issues: [{ severity: 'high', description: 'ACID not supported' }],
      topics: ['database'],
      source: 'review',
    });
    await rejected.recordRejection({
      proposal: 'use redis for caching layer',
      rejectionReason: 'volatile storage',
      issues: [{ severity: 'medium', description: 'data may be lost' }],
      topics: ['cache'],
      source: 'review',
    });

    const results = await rejected.findSimilarRejections('mongodb database', 5);
    expect(results.length).toBeGreaterThan(0);
    // mongodb 那条应排第一
    expect(results[0].content).toContain('mongodb');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('4. 无结果时返回空', async () => {
    await rejected.recordRejection({
      proposal: 'use redis for cache',
      rejectionReason: 'volatile',
      issues: [],
      topics: ['cache'],
      source: 'review',
    });
    const results = await rejected.findSimilarRejections('postgresql database', 5);
    expect(results).toEqual([]);
  });

  it('5. 多条被拒方案检索', async () => {
    await rejected.recordRejection({
      proposal: 'use cassandra database for write-heavy workload',
      rejectionReason: 'eventual consistency',
      issues: [{ severity: 'high', description: 'not suitable for transactional' }],
      topics: ['database'],
      source: 'review',
    });
    await rejected.recordRejection({
      proposal: 'use mongodb database for document storage',
      rejectionReason: 'no transaction',
      issues: [{ severity: 'high', description: 'ACID not supported' }],
      topics: ['database'],
      source: 'review',
    });
    await rejected.recordRejection({
      proposal: 'use mysql database for relational data',
      rejectionReason: 'scaling issues',
      issues: [{ severity: 'medium', description: 'horizontal scaling hard' }],
      topics: ['database'],
      source: 'review',
    });

    const results = await rejected.findSimilarRejections('database', 5);
    expect(results.length).toBe(3);
    // 都应为 rejected_alternative 类型
    expect(results.every((r) => r.type === 'rejected_alternative')).toBe(true);
    // 应按分数降序
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it('6. metadata 包含 rejectionReason 和 issues', async () => {
    const issues = [
      { severity: 'critical', description: 'security vulnerability' },
      { severity: 'high', description: 'performance issue' },
    ];
    const id = await rejected.recordRejection({
      proposal: 'use plain HTTP for API',
      rejectionReason: 'security risk',
      issues,
      topics: ['security'],
      source: 'review',
    });
    const entry = await store.read(id);
    expect(entry!.metadata).toBeDefined();
    expect(entry!.metadata!.rejectionReason).toBe('security risk');
    expect(entry!.metadata!.issues).toBeDefined();
    // 反序列化验证
    const parsed = JSON.parse(entry!.metadata!.issues);
    expect(parsed).toEqual(issues);
    expect(parsed.length).toBe(2);
    expect(parsed[0].severity).toBe('critical');
  });

  it('补充：空查询返回空', async () => {
    await rejected.recordRejection({
      proposal: 'some proposal',
      rejectionReason: 'some reason',
      issues: [],
      topics: ['test'],
      source: 'test',
    });
    expect(await rejected.findSimilarRejections('', 5)).toEqual([]);
    expect(await rejected.findSimilarRejections('   ', 5)).toEqual([]);
  });

  it('补充：只检索 rejected_alternative 类型', async () => {
    // 写入一条非 rejected 类型
    await store.write({
      content: 'use mongodb database for storage',
      type: 'decision',
      source: 'coding',
      validFrom: Date.now(),
      topics: ['database'],
    });
    // 写入一条 rejected 类型
    await rejected.recordRejection({
      proposal: 'use mongodb database for storage',
      rejectionReason: 'no transaction',
      issues: [],
      topics: ['database'],
      source: 'review',
    });

    const results = await rejected.findSimilarRejections('mongodb database', 5);
    // 只应返回 rejected_alternative 类型
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('rejected_alternative');
  });
});

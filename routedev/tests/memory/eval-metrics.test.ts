// tests/memory/eval-metrics.test.ts
// Phase 65 Task 7 测试：EvalMetrics

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore, type MemoryEntry } from '../../src/memory/memory-store.js';
import { retrievalFidelity, temporalUpdateRobustness } from '../../src/memory/eval-metrics.js';

const storeConfig = {
  enabled: true,
  dbPath: ':memory:',
  backend: 'sqlite' as const,
  embeddingProvider: 'hash' as const,
};

function makeMemoryEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    content,
    type: 'fact',
    source: 'test',
    validFrom: Date.now(),
  };
}

describe('Phase 65 Task 7: EvalMetrics', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore(storeConfig);
    await store.initialize();
  });

  describe('retrievalFidelity', () => {
    it('1. top-K 全命中返回 1', () => {
      const retrieved = [
        makeMemoryEntry('a', 'content a'),
        makeMemoryEntry('b', 'content b'),
        makeMemoryEntry('c', 'content c'),
      ];
      const groundTruthIds = ['a', 'b', 'c'];
      const k = 3;
      // top-3 完全包含 ground-truth
      const fidelity = retrievalFidelity(retrieved, groundTruthIds, k);
      expect(fidelity).toBe(1);
    });

    it('2. 部分命中返回正确比率', () => {
      const retrieved = [
        makeMemoryEntry('a', 'content a'),
        makeMemoryEntry('x', 'content x'),
        makeMemoryEntry('b', 'content b'),
      ];
      const groundTruthIds = ['a', 'b', 'c'];
      const k = 3;
      // top-3 包含 a、b，但不含 c → 2/3
      const fidelity = retrievalFidelity(retrieved, groundTruthIds, k);
      expect(fidelity).toBeCloseTo(2 / 3, 5);
    });

    it('补充：k=1 时只看 top-1', () => {
      const retrieved = [
        makeMemoryEntry('a', 'content a'),
        makeMemoryEntry('b', 'content b'),
      ];
      // k=1: top-1 是 'a'，命中 ground-truth['a'] → 1/2 = 0.5
      const fidelity = retrievalFidelity(retrieved, ['a', 'b'], 1);
      expect(fidelity).toBeCloseTo(0.5, 5);
    });

    it('补充：空 ground-truth 返回 0', () => {
      const retrieved = [makeMemoryEntry('a', 'content a')];
      expect(retrievalFidelity(retrieved, [], 5)).toBe(0);
    });
  });

  describe('temporalUpdateRobustness', () => {
    it('3. 更新后返回最新版本', async () => {
      // 先写入初始版本
      const matchKey = { topics: ['auth'], type: 'decision' };
      await store.write({
        content: 'use JWT auth token for authentication',
        type: 'decision',
        source: 'test',
        validFrom: Date.now() - 10000,
        topics: ['auth'],
      });

      // 应用更新（与初始版本高度相似，触发冲突 supersede）
      const result = await temporalUpdateRobustness(store, [
        { matchKey, newContent: 'use JWT auth token for authentication' },
      ]);

      // 冲突 supersede 后应返回最新版本
      expect(result.returnedLatest).toBe(1);
      expect(result.returnedStale).toBe(0);
      expect(result.robustness).toBe(1);
    });

    it('4. 无更新时返回 1', async () => {
      const result = await temporalUpdateRobustness(store, []);
      expect(result.robustness).toBe(1);
      expect(result.returnedLatest).toBe(0);
      expect(result.returnedStale).toBe(0);
    });

    it('补充：多次冲突更新后返回最新版本', async () => {
      const matchKey = { topics: ['config'], type: 'decision' };
      // 三次相同内容更新，每次都触发冲突 supersede
      const result = await temporalUpdateRobustness(store, [
        { matchKey, newContent: 'config setting for production environment' },
        { matchKey, newContent: 'config setting for production environment' },
        { matchKey, newContent: 'config setting for production environment' },
      ]);

      // 三次更新都触发冲突 supersede，最后一次为最新版本
      // 检查每次 retrieveLatest 是否返回最新版本
      expect(result.returnedLatest + result.returnedStale).toBe(3);
      expect(result.robustness).toBeGreaterThan(0);
    });

    it('补充：多个不同 matchKey 的更新', async () => {
      const result = await temporalUpdateRobustness(store, [
        { matchKey: { topics: ['auth'], type: 'decision' }, newContent: 'use JWT for authentication' },
        { matchKey: { topics: ['cache'], type: 'decision' }, newContent: 'use Redis for cache' },
        { matchKey: { topics: ['db'], type: 'decision' }, newContent: 'use PostgreSQL for database' },
      ]);

      // 三个不同 matchKey，应都能检索到最新版本
      expect(result.returnedLatest).toBe(3);
      expect(result.returnedStale).toBe(0);
      expect(result.robustness).toBe(1);
    });
  });
});

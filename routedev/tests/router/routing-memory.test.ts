// tests/router/routing-memory.test.ts
// RoutingMemory 向量库与 kNN 检索测试

import { describe, it, expect, beforeEach } from 'vitest';
import { RoutingMemory } from '../../src/router/routing-memory.js';
import type { NeighborModelStats } from '../../src/router/routing-memory.js';
import { RoutingHistory } from '../../src/router/routing-history.js';
import type { RoutingRecord } from '../../src/router/routing-history.js';
import { HashEmbedder, cosineSimilarity } from '../../src/router/embedder.js';

function makeRecord(overrides: Partial<RoutingRecord> = {}): RoutingRecord {
  return {
    taskSignature: 'default-task',
    modelId: 'gpt-4o',
    qualityScore: 0.8,
    tokenCost: 1200,
    latencyMs: 350,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('RoutingMemory', () => {
  let history: RoutingHistory;
  let embedder: HashEmbedder;

  beforeEach(() => {
    history = new RoutingHistory();
    embedder = new HashEmbedder(32);
  });

  describe('queryNeighbors top-K 与相似度过滤', () => {
    it('应返回不超过 topK 条邻居', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 2,
        minSimilarity: 0,
        enabled: true,
      });

      for (let i = 0; i < 10; i++) {
        const embedding = await embedder.embed(`record-${i}`);
        history.append(makeRecord({ modelId: `m-${i}`, taskEmbedding: embedding }));
      }

      const queryEmbedding = await embedder.embed('record-0');
      const neighbors = await memory.queryNeighbors('record-0');

      expect(neighbors.length).toBeLessThanOrEqual(2);
    });

    it('应过滤掉相似度低于 minSimilarity 的记录', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 100,
        minSimilarity: 0.99,
        enabled: true,
      });

      const highEmbedding = await embedder.embed('exact match query');
      history.append(makeRecord({ modelId: 'high', taskEmbedding: highEmbedding }));

      for (let i = 0; i < 5; i++) {
        history.append(makeRecord({ modelId: `noise-${i}`, taskEmbedding: await embedder.embed(`completely different text ${i}`) }));
      }

      const neighbors = await memory.queryNeighbors('exact match query');

      for (const n of neighbors) {
        const sim = cosineSimilarity(highEmbedding, n.taskEmbedding!);
        expect(sim).toBeGreaterThanOrEqual(0.99);
      }
    });

    it('应跳过无 taskEmbedding 的记录', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 10,
        minSimilarity: 0,
        enabled: true,
      });

      history.append(makeRecord({ modelId: 'no-embedding', taskEmbedding: undefined }));
      history.append(makeRecord({ modelId: 'empty-embedding', taskEmbedding: [] }));

      const neighbors = await memory.queryNeighbors('test query');

      expect(neighbors.length).toBe(0);
    });

    it('应按相似度降序返回结果', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 10,
        minSimilarity: 0,
        enabled: true,
      });

      const target = await embedder.embed('hello world');
      const mid = await embedder.embed('hello world test');
      const low = await embedder.embed('unrelated xyz');

      history.append(makeRecord({ modelId: 'low', taskEmbedding: low }));
      history.append(makeRecord({ modelId: 'target', taskEmbedding: target }));
      history.append(makeRecord({ modelId: 'mid', taskEmbedding: mid }));

      const neighbors = await memory.queryNeighbors('hello world');
      const sims = neighbors.map(n => cosineSimilarity(target, n.taskEmbedding!));

      for (let i = 1; i < sims.length; i++) {
        expect(sims[i - 1]!).toBeGreaterThanOrEqual(sims[i]!);
      }
    });
  });

  describe('queryModelStats 聚合与加权', () => {
    it('应按 modelId 分桶聚合统计', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 10,
        minSimilarity: 0,
        enabled: true,
      });

      const embedding = await embedder.embed('task');
      history.append(makeRecord({ modelId: 'm1', qualityScore: 0.9, tokenCost: 100, latencyMs: 200, taskEmbedding: embedding }));
      history.append(makeRecord({ modelId: 'm1', qualityScore: 0.7, tokenCost: 300, latencyMs: 400, taskEmbedding: embedding }));
      history.append(makeRecord({ modelId: 'm2', qualityScore: 0.5, tokenCost: 500, latencyMs: 100, taskEmbedding: embedding }));

      const stats = await memory.queryModelStats('task');

      expect(stats.size).toBe(2);

      const m1 = stats.get('m1')!;
      expect(m1.neighborCount).toBe(2);
      expect(m1.avgQuality).toBeCloseTo(0.8, 5);
      expect(m1.avgCost).toBeCloseTo(200, 5);
      expect(m1.avgLatency).toBeCloseTo(300, 5);

      const m2 = stats.get('m2')!;
      expect(m2.neighborCount).toBe(1);
      expect(m2.avgQuality).toBeCloseTo(0.5, 5);
    });

    it('应计算 weightedScore = Σ(similarity × qualityScore) / Σ(similarity)', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 10,
        minSimilarity: 0,
        enabled: true,
      });

      const emb = await embedder.embed('query task');
      history.append(makeRecord({ modelId: 'm1', qualityScore: 1.0, taskEmbedding: emb }));
      history.append(makeRecord({ modelId: 'm1', qualityScore: 0.5, taskEmbedding: emb }));

      const stats = await memory.queryModelStats('query task');
      const m1 = stats.get('m1')!;

      const sim = cosineSimilarity(emb, emb);
      const expectedWeighted = (sim * 1.0 + sim * 0.5) / (sim + sim);
      expect(m1.weightedScore).toBeCloseTo(expectedWeighted, 5);
    });

    it('当无 qualityScore 且 totalWeight>0 时 weightedScore 应为 0', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 10,
        minSimilarity: 0,
        enabled: true,
      });

      const emb = await embedder.embed('no quality');
      history.append(makeRecord({ modelId: 'm1', qualityScore: undefined, taskEmbedding: emb }));

      const stats = await memory.queryModelStats('no quality');
      const m1 = stats.get('m1')!;

      expect(m1.weightedScore).toBe(0);
    });

    it('当无邻居时 queryModelStats 应返回空 Map（weightedScore 不会走到 0.5 分支）', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 10,
        minSimilarity: 0,
        enabled: true,
      });

      const stats = await memory.queryModelStats('no records at all');

      expect(stats.size).toBe(0);
    });
  });

  describe('fail-open（记忆查询失败时优雅降级）', () => {
    it('embedder 抛出异常时 queryNeighbors 应返回空数组', async () => {
      const failingEmbedder = {
        embed: async () => { throw new Error('embedding service down'); },
      };

      const memory = new RoutingMemory(history, failingEmbedder, {
        topK: 5,
        minSimilarity: 0,
        enabled: true,
      });

      history.append(makeRecord({ modelId: 'm1', taskEmbedding: [1, 0] }));

      const neighbors = await memory.queryNeighbors('test');
      expect(neighbors).toEqual([]);
    });

    it('embedder 抛出异常时 queryModelStats 应返回空 Map', async () => {
      const failingEmbedder = {
        embed: async () => { throw new Error('timeout'); },
      };

      const memory = new RoutingMemory(history, failingEmbedder, {
        topK: 5,
        minSimilarity: 0,
        enabled: true,
      });

      const stats = await memory.queryModelStats('test');
      expect(stats.size).toBe(0);
    });
  });

  describe('config switch off（禁用状态）', () => {
    it('enabled=false 时 queryNeighbors 应返回空数组', async () => {
      const memory = new RoutingMemory(history, embedder, {
        enabled: false,
      });

      const emb = await embedder.embed('test');
      history.append(makeRecord({ modelId: 'm1', taskEmbedding: emb }));

      const neighbors = await memory.queryNeighbors('test');
      expect(neighbors).toEqual([]);
    });

    it('enabled=false 时 queryModelStats 应返回空 Map', async () => {
      const memory = new RoutingMemory(history, embedder, {
        enabled: false,
      });

      const stats = await memory.queryModelStats('test');
      expect(stats.size).toBe(0);
    });

    it('isEnabled() 应反映配置状态', () => {
      const enabled = new RoutingMemory(history, embedder, { enabled: true });
      const disabled = new RoutingMemory(history, embedder, { enabled: false });
      const defaultDisabled = new RoutingMemory(history, embedder);

      expect(enabled.isEnabled()).toBe(true);
      expect(disabled.isEnabled()).toBe(false);
      expect(defaultDisabled.isEnabled()).toBe(false);
    });
  });

  describe('HashEmbedder 降级', () => {
    it('相同输入应产生一致的 embedding', async () => {
      const a = await embedder.embed('hello world');
      const b = await embedder.embed('hello world');

      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) {
        expect(a[i]).toBe(b[i]);
      }
    });

    it('不同输入应产生不同的 embedding', async () => {
      const a = await embedder.embed('hello world');
      const b = await embedder.embed('completely different text');

      expect(a.length).toBe(b.length);
      let allSame = true;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { allSame = false; break; }
      }
      expect(allSame).toBe(false);
    });

    it('输出应是 L2 归一化的（模长为 1）', async () => {
      const vec = await embedder.embed('normalize me');
      let norm = 0;
      for (const v of vec) norm += v * v;
      expect(Math.sqrt(norm)).toBeCloseTo(1.0, 10);
    });
  });

  describe('cosineSimilarity 工具函数', () => {
    it('相同向量的余弦相似度应为 1', () => {
      const v = [1, 2, 3, 4, 5];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
    });

    it('正交向量的余弦相似度应为 0', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    });

    it('反向向量的余弦相似度应为 -1', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    });

    it('长度不等的向量应返回 0', () => {
      expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    });

    it('零向量应返回 0', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });
  });

  describe('neighbor model stats 加权分数验证', () => {
    it('不同相似度的邻居应产生加权分数', async () => {
      const memory = new RoutingMemory(history, embedder, {
        topK: 10,
        minSimilarity: 0,
        enabled: true,
      });

      const queryEmb = await embedder.embed('weighted test');
      const closeEmb = await embedder.embed('weighted test');
      const farEmb = await embedder.embed('totally different');

      history.append(makeRecord({ modelId: 'm1', qualityScore: 1.0, taskEmbedding: closeEmb }));
      history.append(makeRecord({ modelId: 'm1', qualityScore: 0.0, taskEmbedding: farEmb }));

      const stats = await memory.queryModelStats('weighted test');
      const m1 = stats.get('m1')!;

      const simClose = cosineSimilarity(queryEmb, closeEmb);
      const simFar = cosineSimilarity(queryEmb, farEmb);
      const expected = (simClose * 1.0 + simFar * 0.0) / (simClose + simFar);

      expect(m1.weightedScore).toBeCloseTo(expected, 5);
      expect(m1.neighborCount).toBe(2);
    });
  });
});

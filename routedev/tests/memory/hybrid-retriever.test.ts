// tests/memory/hybrid-retriever.test.ts
// Phase 65 Task 3 测试：BM25Index + HybridRetriever

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { BM25Index, tokenize } from '../../src/memory/bm25-index.js';
import { HybridRetriever } from '../../src/memory/hybrid-retriever.js';
import { HashEmbedder } from '../../src/skills/embedder.js';

const storeConfig = {
  enabled: true,
  dbPath: ':memory:',
  backend: 'sqlite' as const,
  embeddingProvider: 'hash' as const,
};

describe('Phase 65 Task 3: BM25Index', () => {
  it('1. BM25 索引与查询', () => {
    const bm25 = new BM25Index();
    bm25.index([
      { id: 'd1', content: 'the quick brown fox jumps over the lazy dog' },
      { id: 'd2', content: 'a quick brown dog runs in the park' },
      { id: 'd3', content: 'the cat sleeps on the sofa' },
    ]);
    const results = bm25.search('quick brown dog', 3);
    expect(results.length).toBeGreaterThan(0);
    // d1 和 d2 都包含 quick/brown/dog，d3 不包含
    const ids = results.map((r) => r.id);
    expect(ids).toContain('d1');
    expect(ids).toContain('d2');
    expect(ids).not.toContain('d3');
  });

  it('2. BM25 TF 饱和与 IDF', () => {
    const bm25 = new BM25Index(1.5, 0.75);
    // 文档 d1 中 "rare" 出现多次（TF 饱和）
    bm25.index([
      { id: 'd1', content: 'rare rare rare rare common term' },
      { id: 'd2', content: 'common term only' },
      { id: 'd3', content: 'common term only here' },
    ]);
    const results = bm25.search('rare', 3);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('d1');
    expect(results[0].score).toBeGreaterThan(0);
    // "rare" 只在 d1 出现，IDF 应较高
    // 验证：相同查询在多文档场景下，rare 词应得分较高
    const commonResults = bm25.search('common', 3);
    // common 出现在所有文档，IDF 应较低（甚至为 0）
    const rareScore = results[0].score;
    const commonMaxScore = Math.max(...commonResults.map((r) => r.score));
    expect(rareScore).toBeGreaterThan(commonMaxScore);
  });

  it('补充：tokenize CJK bigram', () => {
    const tokens = tokenize('使用 PostgreSQL 数据库');
    // 应包含 CJK bigram
    expect(tokens).toContain('使用');
    expect(tokens).toContain('数据');
    // 应包含 ASCII 词
    expect(tokens).toContain('postgresql');
  });

  it('补充：空查询返回空', () => {
    const bm25 = new BM25Index();
    bm25.index([{ id: 'd1', content: 'some content' }]);
    expect(bm25.search('', 10)).toEqual([]);
    expect(bm25.search('   ', 10)).toEqual([]);
  });
});

describe('Phase 65 Task 3: HybridRetriever', () => {
  let store: MemoryStore;
  let embedder: HashEmbedder;

  beforeEach(async () => {
    store = new MemoryStore(storeConfig);
    await store.initialize();
    embedder = new HashEmbedder();
  });

  it('3. embedding kNN 与 cosine', async () => {
    await store.write({
      content: 'typescript programming language',
      type: 'topic',
      source: 'test',
      validFrom: Date.now(),
    });
    await store.write({
      content: 'typescript programming language',
      type: 'topic',
      source: 'test',
      validFrom: Date.now(),
    });
    await store.write({
      content: 'python programming language',
      type: 'topic',
      source: 'test',
      validFrom: Date.now(),
    });

    const retriever = new HybridRetriever(store, embedder, {
      enabled: true,
      bm25Weight: 0.5,
      embeddingWeight: 0.5,
      timeDecayHalfLifeDays: 30,
      topK: 3,
    });
    const results = await retriever.retrieve('typescript programming');
    expect(results.length).toBeGreaterThan(0);
    // 前两条应为完全匹配
    const contents = results.map((r) => r.content);
    expect(contents.filter((c) => c === 'typescript programming language').length).toBe(2);
  });

  it('4. 混合分数加权', async () => {
    // 写入两条文档：一条 BM25 命中强，一条 embedding 相似
    await store.write({
      content: 'postgresql database connection pool',
      type: 'decision',
      source: 'test',
      validFrom: Date.now(),
    });
    await store.write({
      content: 'redis cache invalidation strategy',
      type: 'decision',
      source: 'test',
      validFrom: Date.now(),
    });

    const retriever = new HybridRetriever(store, embedder, {
      enabled: true,
      bm25Weight: 0.5,
      embeddingWeight: 0.5,
      timeDecayHalfLifeDays: 30,
      topK: 2,
    });
    const results = await retriever.retrieve('postgresql database');
    expect(results.length).toBeGreaterThan(0);
    // postgresql 那条应排第一（BM25 完全命中）
    expect(results[0].content).toBe('postgresql database connection pool');
    // bm25Score 应大于 0
    expect(results[0].bm25Score).toBeGreaterThan(0);
    // embeddingScore 应在 [0, 1]
    expect(results[0].embeddingScore).toBeGreaterThanOrEqual(0);
    expect(results[0].embeddingScore).toBeLessThanOrEqual(1);
    // timeDecay 应在 (0, 1]
    expect(results[0].timeDecay).toBeGreaterThan(0);
    expect(results[0].timeDecay).toBeLessThanOrEqual(1);
    // 综合分数 = (α × bm25_norm + (1-α) × cosine_norm) × timeDecay
    // 各分量都应在合理范围
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('5. 时间衰减', async () => {
    // 写入一条旧的（30 天前）和一条新的（现在）
    const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 天前
    await store.write({
      content: 'old memory about database design',
      type: 'decision',
      source: 'test',
      validFrom: oldTime,
    });
    await store.write({
      content: 'old memory about database design',
      type: 'decision',
      source: 'test',
      validFrom: Date.now(),
    });

    const retriever = new HybridRetriever(store, embedder, {
      enabled: true,
      bm25Weight: 0.5,
      embeddingWeight: 0.5,
      timeDecayHalfLifeDays: 30, // 半衰期 30 天
      topK: 2,
    });
    const results = await retriever.retrieve('database design');
    expect(results.length).toBe(2);
    // 新条目应排前面（timeDecay 更高）
    expect(results[0].timeDecay).toBeGreaterThan(results[1].timeDecay);
    // 30 天前的条目衰减后应约为 0.5
    const oldEntry = results.find((r) => r.validFrom === oldTime);
    expect(oldEntry).toBeDefined();
    expect(Math.abs(oldEntry!.timeDecay - 0.5)).toBeLessThan(0.01);
    // 当前条目 timeDecay 接近 1
    const newEntry = results.find((r) => r.validFrom !== oldTime);
    expect(newEntry!.timeDecay).toBeGreaterThan(0.99);
  });

  it('6. embedder 不可用降级纯 BM25', async () => {
    await store.write({
      content: 'decision use postgresql for main database',
      type: 'decision',
      source: 'test',
      validFrom: Date.now(),
    });
    await store.write({
      content: 'decision use redis for cache',
      type: 'decision',
      source: 'test',
      validFrom: Date.now(),
    });

    // embedder 传 null
    const retriever = new HybridRetriever(store, null, {
      enabled: true,
      bm25Weight: 0.5,
      embeddingWeight: 0.5,
      timeDecayHalfLifeDays: 30,
      topK: 2,
    });
    const results = await retriever.retrieve('postgresql database');
    expect(results.length).toBeGreaterThan(0);
    // 应能命中 postgresql 那条
    expect(results[0].content).toContain('postgresql');
    // embeddingScore 应为 0（无 embedder）
    expect(results[0].embeddingScore).toBe(0);
    // bm25Score 应大于 0
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it('7. 检索失败降级（fail-open）', async () => {
    // 写入正常条目
    await store.write({
      content: 'normal content',
      type: 'topic',
      source: 'test',
      validFrom: Date.now(),
    });

    // embedder 抛异常
    const failingEmbedder = {
      embed: async () => {
        throw new Error('embedder failed');
      },
      embedBatch: async () => {
        throw new Error('embedder failed');
      },
    };

    const retriever = new HybridRetriever(store, failingEmbedder, {
      enabled: true,
      bm25Weight: 0.5,
      embeddingWeight: 0.5,
      timeDecayHalfLifeDays: 30,
      topK: 2,
    });
    // 应降级为纯 BM25，不抛异常
    const results = await retriever.retrieve('normal content');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe('normal content');
    // embedding 不可用，embeddingScore 应为 0
    expect(results[0].embeddingScore).toBe(0);
  });

  it('8. 空查询返回空', async () => {
    await store.write({
      content: 'some content',
      type: 'topic',
      source: 'test',
      validFrom: Date.now(),
    });
    const retriever = new HybridRetriever(store, embedder, {
      enabled: true,
      bm25Weight: 0.5,
      embeddingWeight: 0.5,
      timeDecayHalfLifeDays: 30,
      topK: 5,
    });
    expect(await retriever.retrieve('')).toEqual([]);
    expect(await retriever.retrieve('   ')).toEqual([]);
  });

  it('补充：enabled=false 返回空', async () => {
    await store.write({
      content: 'some content',
      type: 'topic',
      source: 'test',
      validFrom: Date.now(),
    });
    const retriever = new HybridRetriever(store, embedder, {
      enabled: false,
      bm25Weight: 0.5,
      embeddingWeight: 0.5,
      timeDecayHalfLifeDays: 30,
      topK: 5,
    });
    expect(await retriever.retrieve('some content')).toEqual([]);
  });
});

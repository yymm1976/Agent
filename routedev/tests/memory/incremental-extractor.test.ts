// tests/memory/incremental-extractor.test.ts
// Phase 65 Task 2 测试：IncrementalExtractor

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { IncrementalExtractor } from '../../src/memory/incremental-extractor.js';

const storeConfig = {
  enabled: true,
  dbPath: ':memory:',
  backend: 'sqlite' as const,
  embeddingProvider: 'hash' as const,
};

describe('Phase 65 Task 2: IncrementalExtractor', () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = new MemoryStore(storeConfig);
    await store.initialize();
  });

  it('1. 四阶段 type 映射正确', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'none',
      modelId: 'test',
    });
    // requirements → topic
    let result = await extractor.extractFromPhase('requirements', '需求A');
    let entry = await store.read(result.memoryIds[0]);
    expect(entry!.type).toBe('topic');

    // coding → decision
    store = new MemoryStore(storeConfig);
    await store.initialize();
    const ext2 = new IncrementalExtractor(store, { enabled: true, mode: 'none', modelId: 'test' });
    result = await ext2.extractFromPhase('coding', '决策A');
    entry = await store.read(result.memoryIds[0]);
    expect(entry!.type).toBe('decision');

    // testing → error_fix
    store = new MemoryStore(storeConfig);
    await store.initialize();
    const ext3 = new IncrementalExtractor(store, { enabled: true, mode: 'none', modelId: 'test' });
    result = await ext3.extractFromPhase('testing', '修复A');
    entry = await store.read(result.memoryIds[0]);
    expect(entry!.type).toBe('error_fix');

    // review → decision
    store = new MemoryStore(storeConfig);
    await store.initialize();
    const ext4 = new IncrementalExtractor(store, { enabled: true, mode: 'none', modelId: 'test' });
    result = await ext4.extractFromPhase('review', '评审A');
    entry = await store.read(result.memoryIds[0]);
    expect(entry!.type).toBe('decision');
  });

  it('2. 原文优先写入（content 不被替换）', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'topic',
      modelId: 'test',
    });
    const original = 'We decided to use PostgreSQL database for storage';
    const result = await extractor.extractFromPhase('coding', original);
    const entry = await store.read(result.memoryIds[0]);
    // 原文完整保留，未被 topics 替换或摘要化
    expect(entry!.content).toBe(original);
  });

  it('3. mode=topic 生成 topics', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'topic',
      modelId: 'test',
    });
    await extractor.extractFromPhase('requirements', 'We use typescript and postgresql database');
    const all = store.getAll();
    expect(all.length).toBe(1);
    expect(all[0].topics).toBeDefined();
    expect(all[0].topics!.length).toBeGreaterThan(0);
    // 应包含长英文词
    expect(all[0].topics).toContain('typescript');
    expect(all[0].topics).toContain('postgresql');
    expect(all[0].topics).toContain('database');
  });

  it('4. mode=none 仅存原文（不抽取 topics）', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'none',
      modelId: 'test',
    });
    await extractor.extractFromPhase('requirements', 'We use typescript and postgresql');
    const all = store.getAll();
    expect(all.length).toBe(1);
    // topics 应为 undefined（未抽取）
    expect(all[0].topics).toBeUndefined();
    // 原文保留
    expect(all[0].content).toBe('We use typescript and postgresql');
  });

  it('5. 抽取失败 fail-open（topics 留空，原文已存）', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'topic',
      modelId: 'test',
      // 注入会抛异常的 topic 抽取器
      topicExtractor: () => {
        throw new Error('LLM service unavailable');
      },
    });
    const result = await extractor.extractFromPhase('coding', '重要决策原文应被保留');
    expect(result.extracted).toBe(1);
    expect(result.memoryIds.length).toBe(1);
    const entry = await store.read(result.memoryIds[0]);
    // 原文已存（fail-open）
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('重要决策原文应被保留');
    // topics 留空（抽取失败）
    expect(entry!.topics).toBeUndefined();
  });

  it('6. 空输出处理', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'topic',
      modelId: 'test',
    });
    let result = await extractor.extractFromPhase('coding', '');
    expect(result.extracted).toBe(0);
    expect(result.memoryIds).toEqual([]);

    result = await extractor.extractFromPhase('coding', '   \n  \n  ');
    expect(result.extracted).toBe(0);
    expect(result.memoryIds).toEqual([]);
  });

  it('7. 多条输出批量抽取', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'topic',
      modelId: 'test',
    });
    const output = [
      'Decision: use postgresql database',
      'Decision: implement rest api',
      'Decision: deploy with docker',
    ].join('\n');
    const result = await extractor.extractFromPhase('coding', output);
    expect(result.extracted).toBe(3);
    expect(result.memoryIds.length).toBe(3);
    // 三条都应写入
    const all = store.getAll();
    expect(all.length).toBe(3);
    // 每条都有原文
    expect(all[0].content).toBe('Decision: use postgresql database');
    expect(all[1].content).toBe('Decision: implement rest api');
    expect(all[2].content).toBe('Decision: deploy with docker');
    // 每条都抽取了 topics
    expect(all[0].topics!.length).toBeGreaterThan(0);
    expect(all[1].topics!.length).toBeGreaterThan(0);
    expect(all[2].topics!.length).toBeGreaterThan(0);
  });

  it('补充：enabled=false 时不抽取', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: false,
      mode: 'topic',
      modelId: 'test',
    });
    const result = await extractor.extractFromPhase('coding', 'should not extract');
    expect(result.extracted).toBe(0);
    expect(result.memoryIds).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it('补充：CJK 内容 topic 抽取', async () => {
    const extractor = new IncrementalExtractor(store, {
      enabled: true,
      mode: 'topic',
      modelId: 'test',
    });
    await extractor.extractFromPhase('requirements', '使用 PostgreSQL 数据库存储用户信息');
    const all = store.getAll();
    expect(all[0].topics).toBeDefined();
    // 应包含 CJK bigram
    const cjkTopics = all[0].topics!.filter((t) => /[\u4e00-\u9fff]/.test(t));
    expect(cjkTopics.length).toBeGreaterThan(0);
    // 应包含英文词
    expect(all[0].topics).toContain('postgresql');
  });
});

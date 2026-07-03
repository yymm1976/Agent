// tests/memory/memory-store.test.ts
// Phase 65 Task 1 测试：MemoryStore

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore, type MemoryEntry } from '../../src/memory/memory-store.js';
import { HashEmbedder } from '../../src/skills/embedder.js';

const defaultConfig = {
  enabled: true,
  dbPath: ':memory:',
  backend: 'sqlite' as const,
  embeddingProvider: 'hash' as const,
};

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    content: '测试记忆内容',
    type: 'fact',
    source: 'test',
    validFrom: Date.now(),
    ...overrides,
  };
}

describe('Phase 65 Task 1: MemoryStore', () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = new MemoryStore(defaultConfig);
    await store.initialize();
  });

  it('1. initialize 后可写入', async () => {
    const id = await store.write(makeEntry({ content: '初始化后写入' }));
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('2. write + read 往返一致', async () => {
    const entry = makeEntry({
      content: '用户偏好使用 TypeScript',
      type: 'decision',
      source: 'requirements',
      topics: ['typescript', 'language'],
    });
    const id = await store.write(entry);
    const read = await store.read(id);
    expect(read).not.toBeNull();
    expect(read!.id).toBe(id);
    expect(read!.content).toBe('用户偏好使用 TypeScript');
    expect(read!.type).toBe('decision');
    expect(read!.source).toBe('requirements');
    expect(read!.topics).toEqual(['typescript', 'language']);
  });

  it('3. searchFullText LIKE 匹配', async () => {
    await store.write(makeEntry({ content: '使用 PostgreSQL 作为主数据库' }));
    await store.write(makeEntry({ content: '使用 Redis 作为缓存' }));
    await store.write(makeEntry({ content: 'PostgreSQL 配置连接池' }));

    const results = await store.searchFullText('PostgreSQL', 10);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.content.includes('PostgreSQL'))).toBe(true);
  });

  it('4. searchVector kNN 正确性', async () => {
    // 写入多条记忆，使用 HashEmbedder 后内容相似的向量应更接近
    await store.write(makeEntry({ content: 'typescript language programming' }));
    await store.write(makeEntry({ content: 'typescript language programming' }));
    await store.write(makeEntry({ content: 'python language programming' }));

    const embedder = new HashEmbedder();
    const queryEmb = await embedder.embed('typescript language');
    const results = await store.searchVector(queryEmb, 3);
    expect(results.length).toBe(3);
    // 完全匹配的两条应排在前面
    expect(results[0].content).toBe('typescript language programming');
    expect(results[1].content).toBe('typescript language programming');
  });

  it('5. 向量 L2 归一化', async () => {
    await store.write(makeEntry({ content: 'normalized vector test' }));
    const embedder = new HashEmbedder();
    const rawEmb = await embedder.embed('normalized vector test');
    // 直接读取 store 中存储的 embedding
    const all = store.getAll();
    const stored = store.getEmbedding(all[0].id!);
    expect(stored).not.toBeNull();
    // L2 范数应为 1
    const norm = Math.sqrt(stored!.reduce((s, v) => s + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
    // 与原始 embedding（HashEmbedder 已归一化）一致或长度相同
    expect(stored!.length).toBe(rawEmb.length);
  });

  it('6. backend=file 降级为内存模式', async () => {
    const fileStore = new MemoryStore({
      enabled: true,
      dbPath: '/tmp/test-memory.json',
      backend: 'file',
      embeddingProvider: 'none',
    });
    await fileStore.initialize();
    expect(fileStore.backend).toBe('file');
    // 文件 backend 也使用内存模式（接口一致），可正常写入读取
    const id = await fileStore.write(makeEntry({ content: 'file backend 降级' }));
    const read = await fileStore.read(id);
    expect(read).not.toBeNull();
    expect(read!.content).toBe('file backend 降级');
  });

  it('7. 空查询返回空', async () => {
    await store.write(makeEntry({ content: 'some content' }));
    expect(await store.searchFullText('', 10)).toEqual([]);
    expect(await store.searchFullText('   ', 10)).toEqual([]);
    expect(await store.searchVector([], 10)).toEqual([]);
  });

  it('8. read 不存在 id 返回 null', async () => {
    const read = await store.read('non-existent-id-12345');
    expect(read).toBeNull();
  });

  it('补充：embeddingProvider=none 不计算 embedding', async () => {
    const noEmbStore = new MemoryStore({
      enabled: true,
      dbPath: ':memory:',
      backend: 'sqlite',
      embeddingProvider: 'none',
    });
    await noEmbStore.initialize();
    const id = await noEmbStore.write(makeEntry({ content: 'no embedding' }));
    const stored = noEmbStore.getEmbedding(id);
    expect(stored).toBeNull();
    // 仍然可以全文检索
    const results = await noEmbStore.searchFullText('no embedding', 10);
    expect(results.length).toBe(1);
  });

  it('补充：write 不提供 id 时自动生成 UUID', async () => {
    const id1 = await store.write(makeEntry({ content: 'entry 1' }));
    const id2 = await store.write(makeEntry({ content: 'entry 2' }));
    expect(id1).not.toBe(id2);
    // UUID v4 格式
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// tests/memory/memory-store-persistence.test.ts
// 需求 1 测试：MemoryStore SQLite 持久化

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, type MemoryEntry } from '../../src/memory/memory-store.js';

function makeTmpDir(prefix = 'routedev-mem-persist-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    content: '测试记忆内容',
    type: 'fact',
    source: 'test',
    validFrom: Date.now(),
    ...overrides,
  };
}

describe('需求 1: MemoryStore SQLite 持久化', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = join(tmpDir, 'memory.db');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  it('1. dbPath 为真实路径时启用持久化模式', async () => {
    const store = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    expect(store.isPersistent()).toBe(true);
    await store.initialize();
    expect(store.isPersistent()).toBe(true);
    await store.close();
    // DB 文件应被创建
    expect(existsSync(dbPath)).toBe(true);
  });

  it('2. dbPath 为 :memory: 时纯内存模式（向后兼容）', async () => {
    const store = new MemoryStore({
      enabled: true,
      dbPath: ':memory:',
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    expect(store.isPersistent()).toBe(false);
    await store.initialize();
    expect(store.isPersistent()).toBe(false);
    await store.close();
  });

  it('3. 写入后重启，数据从 DB 加载到内存', async () => {
    // 会话 1：写入并关闭
    const store1 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    await store1.initialize();
    const id1 = await store1.write(makeEntry({ content: '持久化记忆 A' }));
    const id2 = await store1.write(makeEntry({ content: '持久化记忆 B', type: 'decision' }));
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    await store1.close();

    // 会话 2：重新打开，数据应从 DB 加载
    const store2 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    await store2.initialize();
    expect(store2.count()).toBe(2);
    const r1 = await store2.read(id1);
    const r2 = await store2.read(id2);
    expect(r1).not.toBeNull();
    expect(r1!.content).toBe('持久化记忆 A');
    expect(r2).not.toBeNull();
    expect(r2!.content).toBe('持久化记忆 B');
    expect(r2!.type).toBe('decision');
    await store2.close();
  });

  it('4. embedding 向量跨会话恢复（searchVector 仍可用）', async () => {
    // 会话 1：写入带 embedding 的记忆
    const store1 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    await store1.initialize();
    await store1.write(makeEntry({ content: 'typescript language programming' }));
    await store1.write(makeEntry({ content: 'python language programming' }));
    await store1.close();

    // 会话 2：重新打开，embedding 应已恢复
    const store2 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    await store2.initialize();
    const { HashEmbedder } = await import('../../src/skills/embedder.js');
    const embedder = new HashEmbedder();
    const queryEmb = await embedder.embed('typescript language');
    const results = await store2.searchVector(queryEmb, 2);
    expect(results.length).toBe(2);
    // typescript 那条应排在前面
    expect(results[0].content).toBe('typescript language programming');
    await store2.close();
  });

  it('5. delete 持久化到 DB（重启后确认删除）', async () => {
    const store1 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'none',
    });
    await store1.initialize();
    const id = await store1.write(makeEntry({ content: '将被删除的记忆' }));
    expect(await store1.read(id)).not.toBeNull();
    await store1.delete(id);
    expect(await store1.read(id)).toBeNull();
    await store1.close();

    // 重启后确认已删除
    const store2 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'none',
    });
    await store2.initialize();
    expect(await store2.read(id)).toBeNull();
    expect(store2.count()).toBe(0);
    await store2.close();
  });

  it('6. update 持久化到 DB（重启后确认更新）', async () => {
    const store1 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'none',
    });
    await store1.initialize();
    const id = await store1.write(makeEntry({ content: '原始内容' }));
    await store1.update(id, { content: '更新后内容', type: 'decision' });
    await store1.close();

    const store2 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'none',
    });
    await store2.initialize();
    const r = await store2.read(id);
    expect(r).not.toBeNull();
    expect(r!.content).toBe('更新后内容');
    expect(r!.type).toBe('decision');
    await store2.close();
  });

  it('7. flush 方法可调用且不抛错', async () => {
    const store = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    await store.initialize();
    await store.write(makeEntry({ content: 'flush 测试' }));
    await expect(store.flush()).resolves.toBeUndefined();
    await store.close();
  });

  it('8. 纯内存模式 close 后数据清空但无副作用', async () => {
    const store = new MemoryStore({
      enabled: true,
      dbPath: ':memory:',
      backend: 'sqlite',
      embeddingProvider: 'hash',
    });
    await store.initialize();
    await store.write(makeEntry({ content: '内存模式' }));
    expect(store.count()).toBe(1);
    await store.close();
    expect(store.count()).toBe(0);
  });

  it('9. topics 与 supersededAt 通过 metadata 列持久化', async () => {
    const store1 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'none',
    });
    await store1.initialize();
    const id = await store1.write(makeEntry({
      content: '带元数据的记忆',
      topics: ['ts', 'lang'],
      supersededAt: 12345,
    }));
    await store1.close();

    const store2 = new MemoryStore({
      enabled: true,
      dbPath,
      backend: 'sqlite',
      embeddingProvider: 'none',
    });
    await store2.initialize();
    const r = await store2.read(id);
    expect(r).not.toBeNull();
    expect(r!.topics).toEqual(['ts', 'lang']);
    expect(r!.supersededAt).toBe(12345);
    await store2.close();
  });
});

// tests/memory/unified-memory.test.ts
// 需求 2 测试：统一记忆接口 UnifiedMemoryStore

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { KnowledgeGraph } from '../../src/agent/memory/graph.js';
import {
  UnifiedMemoryStoreImpl,
  type MemoryEntry,
} from '../../src/memory/unified-memory.js';

function makeMemoryStore(): MemoryStore {
  return new MemoryStore({
    enabled: true,
    dbPath: ':memory:',
    backend: 'sqlite',
    embeddingProvider: 'none',
  });
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'test-id',
    type: 'fact',
    content: '测试内容',
    source: 'test',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('需求 2: UnifiedMemoryStore 统一记忆接口', () => {
  let store: MemoryStore;
  let graph: KnowledgeGraph;

  beforeEach(async () => {
    store = makeMemoryStore();
    await store.initialize();
    graph = new KnowledgeGraph();
  });

  describe('store', () => {
    it('1. store 同时写入 MemoryStore 和 KnowledgeGraph', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.store('key-1', makeEntry({
        id: 'key-1',
        content: 'PostgreSQL 主数据库',
        type: 'decision',
      }));

      // MemoryStore 应有
      const memEntry = await store.read('key-1');
      expect(memEntry).not.toBeNull();
      expect(memEntry!.content).toBe('PostgreSQL 主数据库');
      expect(memEntry!.type).toBe('decision');
      expect(memEntry!.validFrom).toBeGreaterThan(0);

      // KnowledgeGraph 应有
      const node = graph.getNode('key-1');
      expect(node).toBeDefined();
      expect(node!.content).toBe('PostgreSQL 主数据库');
      expect(node!.type).toBe('decision');
    });

    it('2. store 无 KnowledgeGraph 时只写 MemoryStore（fail-open）', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, null);
      await unified.store('key-2', makeEntry({ id: 'key-2', content: '无图模式' }));
      expect(await store.read('key-2')).not.toBeNull();
    });

    it('3. unified type 不匹配 MemoryStore 类型时降级为 topic', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.store('key-3', makeEntry({
        id: 'key-3',
        content: '未知类型',
        type: 'unknown_type',
      }));
      const memEntry = await store.read('key-3');
      expect(memEntry!.type).toBe('topic');
    });
  });

  describe('retrieve', () => {
    it('4. retrieve 从 MemoryStore 和 KnowledgeGraph 合并结果', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      // 写入 MemoryStore（通过 unified.store 同时进图）
      await unified.store('pg-1', makeEntry({
        id: 'pg-1',
        content: '使用 PostgreSQL 作为主数据库',
        type: 'decision',
      }));
      await unified.store('redis-1', makeEntry({
        id: 'redis-1',
        content: '使用 Redis 作为缓存层',
        type: 'decision',
      }));

      const results = await unified.retrieve('PostgreSQL');
      expect(results.length).toBeGreaterThan(0);
      // 应包含 PostgreSQL 条目
      const pgResult = results.find((r) => r.id === 'pg-1');
      expect(pgResult).toBeDefined();
      expect(pgResult!.content).toContain('PostgreSQL');
    });

    it('5. retrieve 去重（同 id 不重复出现）', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.store('dup-1', makeEntry({
        id: 'dup-1',
        content: 'PostgreSQL 配置连接池',
        type: 'fact',
      }));
      const results = await unified.retrieve('PostgreSQL');
      const ids = results.map((r) => r.id);
      const uniqueIds = [...new Set(ids)];
      expect(ids.length).toBe(uniqueIds.length);
    });

    it('6. retrieve 遵守 limit 参数', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.store('a-1', makeEntry({ id: 'a-1', content: 'PostgreSQL a', type: 'fact' }));
      await unified.store('a-2', makeEntry({ id: 'a-2', content: 'PostgreSQL b', type: 'fact' }));
      await unified.store('a-3', makeEntry({ id: 'a-3', content: 'PostgreSQL c', type: 'fact' }));
      const results = await unified.retrieve('PostgreSQL', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('7. retrieve includeGraph=false 时只查 MemoryStore', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      // 只写 KnowledgeGraph（通过 storeTo）
      await unified.storeTo('knowledge', 'graph-only', makeEntry({
        id: 'graph-only',
        content: '只在图里的记忆 PostgreSQL',
        type: 'decision',
      }));
      // includeGraph=false 应该查不到 graph-only
      const results = await unified.retrieve('PostgreSQL', { includeGraph: false });
      expect(results.find((r) => r.id === 'graph-only')).toBeUndefined();
      // includeGraph=true 应该查到
      const resultsWithGraph = await unified.retrieve('PostgreSQL', { includeGraph: true });
      expect(resultsWithGraph.find((r) => r.id === 'graph-only')).toBeDefined();
    });

    it('8. retrieve 空查询返回空', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.store('x-1', makeEntry({ id: 'x-1', content: 'some content' }));
      expect(await unified.retrieve('')).toEqual([]);
    });
  });

  describe('storeTo / retrieveFrom', () => {
    it('9. storeTo(memory) 只写 MemoryStore', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.storeTo('memory', 'mem-only', makeEntry({
        id: 'mem-only',
        content: '只在 MemoryStore',
      }));
      expect(await store.read('mem-only')).not.toBeNull();
      expect(graph.getNode('mem-only')).toBeUndefined();
    });

    it('10. storeTo(knowledge) 只写 KnowledgeGraph', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.storeTo('knowledge', 'graph-only-2', makeEntry({
        id: 'graph-only-2',
        content: '只在 KnowledgeGraph',
      }));
      expect(graph.getNode('graph-only-2')).toBeDefined();
      expect(await store.read('graph-only-2')).toBeNull();
    });

    it('11. storeTo(codebase) 是 no-op（只读索引）', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await expect(unified.storeTo('codebase', 'cb-key', makeEntry({ id: 'cb-key' })))
        .resolves.toBeUndefined();
    });

    it('12. retrieveFrom(memory) 只查 MemoryStore', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.storeTo('memory', 'mem-q', makeEntry({
        id: 'mem-q',
        content: 'memory 子系统查询目标',
      }));
      const results = await unified.retrieveFrom('memory', 'memory 子系统');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe('mem-q');
    });

    it('13. retrieveFrom(knowledge) 只查 KnowledgeGraph', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.storeTo('knowledge', 'graph-q', makeEntry({
        id: 'graph-q',
        content: 'knowledge 子系统查询目标',
        type: 'decision',
      }));
      const results = await unified.retrieveFrom('knowledge', 'knowledge 子系统');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe('graph-q');
      expect(results[0].source).toBe('knowledge');
    });

    it('14. retrieveFrom(codebase) 委托 CodebaseMemory（无实例时返回空）', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph, null);
      const results = await unified.retrieveFrom('codebase', 'anything');
      expect(results).toEqual([]);
    });
  });

  describe('delete', () => {
    it('15. delete 从 MemoryStore 硬删', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.store('del-1', makeEntry({ id: 'del-1', content: '待删除' }));
      expect(await store.read('del-1')).not.toBeNull();
      await unified.delete('del-1');
      expect(await store.read('del-1')).toBeNull();
    });

    it('16. delete 从 KnowledgeGraph 标记 deprecated', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.store('del-2', makeEntry({ id: 'del-2', content: '待遗忘的记忆' }));
      const nodeBefore = graph.getNode('del-2');
      expect(nodeBefore!.deprecated).toBe(false);
      await unified.delete('del-2');
      const nodeAfter = graph.getNode('del-2');
      expect(nodeAfter!.deprecated).toBe(true);
    });

    it('17. delete 不存在的 key 不抛错', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await expect(unified.delete('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('fail-open', () => {
    it('18. MemoryStore 故障不影响 KnowledgeGraph 操作', async () => {
      // 用一个 enabled=false 的 MemoryStore 模拟写入失败场景
      const disabledStore = new MemoryStore({
        enabled: false,
        dbPath: ':memory:',
        backend: 'sqlite',
        embeddingProvider: 'none',
      });
      await disabledStore.initialize();
      const unified = new UnifiedMemoryStoreImpl(disabledStore, graph);

      // store 不应抛错（MemoryStore enabled=false 返回空 id，但图应写入成功）
      await unified.store('fo-1', makeEntry({ id: 'fo-1', content: 'fail-open 测试' }));
      expect(graph.getNode('fo-1')).toBeDefined();
    });

    it('19. retrieve 时单子系统失败返回部分结果', async () => {
      const unified = new UnifiedMemoryStoreImpl(store, graph);
      await unified.storeTo('memory', 'fo-mem', makeEntry({
        id: 'fo-mem',
        content: 'memory 侧的数据 fail-open 测试',
      }));
      // 即使 KnowledgeGraph 无匹配，retrieve 也应返回 MemoryStore 的结果
      const results = await unified.retrieve('fail-open 测试');
      expect(results.length).toBeGreaterThan(0);
      expect(results.find((r) => r.id === 'fo-mem')).toBeDefined();
    });
  });
});

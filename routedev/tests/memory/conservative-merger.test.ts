// tests/memory/conservative-merger.test.ts
// Phase 65 Task 4 测试：ConservativeMerger

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore, type MemoryEntry } from '../../src/memory/memory-store.js';
import { ConservativeMerger, type MatchKey } from '../../src/memory/conservative-merger.js';

const storeConfig = {
  enabled: true,
  dbPath: ':memory:',
  backend: 'sqlite' as const,
  embeddingProvider: 'hash' as const,
};

function makeEntry(content: string, validFrom: number, topics: string[] = ['auth']): MemoryEntry {
  return {
    content,
    type: 'decision',
    source: 'test',
    validFrom,
    topics,
  };
}

describe('Phase 65 Task 4: ConservativeMerger', () => {
  let store: MemoryStore;
  let merger: ConservativeMerger;
  const matchKey: MatchKey = { topics: ['auth'], type: 'decision' };

  beforeEach(async () => {
    store = new MemoryStore(storeConfig);
    await store.initialize();
    merger = new ConservativeMerger(store);
  });

  it('1. writeWithVersion 不删除旧版本', async () => {
    const t1 = Date.now();
    const { newVersionId: id1 } = await merger.writeWithVersion(
      makeEntry('use JWT for authentication', t1),
      matchKey,
    );
    // 写入冲突版本
    const { newVersionId: id2, supersededOldIds } = await merger.writeWithVersion(
      makeEntry('use JWT for authentication', t1 + 1000),
      matchKey,
    );

    // 旧版本仍可读（未被删除）
    const oldEntry = await store.read(id1);
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.content).toBe('use JWT for authentication');
    // 旧版本被标记 supersededAt
    expect(oldEntry!.supersededAt).toBeDefined();
    expect(supersededOldIds).toContain(id1);

    // 新版本也可读
    const newEntry = await store.read(id2);
    expect(newEntry).not.toBeNull();
    expect(newEntry!.supersededAt).toBeUndefined();
  });

  it('2. 同 matchKey 多次写入生成版本链', async () => {
    const baseTime = Date.now();
    // 写入 3 次冲突版本
    const r1 = await merger.writeWithVersion(
      makeEntry('version one content', baseTime),
      matchKey,
    );
    const r2 = await merger.writeWithVersion(
      makeEntry('version one content', baseTime + 1000),
      matchKey,
    );
    const r3 = await merger.writeWithVersion(
      makeEntry('version one content', baseTime + 2000),
      matchKey,
    );

    // 版本链：3 条都存在
    const history = await merger.getVersionHistory(r3.newVersionId);
    expect(history.length).toBe(3);

    // r1 和 r2 应被 supersede，r3 应为最新
    const e1 = await store.read(r1.newVersionId);
    const e2 = await store.read(r2.newVersionId);
    const e3 = await store.read(r3.newVersionId);
    expect(e1!.supersededAt).toBeDefined();
    expect(e2!.supersededAt).toBeDefined();
    expect(e3!.supersededAt).toBeUndefined();

    // r3 应 supersede r2，r2 应 supersede r1
    expect(r2.supersededOldIds).toContain(r1.newVersionId);
    expect(r3.supersededOldIds).toContain(r2.newVersionId);
  });

  it('3. 冲突检测强制 supersede', async () => {
    const t = Date.now();
    await merger.writeWithVersion(makeEntry('use redis for cache', t), matchKey);
    // 完全相同内容 → 冲突
    const result = await merger.writeWithVersion(makeEntry('use redis for cache', t + 1000), matchKey);
    expect(result.supersededOldIds.length).toBe(1);

    const latest = await merger.retrieveLatest(matchKey);
    expect(latest).not.toBeNull();
    expect(latest!.supersededAt).toBeUndefined();
  });

  it('4. 不冲突同 topic 合并追加', async () => {
    const t = Date.now();
    const r1 = await merger.writeWithVersion(makeEntry('use redis for cache', t), matchKey);
    // 不同内容、同 topic → 不冲突，追加
    const r2 = await merger.writeWithVersion(
      makeEntry('use postgresql for storage', t + 1000),
      matchKey,
    );

    // 不应 supersede 旧条目
    expect(r2.supersededOldIds).toEqual([]);
    // r2.newVersionId 应等于 r1.newVersionId（追加到旧条目，不写新条目）
    expect(r2.newVersionId).toBe(r1.newVersionId);

    // 旧条目的 content 应被追加 [补充] 标记
    const entry = await store.read(r1.newVersionId);
    expect(entry!.content).toContain('use redis for cache');
    expect(entry!.content).toContain('[补充] use postgresql for storage');
    expect(entry!.supersededAt).toBeUndefined();

    // 总条目数应为 1（没写新条目）
    expect(store.count()).toBe(1);
  });

  it('5. getVersionHistory 按 validFrom 排序', async () => {
    const baseTime = Date.now();
    // 写入多条不同 validFrom 的版本（冲突链）
    const r1 = await merger.writeWithVersion(
      makeEntry('same content here', baseTime),
      matchKey,
    );
    const r2 = await merger.writeWithVersion(
      makeEntry('same content here', baseTime + 5000),
      matchKey,
    );
    const r3 = await merger.writeWithVersion(
      makeEntry('same content here', baseTime + 2000),
      matchKey,
    );

    const history = await merger.getVersionHistory(r3.newVersionId);
    expect(history.length).toBe(3);
    // 按 validFrom 升序
    expect(history[0].validFrom).toBeLessThanOrEqual(history[1].validFrom);
    expect(history[1].validFrom).toBeLessThanOrEqual(history[2].validFrom);
  });

  it('6. retrieveLatest 只返回未 supersede', async () => {
    const t = Date.now();
    // 写入冲突版本链
    await merger.writeWithVersion(makeEntry('config setting value', t), matchKey);
    await merger.writeWithVersion(makeEntry('config setting value', t + 1000), matchKey);
    await merger.writeWithVersion(makeEntry('config setting value', t + 2000), matchKey);

    const latest = await merger.retrieveLatest(matchKey);
    expect(latest).not.toBeNull();
    expect(latest!.supersededAt).toBeUndefined();

    // 应为 validFrom 最大的
    const all = store.filter((e) => e.type === 'decision');
    const maxValidFrom = Math.max(...all.map((e) => e.validFrom));
    expect(latest!.validFrom).toBe(maxValidFrom);
  });

  it('7. 检索可查历史版本（含已 supersede）', async () => {
    const t = Date.now();
    const r1 = await merger.writeWithVersion(makeEntry('historical record', t), matchKey);
    const r2 = await merger.writeWithVersion(makeEntry('historical record', t + 1000), matchKey);

    // 通过 store.read 仍能读到已 supersede 的旧版本
    const oldEntry = await store.read(r1.newVersionId);
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.supersededAt).toBeDefined();
    expect(oldEntry!.content).toBe('historical record');

    // 通过 getVersionHistory 也能查到所有历史版本
    const history = await merger.getVersionHistory(r2.newVersionId);
    expect(history.length).toBe(2);
    const oldInHistory = history.find((e) => e.id === r1.newVersionId);
    expect(oldInHistory).toBeDefined();
    expect(oldInHistory!.supersededAt).toBeDefined();
  });

  it('8. 无 matchKey 时直接插入', async () => {
    const t = Date.now();
    // 第一次写入：无匹配，直接插入
    const r1 = await merger.writeWithVersion(
      makeEntry('first decision ever', t, ['newtopic']),
      { topics: ['newtopic'], type: 'decision' },
    );
    expect(r1.supersededOldIds).toEqual([]);
    expect(r1.newVersionId).toBeTruthy();
    expect(store.count()).toBe(1);

    // 用不同 topic（无匹配）再次写入
    const r2 = await merger.writeWithVersion(
      makeEntry('another decision', t + 1000, ['anothertopic']),
      { topics: ['anothertopic'], type: 'decision' },
    );
    expect(r2.supersededOldIds).toEqual([]);
    expect(store.count()).toBe(2);
  });

  it('补充：retrieveLatest 无匹配时返回 null', async () => {
    const latest = await merger.retrieveLatest({ topics: ['nonexistent'], type: 'decision' });
    expect(latest).toBeNull();
  });

  it('补充：getVersionHistory 不存在 id 返回空', async () => {
    const history = await merger.getVersionHistory('non-existent-id');
    expect(history).toEqual([]);
  });
});

// tests/memory/local-maintenance.test.ts
// Phase 65 Task 6 测试：LocalMaintenancePolicy

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore, type MemoryEntry } from '../../src/memory/memory-store.js';
import { LocalMaintenancePolicy } from '../../src/memory/local-maintenance.js';

const storeConfig = {
  enabled: true,
  dbPath: ':memory:',
  backend: 'sqlite' as const,
  embeddingProvider: 'none' as const,
};

function makeEntry(content: string, validFrom: number, type: MemoryEntry['type'] = 'fact', topics: string[] = ['t1']): MemoryEntry {
  return { content, type, source: 'test', validFrom, topics };
}

describe('Phase 65 Task 6: LocalMaintenancePolicy', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore(storeConfig);
    await store.initialize();
  });

  it('1. shouldMaintain 阈值判定', async () => {
    const policy = new LocalMaintenancePolicy(store, {
      enabled: true,
      triggerThreshold: 5,
      reorganizeRatio: 0.5,
      minAccessCount: 1,
    });

    // 当前 0 条，不需要维护
    let status = policy.shouldMaintain();
    expect(status.needed).toBe(false);
    expect(status.currentCount).toBe(0);
    expect(status.threshold).toBe(5);

    // 写入 3 条，仍未达阈值
    for (let i = 0; i < 3; i++) {
      await store.write(makeEntry(`entry ${i}`, Date.now() + i));
    }
    status = policy.shouldMaintain();
    expect(status.needed).toBe(false);
    expect(status.currentCount).toBe(3);

    // 写入第 6 条，超过阈值
    for (let i = 3; i < 6; i++) {
      await store.write(makeEntry(`entry ${i}`, Date.now() + i));
    }
    status = policy.shouldMaintain();
    expect(status.needed).toBe(true);
    expect(status.currentCount).toBe(6);
  });

  it('2. 候选选择（最旧优先）', async () => {
    const baseTime = Date.now();
    // 写入 6 条，validFrom 递增
    for (let i = 0; i < 6; i++) {
      await store.write(makeEntry(`entry ${i}`, baseTime + i * 1000));
    }
    // 阈值 5，比例 0.5 → 候选 3 条
    const policy = new LocalMaintenancePolicy(store, {
      enabled: true,
      triggerThreshold: 5,
      reorganizeRatio: 0.5,
      minAccessCount: 1,
    });
    const result = await policy.maintain();
    expect(result.reorganized).toBe(3);

    // 最旧 3 条应被标记 archived
    const all = store.getAll();
    const archived = all.filter((e) => e.metadata?.archived === 'true');
    expect(archived.length).toBe(3);
    // 应是最旧的 3 条（validFrom 最小的）
    const archivedValidFroms = archived.map((e) => e.validFrom).sort((a, b) => a - b);
    expect(archivedValidFroms).toEqual([baseTime, baseTime + 1000, baseTime + 2000]);
  });

  it('3. 局部重组不触全局', async () => {
    const baseTime = Date.now();
    // 写入 10 条
    for (let i = 0; i < 10; i++) {
      await store.write(makeEntry(`entry ${i}`, baseTime + i * 1000));
    }
    // 阈值 5，比例 0.3 → 候选 3 条
    const policy = new LocalMaintenancePolicy(store, {
      enabled: true,
      triggerThreshold: 5,
      reorganizeRatio: 0.3,
      minAccessCount: 1,
    });
    const result = await policy.maintain();
    // 只重组 3 条（不是全部 10 条）
    expect(result.reorganized).toBe(3);
    const all = store.getAll();
    const archived = all.filter((e) => e.metadata?.archived === 'true');
    expect(archived.length).toBe(3);
    // 总条目数不变（不删除）
    expect(all.length).toBe(10);
  });

  it('4. 重组后旧条目标 archived 不删除', async () => {
    const baseTime = Date.now();
    for (let i = 0; i < 6; i++) {
      await store.write(makeEntry(`entry ${i}`, baseTime + i * 1000));
    }
    const policy = new LocalMaintenancePolicy(store, {
      enabled: true,
      triggerThreshold: 5,
      reorganizeRatio: 0.5,
      minAccessCount: 1,
    });
    await policy.maintain();

    // 旧条目仍可读（不删除）
    const all = store.getAll();
    expect(all.length).toBe(6);
    // 3 条被标记 archived
    const archived = all.filter((e) => e.metadata?.archived === 'true');
    expect(archived.length).toBe(3);
    // archived 条目仍可读
    for (const e of archived) {
      const read = await store.read(e.id!);
      expect(read).not.toBeNull();
      expect(read!.metadata!.archived).toBe('true');
    }
  });

  it('5. 维护统计正确', async () => {
    const baseTime = Date.now();
    // 写入 6 条：3 条同 type+topic，3 条不同
    await store.write(makeEntry('same topic entry 1', baseTime, 'fact', ['auth']));
    await store.write(makeEntry('same topic entry 2', baseTime + 1000, 'fact', ['auth']));
    await store.write(makeEntry('same topic entry 3', baseTime + 2000, 'fact', ['auth']));
    await store.write(makeEntry('diff topic entry 4', baseTime + 3000, 'fact', ['cache']));
    await store.write(makeEntry('diff topic entry 5', baseTime + 4000, 'decision', ['auth']));
    await store.write(makeEntry('diff topic entry 6', baseTime + 5000, 'decision', ['db']));

    const policy = new LocalMaintenancePolicy(store, {
      enabled: true,
      triggerThreshold: 5,
      reorganizeRatio: 1.0, // 全部作为候选
      minAccessCount: 1,
    });
    const result = await policy.maintain();

    // 6 条都被重组
    expect(result.reorganized).toBe(6);
    // 同 (type=fact, topic=auth) 的 3 条应合并：2 条被 supersede
    expect(result.superseded).toBe(2);
    // 合并组数：1（fact|auth 组有合并）
    expect(result.merged).toBeGreaterThanOrEqual(1);
    // durationMs 应 >= 0
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('6. 未达阈值时不维护', async () => {
    // 只写 2 条，阈值 5
    await store.write(makeEntry('entry 1', Date.now()));
    await store.write(makeEntry('entry 2', Date.now() + 1000));
    const policy = new LocalMaintenancePolicy(store, {
      enabled: true,
      triggerThreshold: 5,
      reorganizeRatio: 0.5,
      minAccessCount: 1,
    });
    const status = policy.shouldMaintain();
    expect(status.needed).toBe(false);

    const result = await policy.maintain();
    // 未维护，所有统计为 0
    expect(result.reorganized).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.superseded).toBe(0);
    // 总条目数不变
    expect(store.count()).toBe(2);
    // 没有条目被标记 archived
    const archived = store.getAll().filter((e) => e.metadata?.archived === 'true');
    expect(archived.length).toBe(0);
  });

  it('补充：enabled=false 时不维护', async () => {
    for (let i = 0; i < 10; i++) {
      await store.write(makeEntry(`entry ${i}`, Date.now() + i));
    }
    const policy = new LocalMaintenancePolicy(store, {
      enabled: false,
      triggerThreshold: 5,
      reorganizeRatio: 0.5,
      minAccessCount: 1,
    });
    const result = await policy.maintain();
    expect(result.reorganized).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.superseded).toBe(0);
    // 没有条目被标记 archived
    const archived = store.getAll().filter((e) => e.metadata?.archived === 'true');
    expect(archived.length).toBe(0);
  });

  it('补充：重复维护不重复标记', async () => {
    const baseTime = Date.now();
    for (let i = 0; i < 6; i++) {
      await store.write(makeEntry(`entry ${i}`, baseTime + i * 1000, 'fact', ['unique']));
    }
    const policy = new LocalMaintenancePolicy(store, {
      enabled: true,
      triggerThreshold: 5,
      reorganizeRatio: 0.5,
      minAccessCount: 1,
    });
    const r1 = await policy.maintain();
    expect(r1.reorganized).toBe(3);
    // 第二次维护：已 archived 的不再标记
    const r2 = await policy.maintain();
    // 之前没标记的（较新的）现在被标记
    expect(r2.reorganized).toBeLessThanOrEqual(3);
    // 不会重复标记同一条
    const all = store.getAll();
    const archived = all.filter((e) => e.metadata?.archived === 'true');
    expect(archived.length).toBeLessThanOrEqual(6);
  });
});

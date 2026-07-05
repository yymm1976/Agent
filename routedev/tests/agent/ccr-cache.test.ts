import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CCRCache } from '../../src/agent/ccr-cache.js';
import type { LLMMessage } from '../../src/router/types.js';

/** 构造测试用临时 db 路径，避免污染 ~/.routedev/ccr.db */
function makeTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-ccr-test-'));
  return path.join(dir, 'ccr.db');
}

describe('CCRCache', () => {
  let dbPath: string;
  let cache: CCRCache;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    cache = new CCRCache(50, dbPath);
  });

  afterEach(() => {
    cache.close();
    // 清理临时目录
    const dir = path.dirname(dbPath);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  it('store/retrieve 保持原始 messages 可逆', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '原始工具输出', isError: false }] },
    ];

    const record = cache.store(messages);
    messages[1].content = 'mutated';
    const restored = cache.retrieve(record.hash);

    expect(restored).not.toBeNull();
    expect(restored?.[1].content).toEqual([{ type: 'tool_result', toolUseId: 't1', content: '原始工具输出', isError: false }]);
  });

  it('buildMarker 生成可读检索标记', () => {
    const marker = cache.buildMarker('abcdef1234567890', 10, 3);

    expect(marker.marker).toContain('CCR:abcdef123456');
    expect(marker.originalCount).toBe(10);
    expect(marker.compactedCount).toBe(3);
  });
});

// ============================================================
// Phase 60：CCRCache 边界测试补强
// ============================================================

describe('Phase 60: CCRCache 边界测试', () => {
  let dbPath: string;
  let cache: CCRCache;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    cache = new CCRCache(50, dbPath);
  });

  afterEach(() => {
    cache.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  /** 构造测试消息 */
  function makeMessages(tag: string): LLMMessage[] {
    return [
      { role: 'system', content: `sys-${tag}` },
      { role: 'user', content: `user-${tag}` },
    ];
  }

  it('超过 maxSize 时 LRU 淘汰最早记录', () => {
    // maxSize=2，存 3 个，第 1 个应被淘汰
    const smallCache = new CCRCache(2, dbPath);
    try {
      const r1 = smallCache.store(makeMessages('a'));
      const r2 = smallCache.store(makeMessages('b'));
      const r3 = smallCache.store(makeMessages('c'));

      // r1 被淘汰
      expect(smallCache.retrieve(r1.hash)).toBeNull();
      // r2/r3 仍在
      expect(smallCache.retrieve(r2.hash)).not.toBeNull();
      expect(smallCache.retrieve(r3.hash)).not.toBeNull();
    } finally {
      smallCache.close();
    }
  });

  it('retrieve 不存在的 hash 返回 null', () => {
    const cache2 = new CCRCache(50, dbPath);
    try {
      expect(cache2.retrieve('nonexistent-hash-0000000000000000000000000000000000000000000000000000000000000000')).toBeNull();
    } finally {
      cache2.close();
    }
  });

  it('retrieveByPrefix 传入完整 hash 能取回（精确 hash 也能通过前缀匹配）', () => {
    const record = cache.store(makeMessages('exact'));
    // 传入完整 hash 作为前缀，应能取回
    const restored = cache.retrieveByPrefix(record.hash);
    expect(restored).not.toBeNull();
    expect(restored?.[0].content).toBe('sys-exact');
  });

  it('retrieveByPrefix 传入 12 位前缀（marker 中的前缀长度）能取回', () => {
    const record = cache.store(makeMessages('prefix12'));
    const marker = cache.buildMarker(record.hash, 2, 1);
    // marker 中只有 12 位前缀
    const prefix = record.hash.slice(0, 12);
    expect(marker.marker).toContain(`CCR:${prefix}`);
    const restored = cache.retrieveByPrefix(prefix);
    expect(restored).not.toBeNull();
    expect(restored?.[0].content).toBe('sys-prefix12');
  });

  it('retrieveByPrefix 不匹配的前缀返回 null', () => {
    cache.store(makeMessages('x'));
    expect(cache.retrieveByPrefix('zzzzzzzzzzzz')).toBeNull();
  });
});

// ============================================================
// Phase 72 Task B3：SQLite 持久化测试
// ============================================================

describe('Phase 72 Task B3: CCRCache SQLite 持久化', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  it('SQLite 持久化：新实例能读取旧实例写入的记录', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'persistent-message' },
    ];

    // 第一个实例写入
    const cache1 = new CCRCache(50, dbPath);
    const record = cache1.store(messages);
    cache1.close();

    // 第二个实例（同 db 路径）应能读出
    const cache2 = new CCRCache(50, dbPath);
    try {
      const restored = cache2.retrieve(record.hash);
      expect(restored).not.toBeNull();
      expect(restored?.[0].content).toBe('persistent-message');
    } finally {
      cache2.close();
    }
  });

  it('SQLite 持久化：retrieveByPrefix 跨实例工作', () => {
    const cache1 = new CCRCache(50, dbPath);
    const record = cache1.store([
      { role: 'system', content: 'cross-instance' },
    ]);
    const prefix = record.hash.slice(0, 12);
    cache1.close();

    const cache2 = new CCRCache(50, dbPath);
    try {
      const restored = cache2.retrieveByPrefix(prefix);
      expect(restored).not.toBeNull();
      expect(restored?.[0].content).toBe('cross-instance');
    } finally {
      cache2.close();
    }
  });

  it('SQLite LRU 淘汰：跨实例持久化的记录也受 maxSize 限制', () => {
    const cache1 = new CCRCache(2, dbPath);
    const r1 = cache1.store([{ role: 'user', content: 'a' }]);
    const r2 = cache1.store([{ role: 'user', content: 'b' }]);
    cache1.close();

    const cache2 = new CCRCache(2, dbPath);
    try {
      // 在 cache2 中存第 3 条，应淘汰 r1（最早 created_at）
      const r3 = cache2.store([{ role: 'user', content: 'c' }]);
      expect(cache2.retrieve(r1.hash)).toBeNull();
      expect(cache2.retrieve(r2.hash)).not.toBeNull();
      expect(cache2.retrieve(r3.hash)).not.toBeNull();
    } finally {
      cache2.close();
    }
  });
});

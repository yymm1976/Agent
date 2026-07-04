import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionMemoryStore,
  type SessionMemory,
} from '../../../src/agent/memory/session-memory-store.js';

function makeMemory(overrides: Partial<SessionMemory> = {}): SessionMemory {
  return {
    sessionId: 'session-1',
    summary: 'Implemented authentication module',
    keyDecisions: ['Use JWT for tokens'],
    involvedFiles: ['src/auth.ts'],
    errorsAndFixes: [{ error: 'TypeError', fix: 'Added null check' }],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

/** 创建临时目录用于持久化测试 */
function makeTmpDir(prefix = 'routedev-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('SessionMemoryStore', () => {
  let store: SessionMemoryStore;

  beforeEach(() => {
    store = new SessionMemoryStore();
  });

  describe('save + get', () => {
    it('saves and retrieves a memory by sessionId', () => {
      const mem = makeMemory();
      store.save(mem);
      expect(store.get('session-1')).toEqual(mem);
    });

    it('returns undefined for unknown sessionId', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing memory with same sessionId', () => {
      store.save(makeMemory({ summary: 'first' }));
      store.save(makeMemory({ summary: 'second' }));
      expect(store.get('session-1')!.summary).toBe('second');
    });
  });

  describe('query', () => {
    it('returns matching memories by keyword in summary', () => {
      store.save(makeMemory({ sessionId: 's1', summary: 'Build authentication system' }));
      store.save(makeMemory({ sessionId: 's2', summary: 'Implement caching layer' }));
      const results = store.query('authentication');
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('s1');
    });

    it('returns matching memories by keyword in keyDecisions', () => {
      store.save(makeMemory({ sessionId: 's1', keyDecisions: ['Use Redis for caching'] }));
      const results = store.query('redis');
      expect(results).toHaveLength(1);
    });

    it('returns empty array when no match', () => {
      store.save(makeMemory({ summary: 'Build UI components' }));
      const results = store.query('blockchain');
      expect(results).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      store.save(makeMemory({ sessionId: 's1', summary: 'auth module' }));
      store.save(makeMemory({ sessionId: 's2', summary: 'auth service' }));
      store.save(makeMemory({ sessionId: 's3', summary: 'auth controller' }));
      const results = store.query('auth', 2);
      expect(results).toHaveLength(2);
    });

    it('scores exact phrase match higher than partial word match', () => {
      store.save(makeMemory({ sessionId: 's1', summary: 'authentication module' }));
      store.save(makeMemory({ sessionId: 's2', summary: 'auth helper' }));
      const results = store.query('authentication module');
      expect(results[0].sessionId).toBe('s1');
    });
  });

  describe('getRecent', () => {
    it('returns memories sorted by updatedAt descending', () => {
      store.save(makeMemory({ sessionId: 's1', updatedAt: 1000 }));
      store.save(makeMemory({ sessionId: 's2', updatedAt: 3000 }));
      store.save(makeMemory({ sessionId: 's3', updatedAt: 2000 }));
      const recent = store.getRecent();
      expect(recent[0].sessionId).toBe('s2');
      expect(recent[1].sessionId).toBe('s3');
      expect(recent[2].sessionId).toBe('s1');
    });

    it('respects limit', () => {
      store.save(makeMemory({ sessionId: 's1', updatedAt: 1000 }));
      store.save(makeMemory({ sessionId: 's2', updatedAt: 2000 }));
      store.save(makeMemory({ sessionId: 's3', updatedAt: 3000 }));
      expect(store.getRecent(2)).toHaveLength(2);
    });
  });

  describe('size', () => {
    it('returns 0 for empty store', () => {
      expect(store.size()).toBe(0);
    });

    it('returns correct count after saves', () => {
      store.save(makeMemory({ sessionId: 's1' }));
      store.save(makeMemory({ sessionId: 's2' }));
      expect(store.size()).toBe(2);
    });
  });

  describe('serialize + deserialize', () => {
    it('roundtrips data correctly', () => {
      const mem1 = makeMemory({ sessionId: 's1', summary: 'first session' });
      const mem2 = makeMemory({ sessionId: 's2', summary: 'second session', updatedAt: 5000 });
      store.save(mem1);
      store.save(mem2);

      const json = store.serialize();
      const store2 = new SessionMemoryStore();
      store2.deserialize(json);

      expect(store2.size()).toBe(2);
      expect(store2.get('s1')!.summary).toBe('first session');
      expect(store2.get('s2')!.summary).toBe('second session');
    });

    it('clears existing data before deserializing', () => {
      store.save(makeMemory({ sessionId: 'old' }));
      const json = JSON.stringify([makeMemory({ sessionId: 'new' })]);
      store.deserialize(json);
      expect(store.get('old')).toBeUndefined();
      expect(store.get('new')).toBeDefined();
    });
  });

  describe('deserialize handles corrupted data', () => {
    it('silently ignores invalid JSON without clearing existing data', () => {
      store.save(makeMemory({ sessionId: 's1' }));
      store.deserialize('not valid json {{{');
      expect(store.size()).toBe(1);
      expect(store.get('s1')).toBeDefined();
    });

    it('silently ignores non-array JSON', () => {
      store.save(makeMemory({ sessionId: 's1' }));
      store.deserialize('{"foo": "bar"}');
      expect(store.size()).toBe(0);
    });
  });

  // ===== 持久化测试（跨会话 JSONL 落盘） =====
  describe('persistence (JSONL)', () => {
    let tmpDir: string;
    let persistPath: string;

    beforeEach(() => {
      tmpDir = makeTmpDir();
      persistPath = join(tmpDir, 'session-memory.jsonl');
    });

    afterEach(() => {
      // 清理临时目录，避免污染后续测试
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    });

    it('纯内存模式（不传 persistentPath）不写文件', async () => {
      const memStore = new SessionMemoryStore(100);
      memStore.save(makeMemory({ sessionId: 's1' }));
      // 等待可能的 debounce
      await new Promise((r) => setTimeout(r, 600));
      expect(existsSync(persistPath)).toBe(false);
    });

    it('构造时自动加载已持久化的 JSONL 文件', async () => {
      // 预写一条 JSONL 数据
      const mem = makeMemory({ sessionId: 'persisted-1', summary: 'pre-existing memory' });
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(persistPath, JSON.stringify(mem) + '\n', 'utf-8');

      const store = new SessionMemoryStore(100, persistPath);
      // 等待构造时的异步 loadFromFile 完成
      await new Promise((r) => setTimeout(r, 50));

      const loaded = store.get('persisted-1');
      expect(loaded).toBeDefined();
      expect(loaded!.summary).toBe('pre-existing memory');
    });

    it('save 后 debounce 500ms 异步落盘', async () => {
      const store = new SessionMemoryStore(100, persistPath);
      // 等待构造时 loadFromFile 完成（文件不存在，静默跳过）
      await new Promise((r) => setTimeout(r, 50));

      store.save(makeMemory({ sessionId: 's1', summary: 'first save' }));
      // 立即检查：debounce 尚未触发，文件不应存在
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(persistPath)).toBe(false);

      // 等待 debounce 500ms 触发
      await new Promise((r) => setTimeout(r, 600));
      expect(existsSync(persistPath)).toBe(true);

      // 验证文件内容为 JSONL 格式（每行一个 SessionMemory）
      const content = readFileSync(persistPath, 'utf-8').trim();
      const lines = content.split('\n');
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]) as SessionMemory;
      expect(parsed.sessionId).toBe('s1');
      expect(parsed.summary).toBe('first save');
    });

    it('close() 立即 flush 取消 pending debounce', async () => {
      const store = new SessionMemoryStore(100, persistPath);
      await new Promise((r) => setTimeout(r, 50));

      store.save(makeMemory({ sessionId: 's1', summary: 'before close' }));
      // 不等 debounce，直接 close
      await store.close();

      expect(existsSync(persistPath)).toBe(true);
      const content = readFileSync(persistPath, 'utf-8').trim();
      const parsed = JSON.parse(content) as SessionMemory;
      expect(parsed.sessionId).toBe('s1');
    });

    it('跨会话恢复：close → 重新构造 → 自动加载', async () => {
      // 会话 1：保存并 close
      const store1 = new SessionMemoryStore(100, persistPath);
      await new Promise((r) => setTimeout(r, 50));
      store1.save(makeMemory({ sessionId: 'session-a', summary: 'auth module' }));
      store1.save(makeMemory({ sessionId: 'session-b', summary: 'cache layer' }));
      await store1.close();

      // 会话 2：重新构造，应自动加载会话 1 持久化的数据
      const store2 = new SessionMemoryStore(100, persistPath);
      await new Promise((r) => setTimeout(r, 50));

      expect(store2.size()).toBe(2);
      expect(store2.get('session-a')!.summary).toBe('auth module');
      expect(store2.get('session-b')!.summary).toBe('cache layer');
    });

    it('损坏的 JSONL 行被静默跳过（fail-open）', async () => {
      mkdirSync(tmpDir, { recursive: true });
      const validLine = JSON.stringify(makeMemory({ sessionId: 'valid-1' }));
      const corruptLine = '{ this is not valid json }}}';
      writeFileSync(persistPath, validLine + '\n' + corruptLine + '\n', 'utf-8');

      const store = new SessionMemoryStore(100, persistPath);
      await new Promise((r) => setTimeout(r, 50));

      expect(store.get('valid-1')).toBeDefined();
      expect(store.size()).toBe(1);
    });

    it('文件不存在时构造不抛错（fail-open）', async () => {
      const nonExistentPath = join(tmpDir, 'nonexistent', 'memory.jsonl');
      const store = new SessionMemoryStore(100, nonExistentPath);
      await new Promise((r) => setTimeout(r, 50));
      expect(store.size()).toBe(0);
    });

    it('多次 save 在 debounce 窗口内只触发一次落盘', async () => {
      const store = new SessionMemoryStore(100, persistPath);
      await new Promise((r) => setTimeout(r, 50));

      // 连续 save 5 次
      for (let i = 0; i < 5; i++) {
        store.save(makeMemory({ sessionId: `s${i}`, summary: `save ${i}` }));
      }
      // 等待 debounce 完成
      await new Promise((r) => setTimeout(r, 600));

      expect(existsSync(persistPath)).toBe(true);
      const lines = readFileSync(persistPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(5);
    });
  });
});

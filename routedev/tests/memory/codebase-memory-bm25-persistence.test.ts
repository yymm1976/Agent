// tests/memory/codebase-memory-bm25-persistence.test.ts
// 需求 3 测试：CodebaseMemory BM25 索引 JSON 持久化

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodebaseMemory } from '../../src/memory/codebase-memory.js';

function makeTmpDir(prefix = 'routedev-cb-bm25-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('需求 3: CodebaseMemory BM25 索引持久化', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = tmpDir; // dbPath 作为工作目录，BM25 文件派生到 {dbPath}/.routedev/memory/codebase-bm25.json
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  it('1. 传入 dbPath 启用 BM25 持久化模式', async () => {
    const mem = new CodebaseMemory(tmpDir, { dbPath });
    expect(mem.isBm25Persistent()).toBe(true);
  });

  it('2. 不传 dbPath 时纯内存模式（向后兼容）', async () => {
    const mem = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'idx.json') });
    expect(mem.isBm25Persistent()).toBe(false);
  });

  it('3. scan 后生成 BM25 索引快照 JSON 文件', async () => {
    writeFileSync(join(tmpDir, 'auth.ts'), '// auth module\nexport class AuthService {}', 'utf-8');
    writeFileSync(join(tmpDir, 'cache.ts'), '// cache layer\nexport class CacheService {}', 'utf-8');

    const mem = new CodebaseMemory(tmpDir, { dbPath });
    await mem.scan();

    const bm25Path = join(dbPath, '.routedev', 'memory', 'codebase-bm25.json');
    expect(existsSync(bm25Path)).toBe(true);
    const payload = JSON.parse(readFileSync(bm25Path, 'utf-8'));
    expect(payload.version).toBe(1);
    expect(Array.isArray(payload.docs)).toBe(true);
    expect(payload.docs.length).toBe(2);
    const ids = payload.docs.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual(['auth.ts', 'cache.ts']);
  });

  it('4. BM25 快照跨会话恢复（不重新 scan 也能 query）', async () => {
    writeFileSync(join(tmpDir, 'auth.ts'), '// auth module\nexport class AuthService {}', 'utf-8');

    // 会话 1：扫描生成 BM25 快照
    const mem1 = new CodebaseMemory(tmpDir, { dbPath });
    await mem1.scan();
    expect(mem1.size()).toBe(1);

    // 会话 2：重新构造，仅从 BM25 快照恢复（不调用 scan）
    // 使用独立的 entries 持久化路径避免冲突，让 BM25 快照作为兜底数据源
    const mem2 = new CodebaseMemory(tmpDir, {
      dbPath,
      persistPath: join(tmpDir, 'nonexistent', 'idx.json'), // entries 文件不存在，触发 BM25 兜底
    });
    // 等待异步加载完成
    await new Promise((r) => setTimeout(r, 100));
    expect(mem2.size()).toBe(1);
    expect(mem2.get('auth.ts')).toBeDefined();
  });

  it('5. flush 显式落盘生成 BM25 快照', async () => {
    writeFileSync(join(tmpDir, 'feature.ts'), '// feature\nexport const f = 1;', 'utf-8');
    const mem = new CodebaseMemory(tmpDir, { dbPath, persistPath: join(tmpDir, 'idx.json') });
    await mem.scan();

    // 删除 BM25 文件后调 flush 应重新生成
    const bm25Path = join(dbPath, '.routedev', 'memory', 'codebase-bm25.json');
    rmSync(bm25Path, { force: true });
    expect(existsSync(bm25Path)).toBe(false);

    await mem.flush();
    expect(existsSync(bm25Path)).toBe(true);
  });

  it('6. 显式 bm25PersistPath 优先于 dbPath 派生', async () => {
    const explicitPath = join(tmpDir, 'custom-bm25.json');
    writeFileSync(join(tmpDir, 'a.ts'), 'export const a = 1;', 'utf-8');
    const mem = new CodebaseMemory(tmpDir, {
      dbPath,
      bm25PersistPath: explicitPath,
      persistPath: join(tmpDir, 'idx.json'),
    });
    await mem.scan();
    expect(existsSync(explicitPath)).toBe(true);
    // 派生路径不应被创建
    const derivedPath = join(dbPath, '.routedev', 'memory', 'codebase-bm25.json');
    expect(existsSync(derivedPath)).toBe(false);
  });

  it('7. 不传 dbPath 时不生成 BM25 快照文件', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'export const a = 1;', 'utf-8');
    const mem = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'idx.json') });
    await mem.scan();
    const bm25Path = join(dbPath, '.routedev', 'memory', 'codebase-bm25.json');
    expect(existsSync(bm25Path)).toBe(false);
  });

  it('8. BM25 快照损坏时静默跳过（fail-open）', async () => {
    const bm25Path = join(dbPath, '.routedev', 'memory', 'codebase-bm25.json');
    mkdirSync(join(dbPath, '.routedev', 'memory'), { recursive: true });
    writeFileSync(bm25Path, '{ invalid json !!!', 'utf-8');

    // 构造不应抛错
    const mem = new CodebaseMemory(tmpDir, {
      dbPath,
      persistPath: join(tmpDir, 'nonexistent', 'idx.json'),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(mem.size()).toBe(0); // 损坏文件被跳过，entries 为空
  });
});

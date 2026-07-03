// tests/code-map/content-hash.test.ts
// Phase 71 Task A5：content hash 缓存测试
// 验证 indexFile 的 hash 比对逻辑 + getFileContentHash/setFileContentHash 读写

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initParser } from '../../src/code-map/parser.js';
import {
  initDatabase,
  getFileContentHash,
  setFileContentHash,
  insertFile,
  close,
  type DB,
} from '../../src/code-map/database.js';
import {
  indexFile,
  computeContentHash,
  getChangedFilesSinceRank,
  clearChangedFilesSinceRank,
} from '../../src/code-map/indexer.js';
import type { CodeMapFile } from '../../src/code-map/schema.js';

let tempDir: string;
let dbPath: string;
let db: DB;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'content-hash-test-'));
  dbPath = path.join(tempDir, '.routedev', 'code-map', 'code-map.db');
  await initParser();
  db = initDatabase(dbPath);
});

afterEach(async () => {
  try { close(db); } catch { /* ignore */ }
  await fsp.rm(tempDir, { recursive: true, force: true });
});

/** 辅助：写入文件并返回绝对路径 */
async function writeFile(relPath: string, content: string): Promise<string> {
  const fullPath = path.join(tempDir, relPath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

describe('content hash 缓存', () => {
  // 1. hash 相同跳过重新解析
  it('hash 相同时跳过重新解析（skipped=true）', async () => {
    const code = `function greet(name: string): string { return 'hello'; }\n`;
    const filePath = await writeFile('src/a.ts', code);

    // 首次索引
    const result1 = await indexFile(db, tempDir, filePath);
    expect(result1.skipped).toBe(false);
    expect(result1.nodeCount).toBeGreaterThan(0);

    // 清空变更集（模拟 PageRank 已消费）
    clearChangedFilesSinceRank(db);

    // 二次索引：内容未变，hash 相同，应跳过
    const result2 = await indexFile(db, tempDir, filePath);
    expect(result2.skipped).toBe(true);
    expect(result2.nodeCount).toBe(0);
  });

  // 2. hash 不同重新解析
  it('hash 不同时重新解析（skipped=false）', async () => {
    const code1 = `function greet(name: string): string { return 'hello'; }\n`;
    const filePath = await writeFile('src/b.ts', code1);

    // 首次索引
    const result1 = await indexFile(db, tempDir, filePath);
    expect(result1.skipped).toBe(false);
    clearChangedFilesSinceRank(db);

    // 修改文件内容
    const code2 = `function greet(name: string): string { return 'hi'; }\nfunction farewell(): void {}\n`;
    await fsp.writeFile(filePath, code2, 'utf-8');

    // 二次索引：内容已变，hash 不同，应重新解析
    const result2 = await indexFile(db, tempDir, filePath);
    expect(result2.skipped).toBe(false);
    expect(result2.nodeCount).toBeGreaterThan(0);
  });

  // 3. 新文件首次索引
  it('新文件首次索引（skipped=false，hash 写入 DB）', async () => {
    const code = `export function add(a: number, b: number): number { return a + b; }\n`;
    const filePath = await writeFile('src/c.ts', code);

    const result = await indexFile(db, tempDir, filePath);
    expect(result.skipped).toBe(false);
    expect(result.nodeCount).toBeGreaterThan(0);

    // DB 中应能读到 content hash
    const storedHash = getFileContentHash(db, 'src/c.ts');
    expect(storedHash).not.toBeNull();
    expect(storedHash).toBe(computeContentHash(code));
  });

  // 4. getFileContentHash / setFileContentHash 读写正确
  it('getFileContentHash / setFileContentHash 读写正确', async () => {
    // 未索引文件返回 null
    expect(getFileContentHash(db, 'nonexistent.ts')).toBeNull();

    // 插入文件记录
    const file: CodeMapFile = {
      path: 'src/test.ts',
      language: 'typescript',
      contentHash: 'initial-hash-abc',
      lineCount: 10,
      indexedAt: '2026-01-01T00:00:00Z',
    };
    insertFile(db, file);

    // 读取 hash
    expect(getFileContentHash(db, 'src/test.ts')).toBe('initial-hash-abc');

    // 更新 hash
    setFileContentHash(db, 'src/test.ts', 'new-hash-xyz');
    expect(getFileContentHash(db, 'src/test.ts')).toBe('new-hash-xyz');
  });

  // 额外：hash 变更后变更集被填充（供 querier 增量 PageRank 消费）
  it('hash 变更后变更集被填充', async () => {
    const code1 = `function f1(): void {}\n`;
    const filePath = await writeFile('src/d.ts', code1);

    // 首次索引：变更集应包含此文件
    await indexFile(db, tempDir, filePath);
    const changed = getChangedFilesSinceRank(db);
    expect(changed.has('src/d.ts')).toBe(true);

    // 清空后再次索引相同内容：变更集不应再包含
    clearChangedFilesSinceRank(db);
    await indexFile(db, tempDir, filePath);
    expect(getChangedFilesSinceRank(db).has('src/d.ts')).toBe(false);
  });
});

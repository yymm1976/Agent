// tests/code-map/watcher.test.ts
// Phase 71 Task A5：CodeMapWatcher 测试
// 验证文件变更触发增量索引、去抖动、close() 释放句柄、启动失败 fail-open

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ---- mock incrementalIndex（vi.hoisted 保证 mock factory 可引用） ----
const mockIncrementalIndex = vi.hoisted(() => vi.fn());

vi.mock('../../src/code-map/indexer.js', () => ({
  incrementalIndex: mockIncrementalIndex,
}));

import { CodeMapWatcher } from '../../src/code-map/watcher.js';

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'watcher-test-'));
  dbPath = path.join(tempDir, '.routedev', 'code-map', 'code-map.db');
  mockIncrementalIndex.mockReset();
  // 默认 resolve，避免实际执行索引
  mockIncrementalIndex.mockResolvedValue({
    stats: { fileCount: 0, nodeCount: 0, edgeCount: 0, durationMs: 0, incremental: true, skippedFiles: 0 },
    db: {},
  });
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

/** 辅助：等待指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('CodeMapWatcher', () => {
  // 1. 文件变更触发增量索引
  it('文件变更时触发 incrementalIndex', async () => {
    // 创建初始 .ts 文件
    const filePath = path.join(tempDir, 'src', 'a.ts');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, 'function a() {}\n', 'utf-8');

    const watcher = new CodeMapWatcher(tempDir, dbPath);
    watcher.start();
    // 等待 watcher 初始化
    await sleep(200);

    // 修改文件
    await fsp.writeFile(filePath, 'function a() { return 1; }\n', 'utf-8');

    // 等待去抖动（300ms）+ 处理
    await sleep(800);

    watcher.close();

    // incrementalIndex 应被调用至少一次
    expect(mockIncrementalIndex).toHaveBeenCalled();
    const callArgs = mockIncrementalIndex.mock.calls[0];
    expect(callArgs[0]).toBe(tempDir); // rootDir
    expect(callArgs[1]).toBeDefined(); // changedFiles
  });

  // 2. 去抖动生效：连续多次修改只触发一次索引
  it('连续多次修改只触发一次 incrementalIndex（去抖动 300ms）', async () => {
    const filePath = path.join(tempDir, 'b.ts');
    await fsp.writeFile(filePath, 'let x = 1;\n', 'utf-8');

    const watcher = new CodeMapWatcher(tempDir, dbPath);
    watcher.start();
    await sleep(200);

    // 连续修改 5 次（每次间隔 50ms，都在去抖动窗口内）
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(filePath, `let x = ${i};\n`, 'utf-8');
      await sleep(50);
    }

    // 等待去抖动结束 + 处理
    await sleep(800);
    watcher.close();

    // 应只调用 1 次（去抖动合并）
    expect(mockIncrementalIndex).toHaveBeenCalledTimes(1);
  });

  // 3. close() 释放句柄：关闭后文件变更不再触发索引
  it('close() 后文件变更不再触发 incrementalIndex', async () => {
    const filePath = path.join(tempDir, 'c.ts');
    await fsp.writeFile(filePath, 'function c() {}\n', 'utf-8');

    const watcher = new CodeMapWatcher(tempDir, dbPath);
    watcher.start();
    await sleep(200);

    // 关闭 watcher
    watcher.close();
    await sleep(100);

    // 清除之前的调用记录
    mockIncrementalIndex.mockClear();

    // 修改文件
    await fsp.writeFile(filePath, 'function c() { return 2; }\n', 'utf-8');
    await sleep(800);

    // close 后不应再调用
    expect(mockIncrementalIndex).not.toHaveBeenCalled();
  });

  // 4. 启动失败 fail-open：不存在的目录不崩溃
  it('启动时目录不存在不抛错（fail-open）', () => {
    const nonexistentDir = path.join(tempDir, 'does-not-exist');
    const watcher = new CodeMapWatcher(nonexistentDir, dbPath);

    // start() 不应抛错
    expect(() => watcher.start()).not.toThrow();

    // close() 也不应抛错
    expect(() => watcher.close()).not.toThrow();
  });

  // 额外：非监听扩展名的文件变更不触发索引
  it('非监听扩展名（.md）的文件变更不触发 incrementalIndex', async () => {
    const filePath = path.join(tempDir, 'readme.md');
    await fsp.writeFile(filePath, '# Title\n', 'utf-8');

    const watcher = new CodeMapWatcher(tempDir, dbPath);
    watcher.start();
    await sleep(200);

    await fsp.writeFile(filePath, '# Updated\n', 'utf-8');
    await sleep(800);

    watcher.close();

    // .md 不在监听扩展名中，不应触发
    expect(mockIncrementalIndex).not.toHaveBeenCalled();
  });
});

// tests/cli/commands/context-manager.test.ts
// CliContextManager 单元测试：
//   - addFile 读取文件并加入上下文
//   - 重复加入返回 added=false
//   - 不存在的文件返回 added=false + reason
//   - removeFile 移除文件
//   - getFiles 返回元信息（path/size/lines）
//   - getContent 拼接所有文件内容
//   - clear 清空
//   - size 与 has 查询

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliContextManager, cliContextManager } from '../../../src/cli/commands/context-manager.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-ctx-'));
}

describe('CliContextManager', () => {
  let tempDir: string;
  let mgr: CliContextManager;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mgr = new CliContextManager();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('初始状态为空', () => {
    expect(mgr.size()).toBe(0);
    expect(mgr.getFiles()).toEqual([]);
    expect(mgr.getContent()).toBe('');
  });

  it('addFile 读取文件并加入上下文', async () => {
    const filePath = path.join(tempDir, 'a.ts');
    await fs.writeFile(filePath, 'export const a = 1;\n', 'utf-8');

    const r = await mgr.addFile(filePath, tempDir);
    expect(r.added).toBe(true);
    expect(mgr.size()).toBe(1);
    expect(mgr.has(filePath, tempDir)).toBe(true);
  });

  it('重复加入同一文件返回 added=false', async () => {
    const filePath = path.join(tempDir, 'b.ts');
    await fs.writeFile(filePath, 'export const b = 2;\n', 'utf-8');

    await mgr.addFile(filePath, tempDir);
    const r2 = await mgr.addFile(filePath, tempDir);
    expect(r2.added).toBe(false);
    expect(r2.reason).toContain('已在上下文');
    expect(mgr.size()).toBe(1);
  });

  it('不存在的文件返回 added=false + reason', async () => {
    const r = await mgr.addFile('nonexistent.ts', tempDir);
    expect(r.added).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(mgr.size()).toBe(0);
  });

  it('相对路径与绝对路径解析一致', async () => {
    const relPath = 'rel.ts';
    const absPath = path.join(tempDir, relPath);
    await fs.writeFile(absPath, 'content\n', 'utf-8');

    // 用相对路径加入
    await mgr.addFile(relPath, tempDir);
    // 用绝对路径检查存在
    expect(mgr.has(absPath, tempDir)).toBe(true);
    expect(mgr.has(relPath, tempDir)).toBe(true);
  });

  it('removeFile 移除文件', async () => {
    const filePath = path.join(tempDir, 'c.ts');
    await fs.writeFile(filePath, 'c\n', 'utf-8');
    await mgr.addFile(filePath, tempDir);

    const ok = mgr.removeFile(filePath, tempDir);
    expect(ok).toBe(true);
    expect(mgr.size()).toBe(0);
  });

  it('removeFile 不存在的文件返回 false', () => {
    const ok = mgr.removeFile('nope.ts', tempDir);
    expect(ok).toBe(false);
  });

  it('getFiles 返回 path/size/lines 元信息', async () => {
    const filePath = path.join(tempDir, 'info.ts');
    const content = 'line1\nline2\nline3\n';
    await fs.writeFile(filePath, content, 'utf-8');
    await mgr.addFile(filePath, tempDir);

    const files = mgr.getFiles();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(filePath);
    expect(files[0].lines).toBe(3);
    expect(files[0].size).toBe(Buffer.byteLength(content, 'utf-8'));
  });

  it('getContent 拼接所有文件内容，用 === filename === 包裹', async () => {
    const f1 = path.join(tempDir, 'f1.ts');
    const f2 = path.join(tempDir, 'f2.ts');
    await fs.writeFile(f1, 'aaa', 'utf-8');
    await fs.writeFile(f2, 'bbb', 'utf-8');
    await mgr.addFile(f1, tempDir);
    await mgr.addFile(f2, tempDir);

    const content = mgr.getContent();
    expect(content).toContain('=== ' + f1 + ' ===');
    expect(content).toContain('=== ' + f2 + ' ===');
    expect(content).toContain('aaa');
    expect(content).toContain('bbb');
  });

  it('clear 清空所有', async () => {
    const f = path.join(tempDir, 'clear.ts');
    await fs.writeFile(f, 'x\n', 'utf-8');
    await mgr.addFile(f, tempDir);
    expect(mgr.size()).toBe(1);

    mgr.clear();
    expect(mgr.size()).toBe(0);
    expect(mgr.getFiles()).toEqual([]);
    expect(mgr.getContent()).toBe('');
  });

  it('单例 cliContextManager 可用', async () => {
    cliContextManager.clear();
    const f = path.join(tempDir, 'singleton.ts');
    await fs.writeFile(f, 'y\n', 'utf-8');
    await cliContextManager.addFile(f, tempDir);
    expect(cliContextManager.size()).toBe(1);
    cliContextManager.clear();
    expect(cliContextManager.size()).toBe(0);
  });
});

// tests/tools/builtin.test.ts
// 基础工具单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import { FileWriteTool } from '../../src/tools/builtin/file-write.js';
import { FileSearchTool } from '../../src/tools/builtin/file-search.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-tools-'));
}

const context = (dir: string): ToolExecutionContext => ({
  workingDirectory: dir,
  allowedDirectories: [dir],
  environment: {},
  timeoutMs: 30000,
});

describe('FileReadTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should read entire file', async () => {
    const tool = new FileReadTool();
    const result = await tool.execute({ path: 'test.txt' }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 | line1');
    expect(result.output).toContain('5 | line5');
  });

  it('should read line range', async () => {
    const tool = new FileReadTool();
    const result = await tool.execute({ path: 'test.txt', startLine: 2, endLine: 4 }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('2 | line2');
    expect(result.output).toContain('4 | line4');
    expect(result.output).not.toContain('5 | line5');
  });

  it('should return error for non-existent file', async () => {
    const tool = new FileReadTool();
    const result = await tool.execute({ path: 'nonexistent.txt' }, context(tempDir));

    expect(result.success).toBe(false);
    expect(result.error).toContain('读取文件失败');
  });
});

describe('FileWriteTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create new file', async () => {
    const tool = new FileWriteTool();
    const result = await tool.execute({ path: 'new.txt', content: 'hello world' }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('写入成功');

    const content = await fs.readFile(path.join(tempDir, 'new.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });

  it('should overwrite existing file', async () => {
    await fs.writeFile(path.join(tempDir, 'existing.txt'), 'old', 'utf-8');
    const tool = new FileWriteTool();
    const result = await tool.execute({ path: 'existing.txt', content: 'new' }, context(tempDir));

    expect(result.success).toBe(true);

    const content = await fs.readFile(path.join(tempDir, 'existing.txt'), 'utf-8');
    expect(content).toBe('new');
  });

  it('should append to file', async () => {
    await fs.writeFile(path.join(tempDir, 'append.txt'), 'first\n', 'utf-8');
    const tool = new FileWriteTool();
    const result = await tool.execute({ path: 'append.txt', content: 'second\n', append: true }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('追加');

    const content = await fs.readFile(path.join(tempDir, 'append.txt'), 'utf-8');
    expect(content).toBe('first\nsecond\n');
  });

  it('should create parent directories', async () => {
    const tool = new FileWriteTool();
    const result = await tool.execute({ path: 'sub/dir/file.txt', content: 'nested' }, context(tempDir));

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tempDir, 'sub/dir/file.txt'), 'utf-8');
    expect(content).toBe('nested');
  });
});

describe('FileSearchTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src/main.ts'), 'export function hello() { return "world"; }\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'src/util.ts'), 'export const PI = 3.14;\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'readme.md'), '# Hello\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should search content', async () => {
    const tool = new FileSearchTool();
    const result = await tool.execute({ query: 'hello' }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('main.ts');
  });

  it('should search by filename pattern', async () => {
    const tool = new FileSearchTool();
    const result = await tool.execute({ pattern: '*.ts' }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('main.ts');
    expect(result.output).toContain('util.ts');
  });

  it('should respect maxResults', async () => {
    const tool = new FileSearchTool();
    const result = await tool.execute({ pattern: '*.ts', maxResults: 1 }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 个结果');
  });
});

// tests/tools/search-path-traversal.test.ts
// Phase 26 Task 1：搜索工具路径遍历防护测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodeSearchTool } from '../../src/tools/builtin/code-search.js';
import { FileSearchTool } from '../../src/tools/builtin/file-search.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-traversal-'));
}

const context = (dir: string): ToolExecutionContext => ({
  workingDirectory: dir,
  allowedDirectories: [dir],
  environment: {},
  timeoutMs: 30000,
});

describe('CodeSearchTool 路径遍历防护', () => {
  let tempDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    outsideDir = await createTempDir();
    // 在外部目录创建一个敏感文件
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'SECRET_PASSWORD=admin123\n', 'utf-8');
    // 在项目目录内创建正常文件
    await fs.writeFile(path.join(tempDir, 'code.ts'), 'const x = 1;\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('应拒绝搜索项目目录外的路径（../../ 攻击）', async () => {
    const tool = new CodeSearchTool();
    const attackPath = path.relative(tempDir, outsideDir);
    const result = await tool.execute(
      { pattern: 'SECRET', path: attackPath },
      context(tempDir),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('超出项目边界');
  });

  it('应允许搜索项目目录内的正常路径', async () => {
    const tool = new CodeSearchTool();
    const result = await tool.execute(
      { pattern: 'const', path: '.' },
      context(tempDir),
    );

    expect(result.success).toBe(true);
  });

  it('应允许搜索项目根目录（不指定 path）', async () => {
    const tool = new CodeSearchTool();
    const result = await tool.execute(
      { pattern: 'const' },
      context(tempDir),
    );

    expect(result.success).toBe(true);
  });

  it('应拒绝绝对路径指向项目外', async () => {
    const tool = new CodeSearchTool();
    const result = await tool.execute(
      { pattern: 'SECRET', path: outsideDir },
      context(tempDir),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('超出项目边界');
  });
});

describe('FileSearchTool 路径遍历防护', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.writeFile(path.join(tempDir, 'code.ts'), 'const x = 1;\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('应在 allowedDirectories 内正常搜索', async () => {
    const tool = new FileSearchTool();
    const result = await tool.execute(
      { pattern: '*.ts' },
      context(tempDir),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('code.ts');
  });

  it('应在 allowedDirectories 为空时拒绝搜索（安全默认）', async () => {
    const tool = new FileSearchTool();
    const ctx: ToolExecutionContext = {
      workingDirectory: tempDir,
      allowedDirectories: [], // 空数组——安全默认应拒绝
      environment: {},
      timeoutMs: 30000,
    };
    const result = await tool.execute({ pattern: '*.ts' }, ctx);

    // 空数组时无匹配的允许目录，应拒绝
    expect(result.success).toBe(false);
  });
});

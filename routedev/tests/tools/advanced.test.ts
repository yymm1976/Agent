// tests/tools/advanced.test.ts
// Phase 7 进阶工具单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ShellExecTool } from '../../src/tools/builtin/shell-exec.js';
import { GitOpTool } from '../../src/tools/builtin/git-op.js';
import { CodeSearchTool } from '../../src/tools/builtin/code-search.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-adv-'));
}

const context = (dir: string): ToolExecutionContext => ({
  workingDirectory: dir,
  allowedDirectories: [dir],
  environment: {},
  timeoutMs: 30000,
});

describe('ShellExecTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should execute echo command', async () => {
    const tool = new ShellExecTool();
    const result = await tool.execute({ command: process.platform === 'win32' ? 'echo hello' : 'echo hello' }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('should respect timeout', async () => {
    const tool = new ShellExecTool();
    const result = await tool.execute(
      { command: process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > nul' : 'sleep 2', timeoutMs: 100 },
      context(tempDir)
    );

    expect(result.success).toBe(false);
    const errorOrOutput = `${result.error ?? ''}\n${result.output}`;
    expect(errorOrOutput.toLowerCase()).toMatch(/超时|timeout/);
  });
});

describe('GitOpTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return error when not in a git repo', async () => {
    const tool = new GitOpTool();
    const result = await tool.execute({ operation: 'status' }, context(tempDir));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Git');
  });
});

describe('CodeSearchTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await fs.writeFile(path.join(tempDir, 'main.ts'), 'export function hello() { return "world"; }\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'util.ts'), 'export const foo = "bar";\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should search code content', async () => {
    const tool = new CodeSearchTool();
    const result = await tool.execute({ pattern: 'hello', path: tempDir }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('main.ts');
  });

  it('should filter by file pattern', async () => {
    const tool = new CodeSearchTool();
    const result = await tool.execute({ pattern: 'foo', path: tempDir, filePattern: '*.ts' }, context(tempDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain('util.ts');
  });
});

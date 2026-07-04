// tests/cli/commands/include.test.ts
// /include 命令测试：
//   - 无参数列出已包含文件
//   - 加入单个文件
//   - 批量加入多个文件
//   - -remove 移除文件
//   - glob 模式批量加入
//   - 不存在的文件提示失败
//   - 重复加入提示跳过

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { includeCommand } from '../../../src/cli/commands/include.js';
import { cliContextManager } from '../../../src/cli/commands/context-manager.js';
import type { ServiceContext } from '../../../src/cli/service-context.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-inc-'));
}

function buildMockCtx(cwd: string): ServiceContext {
  return { cwd } as ServiceContext;
}

describe('/include 命令', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    cliContextManager.clear();
  });

  afterEach(async () => {
    cliContextManager.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('命令名与描述正确', () => {
    expect(includeCommand.name).toBe('include');
    expect(includeCommand.description).toContain('上下文');
    expect(includeCommand.aliases).toContain('add');
  });

  it('无参数时列出已包含文件（空时提示）', async () => {
    const result = await includeCommand.handler('', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('为空');
  });

  it('无参数时列出已包含文件（有内容时显示列表）', async () => {
    const f = path.join(tempDir, 'list.ts');
    await fs.writeFile(f, 'line1\nline2\n', 'utf-8');
    await includeCommand.handler('list.ts', buildMockCtx(tempDir));

    const result = await includeCommand.handler('', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    const msg = result.messages?.[0] ?? '';
    expect(msg).toContain('list.ts');
    expect(msg).toContain('2 行');
  });

  it('加入单个文件', async () => {
    const f = path.join(tempDir, 'single.ts');
    await fs.writeFile(f, 'export const x = 1;\n', 'utf-8');

    const result = await includeCommand.handler('single.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    const msg = result.messages?.[0] ?? '';
    expect(msg).toContain('已加入 1 个文件');
    expect(msg).toContain('single.ts');
    expect(cliContextManager.size()).toBe(1);
  });

  it('批量加入多个文件', async () => {
    await fs.writeFile(path.join(tempDir, 'a.ts'), 'a\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'b.ts'), 'b\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'c.ts'), 'c\n', 'utf-8');

    const result = await includeCommand.handler('a.ts b.ts c.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('已加入 3 个文件');
    expect(cliContextManager.size()).toBe(3);
  });

  it('-remove 移除已加入的文件', async () => {
    const f = path.join(tempDir, 'rm.ts');
    await fs.writeFile(f, 'rm\n', 'utf-8');
    await includeCommand.handler('rm.ts', buildMockCtx(tempDir));
    expect(cliContextManager.size()).toBe(1);

    const result = await includeCommand.handler('-remove rm.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('已移除');
    expect(cliContextManager.size()).toBe(0);
  });

  it('-remove 不存在的文件返回错误', async () => {
    const result = await includeCommand.handler('-remove nope.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('不在上下文');
  });

  it('-remove 无参数时返回用法提示', async () => {
    const result = await includeCommand.handler('-remove', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('用法');
  });

  it('不存在的文件提示失败', async () => {
    const result = await includeCommand.handler('nonexistent.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    const msg = result.messages?.[0] ?? '';
    expect(msg).toContain('跳过'); // 跳过 + 失败原因
    expect(cliContextManager.size()).toBe(0);
  });

  it('重复加入同一文件提示跳过', async () => {
    const f = path.join(tempDir, 'dup.ts');
    await fs.writeFile(f, 'dup\n', 'utf-8');
    await includeCommand.handler('dup.ts', buildMockCtx(tempDir));

    const result = await includeCommand.handler('dup.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('跳过');
    expect(cliContextManager.size()).toBe(1);
  });

  it('glob 模式批量加入（*.ts）', async () => {
    await fs.writeFile(path.join(tempDir, 'a.ts'), 'a\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'b.ts'), 'b\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'c.js'), 'c\n', 'utf-8'); // 不应被匹配

    const result = await includeCommand.handler('*.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('已加入 2 个文件');
    expect(cliContextManager.size()).toBe(2);
  });

  it('glob 模式跨层匹配（**/*.ts）', async () => {
    await fs.mkdir(path.join(tempDir, 'src', 'sub'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'top.ts'), 'top\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'src', 'sub', 'deep.ts'), 'deep\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'root.ts'), 'root\n', 'utf-8');

    const result = await includeCommand.handler('src/**/*.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    const msg = result.messages?.[0] ?? '';
    expect(msg).toContain('已加入 2 个文件');
    expect(cliContextManager.size()).toBe(2);
  });

  it('glob 无匹配时提示跳过', async () => {
    const result = await includeCommand.handler('nomatch-*.ts', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('跳过');
    expect(cliContextManager.size()).toBe(0);
  });

  it('未知 flag 返回错误', async () => {
    const result = await includeCommand.handler('-unknown', buildMockCtx(tempDir));
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('未知参数');
  });
});

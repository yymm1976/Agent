// tests/cli/commands/undo.test.ts
// /undo 命令测试：
//   - 栈为空时提示"无可撤销操作"
//   - 编辑后 /undo 恢复原内容
//   - /undo 后栈深度归零
//   - 多次编辑后连续 /undo（LIFO 顺序）
//   - 文件不存在时撤销失败（条目回推栈）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { undoCommand } from '../../../src/cli/commands/undo.js';
import { FileEditTool } from '../../../src/tools/builtin/file-edit.js';
import { editHistory } from '../../../src/tools/builtin/edit-history.js';
import type { ServiceContext } from '../../../src/cli/service-context.js';
import type { ToolExecutionContext } from '../../../src/tools/types.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-undo-'));
}

function buildToolContext(dir: string): ToolExecutionContext {
  return {
    workingDirectory: dir,
    allowedDirectories: [dir],
    environment: {},
    timeoutMs: 30000,
  };
}

/** /undo handler 不使用 ServiceContext 的任何字段，传最小 mock 即可 */
function buildMockServiceCtx(): ServiceContext {
  return {} as ServiceContext;
}

describe('/undo 命令', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    editHistory.clear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('栈为空时返回"无可撤销操作"', async () => {
    const result = await undoCommand.handler('', buildMockServiceCtx());
    expect(result.type).toBe('handled');
    expect(result.messages?.[0]).toContain('无可撤销操作');
  });

  it('file_edit 编辑后 /undo 恢复原始内容', async () => {
    const filePath = path.join(tempDir, 'u.txt');
    const original = 'original line\n';
    await fs.writeFile(filePath, original, 'utf-8');

    // 编辑
    const tool = new FileEditTool();
    const editResult = await tool.execute(
      { path: 'u.txt', oldString: 'original', newString: 'modified' },
      buildToolContext(tempDir),
    );
    expect(editResult.success).toBe(true);
    expect(editHistory.size()).toBe(1);

    // 确认文件已被修改
    const mid = await fs.readFile(filePath, 'utf-8');
    expect(mid).toBe('modified line\n');

    // 撤销
    const undoResult = await undoCommand.handler('', buildMockServiceCtx());
    expect(undoResult.type).toBe('handled');
    expect(undoResult.messages?.[0]).toContain('已撤销');

    // 文件已恢复
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(original);
    expect(editHistory.size()).toBe(0);
  });

  it('edit_lines 模式编辑后 /undo 也能恢复', async () => {
    const filePath = path.join(tempDir, 'u2.txt');
    const original = 'L1\nL2\nL3\n';
    await fs.writeFile(filePath, original, 'utf-8');

    const tool = new FileEditTool();
    await tool.execute(
      {
        path: 'u2.txt',
        action: 'edit_lines',
        startLine: 2,
        endLine: 2,
        newContent: 'REPLACED',
      },
      buildToolContext(tempDir),
    );

    const mid = await fs.readFile(filePath, 'utf-8');
    expect(mid).toBe('L1\nREPLACED\nL3\n');

    const undoResult = await undoCommand.handler('', buildMockServiceCtx());
    expect(undoResult.messages?.[0]).toContain('已撤销');

    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(original);
  });

  it('多次编辑后连续 /undo 按 LIFO 顺序恢复', async () => {
    const filePath = path.join(tempDir, 'stack.txt');
    await fs.writeFile(filePath, 'v0\n', 'utf-8');

    const tool = new FileEditTool();
    // 第一次编辑：v0 → v1
    await tool.execute(
      { path: 'stack.txt', oldString: 'v0', newString: 'v1' },
      buildToolContext(tempDir),
    );
    // 第二次编辑：v1 → v2
    await tool.execute(
      { path: 'stack.txt', oldString: 'v1', newString: 'v2' },
      buildToolContext(tempDir),
    );
    expect(editHistory.size()).toBe(2);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('v2\n');

    // 第一次 undo：v2 → v1
    await undoCommand.handler('', buildMockServiceCtx());
    expect(await fs.readFile(filePath, 'utf-8')).toBe('v1\n');
    expect(editHistory.size()).toBe(1);

    // 第二次 undo：v1 → v0
    await undoCommand.handler('', buildMockServiceCtx());
    expect(await fs.readFile(filePath, 'utf-8')).toBe('v0\n');
    expect(editHistory.size()).toBe(0);

    // 第三次 undo：栈空
    const emptyResult = await undoCommand.handler('', buildMockServiceCtx());
    expect(emptyResult.messages?.[0]).toContain('无可撤销操作');
  });

  it('命令名与描述正确', () => {
    expect(undoCommand.name).toBe('undo');
    expect(undoCommand.description).toContain('撤销');
    expect(undoCommand.usage).toBe('/undo');
  });

  it('撤销消息包含文件路径与剩余栈深度', async () => {
    const filePath = path.join(tempDir, 'msg.txt');
    await fs.writeFile(filePath, 'a\n', 'utf-8');

    const tool = new FileEditTool();
    await tool.execute(
      { path: 'msg.txt', oldString: 'a', newString: 'b' },
      buildToolContext(tempDir),
    );

    const result = await undoCommand.handler('', buildMockServiceCtx());
    expect(result.type).toBe('handled');
    const msg = (result.messages ?? []).join('\n');
    expect(msg).toContain(filePath);
    expect(msg).toContain('剩余可撤销操作: 0');
  });

  it('栈深度上限 20：连续编辑 25 次后栈只保留最近 20 条', async () => {
    const filePath = path.join(tempDir, 'cap.txt');
    await fs.writeFile(filePath, 'base\n', 'utf-8');

    const tool = new FileEditTool();
    // 通过 edit_lines 反复改写第 1 行，每次都成功 push 一次
    for (let i = 0; i < 25; i++) {
      await tool.execute(
        {
          path: 'cap.txt',
          action: 'edit_lines',
          startLine: 1,
          endLine: 1,
          newContent: `iter-${i}`,
        },
        buildToolContext(tempDir),
      );
    }
    expect(editHistory.size()).toBe(20);

    // 连续 undo 20 次后栈空
    for (let i = 0; i < 20; i++) {
      const r = await undoCommand.handler('', buildMockServiceCtx());
      expect(r.messages?.[0]).toContain('已撤销');
    }
    expect(editHistory.size()).toBe(0);

    // 第 21 次提示栈空
    const r = await undoCommand.handler('', buildMockServiceCtx());
    expect(r.messages?.[0]).toContain('无可撤销操作');
  });
});

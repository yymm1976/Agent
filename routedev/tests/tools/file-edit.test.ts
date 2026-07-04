// tests/tools/file-edit.test.ts
// file-edit 工具测试：
//   - replace 模式（原有）：单条/批量/唯一性校验
//   - edit_lines 模式（Phase 73 新增）：1-based 闭区间、endLine 截断、删除
//   - 确认流程：requireConfirmation + requestConfirmation 回调
//   - EditHistory 集成：编辑成功后栈深度增加

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileEditTool } from '../../src/tools/builtin/file-edit.js';
import { editHistory } from '../../src/tools/builtin/edit-history.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-fileedit-'));
}

function buildContext(dir: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workingDirectory: dir,
    allowedDirectories: [dir],
    environment: {},
    timeoutMs: 30000,
    ...overrides,
  };
}

describe('FileEditTool - replace 模式（原有行为兼容）', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    editHistory.clear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('单条 str_replace 成功替换', async () => {
    const filePath = path.join(tempDir, 'a.txt');
    await fs.writeFile(filePath, 'foo\nbar\nbaz\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      { path: 'a.txt', oldString: 'bar', newString: 'BAR' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('应用 1 处替换');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('foo\nBAR\nbaz\n');
  });

  it('未指定 action 时默认走 replace 模式', async () => {
    const filePath = path.join(tempDir, 'b.txt');
    await fs.writeFile(filePath, 'hello world\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      { path: 'b.txt', oldString: 'world', newString: 'WORLD' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.action).toBe('replace');
  });

  it('oldString 多处匹配时拒绝替换', async () => {
    const filePath = path.join(tempDir, 'c.txt');
    await fs.writeFile(filePath, 'dup\ndup\ndup\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      { path: 'c.txt', oldString: 'dup', newString: 'x' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('3 处匹配');
  });

  it('oldString 未匹配时返回错误', async () => {
    const filePath = path.join(tempDir, 'd.txt');
    await fs.writeFile(filePath, 'line1\nline2\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      { path: 'd.txt', oldString: 'not-exist', newString: 'x' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未找到匹配');
  });
});

describe('FileEditTool - edit_lines 模式（Phase 73 新增）', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    editHistory.clear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('startLine=1, endLine=1 替换第 1 行', async () => {
    const filePath = path.join(tempDir, 'lines.txt');
    await fs.writeFile(filePath, 'L1\nL2\nL3\nL4\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      {
        path: 'lines.txt',
        action: 'edit_lines',
        startLine: 1,
        endLine: 1,
        newContent: 'NEW1',
      },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.action).toBe('edit_lines');
    expect(result.metadata?.startLine).toBe(1);
    expect(result.metadata?.actualEndLine).toBe(1);
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('NEW1\nL2\nL3\nL4\n');
  });

  it('替换中间多行（2-3 行）', async () => {
    const filePath = path.join(tempDir, 'mid.txt');
    await fs.writeFile(filePath, 'L1\nL2\nL3\nL4\nL5\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      {
        path: 'mid.txt',
        action: 'edit_lines',
        startLine: 2,
        endLine: 3,
        newContent: 'REPLACED',
      },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('L1\nREPLACED\nL4\nL5\n');
  });

  it('endLine 超过总行数时自动截断到最后一行', async () => {
    const filePath = path.join(tempDir, 'trunc.txt');
    await fs.writeFile(filePath, 'A\nB\nC\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      {
        path: 'trunc.txt',
        action: 'edit_lines',
        startLine: 2,
        endLine: 999,
        newContent: 'TAIL',
      },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    // 用户视角的行数：'A\nB\nC\n' 视为 3 行（A/B/C，尾换行不算行），actualEndLine 截断到 3
    expect(result.metadata?.actualEndLine).toBe(3);
    const after = await fs.readFile(filePath, 'utf-8');
    // 原文件以 \n 结尾，结果保留尾 \n
    expect(after).toBe('A\nTAIL\n');
  });

  it('newContent 为空字符串时删除指定行范围', async () => {
    const filePath = path.join(tempDir, 'del.txt');
    await fs.writeFile(filePath, 'L1\nL2\nL3\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      {
        path: 'del.txt',
        action: 'edit_lines',
        startLine: 2,
        endLine: 3,
        newContent: '',
      },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('L1\n');
  });

  it('newContent 包含多行内容时正确插入', async () => {
    const filePath = path.join(tempDir, 'multi.txt');
    await fs.writeFile(filePath, 'A\nB\nC\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      {
        path: 'multi.txt',
        action: 'edit_lines',
        startLine: 2,
        endLine: 2,
        newContent: 'X1\nX2\nX3',
      },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('A\nX1\nX2\nX3\nC\n');
  });

  it('返回 diff 预览（metadata.diffPreview）', async () => {
    const filePath = path.join(tempDir, 'diff.txt');
    await fs.writeFile(filePath, 'old line\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      {
        path: 'diff.txt',
        action: 'edit_lines',
        startLine: 1,
        endLine: 1,
        newContent: 'new line',
      },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    expect(typeof result.metadata?.diffPreview).toBe('string');
    // diff 格式：'- ${行号}  ${内容}' / '+ ${行号}  ${内容}'
    const diff = result.metadata?.diffPreview as string;
    expect(diff).toContain('old line');
    expect(diff).toContain('new line');
    expect(diff).toMatch(/-.*old line/);
    expect(diff).toMatch(/\+.*new line/);
  });

  it('validateArgs 拒绝 edit_lines 模式缺参数', () => {
    const tool = new FileEditTool();
    const r = tool.validateArgs({
      path: 'x.txt',
      action: 'edit_lines',
      startLine: 1,
      // 缺 endLine / newContent
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('endLine'))).toBe(true);
    expect(r.errors.some(e => e.includes('newContent'))).toBe(true);
  });

  it('validateArgs 拒绝 startLine > endLine', () => {
    const tool = new FileEditTool();
    const r = tool.validateArgs({
      path: 'x.txt',
      action: 'edit_lines',
      startLine: 5,
      endLine: 2,
      newContent: 'x',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('startLine 不能大于 endLine'))).toBe(true);
  });

  it('validateArgs 拒绝 edit_lines 与 oldString 混用', () => {
    const tool = new FileEditTool();
    const r = tool.validateArgs({
      path: 'x.txt',
      action: 'edit_lines',
      startLine: 1,
      endLine: 2,
      newContent: 'x',
      oldString: 'y',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('不能同时使用'))).toBe(true);
  });
});

describe('FileEditTool - 确认流程（requireConfirmation）', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    editHistory.clear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('requireConfirmation=true 且用户确认 → 应用编辑', async () => {
    const filePath = path.join(tempDir, 'confirm.txt');
    await fs.writeFile(filePath, 'foo\n', 'utf-8');

    const tool = new FileEditTool();
    tool.setRequireConfirmation(true);

    const confirmCalls: string[] = [];
    const ctx = buildContext(tempDir, {
      requestConfirmation: async (reason: string) => {
        confirmCalls.push(reason);
        return true;
      },
    });

    const result = await tool.execute(
      { path: 'confirm.txt', oldString: 'foo', newString: 'bar' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]).toContain('diff 预览');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('bar\n');
  });

  it('requireConfirmation=true 且用户拒绝 → 不写入文件', async () => {
    const filePath = path.join(tempDir, 'reject.txt');
    await fs.writeFile(filePath, 'original\n', 'utf-8');

    const tool = new FileEditTool();
    tool.setRequireConfirmation(true);

    const ctx = buildContext(tempDir, {
      requestConfirmation: async () => false,
    });

    const result = await tool.execute(
      { path: 'reject.txt', oldString: 'original', newString: 'modified' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('用户取消');
    // 文件未被修改
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('original\n');
    // EditHistory 不应记录（用户取消，不进栈）
    expect(editHistory.size()).toBe(0);
  });

  it('requireConfirmation=true 但无 requestConfirmation 回调 → 直接应用（向后兼容）', async () => {
    const filePath = path.join(tempDir, 'nohook.txt');
    await fs.writeFile(filePath, 'a\n', 'utf-8');

    const tool = new FileEditTool();
    tool.setRequireConfirmation(true);

    // 不提供 requestConfirmation
    const result = await tool.execute(
      { path: 'nohook.txt', oldString: 'a', newString: 'b' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe('b\n');
  });

  it('默认 requireConfirmation=false → 不调用 requestConfirmation', async () => {
    const filePath = path.join(tempDir, 'default.txt');
    await fs.writeFile(filePath, 'x\n', 'utf-8');

    const tool = new FileEditTool();
    // 不调用 setRequireConfirmation，默认 false

    let called = false;
    const ctx = buildContext(tempDir, {
      requestConfirmation: async () => {
        called = true;
        return true;
      },
    });

    const result = await tool.execute(
      { path: 'default.txt', oldString: 'x', newString: 'y' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(called).toBe(false);
  });
});

describe('FileEditTool - EditHistory 集成', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    editHistory.clear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('成功编辑后栈深度 +1，记录原文件路径与内容', async () => {
    const filePath = path.join(tempDir, 'hist.txt');
    await fs.writeFile(filePath, 'before\n', 'utf-8');

    const tool = new FileEditTool();
    expect(editHistory.size()).toBe(0);

    const result = await tool.execute(
      { path: 'hist.txt', oldString: 'before', newString: 'after' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    expect(editHistory.size()).toBe(1);
    const popped = editHistory.pop();
    expect(popped).not.toBeNull();
    expect(popped!.filePath).toBe(filePath);
    expect(popped!.content).toBe('before\n');
  });

  it('edit_lines 模式同样会推入 EditHistory', async () => {
    const filePath = path.join(tempDir, 'hist2.txt');
    await fs.writeFile(filePath, 'L1\nL2\nL3\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      { path: 'hist2.txt', action: 'edit_lines', startLine: 2, endLine: 2, newContent: 'X' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(true);
    expect(editHistory.size()).toBe(1);
    const popped = editHistory.pop();
    expect(popped!.content).toBe('L1\nL2\nL3\n');
  });

  it('编辑失败（oldString 未匹配）时不推入 EditHistory', async () => {
    const filePath = path.join(tempDir, 'fail.txt');
    await fs.writeFile(filePath, 'content\n', 'utf-8');

    const tool = new FileEditTool();
    const result = await tool.execute(
      { path: 'fail.txt', oldString: 'not-exist', newString: 'x' },
      buildContext(tempDir),
    );

    expect(result.success).toBe(false);
    expect(editHistory.size()).toBe(0);
  });

  it('EditHistory 单例栈深度上限 20', () => {
    for (let i = 0; i < 25; i++) {
      editHistory.push(`/fake/${i}.txt`, `content-${i}`);
    }
    expect(editHistory.size()).toBe(20);
    // 弹出最近一条（第 25 条，FIFO 丢掉了前 5 条）
    const top = editHistory.pop();
    expect(top!.filePath).toBe('/fake/24.txt');
  });
});

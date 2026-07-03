// tests/agent/tools/vfs-tool.test.ts
// Phase 71 Task E1：VFS 工具单元测试
import { describe, it, expect } from 'vitest';
import { createVFS } from '../../../src/agent/context/virtual-fs.js';
import { VfsReadTool, VfsWriteTool, VfsListTool, VfsDeleteTool } from '../../../src/agent/tools/vfs-tool.js';
import type { ToolExecutionContext } from '../../../src/tools/types.js';

// 测试用的空执行上下文（VFS 工具不读取 context，但 ITool 接口要求）
const fakeContext: ToolExecutionContext = {
  workingDirectory: '/tmp',
  allowedDirectories: ['/tmp'],
  environment: {},
  timeoutMs: 1000,
};

describe('VFS 工具集', () => {
  it('vfs_write 工具调用：写入文件后 vfs_read 能读取', async () => {
    const vfs = createVFS();
    const writeTool = new VfsWriteTool(vfs);
    const readTool = new VfsReadTool(vfs);

    const writeResult = await writeTool.execute(
      { path: '/notes/todo.md', content: '实装 VFS' },
      fakeContext,
    );
    expect(writeResult.success).toBe(true);

    const readResult = await readTool.execute({ path: '/notes/todo.md' }, fakeContext);
    expect(readResult.success).toBe(true);
    expect(readResult.output).toBe('实装 VFS');
  });

  it('vfs_read 工具调用：文件不存在时返回 success=false', async () => {
    const vfs = createVFS();
    const readTool = new VfsReadTool(vfs);

    const result = await readTool.execute({ path: '/not-exist.md' }, fakeContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('vfs_read');
  });

  it('vfs_list 工具调用：列出目录直接子节点', async () => {
    const vfs = createVFS();
    const writeTool = new VfsWriteTool(vfs);
    const listTool = new VfsListTool(vfs);

    await writeTool.execute({ path: '/foo/a.txt', content: 'a' }, fakeContext);
    await writeTool.execute({ path: '/foo/b.txt', content: 'b' }, fakeContext);
    await writeTool.execute({ path: '/foo/sub/c.txt', content: 'c' }, fakeContext);

    const result = await listTool.execute({ dir: '/foo' }, fakeContext);
    expect(result.success).toBe(true);
    const entries = JSON.parse(result.output);
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
    expect(entries).toContain('sub/');
    expect(entries).not.toContain('c.txt');
  });

  it('vfs_delete 工具调用：删除文件后不再可读', async () => {
    const vfs = createVFS();
    const writeTool = new VfsWriteTool(vfs);
    const deleteTool = new VfsDeleteTool(vfs);
    const readTool = new VfsReadTool(vfs);

    await writeTool.execute({ path: '/tmp.md', content: 'x' }, fakeContext);
    const deleteResult = await deleteTool.execute({ path: '/tmp.md' }, fakeContext);
    expect(deleteResult.success).toBe(true);

    const readResult = await readTool.execute({ path: '/tmp.md' }, fakeContext);
    expect(readResult.success).toBe(false);
  });

  it('vfs_delete 工具调用：删除不存在的路径返回 success=false', async () => {
    const vfs = createVFS();
    const deleteTool = new VfsDeleteTool(vfs);
    const result = await deleteTool.execute({ path: '/no-such-file.md' }, fakeContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('不存在');
  });

  it('vfs_write 工具调用：.. 越权路径返回 success=false', async () => {
    const vfs = createVFS();
    const writeTool = new VfsWriteTool(vfs);
    const result = await writeTool.execute(
      { path: '../etc/passwd', content: 'hacked' },
      fakeContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('路径非法');
  });

  it('vfs_delete 工具调用：删除根目录 / 被禁止', async () => {
    const vfs = createVFS();
    const deleteTool = new VfsDeleteTool(vfs);
    const result = await deleteTool.execute({ path: '/' }, fakeContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('禁止删除根目录');
  });

  it('validateArgs：缺少必需参数返回 valid=false', () => {
    const vfs = createVFS();
    const writeTool = new VfsWriteTool(vfs);
    const readTool = new VfsReadTool(vfs);

    expect(writeTool.validateArgs({}).valid).toBe(false);
    expect(readTool.validateArgs({}).valid).toBe(false);
    expect(writeTool.validateArgs({ path: '/x' }).valid).toBe(false); // 缺 content
  });

  it('definition：4 个工具名称符合规范', () => {
    const vfs = createVFS();
    expect(new VfsReadTool(vfs).definition.name).toBe('vfs_read');
    expect(new VfsWriteTool(vfs).definition.name).toBe('vfs_write');
    expect(new VfsListTool(vfs).definition.name).toBe('vfs_list');
    expect(new VfsDeleteTool(vfs).definition.name).toBe('vfs_delete');
  });

  it('definition：4 个工具均为 system 类别 + 无需确认', () => {
    const vfs = createVFS();
    for (const Tool of [VfsReadTool, VfsWriteTool, VfsListTool, VfsDeleteTool]) {
      const def = new Tool(vfs).definition;
      expect(def.category).toBe('system');
      expect(def.requiresApproval).toBe(false);
    }
  });
});

// tests/agent/context/virtual-fs.test.ts
// Phase 71 Task E1：VirtualFS 单元测试
import { describe, it, expect } from 'vitest';
import { VirtualFS, createVFS } from '../../../src/agent/context/virtual-fs.js';

describe('VirtualFS', () => {
  it('write + read 往返：写入后能读取到相同内容', () => {
    const vfs = createVFS();
    vfs.write('/todo.md', '完成 VFS 实装');
    expect(vfs.read('/todo.md')).toBe('完成 VFS 实装');
  });

  it('write 覆盖式：二次写入替换原内容', () => {
    const vfs = createVFS();
    vfs.write('/scratch.txt', 'v1');
    vfs.write('/scratch.txt', 'v2');
    expect(vfs.read('/scratch.txt')).toBe('v2');
  });

  it('read 不存在的文件返回 null', () => {
    const vfs = createVFS();
    expect(vfs.read('/not-exist.md')).toBeNull();
  });

  it('list 列出目录直接子节点（文件原样、目录加 / 后缀）', () => {
    const vfs = createVFS();
    vfs.write('/foo/a.txt', 'a');
    vfs.write('/foo/b.txt', 'b');
    vfs.write('/foo/bar/c.txt', 'c');
    vfs.write('/baz.txt', 'baz');
    const entries = vfs.list('/foo');
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
    expect(entries).toContain('bar/');
    expect(entries).not.toContain('c.txt');
    expect(entries).not.toContain('baz.txt');
  });

  it('list 根目录 / 列出顶层节点', () => {
    const vfs = createVFS();
    vfs.write('/top.md', 'top');
    vfs.write('/sub/inner.md', 'inner');
    const entries = vfs.list('/');
    expect(entries).toContain('top.md');
    expect(entries).toContain('sub/');
  });

  it('delete 删除文件后 exists 返回 false', () => {
    const vfs = createVFS();
    vfs.write('/tmp.md', 'x');
    expect(vfs.exists('/tmp.md')).toBe(true);
    vfs.delete('/tmp.md');
    expect(vfs.exists('/tmp.md')).toBe(false);
    expect(vfs.read('/tmp.md')).toBeNull();
  });

  it('delete 目录递归删除子节点', () => {
    const vfs = createVFS();
    vfs.write('/dir/a.txt', 'a');
    vfs.write('/dir/sub/b.txt', 'b');
    vfs.delete('/dir');
    expect(vfs.exists('/dir')).toBe(false);
    expect(vfs.exists('/dir/a.txt')).toBe(false);
    expect(vfs.exists('/dir/sub/b.txt')).toBe(false);
  });

  it('exists 根目录 / 始终返回 true', () => {
    const vfs = createVFS();
    expect(vfs.exists('/')).toBe(true);
  });

  it('路径规范化：Windows 反斜杠转换为 posix 斜杠', () => {
    const vfs = createVFS();
    vfs.write('a\\b\\c.md', 'content');
    // 反斜杠应被规范化为正斜杠，相对路径基于 / 根
    expect(vfs.read('/a/b/c.md')).toBe('content');
    expect(vfs.read('a/b/c.md')).toBe('content');
    expect(vfs.read('a\\b\\c.md')).toBe('content');
  });

  it('路径规范化：去除 ./ 前缀并基于 / 根', () => {
    const vfs = createVFS();
    vfs.write('./notes/todo.md', 'task');
    expect(vfs.read('/notes/todo.md')).toBe('task');
    expect(vfs.read('notes/todo.md')).toBe('task');
  });

  it('路径规范化：折叠多余斜杠', () => {
    const vfs = createVFS();
    vfs.write('//foo//bar.md', 'x');
    expect(vfs.read('/foo/bar.md')).toBe('x');
  });

  it('.. 越权检测：跳出根的相对路径被拒绝（normalizePath 返回 null）', () => {
    const vfs = createVFS();
    expect(vfs.normalizePath('../etc/passwd')).toBeNull();
    expect(vfs.normalizePath('/../../etc')).toBeNull();
    expect(vfs.normalizePath('..')).toBeNull();
  });

  it('.. 越权检测：合法的 .. 内部引用被正确规范化（不拒绝）', () => {
    const vfs = createVFS();
    // /foo/bar/../baz → /foo/baz（合法）
    expect(vfs.normalizePath('/foo/bar/../baz')).toBe('/foo/baz');
  });

  it('.. 越权检测：write 非法路径静默忽略，read 返回 null', () => {
    const vfs = createVFS();
    vfs.write('../etc/passwd', 'hacked');
    expect(vfs.read('../etc/passwd')).toBeNull();
    expect(vfs.exists('../etc/passwd')).toBe(false);
  });

  it('路径非法返回错误（不抛异常）：空字符串 normalizePath 返回 null', () => {
    const vfs = createVFS();
    expect(vfs.normalizePath('')).toBeNull();
    // 各方法在非法路径下不抛异常，返回默认值
    expect(() => vfs.read('')).not.toThrow();
    expect(() => vfs.write('', 'x')).not.toThrow();
    expect(() => vfs.list('')).not.toThrow();
    expect(() => vfs.delete('')).not.toThrow();
    expect(() => vfs.exists('')).not.toThrow();
    expect(vfs.read('')).toBeNull();
    expect(vfs.list('')).toEqual([]);
    expect(vfs.exists('')).toBe(false);
  });

  it('createVFS 工厂返回 VirtualFS 实例', () => {
    const vfs = createVFS();
    expect(vfs).toBeInstanceOf(VirtualFS);
  });

  it('delete 根目录 / 被禁止（静默忽略）', () => {
    const vfs = createVFS();
    vfs.write('/a.md', 'a');
    vfs.delete('/'); // 不应清空整个 VFS
    expect(vfs.exists('/a.md')).toBe(true);
    expect(vfs.exists('/')).toBe(true);
  });
});

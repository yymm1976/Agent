// tests/agent/context/mention-parser.test.ts
// Phase 71 Task B2：@-mention 统一引用协议解析器测试
// 覆盖：文件路径 / 符号名 / URL / 混合解析 / fail-open / 非法前缀 / 跨平台路径

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// 用 vi.hoisted 提升 mock 函数，使其在 vi.mock 工厂中可引用
const mocks = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  getNodeByName: vi.fn(),
}));

// Mock code-map/database 避免 node:sqlite 真实 DB 访问
vi.mock('../../../src/code-map/database.js', () => ({
  initDatabase: mocks.initDatabase,
  getNodeByName: mocks.getNodeByName,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { parseMentions } from '../../../src/agent/context/mention-parser.js';

describe('parseMentions - @-mention 统一引用协议解析器', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mention-parser-'));
    // 默认：DB 不存在（fs.existsSync 返回 false），getNodeByName 不被调用
    // 若被调用则返回空数组（fail-open 退化为符号名本身）
    mocks.getNodeByName.mockReturnValue([]);
    mocks.initDatabase.mockReturnValue({ close: vi.fn() });
  });

  it('解析文件路径 @src/foo.ts', () => {
    const mentions = parseMentions('请查看 @src/foo.ts', tempDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('file');
    expect(mentions[0].raw).toBe('src/foo.ts');
    expect(mentions[0].resolved).toBe(path.resolve(tempDir, 'src/foo.ts'));
  });

  it('解析符号名 @MyClass（无路径分隔符）', () => {
    // DB 文件不存在，fail-open：resolved 退化为符号名本身
    const mentions = parseMentions('请查看 @MyClass 的定义', tempDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('symbol');
    expect(mentions[0].raw).toBe('MyClass');
    expect(mentions[0].resolved).toBe('MyClass');
  });

  it('解析 URL @https://example.com', () => {
    const mentions = parseMentions('请访问 @https://example.com 获取信息', tempDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('url');
    expect(mentions[0].raw).toBe('https://example.com');
    expect(mentions[0].resolved).toBe('https://example.com');
  });

  it('解析 http:// 开头的 URL', () => {
    const mentions = parseMentions('看下 @http://foo.bar/baz', tempDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('url');
    expect(mentions[0].raw).toBe('http://foo.bar/baz');
  });

  it('多个 mention 混合解析', () => {
    const text = '查看 @src/foo.ts 和 @MyClass 以及 @https://example.com';
    const mentions = parseMentions(text, tempDir);
    expect(mentions).toHaveLength(3);
    expect(mentions[0].type).toBe('file');
    expect(mentions[0].raw).toBe('src/foo.ts');
    expect(mentions[1].type).toBe('symbol');
    expect(mentions[1].raw).toBe('MyClass');
    expect(mentions[2].type).toBe('url');
    expect(mentions[2].raw).toBe('https://example.com');
  });

  it('文件不存在时 fail-open（保留 raw，type 标 file 但 resolved 为尝试路径）', () => {
    const mentions = parseMentions('查看 @nonexistent/file.ts', tempDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('file');
    expect(mentions[0].raw).toBe('nonexistent/file.ts');
    // resolved 仍为尝试解析的绝对路径（不因文件不存在而改变）
    expect(mentions[0].resolved).toBe(path.resolve(tempDir, 'nonexistent/file.ts'));
  });

  it('@ 后跟空格或非标识符字符不解析', () => {
    // @ 后跟空格
    expect(parseMentions('hello @ world', tempDir)).toHaveLength(0);
    // @ 后跟标点 !
    expect(parseMentions('hello @!world', tempDir)).toHaveLength(0);
    // @ 后跟逗号
    expect(parseMentions('hello @,world', tempDir)).toHaveLength(0);
    // 单独的 @
    expect(parseMentions('hello @', tempDir)).toHaveLength(0);
    // @ 后跟分号
    expect(parseMentions('hello @;world', tempDir)).toHaveLength(0);
  });

  it('跨平台路径（Windows 反斜杠）', () => {
    const mentions = parseMentions('查看 @src\\foo.ts', tempDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('file');
    expect(mentions[0].raw).toBe('src\\foo.ts');
    // path.resolve 跨平台正确处理反斜杠
    expect(mentions[0].resolved).toBe(path.resolve(tempDir, 'src\\foo.ts'));
  });

  it('无 @-mention 时返回空数组', () => {
    expect(parseMentions('普通文本无 mention', tempDir)).toHaveLength(0);
    expect(parseMentions('', tempDir)).toHaveLength(0);
  });

  it('DB 命中时符号解析为文件路径', async () => {
    // 创建 DB 文件让 fs.existsSync 返回 true（避免 spy 内置模块）
    const dbPath = path.join(tempDir, '.routedev', 'code-map', 'code-map.db');
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, 'fake db content');
    mocks.getNodeByName.mockReturnValue([
      { filePath: 'src/models/my-class.ts' },
    ]);

    const mentions = parseMentions('查看 @MyClass', tempDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('symbol');
    expect(mentions[0].resolved).toBe('src/models/my-class.ts');
  });
});

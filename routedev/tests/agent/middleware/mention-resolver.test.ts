// tests/agent/middleware/mention-resolver.test.ts
// Phase 71 Task B2：@-mention 解析中间件测试
// 覆盖：mentions 注入 / 标准化替换 / fail-open / 无 mention 透传

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// 用 vi.hoisted 提升 mock 函数，使其在 vi.mock 工厂中可引用
const mocks = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  getNodeByName: vi.fn(),
  parseMentions: vi.fn(),
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

import { MentionResolverMiddleware } from '../../../src/agent/middleware/mention-resolver.js';
import type { MiddlewareContext } from '../../../src/agent/middleware.js';

describe('MentionResolverMiddleware - @-mention 解析中间件', () => {
  let tempDir: string;
  let middleware: MentionResolverMiddleware;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mention-resolver-'));
    middleware = new MentionResolverMiddleware(tempDir);
    // 默认 DB 不存在，getNodeByName 返回空（符号 fail-open 退化为符号名本身）
    mocks.getNodeByName.mockReturnValue([]);
    mocks.initDatabase.mockReturnValue({ close: vi.fn() });
  });

  /** 构造一个带 userMessage 的 MiddlewareContext */
  function makeCtx(userMessage: string): MiddlewareContext {
    return {
      phase: 'onUserMessage',
      metadata: { userMessage },
    };
  }

  /** next 回调桩 */
  const noopNext = async (): Promise<void> => {};

  it('@-mention 被解析后注入 ctx.metadata.mentions', async () => {
    const ctx = makeCtx('查看 @src/foo.ts');
    await middleware.getHandler()(ctx, noopNext);

    const mentions = ctx.metadata.mentions as Array<{ type: string; raw: string }>;
    expect(Array.isArray(mentions)).toBe(true);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('file');
    expect(mentions[0].raw).toBe('src/foo.ts');
    expect(mentions[0].resolved).toBe(path.resolve(tempDir, 'src/foo.ts'));
  });

  it('标准化替换：@src/foo.ts → @/abs/path/foo.ts', async () => {
    const ctx = makeCtx('请查看 @src/foo.ts 的内容');
    await middleware.getHandler()(ctx, noopNext);

    const transformed = ctx.metadata.userMessage as string;
    const absPath = path.resolve(tempDir, 'src/foo.ts');
    expect(transformed).toBe(`请查看 @${absPath} 的内容`);
    // 原始 @src/foo.ts 不应残留
    expect(transformed).not.toContain('@src/foo.ts');
  });

  it('解析失败时不阻塞（fail-open）', async () => {
    // 模拟 parseMentions 抛异常：通过让 getNodeByName 抛异常触发 resolveSymbol 的 catch
    // 但 resolveSymbol 内部已 catch，不会抛出。改用破坏 userMessage 类型来触发 catch
    // 更直接的方式：让 initDatabase 抛异常（resolveSymbol 内 try/catch 会捕获）
    mocks.initDatabase.mockImplementation(() => {
      throw new Error('DB corrupted');
    });
    // 创建 DB 文件让 fs.existsSync 返回 true，触发 initDatabase 调用
    const dbPath = path.join(tempDir, '.routedev', 'code-map', 'code-map.db');
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, 'fake');

    const ctx = makeCtx('查看 @MyClass');
    // 不应抛异常
    await expect(middleware.getHandler()(ctx, noopNext)).resolves.toBeUndefined();
    // fail-open：userMessage 仍可读（可能未标准化但不应消失）
    expect(ctx.metadata.userMessage).toBeDefined();
  });

  it('无 mention 时正常透传', async () => {
    const ctx = makeCtx('普通文本无 mention');
    await middleware.getHandler()(ctx, noopNext);

    // mentions 为空数组
    const mentions = ctx.metadata.mentions as unknown[];
    expect(Array.isArray(mentions)).toBe(true);
    expect(mentions).toHaveLength(0);
    // userMessage 不变
    expect(ctx.metadata.userMessage).toBe('普通文本无 mention');
  });

  it('无 userMessage 时正常透传', async () => {
    // 模拟 loop.ts 未设置 metadata.userMessage 的情况
    const ctx: MiddlewareContext = {
      phase: 'onUserMessage',
      metadata: {},
    };
    await middleware.getHandler()(ctx, noopNext);
    // 不应注入 mentions
    expect(ctx.metadata.mentions).toBeUndefined();
  });

  it('符号 mention 在 DB 未命中时保持原样（raw === resolved 不替换）', async () => {
    const ctx = makeCtx('查看 @MyClass');
    await middleware.getHandler()(ctx, noopNext);

    const mentions = ctx.metadata.mentions as Array<{ type: string; raw: string; resolved: string }>;
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe('symbol');
    // DB 未命中，resolved === raw，不替换
    expect(mentions[0].resolved).toBe('MyClass');
    // userMessage 中的 @MyClass 保持原样
    expect(ctx.metadata.userMessage).toBe('查看 @MyClass');
  });
});

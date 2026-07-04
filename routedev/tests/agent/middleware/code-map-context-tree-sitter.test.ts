// tests/agent/middleware/code-map-context-tree-sitter.test.ts
// Phase 41/42：CodeMapContextMiddleware tree-sitter 接入测试
// 覆盖：tree-sitter 正常路径 / 失败降级 regex / 首次 fullIndex 后续复用 /
//       getIndexStatus 判断 / 空查询不报错 / 结果注入 systemPrompt

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// 用 vi.hoisted 提升 mock 函数，使其在 vi.mock 工厂中可引用
const mocks = vi.hoisted(() => ({
  fullIndex: vi.fn(),
  incrementalIndex: vi.fn(),
  explore: vi.fn(),
  getIndexStatus: vi.fn(),
  incrementalScan: vi.fn(),
}));

vi.mock('../../../src/code-map/indexer.js', () => ({
  fullIndex: mocks.fullIndex,
  incrementalIndex: mocks.incrementalIndex,
}));

vi.mock('../../../src/code-map/querier.js', () => ({
  explore: mocks.explore,
}));

vi.mock('../../../src/code-map/database.js', () => ({
  getIndexStatus: mocks.getIndexStatus,
}));

vi.mock('../../../src/tools/repo-map.js', () => ({
  incrementalScan: mocks.incrementalScan,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { CodeMapContextMiddleware } from '../../../src/agent/middleware/code-map-context.js';
import type { MiddlewareContext } from '../../../src/agent/middleware.js';
import type { CodeMapNode, IndexStatus } from '../../../src/code-map/schema.js';

// 测试夹具：fake db 对象（middleware 仅作为引用传递，不实际调用其方法）
const fakeDb = { id: 'fake-db' } as unknown;

const fakeStatus: IndexStatus = {
  fileCount: 10,
  nodeCount: 50,
  edgeCount: 20,
  lastIndexedAt: '2026-07-04T00:00:00Z',
  initialized: true,
};

const fakeNodes: CodeMapNode[] = [
  {
    id: 'src/auth/login.ts:0:login',
    name: 'login',
    kind: 'function',
    filePath: 'src/auth/login.ts',
    startLine: 0,
    endLine: 10,
    signature: '(user: string): Promise<void>',
    exported: true,
  },
];

describe('CodeMapContextMiddleware - tree-sitter 接入', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-map-tree-sitter-'));

    // 默认 mock：tree-sitter 路径全部成功
    mocks.fullIndex.mockResolvedValue({ stats: {}, db: fakeDb });
    mocks.incrementalIndex.mockResolvedValue({ stats: {}, db: fakeDb });
    mocks.explore.mockReturnValue({
      query: '',
      nodes: fakeNodes,
      snippets: [],
      callPaths: [],
      impactRadius: 0,
    });
    mocks.getIndexStatus.mockReturnValue(fakeStatus);
    mocks.incrementalScan.mockResolvedValue([]);
  });

  // ===== 用例 1：tree-sitter 正常路径 =====
  it('tree-sitter 正常路径：fullIndex + explore 结果注入 systemPrompt', async () => {
    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '你是 AI 助手',
      metadata: { userQuery: 'login' },
    };

    await handler(ctx, async () => {});

    expect(mocks.fullIndex).toHaveBeenCalledTimes(1);
    expect(mocks.fullIndex).toHaveBeenCalledWith(tempDir, { maxFiles: 5000 });
    expect(mocks.explore).toHaveBeenCalledWith(
      fakeDb,
      'login',
      tempDir,
      expect.objectContaining({ maxResults: 10, includeSnippets: false }),
    );
    expect(ctx.systemPrompt).toContain('你是 AI 助手');
    expect(ctx.systemPrompt).toContain('<project_structure>');
    expect(ctx.systemPrompt).toContain('indexed_files: 10');
    expect(ctx.systemPrompt).toContain('<related_files>');
    expect(ctx.systemPrompt).toContain('src/auth/login.ts');
    expect(ctx.systemPrompt).toContain('symbol: login (function)');
    expect(ctx.systemPrompt).toContain('signature: (user: string): Promise<void>');
    expect(ctx.metadata.codeMapEngine).toBe('tree-sitter');
    expect(ctx.metadata.codeMapInjected).toBe(true);
    expect(ctx.metadata.codeMapFileCount).toBe(10);
    expect(ctx.metadata.codeMapRelatedCount).toBe(1);
  });

  // ===== 用例 2：失败降级 regex =====
  it('fullIndex 失败时降级到 regex incrementalScan', async () => {
    mocks.fullIndex.mockRejectedValue(new Error('tree-sitter wasm not loaded'));
    mocks.incrementalScan.mockResolvedValue([
      {
        path: 'src/index.ts',
        exports: ['main'],
        signatures: ['export function main() {}'],
        language: 'typescript',
      },
    ]);

    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '你是 AI 助手',
      metadata: { userQuery: 'main' },
    };

    await handler(ctx, async () => {});

    expect(mocks.fullIndex).toHaveBeenCalledTimes(1);
    expect(mw.engineFailed).toBe(true);
    expect(mocks.incrementalScan).toHaveBeenCalledTimes(1);
    expect(ctx.systemPrompt).toContain('src/index.ts');
    expect(ctx.systemPrompt).toContain('export function main() {}');
    expect(ctx.metadata.codeMapEngine).toBe('regex');
    expect(ctx.metadata.codeMapInjected).toBe(true);
  });

  // ===== 用例 3：首次 fullIndex 后续复用 db =====
  it('首次 fullIndex 后续调用复用 db，不重复 fullIndex', async () => {
    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx1: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: {},
    };
    await handler(ctx1, async () => {});

    const ctx2: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: { userQuery: 'login' },
    };
    await handler(ctx2, async () => {});

    // fullIndex 只调用 1 次（首次）
    expect(mocks.fullIndex).toHaveBeenCalledTimes(1);
    // 第二次复用 db，节流间隔内不触发 incrementalIndex
    expect(mocks.incrementalIndex).not.toHaveBeenCalled();
    // 两次都应注入 systemPrompt
    expect(ctx1.metadata.codeMapInjected).toBe(true);
    expect(ctx2.metadata.codeMapInjected).toBe(true);
    // 第二次有 userQuery，应调用 explore
    expect(mocks.explore).toHaveBeenCalledWith(
      fakeDb,
      'login',
      tempDir,
      expect.objectContaining({ maxResults: 10 }),
    );
  });

  // ===== 用例 4：getIndexStatus 判断 =====
  it('getIndexStatus 返回状态注入 systemPrompt 与 metadata', async () => {
    const customStatus: IndexStatus = {
      fileCount: 42,
      nodeCount: 100,
      edgeCount: 80,
      lastIndexedAt: '2026-07-04T12:00:00Z',
      initialized: true,
    };
    mocks.getIndexStatus.mockReturnValue(customStatus);

    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: {},
    };

    await handler(ctx, async () => {});

    // getIndexStatus 在 ensureIndex 和 handleTreeSitter 中都被调用
    expect(mocks.getIndexStatus).toHaveBeenCalledWith(fakeDb);
    expect(ctx.systemPrompt).toContain('indexed_files: 42');
    expect(ctx.systemPrompt).toContain('indexed_symbols: 100');
    expect(ctx.systemPrompt).toContain('indexed_edges: 80');
    expect(ctx.systemPrompt).toContain('last_indexed_at: 2026-07-04T12:00:00Z');
    expect(ctx.metadata.codeMapFileCount).toBe(42);
  });

  // ===== 用例 5：空查询不报错 =====
  it('空查询时 explore 不被调用，handler 不报错', async () => {
    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: { userQuery: '' },
    };

    await handler(ctx, async () => {});

    expect(mocks.explore).not.toHaveBeenCalled();
    expect(ctx.metadata.codeMapInjected).toBe(true);
    expect(ctx.metadata.codeMapRelatedCount).toBe(0);
    expect(ctx.systemPrompt).toContain('<project_structure>');
    // 无相关文件时不应注入 <related_files>
    expect(ctx.systemPrompt).not.toContain('<related_files>');
  });

  // ===== 用例 6：explore 结果注入 systemPrompt（详细格式验证）=====
  it('explore 结果按 <related_files> 格式注入 systemPrompt', async () => {
    const customNodes: CodeMapNode[] = [
      {
        id: 'src/utils/math.ts:0:add',
        name: 'add',
        kind: 'function',
        filePath: 'src/utils/math.ts',
        startLine: 0,
        endLine: 5,
        signature: '(a: number, b: number): number',
        exported: true,
      },
      {
        id: 'src/utils/math.ts:10:subtract',
        name: 'subtract',
        kind: 'function',
        filePath: 'src/utils/math.ts',
        startLine: 10,
        endLine: 15,
        signature: '(a: number, b: number): number',
        exported: true,
      },
    ];
    mocks.explore.mockReturnValue({
      query: 'math',
      nodes: customNodes,
      snippets: [],
      callPaths: [],
      impactRadius: 0,
    });

    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '原 prompt',
      metadata: { userQuery: 'math' },
    };

    await handler(ctx, async () => {});

    // 原 prompt 保留
    expect(ctx.systemPrompt).toContain('原 prompt');
    // project_structure 段落
    expect(ctx.systemPrompt).toContain('<project_structure>');
    expect(ctx.systemPrompt).toContain('</project_structure>');
    // related_files 段落
    expect(ctx.systemPrompt).toContain('<related_files>');
    expect(ctx.systemPrompt).toContain('</related_files>');
    // 节点 1：add
    expect(ctx.systemPrompt).toContain('src/utils/math.ts');
    expect(ctx.systemPrompt).toContain('symbol: add (function)');
    expect(ctx.systemPrompt).toContain('signature: (a: number, b: number): number');
    // 节点 2：subtract
    expect(ctx.systemPrompt).toContain('symbol: subtract (function)');
    // metadata 计数
    expect(ctx.metadata.codeMapRelatedCount).toBe(2);
    expect(ctx.metadata.codeMapEngine).toBe('tree-sitter');
  });

  // ===== 补充用例：engineFailed 后不再尝试 tree-sitter =====
  it('engineFailed 后下次调用直接走 regex 路径', async () => {
    mocks.fullIndex.mockRejectedValueOnce(new Error('first fail'));
    mocks.incrementalScan.mockResolvedValue([
      {
        path: 'src/a.ts',
        exports: ['a'],
        signatures: [],
        language: 'typescript',
      },
    ]);

    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    // 第一次：fullIndex 失败，降级 regex
    const ctx1: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: {},
    };
    await handler(ctx1, async () => {});
    expect(mw.engineFailed).toBe(true);
    expect(ctx1.metadata.codeMapEngine).toBe('regex');

    // 第二次：直接走 regex，不再调 fullIndex
    mocks.fullIndex.mockClear();
    const ctx2: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: {},
    };
    await handler(ctx2, async () => {});

    expect(mocks.fullIndex).not.toHaveBeenCalled();
    expect(ctx2.metadata.codeMapEngine).toBe('regex');
  });
});

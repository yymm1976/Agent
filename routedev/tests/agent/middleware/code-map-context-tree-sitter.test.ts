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
  getTopFilesByRank: vi.fn(),
  getTopSymbolsByFile: vi.fn(),
  countTokens: vi.fn(),
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
  getTopFilesByRank: mocks.getTopFilesByRank,
  getTopSymbolsByFile: mocks.getTopSymbolsByFile,
}));

vi.mock('../../../src/code-map/token-counter.js', () => ({
  countTokens: mocks.countTokens,
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
    // top 文件清单默认返回空数组（不注入文件清单，简化断言）
    mocks.getTopFilesByRank.mockReturnValue([]);
    mocks.getTopSymbolsByFile.mockReturnValue([]);
    // countTokens 默认返回 1（确保不会触发预算截断）
    mocks.countTokens.mockReturnValue(1);
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

  // ===== 新增用例 7：handleTreeSitter 注入 top 文件清单（按 PageRank 排序）=====
  it('handleTreeSitter 注入 top 文件清单（对标 regex 路径 formatSummary）', async () => {
    mocks.getTopFilesByRank.mockReturnValue([
      { filePath: 'src/auth/login.ts', nodeCount: 5 },
      { filePath: 'src/auth/session.ts', nodeCount: 3 },
    ]);
    mocks.getTopSymbolsByFile.mockImplementation((_db: unknown, filePath: string) => {
      if (filePath === 'src/auth/login.ts') {
        return [
          { name: 'login', kind: 'function', signature: 'export function login(user: string): Promise<void>' },
          { name: 'logout', kind: 'function', signature: 'export function logout(): void' },
        ];
      }
      return [{ name: 'createSession', kind: 'function', signature: 'export function createSession(): Session' }];
    });

    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: { userQuery: '' },
    };

    await handler(ctx, async () => {});

    // top 文件清单注入到 <project_structure>
    expect(ctx.systemPrompt).toContain('<project_structure>');
    expect(ctx.systemPrompt).toContain('src/auth/login.ts');
    expect(ctx.systemPrompt).toContain('src/auth/session.ts');
    expect(ctx.systemPrompt).toContain('export function login(user: string): Promise<void>');
    expect(ctx.systemPrompt).toContain('export function logout(): void');
    expect(ctx.systemPrompt).toContain('export function createSession(): Session');
    // 统计数字也保留
    expect(ctx.systemPrompt).toContain('indexed_files: 10');
    // getTopFilesByRank 调用 limit=50
    expect(mocks.getTopFilesByRank).toHaveBeenCalledWith(fakeDb, 50);
    // getTopSymbolsByFile 调用 limit=3
    expect(mocks.getTopSymbolsByFile).toHaveBeenCalledWith(fakeDb, 'src/auth/login.ts', 3);
  });

  // ===== 新增用例 8：token 预算超限时优先保留 <related_files> =====
  it('token 预算超限：统计数字始终保留，related_files 优先于文件清单', async () => {
    // 让 countTokens 返回大值触发预算截断
    // statsTokens ≈ 4 行 × 100 = 400；filesBudget = (2048-400)*0.4 ≈ 590
    // relatedBudget = 2048 - projectTokens
    mocks.countTokens.mockImplementation((text: string) => {
      // 简单按文本长度估算，让 filesBlock 容易超预算
      return Math.ceil(text.length / 4);
    });
    mocks.getTopFilesByRank.mockReturnValue([
      { filePath: 'src/a.ts', nodeCount: 1 },
      { filePath: 'src/b.ts', nodeCount: 1 },
      { filePath: 'src/c.ts', nodeCount: 1 },
    ]);
    mocks.getTopSymbolsByFile.mockReturnValue([]);

    const mw = new CodeMapContextMiddleware(tempDir, 200); // 极小预算触发截断
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: { userQuery: 'login' },
    };

    await handler(ctx, async () => {});

    // 统计数字始终保留
    expect(ctx.systemPrompt).toContain('indexed_files: 10');
    expect(ctx.systemPrompt).toContain('indexed_symbols: 50');
    // <related_files> 段落存在（优先保留）
    expect(ctx.systemPrompt).toContain('<related_files>');
    expect(ctx.systemPrompt).toContain('src/auth/login.ts');
  });

  // ===== 新增用例 9：snippet 渲染（前 5 行带行号）=====
  it('handleTreeSitter 渲染 top 3 节点的 snippet（前 5 行带行号）', async () => {
    // 创建实际文件供 readTopSnippets 异步读取
    const fileContent = 'export function login() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  return a + b;\n}\n';
    await fs.mkdir(path.join(tempDir, 'src/auth'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src/auth/login.ts'), fileContent, 'utf-8');

    const customNodes: CodeMapNode[] = [
      {
        id: 'src/auth/login.ts:0:login',
        name: 'login',
        kind: 'function',
        filePath: 'src/auth/login.ts',
        startLine: 0,
        endLine: 7,
        signature: '(): void',
        exported: true,
      },
    ];
    mocks.explore.mockReturnValue({
      query: 'login',
      nodes: customNodes,
      snippets: [],
      callPaths: [],
      impactRadius: 0,
    });

    const mw = new CodeMapContextMiddleware(tempDir);
    const handler = mw.getHandler();

    const ctx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: { userQuery: 'login' },
    };

    await handler(ctx, async () => {});

    // <related_files> 中包含 snippet 段落
    expect(ctx.systemPrompt).toContain('<related_files>');
    expect(ctx.systemPrompt).toContain('snippet:');
    // 前 5 行带行号（1-based）
    expect(ctx.systemPrompt).toContain('1: export function login() {');
    expect(ctx.systemPrompt).toContain('2:   const a = 1;');
    expect(ctx.systemPrompt).toContain('5:   const d = 4;');
  });

  // ===== 新增用例 10：构造函数接收 budgetTokens（默认 2048）=====
  it('构造函数：未传 budgetTokens 时默认 2048，传入时使用指定值', async () => {
    const mw1 = new CodeMapContextMiddleware(tempDir);
    const handler1 = mw1.getHandler();
    const ctx1: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: {},
    };
    await handler1(ctx1, async () => {});
    // 默认预算 2048 不会触发截断（countTokens mock 返回 1）
    expect(ctx1.systemPrompt).toContain('<project_structure>');

    // 传入预算 100，仍然能注入统计数字（始终保留）
    const mw2 = new CodeMapContextMiddleware(tempDir, 100);
    const handler2 = mw2.getHandler();
    const ctx2: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt: '',
      metadata: {},
    };
    await handler2(ctx2, async () => {});
    expect(ctx2.systemPrompt).toContain('indexed_files: 10');
  });
});

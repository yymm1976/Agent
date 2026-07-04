// tests/tools/code-graph-query.test.ts
// 短板 2 修复：code_graph_query 工具测试
// 验证 4 种查询模式：find_callers / find_callees / impact_analysis / search_symbols

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodeGraphQueryTool } from '../../src/tools/builtin/code-graph-query.js';
import {
  initDatabase,
  insertFile,
  insertNode,
  insertEdge,
  close,
  type DB,
} from '../../src/code-map/database.js';
import type { CodeMapNode, CodeMapFile, CodeMapEdge } from '../../src/code-map/schema.js';

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'code-graph-query-test-'));
  dbPath = path.join(tempDir, '.routedev', 'code-map', 'code-map.db');
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

// ---- 测试数据构造辅助 ----

function makeFile(filePath: string): CodeMapFile {
  return {
    path: filePath,
    language: 'typescript',
    contentHash: 'hash-' + filePath,
    lineCount: 10,
    indexedAt: new Date().toISOString(),
  };
}

function makeNode(opts: {
  id: string;
  name: string;
  kind: CodeMapNode['kind'];
  filePath: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  exported?: boolean;
  className?: string;
  rankScore?: number;
}): CodeMapNode {
  return {
    id: opts.id,
    name: opts.name,
    kind: opts.kind,
    filePath: opts.filePath,
    startLine: opts.startLine ?? 0,
    endLine: opts.endLine ?? 5,
    signature: opts.signature,
    exported: opts.exported,
    className: opts.className,
    rankScore: opts.rankScore ?? 0,
  };
}

function makeEdge(
  source: string,
  target: string,
  kind: CodeMapEdge['kind'] = 'CALLS',
): CodeMapEdge {
  return {
    id: `${source}->${target}:${kind}`,
    source,
    target,
    kind,
    weight: 1.0,
  };
}

/**
 * 构建测试 DB：
 *   handler.ts:handleRequest  →  service.ts:fetchUser  →  utils.ts:formatDate
 *   (CALLS 边：handleRequest 调用 fetchUser，fetchUser 调用 formatDate)
 */
function setupDB(): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = initDatabase(dbPath);

  insertFile(db, makeFile('src/service.ts'));
  insertFile(db, makeFile('src/handler.ts'));
  insertFile(db, makeFile('src/utils.ts'));

  insertNode(
    db,
    makeNode({
      id: 'src/service.ts:0:fetchUser',
      name: 'fetchUser',
      kind: 'function',
      filePath: 'src/service.ts',
      startLine: 0,
      endLine: 5,
      signature: '(id: string): Promise<User>',
      exported: true,
      rankScore: 0.9,
    }),
  );
  insertNode(
    db,
    makeNode({
      id: 'src/handler.ts:0:handleRequest',
      name: 'handleRequest',
      kind: 'function',
      filePath: 'src/handler.ts',
      startLine: 0,
      endLine: 10,
      signature: '(req: Request): Promise<void>',
      exported: true,
      rankScore: 0.8,
    }),
  );
  insertNode(
    db,
    makeNode({
      id: 'src/utils.ts:0:formatDate',
      name: 'formatDate',
      kind: 'function',
      filePath: 'src/utils.ts',
      startLine: 0,
      endLine: 3,
      signature: '(d: Date): string',
      exported: true,
      rankScore: 0.5,
    }),
  );

  // CALLS 边
  insertEdge(
    db,
    makeEdge('src/handler.ts:0:handleRequest', 'src/service.ts:0:fetchUser'),
  );
  insertEdge(
    db,
    makeEdge('src/service.ts:0:fetchUser', 'src/utils.ts:0:formatDate'),
  );

  return db;
}

describe('CodeGraphQueryTool', () => {
  // ---- validateArgs ----

  it('validateArgs 拒绝无效 action', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'invalid_action' });
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('action'))).toBe(true);
  });

  it('validateArgs 拒绝缺失 action', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({});
    expect(v.valid).toBe(false);
  });

  it('validateArgs 要求 find_callers 提供 symbol', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'find_callers' });
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('symbol'))).toBe(true);
  });

  it('validateArgs 要求 find_callees 提供 symbol', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'find_callees' });
    expect(v.valid).toBe(false);
  });

  it('validateArgs 要求 impact_analysis 提供 symbol 或 filePath', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'impact_analysis' });
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('symbol') || e.includes('filePath'))).toBe(true);
  });

  it('validateArgs 接受 impact_analysis 的 symbol', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'impact_analysis', symbol: 'foo' });
    expect(v.valid).toBe(true);
  });

  it('validateArgs 接受 impact_analysis 的 filePath', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'impact_analysis', filePath: 'src/foo.ts' });
    expect(v.valid).toBe(true);
  });

  it('validateArgs 要求 search_symbols 提供 query', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'search_symbols' });
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('query'))).toBe(true);
  });

  it('validateArgs 拒绝非数字 maxDepth', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'impact_analysis', symbol: 'foo', maxDepth: 'three' });
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('maxDepth'))).toBe(true);
  });

  it('validateArgs 接受合法 find_callers', () => {
    const tool = new CodeGraphQueryTool();
    const v = tool.validateArgs({ action: 'find_callers', symbol: 'foo', fileHint: 'src/' });
    expect(v.valid).toBe(true);
  });

  // ---- fail-open: DB 不存在 ----

  it('DB 不存在时 fail-open 返回提示', async () => {
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'find_callers', symbol: 'foo' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('代码地图尚未索引');
    expect(result.metadata?.reason).toBe('db-not-found');
  });

  // ---- find_callers ----

  it('find_callers 返回调用者列表', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'find_callers', symbol: 'fetchUser' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('handleRequest');
    expect(result.output).toContain('src/handler.ts');
    expect(result.metadata?.count).toBe(1);
  });

  it('find_callers 零结果时返回提示', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'find_callers', symbol: 'nonExistentSymbol' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('未找到');
    expect(result.metadata?.count).toBe(0);
  });

  it('find_callers 支持 fileHint 过滤', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    // fileHint 匹配 handler.ts → 应返回 handleRequest
    const matched = await tool.execute(
      { action: 'find_callers', symbol: 'fetchUser', fileHint: 'handler' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(matched.success).toBe(true);
    expect(matched.metadata?.count).toBe(1);

    // fileHint 不匹配 → 零结果
    const filtered = await tool.execute(
      { action: 'find_callers', symbol: 'fetchUser', fileHint: 'nomatch' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(filtered.success).toBe(true);
    expect(filtered.metadata?.count).toBe(0);
  });

  // ---- find_callees ----

  it('find_callees 返回被调用者列表', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'find_callees', symbol: 'fetchUser' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('formatDate');
    expect(result.output).toContain('src/utils.ts');
    expect(result.metadata?.count).toBe(1);
  });

  it('find_callees 顶层符号零结果时返回提示', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'find_callees', symbol: 'formatDate' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('未找到');
  });

  // ---- impact_analysis ----

  it('impact_analysis 按 symbol 返回影响半径', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    // formatDate 被 fetchUser 调用，fetchUser 被 handleRequest 调用
    // 反向 BFS：formatDate → fetchUser → handleRequest
    const result = await tool.execute(
      { action: 'impact_analysis', symbol: 'formatDate', maxDepth: 3 },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('formatDate');
    expect(result.output).toContain('fetchUser');
    expect(result.output).toContain('handleRequest');
    expect(result.metadata?.totalCount).toBe(3);
    expect(result.metadata?.fileCount).toBe(3);
  });

  it('impact_analysis 按 filePath 返回影响半径', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'impact_analysis', filePath: 'src/utils.ts' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('src/utils.ts');
    // utils.ts 中的 formatDate 被 fetchUser 调用
    expect(result.output).toContain('fetchUser');
  });

  it('impact_analysis 默认 maxDepth=3', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'impact_analysis', symbol: 'formatDate' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.maxDepth).toBe(3);
  });

  it('impact_analysis 零结果时返回提示', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'impact_analysis', symbol: 'nonExistentSymbol' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('未找到');
  });

  // ---- search_symbols ----

  it('search_symbols 按关键词搜索符号', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'search_symbols', query: 'fetch' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('fetchUser');
    expect(result.metadata?.count).toBeGreaterThanOrEqual(1);
  });

  it('search_symbols 按签名关键词搜索', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    // signature 包含 'Date'（formatDate 的签名是 (d: Date): string）
    const result = await tool.execute(
      { action: 'search_symbols', query: 'Date' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('formatDate');
  });

  it('search_symbols 零结果时返回提示', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    const result = await tool.execute(
      { action: 'search_symbols', query: 'zzzNoMatch' },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('未找到');
  });

  it('search_symbols 尊重 maxResults 参数', async () => {
    const db = setupDB();
    close(db);
    const tool = new CodeGraphQueryTool();
    // 搜索 'e'（匹配多个符号名），限制 maxResults=1
    const result = await tool.execute(
      { action: 'search_symbols', query: 'e', maxResults: 1 },
      { workingDirectory: tempDir, allowedDirectories: [tempDir] },
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.count).toBeLessThanOrEqual(1);
  });

  // ---- 工具定义 ----

  it('工具定义为 code 分类且不需审批', () => {
    const tool = new CodeGraphQueryTool();
    expect(tool.definition.name).toBe('code_graph_query');
    expect(tool.definition.category).toBe('code');
    expect(tool.definition.requiresApproval).toBe(false);
  });
});

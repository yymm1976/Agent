// tests/code-map/engine.test.ts
// CodeMap 引擎测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initParser, parseFile } from '../../src/code-map/parser.js';
import { extractFromTree } from '../../src/code-map/extractor.js';
import { computePageRank } from '../../src/code-map/ranker.js';
import { distillContext } from '../../src/code-map/compression.js';
import { renderCodeMap } from '../../src/code-map/renderer.js';
import {
  initDatabase,
  insertFile,
  insertNode,
  insertEdge,
  deleteFileNodes,
  getAllNodes,
  getAllEdges,
  getNodeByName,
  getCallers,
  getCallees,
  close,
  type DB,
} from '../../src/code-map/database.js';
import {
  fullIndex,
  incrementalIndex,
  computeContentHash,
} from '../../src/code-map/indexer.js';
import {
  explore,
  findCallers,
  analyzeImpact,
  getFileStructure,
  getStatus,
} from '../../src/code-map/querier.js';
import type { CodeMapNode, CodeMapFile } from '../../src/code-map/schema.js';

let tempDir: string;
let dbPath: string;
let db: DB;

async function writeFile(relPath: string, content: string): Promise<string> {
  const fullPath = path.join(tempDir, relPath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'code-map-test-'));
  dbPath = path.join(tempDir, '.routedev', 'code-map', 'code-map.db');
  await initParser();
  db = initDatabase(dbPath);
});

afterEach(async () => {
  try { close(db); } catch { /* ignore */ }
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('CodeMap Engine', () => {
  // 1. 解析 TS 文件提取 function
  it('should extract function from TS file', async () => {
    const code = `function greet(name: string): string { return 'hello'; }`;
    const result = await parseFile('test.ts', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const funcs = extracted.nodes.filter(n => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0].name).toBe('greet');
    expect(funcs[0].startLine).toBe(0);
  });

  // 2. 解析 TS 文件提取 class + method
  it('should extract class and method from TS file', async () => {
    const code = `class Foo {\n  bar(): void {}\n  static baz(): number { return 1; }\n}`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const classes = extracted.nodes.filter(n => n.kind === 'class');
    const methods = extracted.nodes.filter(n => n.kind === 'method');
    expect(classes.length).toBe(1);
    expect(classes[0].name).toBe('Foo');
    expect(methods.length).toBe(2);
    expect(methods.some(m => m.name === 'bar')).toBe(true);
    expect(methods.some(m => m.name === 'baz' && m.static === true)).toBe(true);
  });

  // 3. 解析 TS 文件提取 interface
  it('should extract interface from TS file', async () => {
    const code = `interface IConfig {\n  name: string;\n  value: number;\n}`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const interfaces = extracted.nodes.filter(n => n.kind === 'interface');
    expect(interfaces.length).toBe(1);
    expect(interfaces[0].name).toBe('IConfig');
  });

  // 4. 解析 TS 文件提取 arrow function
  it('should extract arrow function from TS file', async () => {
    const code = `const add = (a: number, b: number): number => a + b;`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const arrows = extracted.nodes.filter(n => n.kind === 'arrow_function');
    expect(arrows.length).toBe(1);
    expect(arrows[0].name).toBe('add');
  });

  // 5. 解析 TS 文件提取 import 语句
  it('should extract import statement from TS file', async () => {
    const code = `import { foo, bar } from './utils';`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const imports = extracted.nodes.filter(n => n.kind === 'import');
    expect(imports.length).toBe(1);
    expect(imports[0].sourceModule).toBe('./utils');
    expect(imports[0].importedNames).toContain('foo');
    expect(imports[0].importedNames).toContain('bar');
  });

  // 6. 验证 CALLS 边（函数调用）
  it('should extract CALLS edge', async () => {
    const code = `function greet() { return helper(); }`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const callsEdges = extracted.edges.filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBeGreaterThan(0);
    expect(callsEdges.some(e => e.target === 'helper')).toBe(true);
  });

  // 7. 验证 IMPORTS 边
  it('should extract IMPORTS edge', async () => {
    const code = `import { foo } from './utils';`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const importsEdges = extracted.edges.filter(e => e.kind === 'IMPORTS');
    expect(importsEdges.length).toBe(1);
    expect(importsEdges[0].target).toBe('./utils');
  });

  // 8. 验证 EXTENDS 边（class A extends B）
  it('should extract EXTENDS edge', async () => {
    const code = `class Dog extends Animal { }`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const extendsEdges = extracted.edges.filter(e => e.kind === 'EXTENDS');
    expect(extendsEdges.length).toBe(1);
    expect(extendsEdges[0].target).toBe('Animal');
  });

  // 9. 验证 IMPLEMENTS 边
  it('should extract IMPLEMENTS edge', async () => {
    const code = `class Dog implements IAnimal { }`;
    const result = await parseFile('test.ts', code);
    const extracted = extractFromTree(result!.tree, 'test.ts', 'typescript');
    const implEdges = extracted.edges.filter(e => e.kind === 'IMPLEMENTS');
    expect(implEdges.length).toBe(1);
    expect(implEdges[0].target).toBe('IAnimal');
  });

  // 10. 解析 Python 文件提取 function/class
  it('should extract function and class from Python file', async () => {
    const code = `def greet(name):\n    return name\n\nclass Animal:\n    def speak(self):\n        return "..."`;
    const result = await parseFile('test.py', code);
    expect(result).not.toBeNull();
    const extracted = extractFromTree(result!.tree, 'test.py', 'python');
    const funcs = extracted.nodes.filter(n => n.kind === 'function');
    const classes = extracted.nodes.filter(n => n.kind === 'class');
    expect(funcs.length).toBe(1);
    expect(funcs[0].name).toBe('greet');
    expect(classes.length).toBe(1);
    expect(classes[0].name).toBe('Animal');
  });

  // 11. 解析 Python 文件提取 import
  it('should extract import from Python file', async () => {
    const code = `import os\nfrom typing import List`;
    const result = await parseFile('test.py', code);
    const extracted = extractFromTree(result!.tree, 'test.py', 'python');
    const imports = extracted.nodes.filter(n => n.kind === 'import');
    expect(imports.length).toBe(2);
    expect(imports.some(i => i.sourceModule === 'os')).toBe(true);
    expect(imports.some(i => i.sourceModule === 'typing' && i.importedNames?.includes('List'))).toBe(true);
  });

  // 12. PageRank star 图中心节点得分最高
  it('PageRank: center node in star graph has highest score', () => {
    const nodes = ['center', 'a', 'b', 'c', 'd'];
    const edges = [
      { source: 'a', target: 'center', weight: 1 },
      { source: 'b', target: 'center', weight: 1 },
      { source: 'c', target: 'center', weight: 1 },
      { source: 'd', target: 'center', weight: 1 },
    ];
    const scores = computePageRank(nodes, edges);
    const centerScore = scores.get('center') ?? 0;
    const aScore = scores.get('a') ?? 0;
    expect(centerScore).toBeGreaterThan(aScore);
    expect(centerScore).toBeGreaterThan(scores.get('b') ?? 0);
  });

  // 13. PageRank 链式图正确计算
  it('PageRank: chain graph computes correctly', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'b', target: 'c', weight: 1 },
    ];
    const scores = computePageRank(nodes, edges);
    expect(scores.size).toBe(3);
    // c should have higher score than a (more incoming)
    expect(scores.get('c') ?? 0).toBeGreaterThan(scores.get('a') ?? 0);
  });

  // 14. PageRank 环形图收敛
  it('PageRank: ring graph converges', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const edges = [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'b', target: 'c', weight: 1 },
      { source: 'c', target: 'd', weight: 1 },
      { source: 'd', target: 'a', weight: 1 },
    ];
    const scores = computePageRank(nodes, edges, { maxIterations: 100 });
    // In a symmetric ring, all scores should be approximately equal
    const vals = Array.from(scores.values());
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    expect(max - min).toBeLessThan(0.01);
  });

  // 15. content_hash 变化触发重新索引
  it('should reindex when content_hash changes', async () => {
    const filePath = await writeFile('src/test.ts', 'function foo() {}');
    const result1 = await (async () => {
      const { indexFile } = await import('../../src/code-map/indexer.js');
      return indexFile(db, tempDir, filePath);
    })();
    expect(result1.skipped).toBe(false);

    // 修改文件内容
    await writeFile('src/test.ts', 'function bar() {}');
    const result2 = await (async () => {
      const { indexFile } = await import('../../src/code-map/indexer.js');
      return indexFile(db, tempDir, filePath);
    })();
    expect(result2.skipped).toBe(false);
    const nodes = getAllNodes(db);
    expect(nodes.some(n => n.name === 'bar')).toBe(true);
    expect(nodes.some(n => n.name === 'foo')).toBe(false);
  });

  // 16. content_hash 未变化跳过索引
  it('should skip indexing when content_hash unchanged', async () => {
    const filePath = await writeFile('src/test.ts', 'function foo() {}');
    const { indexFile } = await import('../../src/code-map/indexer.js');
    const result1 = await indexFile(db, tempDir, filePath);
    expect(result1.skipped).toBe(false);
    const result2 = await indexFile(db, tempDir, filePath);
    expect(result2.skipped).toBe(true);
  });

  // 17. explore 关键词搜索返回相关符号
  it('explore should return matching symbols', async () => {
    const filePath = await writeFile('src/auth.ts', 'export function login(user: string): void {}\nexport function logout(): void {}');
    const { indexFile } = await import('../../src/code-map/indexer.js');
    await indexFile(db, tempDir, filePath);
    const ctx = explore(db, 'login', tempDir);
    expect(ctx.nodes.length).toBeGreaterThan(0);
    expect(ctx.nodes.some(n => n.name === 'login')).toBe(true);
  });

  // 18. findCallers 返回正确调用者
  it('findCallers should return correct callers', async () => {
    // 手动插入节点和边
    const file: CodeMapFile = {
      path: 'test.ts',
      language: 'typescript',
      contentHash: 'abc',
      lineCount: 5,
      indexedAt: new Date().toISOString(),
    };
    insertFile(db, file);
    const callerNode: CodeMapNode = {
      id: 'test.ts:0:caller',
      name: 'caller',
      kind: 'function',
      filePath: 'test.ts',
      startLine: 0,
      endLine: 5,
    };
    const calleeNode: CodeMapNode = {
      id: 'test.ts:6:callee',
      name: 'callee',
      kind: 'function',
      filePath: 'test.ts',
      startLine: 6,
      endLine: 10,
    };
    insertNode(db, callerNode);
    insertNode(db, calleeNode);
    insertEdge(db, {
      id: 'edge1',
      source: callerNode.id,
      target: calleeNode.name,
      kind: 'CALLS',
      weight: 1.0,
    });
    const callers = findCallers(db, 'callee');
    expect(callers.length).toBe(1);
    expect(callers[0].name).toBe('caller');
  });

  // 19. analyzeImpact 递归追踪
  it('analyzeImpact should trace recursively', async () => {
    const file: CodeMapFile = {
      path: 'test.ts',
      language: 'typescript',
      contentHash: 'abc',
      lineCount: 10,
      indexedAt: new Date().toISOString(),
    };
    insertFile(db, file);
    const a: CodeMapNode = { id: 'test.ts:0:a', name: 'a', kind: 'function', filePath: 'test.ts', startLine: 0, endLine: 1 };
    const b: CodeMapNode = { id: 'test.ts:2:b', name: 'b', kind: 'function', filePath: 'test.ts', startLine: 2, endLine: 3 };
    const c: CodeMapNode = { id: 'test.ts:4:c', name: 'c', kind: 'function', filePath: 'test.ts', startLine: 4, endLine: 5 };
    insertNode(db, a);
    insertNode(db, b);
    insertNode(db, c);
    // c calls b, b calls a
    insertEdge(db, { id: 'e1', source: b.id, target: a.name, kind: 'CALLS', weight: 1 });
    insertEdge(db, { id: 'e2', source: c.id, target: b.name, kind: 'CALLS', weight: 1 });
    const result = analyzeImpact(db, 'a', 3);
    expect(result.totalCount).toBeGreaterThanOrEqual(3);
    expect(result.impactedFiles).toContain('test.ts');
  });

  // 20. RepoDistill 预算分配不超过预算
  it('distillContext should not exceed budget', () => {
    const nodes = [
      { id: '1', rankScore: 0.5, signature: 'function foo()', source: 'function foo() { return 1; }' },
      { id: '2', rankScore: 0.3, signature: 'function bar()', source: 'function bar() { return 2; }' },
      { id: '3', rankScore: 0.2, signature: 'function baz()', source: 'function baz() { return 3; }' },
    ];
    const result = distillContext(nodes, 20); // very small budget
    expect(result.estimatedTokens).toBeLessThanOrEqual(20);
    expect(result.truncated).toBeGreaterThan(0);
  });

  // 21. 删除文件后节点级联删除
  it('should cascade delete nodes when file is deleted', async () => {
    const file: CodeMapFile = {
      path: 'test.ts',
      language: 'typescript',
      contentHash: 'abc',
      lineCount: 5,
      indexedAt: new Date().toISOString(),
    };
    insertFile(db, file);
    const node: CodeMapNode = {
      id: 'test.ts:0:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'test.ts',
      startLine: 0,
      endLine: 5,
    };
    insertNode(db, node);
    expect(getAllNodes(db).length).toBe(1);
    deleteFileNodes(db, 'test.ts');
    expect(getAllNodes(db).length).toBe(0);
  });

  // 22. 语法错误文件不崩溃
  it('should not crash on syntax errors', async () => {
    const code = `function {{{{ broken`;
    const result = await parseFile('test.ts', code);
    // Should not throw, may return null or a tree with errors
    expect(result).not.toBeNull();
    if (result) {
      const extracted = extractFromTree(result.tree, 'test.ts', 'typescript');
      // May extract partial symbols or none
      expect(extracted.nodes).toBeDefined();
    }
  });

  // 23. renderer 输出 Aider 风格文本
  it('renderer should output Aider-style text', () => {
    const files = [{
      path: 'src/auth.ts',
      language: 'typescript' as const,
      contentHash: 'abc',
      lineCount: 10,
      indexedAt: new Date().toISOString(),
    }];
    const nodes: CodeMapNode[] = [{
      id: 'src/auth.ts:0:login',
      name: 'login',
      kind: 'function',
      filePath: 'src/auth.ts',
      startLine: 0,
      endLine: 5,
      signature: 'function login(user: string): void',
      rankScore: 0.5,
    }];
    const result = renderCodeMap(files, nodes, { tokenBudget: 1000 });
    expect(result.text).toContain('src/auth.ts:');
    expect(result.text).toContain('⋮...');
    expect(result.text).toContain('│function login');
    expect(result.fileCount).toBe(1);
  });

  // 24. getStatus 返回正确统计
  it('getStatus should return correct stats', async () => {
    const file: CodeMapFile = {
      path: 'test.ts',
      language: 'typescript',
      contentHash: 'abc',
      lineCount: 5,
      indexedAt: new Date().toISOString(),
    };
    insertFile(db, file);
    const node: CodeMapNode = {
      id: 'test.ts:0:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'test.ts',
      startLine: 0,
      endLine: 5,
    };
    insertNode(db, node);
    insertEdge(db, { id: 'e1', source: 'file:test.ts', target: node.id, kind: 'CONTAINS', weight: 0.1 });
    const status = getStatus(db);
    expect(status.fileCount).toBe(1);
    expect(status.nodeCount).toBe(1);
    expect(status.edgeCount).toBe(1);
    expect(status.lastIndexedAt).not.toBeNull();
  });
});

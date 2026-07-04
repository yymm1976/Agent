// tests/code-map/cross-file-resolve.test.ts
// 短板 1 + 3：跨文件 CALLS 边回填 + 符号边 target 统一为节点 ID

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initParser } from '../../src/code-map/parser.js';
import {
  initDatabase,
  insertFile,
  insertNode,
  insertEdge,
  insertUnresolvedRefs,
  getAllUnresolvedRefs,
  getAllEdges,
  getAllNodes,
  close,
  type DB,
} from '../../src/code-map/database.js';
import {
  resolveCrossFileCalls,
  resolveSymbolEdges,
} from '../../src/code-map/indexer.js';
import type { CodeMapNode, CodeMapEdge } from '../../src/code-map/schema.js';
import type { PendingReference } from '../../src/code-map/extractor.js';

let tempDir: string;
let dbPath: string;
let db: DB;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cross-file-resolve-'));
  dbPath = path.join(tempDir, '.routedev', 'code-map', 'code-map.db');
  await initParser();
  db = initDatabase(dbPath);
});

afterEach(async () => {
  try { close(db); } catch { /* ignore */ }
  await fsp.rm(tempDir, { recursive: true, force: true });
});

function insertTestFile(filePath: string): void {
  insertFile(db, {
    path: filePath,
    language: 'typescript',
    contentHash: 'test',
    lineCount: 10,
    indexedAt: new Date().toISOString(),
  });
}

describe('resolveCrossFileCalls', () => {
  it('1. 唯一匹配：跨文件 CALLS 边回填，target 为节点 ID', () => {
    // fileA 定义 foo，fileB 调用 foo（跨文件）
    insertTestFile('a.ts');
    insertTestFile('b.ts');
    const fooNode: CodeMapNode = {
      id: 'a.ts:0:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    const barNode: CodeMapNode = {
      id: 'b.ts:0:bar',
      name: 'bar',
      kind: 'function',
      filePath: 'b.ts',
      startLine: 0,
      endLine: 5,
    };
    insertNode(db, fooNode);
    insertNode(db, barNode);

    // bar 调用 foo（跨文件，extractFromTree 无法解析，存入 unresolved_refs）
    const ref: PendingReference = {
      sourceId: 'b.ts:0:bar',
      calleeName: 'foo',
      line: 1,
      filePath: 'b.ts',
    };
    insertUnresolvedRefs(db, [ref]);

    // 执行回填
    const result = resolveCrossFileCalls(db);

    expect(result.resolved).toBe(1);
    expect(result.skipped).toBe(0);

    // unresolved_refs 应清空
    const remaining = getAllUnresolvedRefs(db);
    expect(remaining.length).toBe(0);

    // 应插入 CALLS 边：bar -> foo（target 是节点 ID，不是字符串名）
    const edges = getAllEdges(db);
    const callsEdge = edges.find(e => e.kind === 'CALLS');
    expect(callsEdge).toBeDefined();
    expect(callsEdge!.source).toBe('b.ts:0:bar');
    expect(callsEdge!.target).toBe('a.ts:0:foo'); // 节点 ID，不是字符串 "foo"
  });

  it('2. 零匹配：保留在 unresolved_refs（外部库）', () => {
    insertTestFile('a.ts');
    const barNode: CodeMapNode = {
      id: 'a.ts:0:bar',
      name: 'bar',
      kind: 'function',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
    };
    insertNode(db, barNode);

    // 调用未定义的 externalLib()
    const ref: PendingReference = {
      sourceId: 'a.ts:0:bar',
      calleeName: 'externalLib',
      line: 1,
      filePath: 'a.ts',
    };
    insertUnresolvedRefs(db, [ref]);

    const result = resolveCrossFileCalls(db);

    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(1);

    // 仍保留在 unresolved_refs
    const remaining = getAllUnresolvedRefs(db);
    expect(remaining.length).toBe(1);
    expect(remaining[0].calleeName).toBe('externalLib');

    // 不应有 CALLS 边
    const edges = getAllEdges(db);
    expect(edges.filter(e => e.kind === 'CALLS').length).toBe(0);
  });

  it('3. 多个匹配且 rank_score 全 0：跳过保留 unresolved（首次 resolve）', () => {
    insertTestFile('a.ts');
    insertTestFile('b.ts');
    // 两个文件都定义了同名函数 foo
    const fooA: CodeMapNode = {
      id: 'a.ts:0:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    const fooB: CodeMapNode = {
      id: 'b.ts:0:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'b.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    const callerNode: CodeMapNode = {
      id: 'c.ts:0:caller',
      name: 'caller',
      kind: 'function',
      filePath: 'c.ts',
      startLine: 0,
      endLine: 5,
    };
    insertTestFile('c.ts');
    insertNode(db, fooA);
    insertNode(db, fooB);
    insertNode(db, callerNode);

    const ref: PendingReference = {
      sourceId: 'c.ts:0:caller',
      calleeName: 'foo',
      line: 1,
      filePath: 'c.ts',
    };
    insertUnresolvedRefs(db, [ref]);

    // 首次 resolve：所有 rank_score = 0，应跳过
    const result = resolveCrossFileCalls(db);
    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(1);

    // 仍保留在 unresolved_refs
    const remaining = getAllUnresolvedRefs(db);
    expect(remaining.length).toBe(1);
  });

  it('4. 重复插入防御：已存在的 CALLS 边不重复插入，但清理 unresolved_refs', () => {
    insertTestFile('a.ts');
    insertTestFile('b.ts');
    const fooNode: CodeMapNode = {
      id: 'a.ts:0:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    const barNode: CodeMapNode = {
      id: 'b.ts:0:bar',
      name: 'bar',
      kind: 'function',
      filePath: 'b.ts',
      startLine: 0,
      endLine: 5,
    };
    insertNode(db, fooNode);
    insertNode(db, barNode);

    // 预先插入 CALLS 边
    const existingEdge: CodeMapEdge = {
      id: 'b.ts:0:bar->a.ts:0:foo:CALLS',
      source: 'b.ts:0:bar',
      target: 'a.ts:0:foo',
      kind: 'CALLS',
      weight: 1.0,
    };
    insertEdge(db, existingEdge);

    // 同时有 unresolved_refs
    const ref: PendingReference = {
      sourceId: 'b.ts:0:bar',
      calleeName: 'foo',
      line: 1,
      filePath: 'b.ts',
    };
    insertUnresolvedRefs(db, [ref]);

    const result = resolveCrossFileCalls(db);
    expect(result.resolved).toBe(1);

    // unresolved_refs 应清空
    expect(getAllUnresolvedRefs(db).length).toBe(0);

    // CALLS 边只有 1 条（不重复）
    const callsEdges = getAllEdges(db).filter(e => e.kind === 'CALLS');
    expect(callsEdges.length).toBe(1);
  });
});

describe('resolveSymbolEdges', () => {
  it('1. EXTENDS 边 target 从字符串名解析为节点 ID', () => {
    insertTestFile('a.ts');
    insertTestFile('b.ts');
    // Animal 在 a.ts 定义，Dog 在 b.ts 继承 Animal
    const animalNode: CodeMapNode = {
      id: 'a.ts:0:Animal',
      name: 'Animal',
      kind: 'class',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    const dogNode: CodeMapNode = {
      id: 'b.ts:0:Dog',
      name: 'Dog',
      kind: 'class',
      filePath: 'b.ts',
      startLine: 0,
      endLine: 5,
      extends: ['Animal'],
      exported: true,
    };
    insertNode(db, animalNode);
    insertNode(db, dogNode);

    // EXTENDS 边 target 是字符串名 "Animal"
    insertEdge(db, {
      id: 'b.ts:0:Dog->Animal:EXTENDS',
      source: 'b.ts:0:Dog',
      target: 'Animal',
      kind: 'EXTENDS',
      weight: 0.8,
    });

    const result = resolveSymbolEdges(db);
    expect(result.resolved).toBe(1);

    // EXTENDS 边 target 应更新为节点 ID "a.ts:0:Animal"
    const extendsEdges = getAllEdges(db).filter(e => e.kind === 'EXTENDS');
    expect(extendsEdges.length).toBe(1);
    expect(extendsEdges[0].target).toBe('a.ts:0:Animal');
    expect(extendsEdges[0].source).toBe('b.ts:0:Dog');
  });

  it('2. 未匹配的 EXTENDS 边被删除（外部库类型）', () => {
    insertTestFile('a.ts');
    const dogNode: CodeMapNode = {
      id: 'a.ts:0:Dog',
      name: 'Dog',
      kind: 'class',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
      extends: ['ExternalBase'],
    };
    insertNode(db, dogNode);

    // ExternalBase 不在 nodes 表中
    insertEdge(db, {
      id: 'a.ts:0:Dog->ExternalBase:EXTENDS',
      source: 'a.ts:0:Dog',
      target: 'ExternalBase',
      kind: 'EXTENDS',
      weight: 0.8,
    });

    const result = resolveSymbolEdges(db);
    expect(result.deleted).toBe(1);
    expect(result.resolved).toBe(0);

    // EXTENDS 边应被删除
    const extendsEdges = getAllEdges(db).filter(e => e.kind === 'EXTENDS');
    expect(extendsEdges.length).toBe(0);
  });

  it('3. IMPLEMENTS 边 target 解析为节点 ID', () => {
    insertTestFile('a.ts');
    insertTestFile('b.ts');
    const iRunner: CodeMapNode = {
      id: 'a.ts:0:IRunner',
      name: 'IRunner',
      kind: 'interface',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    const dogNode: CodeMapNode = {
      id: 'b.ts:0:Dog',
      name: 'Dog',
      kind: 'class',
      filePath: 'b.ts',
      startLine: 0,
      endLine: 5,
      implements: ['IRunner'],
      exported: true,
    };
    insertNode(db, iRunner);
    insertNode(db, dogNode);

    insertEdge(db, {
      id: 'b.ts:0:Dog->IRunner:IMPLEMENTS',
      source: 'b.ts:0:Dog',
      target: 'IRunner',
      kind: 'IMPLEMENTS',
      weight: 0.8,
    });

    const result = resolveSymbolEdges(db);
    expect(result.resolved).toBe(1);

    const implEdges = getAllEdges(db).filter(e => e.kind === 'IMPLEMENTS');
    expect(implEdges.length).toBe(1);
    expect(implEdges[0].target).toBe('a.ts:0:IRunner');
  });

  it('4. IMPORTS 边 target 通常是模块路径，未匹配则删除', () => {
    insertTestFile('a.ts');
    // 不存在 name='react' 的节点
    insertEdge(db, {
      id: 'file:a.ts->react:IMPORTS',
      source: 'file:a.ts',
      target: 'react',
      kind: 'IMPORTS',
      weight: 0.5,
    });

    const result = resolveSymbolEdges(db);
    // 'react' 不在 nodes 表中 → 删除
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const importsEdges = getAllEdges(db).filter(e => e.kind === 'IMPORTS');
    expect(importsEdges.length).toBe(0);
  });

  it('5. 已是节点 ID 的边不重复处理', () => {
    insertTestFile('a.ts');
    insertTestFile('b.ts');
    const animalNode: CodeMapNode = {
      id: 'a.ts:0:Animal',
      name: 'Animal',
      kind: 'class',
      filePath: 'a.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    const dogNode: CodeMapNode = {
      id: 'b.ts:0:Dog',
      name: 'Dog',
      kind: 'class',
      filePath: 'b.ts',
      startLine: 0,
      endLine: 5,
      exported: true,
    };
    insertNode(db, animalNode);
    insertNode(db, dogNode);

    // EXTENDS 边 target 已是节点 ID
    insertEdge(db, {
      id: 'b.ts:0:Dog->a.ts:0:Animal:EXTENDS',
      source: 'b.ts:0:Dog',
      target: 'a.ts:0:Animal',
      kind: 'EXTENDS',
      weight: 0.8,
    });

    const result = resolveSymbolEdges(db);
    expect(result.resolved).toBe(1);
    expect(result.deleted).toBe(0);

    // 边保持不变
    const extendsEdges = getAllEdges(db).filter(e => e.kind === 'EXTENDS');
    expect(extendsEdges.length).toBe(1);
    expect(extendsEdges[0].target).toBe('a.ts:0:Animal');
  });
});

describe('fullIndex 集成 - 跨文件 CALLS 回填', () => {
  it('fullIndex 后跨文件 CALLS 边建立', async () => {
    // fileA: export function foo() {}
    // fileB: import { foo } from './a'; function bar() { foo(); }
    await fsp.writeFile(path.join(tempDir, 'a.ts'), 'export function foo() {}\n');
    await fsp.writeFile(path.join(tempDir, 'b.ts'), "import { foo } from './a.js';\nexport function bar() { foo(); }\n");

    const { fullIndex } = await import('../../src/code-map/indexer.js');
    const { stats, db: idxDb } = await fullIndex(tempDir, { dbPath });

    // 至少有 2 个文件被索引
    expect(stats.fileCount).toBeGreaterThanOrEqual(2);

    // 应存在跨文件 CALLS 边：bar -> foo（target 是节点 ID）
    const edges = getAllEdges(idxDb);
    const callsEdges = edges.filter(e => e.kind === 'CALLS');
    // 至少有 1 条 CALLS 边（bar 调用 foo）
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);
    // 至少有一条 CALLS 边的 source 是 bar、target 是 foo 节点 ID
    const barToFoo = callsEdges.find(
      e => e.source.includes('bar') && e.target.includes(':foo'),
    );
    expect(barToFoo).toBeDefined();
    // target 应是节点 ID（包含 ":foo"），而不是裸名 "foo"
    expect(barToFoo!.target).not.toBe('foo');

    close(idxDb);
  }, 15000);
});

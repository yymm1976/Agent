// src/code-map/database.ts
// node:sqlite 封装

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  CodeMapNode,
  CodeMapEdge,
  CodeMapFile,
  IndexStatus,
} from './schema.js';
import type { PendingReference } from './extractor.js';
import { camelSplitToFTS } from './camel-split-tokenizer.js';
import { parseFileRow, parseJsonArrayField } from '../config/schemas/database.js';
import { logger } from '../utils/logger.js';

// DatabaseSync 类型降级：node:sqlite 在 Electron 中可能不可用（实验性模块被排除）
// 定义本地接口描述用到的 DatabaseSync 方法，避免静态 import 导致 ERR_UNKNOWN_BUILTIN_MODULE
interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
}
type DatabaseSyncConstructor = new (path: string) => DatabaseSyncLike;

// 动态 require 避免静态 import 导致 Electron 启动失败（ERR_UNKNOWN_BUILTIN_MODULE）
const requireFromESM = createRequire(import.meta.url);
let DatabaseSyncCtor: DatabaseSyncConstructor | null = null;
try {
  const mod = requireFromESM('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
  DatabaseSyncCtor = mod.DatabaseSync;
} catch (e) {
    // fail-open：node:sqlite 不可用（Electron 未包含实验性模块），降级为 null
    logger.warn('[database] node:sqlite 不可用，降级为 null', { error: e instanceof Error ? e.message : String(e) });
  }

export type DB = DatabaseSyncLike;

/** 初始化数据库（创建表 + 索引） */
export function initDatabase(dbPath: string): DB {
  if (!DatabaseSyncCtor) {
    // node:sqlite 不可用：抛出有意义错误，调用方 try/catch 后降级（如 code-graph-query/repo-map）
    throw new Error('node:sqlite 不可用：Electron 未包含实验性 node:sqlite 模块，code-map 功能无法使用');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSyncCtor(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT,
      async INTEGER DEFAULT 0,
      exported INTEGER DEFAULT 0,
      static INTEGER DEFAULT 0,
      visibility TEXT,
      class_name TEXT,
      extends TEXT,
      implements TEXT,
      source_module TEXT,
      imported_names TEXT,
      rank_score REAL DEFAULT 0,
      FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS unresolved_refs (
      id INTEGER PRIMARY KEY,
      source_node_id TEXT NOT NULL,
      callee_name TEXT NOT NULL,
      line INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      import_source TEXT,
      FOREIGN KEY (source_node_id) REFERENCES nodes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
    CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
    CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
    CREATE INDEX IF NOT EXISTS idx_unresolved_callee ON unresolved_refs(callee_name);
  `);

  // Phase 72 Task D2：FTS5 BM25 符号搜索表
  // 决策：node:sqlite 不支持注册 JS 自定义分词器（验证：no such tokenizer: javascript）
  // 降级方案：写入时用 camelSplitToFTS 预分词为空格分隔字符串，用内置 unicode61 tokenizer
  // 字段说明：
  //   - node_id：关联 nodes.id（不参与 FTS 匹配，仅用于 JOIN 取完整节点）
  //   - name_tokens：符号名分词后的字符串（如 "get file structure"）
  //   - qualified_tokens：限定名分词（className.name 或 filePath 拆分），提高类内方法搜索精度
  // 独立存储（不用外部内容表），删除时通过 deleteNodeFtsByFile 手动维护，逻辑更直观
  // tokenize 选 unicode61：node:sqlite 不支持 JS 自定义分词器，改用 unicode61 + 写入时 camelSplitToFTS 预分词
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      node_id UNINDEXED,
      name_tokens,
      qualified_tokens,
      tokenize='unicode61 remove_diacritics 1'
    );
  `);

  // Phase 72 Task D4：旧 DB 兼容——为 unresolved_refs 补 import_source 列
  // 旧 DB 的表不含此列，ALTER TABLE ADD COLUMN 补上；列已存在时忽略错误
  try {
    db.exec('ALTER TABLE unresolved_refs ADD COLUMN import_source TEXT');
  } catch (e) {
    // 列已存在或表不存在，忽略（旧 DB 兼容的正常路径）
    logger.warn('[database] ALTER TABLE 添加 import_source 列失败（可能已存在）', { error: e instanceof Error ? e.message : String(e) });
  }

  return db;
}

/** 插入文件记录 */
export function insertFile(db: DB, file: CodeMapFile): void {
  db.prepare(`
    INSERT OR REPLACE INTO files (path, language, content_hash, line_count, indexed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(file.path, file.language, file.contentHash, file.lineCount, file.indexedAt);
}

/** 插入节点 */
export function insertNode(db: DB, node: CodeMapNode): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes
      (id, name, kind, file_path, start_line, end_line, signature,
       async, exported, static, visibility, class_name,
       extends, implements, source_module, imported_names, rank_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    node.id,
    node.name,
    node.kind,
    node.filePath,
    node.startLine,
    node.endLine,
    node.signature ?? null,
    node.async ? 1 : 0,
    node.exported ? 1 : 0,
    node.static ? 1 : 0,
    node.visibility ?? null,
    node.className ?? null,
    node.extends ? JSON.stringify(node.extends) : null,
    node.implements ? JSON.stringify(node.implements) : null,
    node.sourceModule ?? null,
    node.importedNames ? JSON.stringify(node.importedNames) : null,
    node.rankScore ?? 0,
  );
}

/** 插入边 */
export function insertEdge(db: DB, edge: CodeMapEdge): void {
  db.prepare(`
    INSERT OR REPLACE INTO edges (id, source, target, kind, weight)
    VALUES (?, ?, ?, ?, ?)
  `).run(edge.id, edge.source, edge.target, edge.kind, edge.weight);
}

/** 批量插入未解析调用引用 */
export function insertUnresolvedRefs(db: DB, refs: PendingReference[]): void {
  if (refs.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO unresolved_refs (source_node_id, callee_name, line, file_path, import_source)
    VALUES (?, ?, ?, ?, ?)
  `);
  const begin = db.prepare('BEGIN');
  begin.run();
  try {
    for (const ref of refs) {
      stmt.run(ref.sourceId, ref.calleeName, ref.line, ref.filePath, ref.importSource ?? null);
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
}

/** 按 callee 名字查询未解析引用（供后续索引补全使用） */
export function getUnresolvedRefsByCallee(db: DB, calleeName: string): PendingReference[] {
  const rows = db.prepare(
    'SELECT source_node_id AS sourceId, callee_name AS calleeName, line, file_path AS filePath, import_source AS importSource FROM unresolved_refs WHERE callee_name = ?',
  ).all(calleeName) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    sourceId: row.sourceId as string,
    calleeName: row.calleeName as string,
    line: row.line as number,
    filePath: row.filePath as string,
    importSource: (row.importSource as string | null) ?? undefined,
  }));
}

/** 读取所有未解析调用引用（供 resolveCrossFileSteps 跨文件回填使用） */
export function getAllUnresolvedRefs(db: DB): PendingReference[] {
  const rows = db.prepare(
    'SELECT source_node_id AS sourceId, callee_name AS calleeName, line, file_path AS filePath, import_source AS importSource FROM unresolved_refs',
  ).all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    sourceId: row.sourceId as string,
    calleeName: row.calleeName as string,
    line: row.line as number,
    filePath: row.filePath as string,
    importSource: (row.importSource as string | null) ?? undefined,
  }));
}

/** 删除单条未解析引用（成功回填 CALLS 边后调用） */
export function deleteUnresolvedRef(
  db: DB,
  sourceId: string,
  calleeName: string,
  line: number,
  filePath: string,
): void {
  db.prepare(
    'DELETE FROM unresolved_refs WHERE source_node_id = ? AND callee_name = ? AND line = ? AND file_path = ?',
  ).run(sourceId, calleeName, line, filePath);
}

/** 按 name 查询节点 id 和 file_path（供跨文件 CALLS 解析使用） */
export function getNodeIdsByName(db: DB, name: string): Array<{ id: string; filePath: string; rankScore: number }> {
  const rows = db.prepare(
    'SELECT id, file_path AS filePath, rank_score AS rankScore FROM nodes WHERE name = ?',
  ).all(name) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as string,
    filePath: row.filePath as string,
    rankScore: (row.rankScore as number) ?? 0,
  }));
}

/** 检查指定边是否已存在（避免重复插入 CALLS 边） */
export function edgeExists(db: DB, source: string, target: string, kind: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS c FROM edges WHERE source = ? AND target = ? AND kind = ?',
  ).get(source, target, kind) as { c: number } | undefined;
  return row !== undefined;
}

/** 检查指定节点 ID 是否存在（用于判断边 target 是否已是节点 ID） */
export function nodeExistsById(db: DB, id: string): boolean {
  const row = db.prepare('SELECT 1 AS c FROM nodes WHERE id = ?').get(id) as { c: number } | undefined;
  return row !== undefined;
}

/** 删除指定边（按 source + target + kind） */
export function deleteEdge(db: DB, source: string, target: string, kind: string): void {
  db.prepare(
    'DELETE FROM edges WHERE source = ? AND target = ? AND kind = ?',
  ).run(source, target, kind);
}

/** 删除指定文件的所有未解析引用（重新索引前清理） */
export function deleteFileUnresolvedRefs(db: DB, filePath: string): void {
  db.prepare('DELETE FROM unresolved_refs WHERE file_path = ?').run(filePath);
}

/** 删除文件的所有节点和边（级联） */
export function deleteFileNodes(db: DB, filePath: string): void {
  // 先删除与该文件节点相关的边
  const nodeIds = db.prepare('SELECT id FROM nodes WHERE file_path = ?').all(filePath) as Array<{ id: string }>;
  const idList = nodeIds.map(n => n.id);
  if (idList.length > 0) {
    const placeholders = idList.map(() => '?').join(',');
    db.prepare(`DELETE FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`).run(...idList, ...idList);
  }
  db.prepare('DELETE FROM nodes WHERE file_path = ?').run(filePath);
  db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
}

/** 查询节点 */
export function queryNodes(db: DB, sql: string, params: unknown[] = []): CodeMapNode[] {
  const rows = db.prepare(sql).all(...params as Array<string | number | null>) as Array<Record<string, unknown>>;
  return rows.map(rowToNode);
}

/** 查询边 */
export function queryEdges(db: DB, sql: string, params: unknown[] = []): CodeMapEdge[] {
  const rows = db.prepare(sql).all(...params as Array<string | number | null>) as Array<Record<string, unknown>>;
  return rows.map(rowToEdge);
}

/** 按名称查询节点 */
export function getNodeByName(db: DB, name: string): CodeMapNode[] {
  return queryNodes(db, 'SELECT * FROM nodes WHERE name = ?', [name]);
}

// ===== Phase 72 Task D2：FTS5 BM25 符号搜索 =====

/**
 * 写入节点的 FTS5 索引行
 * 在 insertNode 之后调用，保持 nodes_fts 与 nodes 表同步
 */
export function insertNodeFts(db: DB, node: CodeMapNode): void {
  // 构造限定名：className.name（方法）或 name（其他）
  const qualifiedName = node.className ? `${node.className}.${node.name}` : node.name;
  db.prepare(`
    INSERT INTO nodes_fts (node_id, name_tokens, qualified_tokens)
    VALUES (?, ?, ?)
  `).run(
    node.id,
    camelSplitToFTS(node.name),
    camelSplitToFTS(qualifiedName),
  );
}

/**
 * 按文件路径删除该文件所有节点的 FTS5 索引行
 * 在 deleteFileNodes 之前调用，避免 FTS 残留指向已删除节点的引用
 */
export function deleteNodeFtsByFile(db: DB, filePath: string): void {
  // FTS5 不支持 JOIN，需先查 node_id 列表再删除
  const rows = db.prepare(
    'SELECT id FROM nodes WHERE file_path = ?',
  ).all(filePath) as Array<{ id: string }>;
  if (rows.length === 0) return;
  const stmt = db.prepare('DELETE FROM nodes_fts WHERE node_id = ?');
  const begin = db.prepare('BEGIN');
  begin.run();
  try {
    for (const row of rows) {
      stmt.run(row.id);
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
}

/** FTS5 搜索结果项（node_id + BM25 分数，分数越低越相关） */
export interface FtsSearchHit {
  nodeId: string;
  bm25Score: number;
}

/**
 * 用 FTS5 BM25 搜索符号
 *
 * @param matchQuery FTS5 MATCH 表达式（调用方应用 buildFtsMatchQuery 构造）
 * @param limit 最大返回数
 * @returns 按 BM25 相关性排序的命中列表（分数越低越相关）
 */
export function searchNodesByFts(db: DB, matchQuery: string, limit = 20): FtsSearchHit[] {
  if (!matchQuery) return [];
  const rows = db.prepare(`
    SELECT node_id AS nodeId, bm25(nodes_fts) AS score
    FROM nodes_fts
    WHERE nodes_fts MATCH ?
    ORDER BY score ASC
    LIMIT ?
  `).all(matchQuery, limit) as Array<{ nodeId: string; score: number }>;
  return rows.map(r => ({ nodeId: r.nodeId, bm25Score: r.score }));
}

/** 获取节点的调用者（谁调用了此节点） */
function getCallers(db: DB, nodeId: string): CodeMapNode[] {
  const edges = queryEdges(
    db,
    'SELECT * FROM edges WHERE target = ? AND kind = ?',
    [nodeId, 'CALLS'],
  );
  const callerIds = edges.map(e => e.source);
  if (callerIds.length === 0) return [];
  const placeholders = callerIds.map(() => '?').join(',');
  return queryNodes(db, `SELECT * FROM nodes WHERE id IN (${placeholders})`, callerIds);
}

/** 获取节点的被调用者（此节点调用了谁） */
function getCallees(db: DB, nodeId: string): CodeMapNode[] {
  const edges = queryEdges(
    db,
    'SELECT * FROM edges WHERE source = ? AND kind = ?',
    [nodeId, 'CALLS'],
  );
  const calleeTargets = edges.map(e => e.target);
  if (calleeTargets.length === 0) return [];
  const placeholders = calleeTargets.map(() => '?').join(',');
  return queryNodes(db, `SELECT * FROM nodes WHERE id IN (${placeholders}) OR name IN (${placeholders})`, [...calleeTargets, ...calleeTargets]);
}

/** 更新节点的 PageRank 分数 */
function updateRankScore(db: DB, nodeId: string, score: number): void {
  db.prepare('UPDATE nodes SET rank_score = ? WHERE id = ?').run(score, nodeId);
}

/** 批量更新 PageRank 分数 */
export function batchUpdateRankScores(db: DB, scores: Map<string, number>): void {
  const stmt = db.prepare('UPDATE nodes SET rank_score = ? WHERE id = ?');
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    for (const [id, score] of scores) {
      stmt.run(score, id);
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
}

/** 按路径获取文件 */
function getFileByPath(db: DB, filePath: string): CodeMapFile | null {
  const row = parseFileRow(db.prepare('SELECT * FROM files WHERE path = ?').get(filePath));
  return row ? rowToFile(row) : null;
}

/**
 * 读取文件已存储的 content hash
 * 供 indexer 在增量索引时与当前文件 hash 比对，相同则跳过重新解析
 * @returns 已存储的 hash；文件未索引时返回 null
 */
export function getFileContentHash(db: DB, filePath: string): string | null {
  const row = db.prepare('SELECT content_hash FROM files WHERE path = ?').get(filePath) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

/**
 * 更新文件的 content hash（同时刷新 indexed_at）
 * 供 indexer 在跳过重新解析时仅更新 hash 和索引时间（轻量 touch）
 */
export function setFileContentHash(db: DB, filePath: string, hash: string): void {
  db.prepare('UPDATE files SET content_hash = ?, indexed_at = ? WHERE path = ?').run(
    hash,
    new Date().toISOString(),
    filePath,
  );
}

/** 获取所有文件 */
export function getAllFiles(db: DB): CodeMapFile[] {
  const rows = db.prepare('SELECT * FROM files').all() as Array<Record<string, unknown>>;
  return rows.map(rowToFile);
}

/** 获取所有节点 */
export function getAllNodes(db: DB): CodeMapNode[] {
  return queryNodes(db, 'SELECT * FROM nodes');
}

/** 获取所有边 */
export function getAllEdges(db: DB): CodeMapEdge[] {
  return queryEdges(db, 'SELECT * FROM edges');
}

/** 获取索引状态 */
export function getIndexStatus(db: DB): IndexStatus {
  const fileCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
  const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
  const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
  const lastRow = db.prepare('SELECT indexed_at FROM files ORDER BY indexed_at DESC LIMIT 1').get() as { indexed_at: string } | undefined;
  return {
    fileCount,
    nodeCount,
    edgeCount,
    lastIndexedAt: lastRow?.indexed_at ?? null,
    initialized: true,
  };
}

/** Top 文件结果（按 PageRank 排序） */
export interface TopFileEntry {
  filePath: string;
  nodeCount: number;
}

/** Top 符号结果（精简版，仅含注入 systemPrompt 所需字段） */
export interface TopSymbolEntry {
  name: string;
  kind: string;
  signature: string | null;
}

/**
 * 按 PageRank 排序获取 top N 文件
 * 排序依据：文件内节点最大 rank_score；排除 import 节点
 * 供 middleware 注入 <project_structure> 文件清单使用
 */
export function getTopFilesByRank(db: DB, limit: number): TopFileEntry[] {
  const rows = db.prepare(
    `SELECT file_path AS filePath, COUNT(*) AS nodeCount
     FROM nodes
     WHERE kind != 'import'
     GROUP BY file_path
     ORDER BY MAX(rank_score) DESC
     LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    filePath: row.filePath as string,
    nodeCount: row.nodeCount as number,
  }));
}

/**
 * 按 rank_score 排序获取指定文件的 top N 符号
 * 排除 import 节点；供 middleware 在 <project_structure> 中渲染每个文件的符号签名
 */
export function getTopSymbolsByFile(db: DB, filePath: string, limit: number): TopSymbolEntry[] {
  const rows = db.prepare(
    `SELECT name, kind, signature
     FROM nodes
     WHERE file_path = ? AND kind != 'import'
     ORDER BY rank_score DESC
     LIMIT ?`,
  ).all(filePath, limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    name: row.name as string,
    kind: row.kind as string,
    signature: (row.signature as string) ?? null,
  }));
}

/** 关闭数据库 */
export function close(db: DB): void {
  db.close();
}

// ---- 行 → 对象转换 ----

function rowToNode(row: Record<string, unknown>): CodeMapNode {
  return {
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as CodeMapNode['kind'],
    filePath: row.file_path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    signature: (row.signature as string) ?? undefined,
    async: Boolean(row.async),
    exported: Boolean(row.exported),
    static: Boolean(row.static),
    visibility: (row.visibility as string) ?? undefined,
    className: (row.class_name as string) ?? undefined,
    extends: row.extends ? parseJsonArrayField(JSON.parse(row.extends as string)) : undefined,
    implements: row.implements ? parseJsonArrayField(JSON.parse(row.implements as string)) : undefined,
    sourceModule: (row.source_module as string) ?? undefined,
    importedNames: row.imported_names ? parseJsonArrayField(JSON.parse(row.imported_names as string)) : undefined,
    rankScore: (row.rank_score as number) ?? 0,
  };
}

function rowToEdge(row: Record<string, unknown>): CodeMapEdge {
  return {
    id: row.id as string,
    source: row.source as string,
    target: row.target as string,
    kind: row.kind as CodeMapEdge['kind'],
    weight: row.weight as number,
  };
}

function rowToFile(row: Record<string, unknown>): CodeMapFile {
  return {
    path: row.path as string,
    language: row.language as CodeMapFile['language'],
    contentHash: row.content_hash as string,
    lineCount: row.line_count as number,
    indexedAt: row.indexed_at as string,
  };
}

// src/code-map/database.ts
// node:sqlite 封装

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CodeMapNode,
  CodeMapEdge,
  CodeMapFile,
  IndexStatus,
} from './schema.js';

export type DB = DatabaseSync;

/** 初始化数据库（创建表 + 索引） */
export function initDatabase(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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

    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
    CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
    CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
  `);

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

/** 获取节点的调用者（谁调用了此节点） */
export function getCallers(db: DB, nodeId: string): CodeMapNode[] {
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
export function getCallees(db: DB, nodeId: string): CodeMapNode[] {
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
export function updateRankScore(db: DB, nodeId: string, score: number): void {
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
export function getFileByPath(db: DB, filePath: string): CodeMapFile | null {
  const row = db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as Record<string, unknown> | undefined;
  return row ? rowToFile(row) : null;
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
    extends: row.extends ? JSON.parse(row.extends as string) : undefined,
    implements: row.implements ? JSON.parse(row.implements as string) : undefined,
    sourceModule: (row.source_module as string) ?? undefined,
    importedNames: row.imported_names ? JSON.parse(row.imported_names as string) : undefined,
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

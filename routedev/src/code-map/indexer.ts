// src/code-map/indexer.ts
// 全量/增量索引器

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CodeMapFile,
  CodeMapNode,
  CodeMapEdge,
  IndexStats,
  Language,
} from './schema.js';
import { EXTENSION_LANGUAGE_MAP } from './schema.js';
import { parseFile } from './parser.js';
import { extractFromTree } from './extractor.js';
import {
  initDatabase,
  insertFile,
  insertNode,
  insertEdge,
  insertUnresolvedRefs,
  deleteFileNodes,
  deleteFileUnresolvedRefs,
  getAllNodes,
  getAllEdges,
  batchUpdateRankScores,
  getFileContentHash,
  setFileContentHash,
  type DB,
} from './database.js';
import { computePageRank } from './ranker.js';

/**
 * 自上次 PageRank 计算以来发生 content hash 变化的文件路径集合
 * 按 DB 实例隔离（WeakMap），indexer 在 indexFile 检测到 hash 变化时写入，
 * querier.explore 消费后清空，触发 incrementalPageRank
 */
const changedFilesSinceRank = new WeakMap<DB, Set<string>>();

/** 标记文件 content hash 已变化（供 indexFile 在 hash 不匹配时调用） */
function markFileChanged(db: DB, filePath: string): void {
  let set = changedFilesSinceRank.get(db);
  if (!set) {
    set = new Set();
    changedFilesSinceRank.set(db, set);
  }
  set.add(filePath);
}

/** 读取自上次 PageRank 以来变更的文件集合（供 querier.explore 消费） */
export function getChangedFilesSinceRank(db: DB): Set<string> {
  return changedFilesSinceRank.get(db) ?? new Set();
}

/** 清空变更文件集合（querier.explore 调用 incrementalPageRank 后清空） */
export function clearChangedFilesSinceRank(db: DB): void {
  changedFilesSinceRank.delete(db);
}

/** 排除的目录 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.routedev',
  '.routedev-wts',
  'coverage',
  '__pycache__',
  '.next',
  'release-v',
]);

/** 支持的扩展名集合 */
const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXTENSION_LANGUAGE_MAP));

/** 索引选项 */
interface IndexOptions {
  /** 数据库路径 */
  dbPath?: string;
  /** 是否强制全量索引 */
  force?: boolean;
  /** 最大文件数 */
  maxFiles?: number;
}

/** 扫描项目中的源码文件 */
export async function scanSourceFiles(rootDir: string, maxFiles = 5000): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const name = entry.name;
      if (name.startsWith('.') && name !== '.') continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) continue;
        // 排除 release-v* 目录
        if (name.startsWith('release-v')) continue;
        await walk(path.join(dir, name));
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push(path.join(dir, name));
        }
      }
    }
  }

  await walk(rootDir);
  return results;
}

/** 计算文件内容 hash */
export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** 索引单个文件 */
export async function indexFile(
  db: DB,
  rootDir: string,
  filePath: string,
): Promise<{ nodeCount: number; edgeCount: number; skipped: boolean }> {
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');

  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    return { nodeCount: 0, edgeCount: 0, skipped: true };
  }

  const contentHash = computeContentHash(content);
  const ext = path.extname(filePath).toLowerCase();
  const language: Language = EXTENSION_LANGUAGE_MAP[ext] ?? 'unknown';
  if (language === 'unknown') {
    return { nodeCount: 0, edgeCount: 0, skipped: true };
  }

  // content hash 比对：与数据库存储的 hash 比较，相同则跳过重新解析（只 touch indexed_at）
  const storedHash = getFileContentHash(db, relPath);
  if (storedHash === contentHash) {
    // hash 相同：仅更新索引时间（mtime 等价），跳过昂贵的 AST 解析
    setFileContentHash(db, relPath, contentHash);
    return { nodeCount: 0, edgeCount: 0, skipped: true };
  }

  // hash 不同或新文件：标记变更，供 querier.explore 触发增量 PageRank
  markFileChanged(db, relPath);

  // 删除旧数据（含 unresolved_refs）
  deleteFileUnresolvedRefs(db, relPath);
  deleteFileNodes(db, relPath);

  // 解析 AST
  const parseResult = await parseFile(filePath, content);
  if (!parseResult) {
    // 解析失败，但仍记录文件
    const fileRecord: CodeMapFile = {
      path: relPath,
      language,
      contentHash,
      lineCount: content.split('\n').length,
      indexedAt: new Date().toISOString(),
    };
    insertFile(db, fileRecord);
    return { nodeCount: 0, edgeCount: 0, skipped: false };
  }

  // 提取符号和边
  const { nodes, edges, unresolvedRefs } = extractFromTree(parseResult.tree, relPath, parseResult.language);
  parseResult.tree.delete();

  // 写入数据库
  const fileRecord: CodeMapFile = {
    path: relPath,
    language,
    contentHash,
    lineCount: content.split('\n').length,
    indexedAt: new Date().toISOString(),
  };
  insertFile(db, fileRecord);

  for (const node of nodes) {
    insertNode(db, node);
  }
  for (const edge of edges) {
    insertEdge(db, edge);
  }
  // 持久化未解析调用引用（供后续索引补全：Task A3 通过 getUnresolvedRefsByCallee 跨文件解析）
  if (unresolvedRefs && unresolvedRefs.length > 0) {
    insertUnresolvedRefs(db, unresolvedRefs);
  }

  return { nodeCount: nodes.length, edgeCount: edges.length, skipped: false };
}

/** 全量索引 */
export async function fullIndex(
  rootDir: string,
  options?: IndexOptions,
): Promise<{ stats: IndexStats; db: DB }> {
  const dbPath = options?.dbPath ?? path.join(rootDir, '.routedev', 'code-map', 'code-map.db');
  const db = initDatabase(dbPath);

  const startTime = Date.now();
  const files = await scanSourceFiles(rootDir, options?.maxFiles);

  let nodeCount = 0;
  let edgeCount = 0;
  let skippedFiles = 0;

  for (const filePath of files) {
    const result = await indexFile(db, rootDir, filePath);
    nodeCount += result.nodeCount;
    edgeCount += result.edgeCount;
    if (result.skipped) skippedFiles++;
  }

  // 计算 PageRank
  updatePageRank(db);

  const durationMs = Date.now() - startTime;
  const stats: IndexStats = {
    fileCount: files.length - skippedFiles,
    nodeCount,
    edgeCount,
    durationMs,
    incremental: false,
    skippedFiles,
  };

  return { stats, db };
}

/** 增量索引 */
export async function incrementalIndex(
  rootDir: string,
  changedFiles?: string[],
  options?: IndexOptions,
): Promise<{ stats: IndexStats; db: DB }> {
  const dbPath = options?.dbPath ?? path.join(rootDir, '.routedev', 'code-map', 'code-map.db');
  const db = initDatabase(dbPath);

  const startTime = Date.now();

  let filesToIndex: string[];
  if (changedFiles && changedFiles.length > 0) {
    filesToIndex = changedFiles.map(f => path.isAbsolute(f) ? f : path.join(rootDir, f));
  } else {
    filesToIndex = await scanSourceFiles(rootDir, options?.maxFiles);
  }

  let nodeCount = 0;
  let edgeCount = 0;
  let skippedFiles = 0;

  for (const filePath of filesToIndex) {
    const result = await indexFile(db, rootDir, filePath);
    nodeCount += result.nodeCount;
    edgeCount += result.edgeCount;
    if (result.skipped) skippedFiles++;
  }

  // 计算 PageRank
  updatePageRank(db);

  const durationMs = Date.now() - startTime;
  const stats: IndexStats = {
    fileCount: filesToIndex.length - skippedFiles,
    nodeCount,
    edgeCount,
    durationMs,
    incremental: true,
    skippedFiles,
  };

  return { stats, db };
}

/** 更新 PageRank 分数（全量重算） */
export function updatePageRank(db: DB): void {
  const nodes = getAllNodes(db);
  const edges = getAllEdges(db);

  const nodeIds = nodes.map(n => n.id);
  const rankedEdges = edges
    .filter(e => e.kind !== 'CONTAINS') // CONTAINS 边不参与 PageRank 传播
    .map(e => ({ source: e.source, target: e.target, weight: e.weight }));

  const scores = computePageRank(nodeIds, rankedEdges);
  batchUpdateRankScores(db, scores);

  // 全量 PageRank 已消费所有变更，清空变更集（避免 querier 重复触发增量计算）
  clearChangedFilesSinceRank(db);
}

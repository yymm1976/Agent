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
  deleteFileNodes,
  getAllFiles,
  getAllNodes,
  getAllEdges,
  batchUpdateRankScores,
  type DB,
} from './database.js';
import { computePageRank } from './ranker.js';

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
export interface IndexOptions {
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

  // 检查是否需要重新索引
  const existingFiles = getAllFiles(db);
  const existing = existingFiles.find(f => f.path === relPath);
  if (existing && existing.contentHash === contentHash) {
    return { nodeCount: 0, edgeCount: 0, skipped: true };
  }

  // 删除旧数据
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
  const { nodes, edges } = extractFromTree(parseResult.tree, relPath, parseResult.language);
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

/** 更新 PageRank 分数 */
export function updatePageRank(db: DB): void {
  const nodes = getAllNodes(db);
  const edges = getAllEdges(db);

  const nodeIds = nodes.map(n => n.id);
  const rankedEdges = edges
    .filter(e => e.kind !== 'CONTAINS') // CONTAINS 边不参与 PageRank 传播
    .map(e => ({ source: e.source, target: e.target, weight: e.weight }));

  const scores = computePageRank(nodeIds, rankedEdges);
  batchUpdateRankScores(db, scores);
}

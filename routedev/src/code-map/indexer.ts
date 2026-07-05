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
import { EXTENSION_LANGUAGE_MAP, EDGE_WEIGHTS } from './schema.js';
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
  deleteUnresolvedRef,
  deleteEdge,
  getAllNodes,
  getAllEdges,
  getAllUnresolvedRefs,
  getNodeIdsByName,
  edgeExists,
  nodeExistsById,
  batchUpdateRankScores,
  getFileContentHash,
  setFileContentHash,
  insertNodeFts,
  deleteNodeFtsByFile,
  type DB,
} from './database.js';
import { computePageRank } from './ranker.js';
import { exportArtifact, importArtifact, artifactExists } from './artifact.js';
import { buildFileImportMap, buildExportedSymbolMap, resolveRefByImport } from './type-resolver.js';

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
  // Phase 72 Task D2：FTS5 索引需在 deleteFileNodes 之前清理（FTS 用 node_id 关联，删 nodes 后查不到 id）
  deleteNodeFtsByFile(db, relPath);
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
    // Phase 72 Task D2：同步写入 FTS5 索引（BM25 符号搜索）
    insertNodeFts(db, node);
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

  // 跨文件 CALLS 边回填（在所有文件解析完成后、PageRank 之前）
  resolveCrossFileCalls(db);
  // EXTENDS/IMPLEMENTS/IMPORTS 边 target 统一为节点 ID（在 CALLS 回填之后、PageRank 之前）
  resolveSymbolEdges(db);

  // 计算 PageRank
  updatePageRank(db);

  // Phase 72 Task D1：全量索引完成后导出 team-shared artifact（VACUUM INTO + zstd 压缩）
  // 失败不阻塞索引流程，仅打日志
  exportArtifact(db, rootDir);

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

/**
 * 加载或构建索引（Phase 72 Task D1：artifact 优先策略）
 *
 * 启动顺序：
 * 1. 检测 .routedev/code-map.db.zst 是否存在
 * 2. 存在 → importArtifact 解压为运行时 DB → 调 incrementalIndex 补 diff（新机器/新分支秒级启动）
 * 3. 不存在 → 走 fullIndex（首索引或 artifact 缺失场景）
 *
 * @returns 索引统计 + 已打开的 DB 实例
 */
export async function loadOrBuildIndex(
  rootDir: string,
  options?: IndexOptions,
): Promise<{ stats: IndexStats; db: DB }> {
  const hasArtifact = await artifactExists(rootDir);
  if (hasArtifact) {
    const dbPath = await importArtifact(rootDir);
    if (dbPath) {
      // artifact 导入成功：走增量索引补 diff（DB 已有大部分内容，仅扫描变更文件）
      return incrementalIndex(rootDir, undefined, { ...options, dbPath });
    }
    // 导入失败：降级走 fullIndex
  }
  return fullIndex(rootDir, options);
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

  // 跨文件 CALLS 边回填（处理新增/变更文件产生的 unresolved_refs，并尝试解析上一轮跳过的多匹配）
  resolveCrossFileCalls(db);
  // EXTENDS/IMPLEMENTS/IMPORTS 边 target 统一为节点 ID
  resolveSymbolEdges(db);

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

/**
 * 跨文件 CALLS 边回填
 *
 * 从 unresolved_refs 表读取所有未解析的调用引用，按 callee 名字在 nodes 表中匹配定义节点：
 * - Phase 72 Task D4 优先：若 ref 带 importSource（来自 extractor 的 import 解析），
 *   用 type-resolver 按 import 信息精确解析到具体文件的 definition 节点
 * - 唯一匹配：插入 CALLS 边（source=source_node_id, target=匹配节点id, weight=EDGE_WEIGHTS.CALLS），
 *   删除该 unresolved_refs 记录
 * - 多个匹配：仅当最高 rank_score > 0 时（说明 PageRank 已计算过）才选取最高分节点回填，
 *   否则跳过（保留 unresolved），等下一轮 resolve 时再处理
 * - 零匹配：保留在 unresolved_refs 表（外部库/标准库，正常）
 *
 * 应在所有文件解析完成后、PageRank 计算之前执行。
 */
export function resolveCrossFileCalls(db: DB): { resolved: number; skipped: number } {
  const refs = getAllUnresolvedRefs(db);
  let resolved = 0;
  let skipped = 0;

  // Phase 72 Task D4：构建全局 import/export 映射 + 文件路径集合，供 type-resolver 精确解析
  const allNodes = getAllNodes(db);
  const importMap = buildFileImportMap(allNodes);
  const exportMap = buildExportedSymbolMap(allNodes);
  const allFilePaths = new Set(allNodes.map(n => n.filePath));

  for (const ref of refs) {
    // Phase 72 Task D4：优先用 import 信息精确解析（处理多匹配场景的关键）
    // 当 calleeName 有多个候选 definition 时，按 caller 文件的 import 列表精确选目标
    const importResolved = resolveRefByImport(ref, importMap, exportMap, allFilePaths);
    if (importResolved) {
      // 避免重复插入
      if (edgeExists(db, ref.sourceId, importResolved.id, 'CALLS')) {
        deleteUnresolvedRef(db, ref.sourceId, ref.calleeName, ref.line, ref.filePath);
        resolved++;
        continue;
      }
      insertEdge(db, {
        id: `${ref.sourceId}->${importResolved.id}:CALLS`,
        source: ref.sourceId,
        target: importResolved.id,
        kind: 'CALLS',
        weight: EDGE_WEIGHTS.CALLS,
      });
      deleteUnresolvedRef(db, ref.sourceId, ref.calleeName, ref.line, ref.filePath);
      resolved++;
      continue;
    }

    const candidates = getNodeIdsByName(db, ref.calleeName);

    if (candidates.length === 0) {
      // 外部库/标准库：保留
      skipped++;
      continue;
    }

    let targetId: string | null = null;
    if (candidates.length === 1) {
      // 唯一匹配：直接回填
      targetId = candidates[0].id;
    } else {
      // 多个匹配：仅当最高 rank_score > 0 时才选取最高分节点回填
      // 首次 resolve 时 PageRank 还没算（所有 rank_score = 0），跳过保留 unresolved
      const topRank = candidates.reduce((max, c) => Math.max(max, c.rankScore), 0);
      if (topRank > 0) {
        const sorted = [...candidates].sort((a, b) => b.rankScore - a.rankScore);
        targetId = sorted[0].id;
      } else {
        skipped++;
        continue;
      }
    }

    if (targetId === null) {
      skipped++;
      continue;
    }

    // 避免重复插入
    if (edgeExists(db, ref.sourceId, targetId, 'CALLS')) {
      // 边已存在，仅清理 unresolved_refs
      deleteUnresolvedRef(db, ref.sourceId, ref.calleeName, ref.line, ref.filePath);
      resolved++;
      continue;
    }

    insertEdge(db, {
      id: `${ref.sourceId}->${targetId}:CALLS`,
      source: ref.sourceId,
      target: targetId,
      kind: 'CALLS',
      weight: EDGE_WEIGHTS.CALLS,
    });
    deleteUnresolvedRef(db, ref.sourceId, ref.calleeName, ref.line, ref.filePath);
    resolved++;
  }

  return { resolved, skipped };
}

/**
 * 符号边（EXTENDS/IMPLEMENTS/IMPORTS）target 类型统一为节点 ID
 *
 * 现状：CALLS 边 target 是节点 ID，EXTENDS/IMPLEMENTS/IMPORTS 边 target 是字符串名（类名/模块名），
 * 混合存储破坏图遍历一致性。
 *
 * 修复（采用更简单方案）：对每条 EXTENDS/IMPLEMENTS/IMPORTS 边，按 target 字符串在 nodes 表
 * 按 name 匹配：
 * - 匹配到：删除旧边，以节点 ID 作为 target 重新插入
 * - 未匹配：删除该边（外部库类型不参与图遍历，保留意义不大）
 *
 * 应在 resolveCrossFileCalls 之后、PageRank 计算之前执行。
 */
export function resolveSymbolEdges(db: DB): { resolved: number; deleted: number } {
  const edges = getAllEdges(db);
  const targetKinds = new Set(['EXTENDS', 'IMPLEMENTS', 'IMPORTS']);
  let resolved = 0;
  let deleted = 0;

  for (const edge of edges) {
    if (!targetKinds.has(edge.kind)) continue;

    // 若 target 已经是节点 ID（之前已 resolve 过），跳过
    if (nodeExistsById(db, edge.target)) {
      resolved++;
      continue;
    }

    const candidates = getNodeIdsByName(db, edge.target);

    if (candidates.length === 0) {
      // 未匹配：删除（外部库类型）
      deleteEdge(db, edge.source, edge.target, edge.kind);
      deleted++;
      continue;
    }

    // 多个匹配时按 rank_score 取最高（IMPORTS 边的 target 是模块名，
    // EXTENDS/IMPLEMENTS 的 target 是类/接口名，匹配多节点时取最高分）
    let targetId: string;
    if (candidates.length === 1) {
      targetId = candidates[0].id;
    } else {
      const topRank = candidates.reduce((max, c) => Math.max(max, c.rankScore), 0);
      if (topRank > 0) {
        const sorted = [...candidates].sort((a, b) => b.rankScore - a.rankScore);
        targetId = sorted[0].id;
      } else {
        // 首次 fullIndex：所有 rank_score=0，排序不稳定，跳过等下次处理
        continue;
      }
    }

    // 已是节点 ID（与匹配的节点 id 相同），跳过
    if (targetId === edge.target) {
      resolved++;
      continue;
    }

    // 避免重复插入
    if (edgeExists(db, edge.source, targetId, edge.kind)) {
      deleteEdge(db, edge.source, edge.target, edge.kind);
      resolved++;
      continue;
    }

    // 删除旧边（target=字符串名），插入新边（target=节点 ID）
    deleteEdge(db, edge.source, edge.target, edge.kind);
    insertEdge(db, {
      id: `${edge.source}->${targetId}:${edge.kind}`,
      source: edge.source,
      target: targetId,
      kind: edge.kind,
      weight: edge.weight,
    });
    resolved++;
  }

  return { resolved, deleted };
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

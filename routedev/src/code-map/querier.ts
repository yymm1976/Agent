// src/code-map/querier.ts
// 查询接口

import path from 'node:path';
import fsp from 'node:fs/promises';
import type {
  CodeMapNode,
  CodeMapEdge,
  CodeContext,
  CodeSnippet,
  ImpactResult,
  FileNode,
  IndexStatus,
  CallPath,
  RiskLevel,
} from './schema.js';
import {
  queryNodes,
  queryEdges,
  getNodeByName,
  getAllFiles,
  getAllNodes,
  getAllEdges,
  getIndexStatus,
  batchUpdateRankScores,
  searchNodesByFts,
  type DB,
} from './database.js';
import { computePersonalizedPageRank, incrementalPageRank, type RankedEdge } from './ranker.js';
import { getSeedNodeIdsFromCache } from './git-integration.js';
import { getChangedFilesSinceRank, clearChangedFilesSinceRank } from './indexer.js';
import { buildFtsMatchQuery } from './camel-split-tokenizer.js';

/** 查询选项 */
interface QueryOptions {
  /** 最大返回数 */
  maxResults?: number;
  /** 是否包含源代码片段 */
  includeSnippets?: boolean;
  /** 是否包含调用路径 */
  includeCallPaths?: boolean;
  /** 文件过滤提示 */
  fileHint?: string;
}

/**
 * Phase 72 Task D2：BM25 符号搜索
 *
 * 借鉴 codebase-memory-mcp 的 cbm_camel_split 分词器，用 FTS5 BM25 替代精确匹配
 * - camelCase / snake_case 感知：getFileStructure / get_file_structure 都能匹配 "file structure"
 * - BM25 相关性排序：高频词权重低，稀有词权重高
 *
 * @param query 用户输入的符号名（可以是 camelCase / snake_case / 空格分隔）
 * @param limit 最大返回数（默认 20）
 * @returns 按 BM25 相关性排序的节点列表（分数越低越相关，已转 rankScore 供统一消费）
 */
export function searchBySymbolName(db: DB, query: string, limit = 20): CodeMapNode[] {
  const matchQuery = buildFtsMatchQuery(query);
  if (!matchQuery) return [];

  const hits = searchNodesByFts(db, matchQuery, limit);
  if (hits.length === 0) return [];

  // 按 node_id 批量取完整节点
  const nodeIds = hits.map(h => h.nodeId);
  const placeholders = nodeIds.map(() => '?').join(',');
  const nodes = queryNodes(db, `SELECT * FROM nodes WHERE id IN (${placeholders})`, nodeIds);

  // 用 BM25 分数排序（分数越低越相关；转换为 rankScore 供下游统一排序逻辑复用）
  // BM25 score 可能为负（FTS5 实现细节），取负数让"分数越低越相关"变成"rankScore 越高越相关"
  const scoreMap = new Map<string, number>();
  for (const h of hits) scoreMap.set(h.nodeId, -h.bm25Score);

  return nodes
    .map(n => ({ ...n, rankScore: scoreMap.get(n.id) ?? 0 }))
    .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
}

/** 关键词搜索符号 */
export function explore(
  db: DB,
  query: string,
  rootDir: string,
  options?: QueryOptions,
): CodeContext {
  const maxResults = options?.maxResults ?? 20;
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (keywords.length === 0) {
    return {
      query,
      nodes: [],
      snippets: [],
      callPaths: [],
      impactRadius: 0,
    };
  }

  // 搜索节点：name 或 signature 匹配关键词
  const allNodes = getAllNodes(db);
  let filtered = allNodes.filter(node => {
    const nameLower = node.name.toLowerCase();
    const sigLower = (node.signature ?? '').toLowerCase();
    return keywords.some(kw => nameLower.includes(kw) || sigLower.includes(kw));
  });

  // Phase 72 Task D2：includes 匹配为空时，用 FTS5 BM25 作为 fallback
  // 场景：用户输入 "file structure" 想找 getFileStructure，includes 子串匹配不到 camelCase
  if (filtered.length === 0) {
    const ftsHits = searchBySymbolName(db, query, maxResults);
    if (ftsHits.length > 0) {
      filtered = ftsHits;
    }
  }

  // Phase 71 Task A5：content hash 变更检测 → 增量 PageRank
  // 有变更时走 incrementalPageRank（仅重算受影响节点 + 一阶邻居），无变更时走 PPR
  const changedFiles = getChangedFilesSinceRank(db);
  let rankedNodes: CodeMapNode[];

  if (changedFiles.size > 0) {
    // 有变更：增量 PageRank
    try {
      const allEdges = getAllEdges(db);
      const rankedEdges = allEdges
        .filter(e => e.kind !== 'CONTAINS')
        .map(e => ({ source: e.source, target: e.target, weight: e.weight })) as RankedEdge[];

      // 计算受影响节点：变更文件的节点 + 一阶邻居（CALLS/IMPORTS 等边连接的节点）
      const affectedNodeIds = new Set<string>();
      for (const node of allNodes) {
        if (changedFiles.has(node.filePath)) {
          affectedNodeIds.add(node.id);
        }
      }
      for (const edge of allEdges) {
        if (affectedNodeIds.has(edge.source)) affectedNodeIds.add(edge.target);
        if (affectedNodeIds.has(edge.target)) affectedNodeIds.add(edge.source);
      }

      // 旧分数（来自 DB rank_score）
      const oldScores = new Map<string, number>();
      for (const node of allNodes) {
        oldScores.set(node.id, node.rankScore ?? 0);
      }

      const scores = incrementalPageRank(
        allNodes.map(n => n.id),
        rankedEdges,
        affectedNodeIds,
        oldScores,
      );

      // 持久化新分数到 DB + 清空变更集
      batchUpdateRankScores(db, scores);
      clearChangedFilesSinceRank(db);

      rankedNodes = filtered
        .map(n => ({ ...n, rankScore: scores.get(n.id) ?? 0 }))
        .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
        .slice(0, maxResults);
    } catch {
      // 增量 PageRank 失败：fail-open 清空变更集，回退 PPR
      clearChangedFilesSinceRank(db);
      rankedNodes = rankByPPROrScore(db, allNodes, filtered, maxResults);
    }
  } else {
    // 无变更：走 PPR 或 rankScore 排序
    rankedNodes = rankByPPROrScore(db, allNodes, filtered, maxResults);
  }
  const matched = rankedNodes;

  // 收集源代码片段
  const snippets: CodeSnippet[] = [];
  if (options?.includeSnippets !== false) {
    for (const node of matched.slice(0, 10)) {
      const fullPath = path.join(rootDir, node.filePath);
      const snippet = readSnippet(fullPath, node.startLine, node.endLine, node.name);
      if (snippet) snippets.push(snippet);
    }
  }

  // 调用路径：对每个 matched 节点取前 2 跳 callees 调用链（多跳路径，非单节点列表）
  // 短板 3 修复：原实现只是单节点列表伪装成 callPaths，现已用真实多跳 BFS
  const callPaths: CallPath[] = [];
  if (options?.includeCallPaths !== false) {
    for (const node of matched.slice(0, 5)) {
      if (callPaths.length >= 20) break;
      const chains = findCallChain(db, node.name, 'callees', 2);
      for (const chain of chains) {
        if (callPaths.length >= 20) break;
        callPaths.push(chain);
      }
    }
  }

  // 影响半径：匹配节点的最大调用者链深度
  const impactRadius = matched.length > 0 ? computeImpactRadius(db, matched[0].id) : 0;

  return {
    query,
    nodes: matched,
    snippets,
    callPaths,
    impactRadius,
  };
}

/** 查找调用某符号的所有符号 */
export function findCallers(
  db: DB,
  symbolName: string,
  fileHint?: string,
): CodeMapNode[] {
  // 先找到目标节点
  let targets = getNodeByName(db, symbolName);
  if (targets.length === 0) {
    // 尝试按 className.method 形式
    targets = queryNodes(db, 'SELECT * FROM nodes WHERE name LIKE ?', [`%.${symbolName}`]);
  }
  if (targets.length === 0) return [];

  const targetIds = new Set(targets.map(t => t.id));
  const targetNames = new Set(targets.map(t => t.name));

  // 查找所有 CALLS 边，target 匹配
  const allEdges = getAllEdges(db);
  const callerIds = new Set<string>();
  for (const edge of allEdges) {
    if (edge.kind !== 'CALLS') continue;
    if (targetIds.has(edge.target) || targetNames.has(edge.target)) {
      callerIds.add(edge.source);
    }
  }

  if (callerIds.size === 0) return [];
  const idList = Array.from(callerIds);
  const placeholders = idList.map(() => '?').join(',');
  let callers = queryNodes(db, `SELECT * FROM nodes WHERE id IN (${placeholders})`, idList);

  if (fileHint) {
    callers = callers.filter(c => c.filePath.includes(fileHint));
  }

  return callers;
}

/** 查找某符号调用的所有符号 */
export function findCallees(
  db: DB,
  symbolName: string,
  fileHint?: string,
): CodeMapNode[] {
  let sources = getNodeByName(db, symbolName);
  if (sources.length === 0) {
    sources = queryNodes(db, 'SELECT * FROM nodes WHERE name LIKE ?', [`%.${symbolName}`]);
  }
  if (sources.length === 0) return [];

  const sourceIds = new Set(sources.map(s => s.id));

  const allEdges = getAllEdges(db);
  const calleeTargets = new Set<string>();
  for (const edge of allEdges) {
    if (edge.kind !== 'CALLS') continue;
    if (sourceIds.has(edge.source)) {
      calleeTargets.add(edge.target);
    }
  }

  if (calleeTargets.size === 0) return [];
  const targetList = Array.from(calleeTargets);
  const placeholders = targetList.map(() => '?').join(',');
  let callees = queryNodes(db, `SELECT * FROM nodes WHERE id IN (${placeholders}) OR name IN (${placeholders})`, [...targetList, ...targetList]);

  if (fileHint) {
    callees = callees.filter(c => c.filePath.includes(fileHint));
  }

  return callees;
}

/**
 * 查找两个符号之间的多跳调用路径（BFS，沿 CALLS 边）
 *
 * 短板 3：实现真正的 A→B→C 多跳调用路径，而非单节点列表
 * Wave 1 已统一 CALLS 边 target 为节点 ID，BFS 可跨文件遍历
 *
 * @returns 找到返回 { nodeIds, symbolNames }；未找到返回 null
 */
export function findCallPath(
  db: DB,
  fromName: string,
  toName: string,
  maxDepth = 5,
): CallPath | null {
  const fromNodes = getNodeByName(db, fromName);
  const toNodes = getNodeByName(db, toName);
  if (fromNodes.length === 0 || toNodes.length === 0) return null;

  const fromNode = fromNodes[0];
  const toIds = new Set(toNodes.map(n => n.id));

  // id → name 映射，回溯路径时直接查表，避免重复 SQL
  const allNodes = getAllNodes(db);
  const idToName = new Map<string, string>();
  for (const n of allNodes) idToName.set(n.id, n.name);

  // 起点 = 终点的边界
  if (toIds.has(fromNode.id)) {
    return { nodeIds: [fromNode.id], symbolNames: [fromNode.name] };
  }

  // BFS：从 fromNode 沿 CALLS 边遍历到 toNode
  const visited = new Set<string>([fromNode.id]);
  const parent = new Map<string, string | null>();
  parent.set(fromNode.id, null);
  const queue: Array<{ id: string; depth: number }> = [{ id: fromNode.id, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    // 沿 CALLS 边遍历（target 已统一为节点 ID）
    const edges = queryEdges(
      db,
      'SELECT * FROM edges WHERE source = ? AND kind = ?',
      [id, 'CALLS'],
    );
    for (const edge of edges) {
      const nextId = edge.target;
      if (visited.has(nextId)) continue;
      // 仅走真实节点 ID（跳过仍是字符串名的边 target，容错旧数据）
      if (!idToName.has(nextId)) continue;
      visited.add(nextId);
      parent.set(nextId, id);

      if (toIds.has(nextId)) {
        // 找到终点：回溯 parent 链构建路径
        const nodeIds: string[] = [];
        let cur: string | null = nextId;
        while (cur !== null && cur !== undefined) {
          nodeIds.unshift(cur);
          cur = parent.get(cur) ?? null;
        }
        const symbolNames = nodeIds.map(id2 => idToName.get(id2) ?? id2);
        return { nodeIds, symbolNames };
      }

      queue.push({ id: nextId, depth: depth + 1 });
    }
  }

  return null;
}

/**
 * 查找某符号的多跳调用链（沿 CALLS 边 BFS，返回多条路径）
 *
 * 短板 3：用于 explore 生成真实多跳 callPaths
 *
 * @param direction 'callees' = 正向（它调用了谁）；'callers' = 反向（谁调用了它）
 * @param maxDepth 路径最大跳数（默认 3，防爆炸）
 * @returns CallPath[]，仅包含长度 ≥ 2 的路径
 */
export function findCallChain(
  db: DB,
  symbolName: string,
  direction: 'callers' | 'callees',
  maxDepth = 3,
): CallPath[] {
  // 防爆炸：硬限制 maxDepth ≤ 5
  const effectiveDepth = Math.min(maxDepth, 5);
  const startNodes = getNodeByName(db, symbolName);
  if (startNodes.length === 0) return [];

  const allNodes = getAllNodes(db);
  const idToName = new Map<string, string>();
  for (const n of allNodes) idToName.set(n.id, n.name);

  const MAX_PATHS = 20; // 路径数硬上限，防止爆炸
  const results: CallPath[] = [];
  const seenPathKeys = new Set<string>();

  for (const startNode of startNodes) {
    if (results.length >= MAX_PATHS) break;

    const startPath: CallPath = {
      nodeIds: [startNode.id],
      symbolNames: [startNode.name],
    };

    // DFS 枚举每条路径（栈实现），用 visited Set 防环
    const stack: Array<{ path: CallPath; depth: number; visited: Set<string> }> = [
      { path: startPath, depth: 0, visited: new Set([startNode.id]) },
    ];

    while (stack.length > 0 && results.length < MAX_PATHS) {
      const { path, depth, visited } = stack.pop()!;

      // 深度达到上限：提交路径（仅长度 ≥ 2）
      if (depth >= effectiveDepth) {
        if (path.nodeIds.length >= 2) {
          const key = path.nodeIds.join('|');
          if (!seenPathKeys.has(key)) {
            seenPathKeys.add(key);
            results.push(path);
          }
        }
        continue;
      }

      const lastId = path.nodeIds[path.nodeIds.length - 1];

      // callees = 正向（source=lastId）；callers = 反向（target=lastId）
      const edges = direction === 'callees'
        ? queryEdges(db, 'SELECT * FROM edges WHERE source = ? AND kind = ?', [lastId, 'CALLS'])
        : queryEdges(db, 'SELECT * FROM edges WHERE target = ? AND kind = ?', [lastId, 'CALLS']);

      const nextIds: string[] = [];
      for (const edge of edges) {
        const nextId = direction === 'callees' ? edge.target : edge.source;
        if (visited.has(nextId)) continue;
        if (!idToName.has(nextId)) continue; // 仅走真实节点 ID，容错旧数据
        nextIds.push(nextId);
      }

      if (nextIds.length === 0) {
        // 叶子节点：提交路径（仅长度 ≥ 2，确保不是孤立单节点）
        if (path.nodeIds.length >= 2) {
          const key = path.nodeIds.join('|');
          if (!seenPathKeys.has(key)) {
            seenPathKeys.add(key);
            results.push(path);
          }
        }
        continue;
      }

      // 扩展：reverse 保证 DFS 顺序稳定（栈 LIFO）
      for (let i = nextIds.length - 1; i >= 0; i--) {
        const nextId = nextIds[i];
        const newPath: CallPath = {
          nodeIds: [...path.nodeIds, nextId],
          symbolNames: [...path.symbolNames, idToName.get(nextId)!],
        };
        const newVisited = new Set(visited);
        newVisited.add(nextId);
        stack.push({ path: newPath, depth: depth + 1, visited: newVisited });
      }
    }
  }

  return results;
}

/**
 * Phase 72 Task D3：风险分级
 *
 * 借鉴 codebase-memory-mcp 的 detect_changes 风险分类思路
 * - high：调用方 > 10 或 是 entry point（exported / main / index / run / start）或 跨包
 * - medium：调用方 3-10 或 同包内跨文件
 * - low：调用方 < 3 或 仅同文件内
 *
 * 决策：不扩展 CodeMapNode 类型新增 isEntryPoint / crossPackage 字段，
 * 而是用现有字段推断（exported / name / filePath 顶层目录），避免 schema 改动传导到 extractor
 *
 * 注意：本函数为启发式推断，精度有限：
 *   - isEntryPoint 用 exported + 入口符号名集合猜测，可能漏判非 exported 的真入口
 *     （如 HTTP handler、CLI subcommand），也可能误判 exported 的内部工具函数
 *   - crossPackage 用 filePath 顶层目录推断包边界，对 monorepo 子包结构准确，
 *     但对单包多层目录项目可能误判跨包
 * 未来可扩展 schema 显式存储 isEntryPoint / crossPackage，由 extractor 在索引阶段精确标注
 */
function classifyRisk(
  node: CodeMapNode,
  callerCount: number,
  callerFilePaths: string[],
): RiskLevel {
  // isEntryPoint 推断：exported 函数 + 常见入口符号名
  const entryPointNames = new Set(['main', 'index', 'run', 'start', 'bootstrap', 'init']);
  const isEntryPoint = node.exported === true || entryPointNames.has(node.name.toLowerCase());

  // crossPackage 推断：任一 caller 的顶层目录与 node 不同
  // 例：node 在 src/code-map/，caller 在 src/agent/ → 跨包
  const nodeTopDir = node.filePath.split('/')[0] ?? '';
  const crossPackage = callerFilePaths.some(fp => (fp.split('/')[0] ?? '') !== nodeTopDir);

  if (callerCount > 10 || isEntryPoint || crossPackage) return 'high';
  if (callerCount >= 3) return 'medium';
  // < 3 调用方：检查是否同文件
  const sameFileOnly = callerFilePaths.length === 0 || callerFilePaths.every(fp => fp === node.filePath);
  return sameFileOnly ? 'low' : 'medium';
}

/** 风险等级排序权重（用于降序排列） */
const RISK_ORDER: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1 };

/** 影响分析：反向 BFS 收集所有受影响符号 */
export function analyzeImpact(
  db: DB,
  fileOrSymbol: string,
  maxDepth = 3,
): ImpactResult {
  // 判断是文件还是符号
  const allNodes = getAllNodes(db);
  const allEdges = getAllEdges(db);

  let rootNodes: CodeMapNode[];
  if (fileOrSymbol.includes('/') || fileOrSymbol.includes('\\')) {
    // 文件路径
    rootNodes = allNodes.filter(n => n.filePath === fileOrSymbol || n.filePath.endsWith(fileOrSymbol));
  } else {
    // 符号名
    rootNodes = allNodes.filter(n => n.name === fileOrSymbol);
  }

  if (rootNodes.length === 0) {
    return {
      root: fileOrSymbol,
      impactedNodes: [],
      impactedFiles: [],
      maxDepth,
      totalCount: 0,
    };
  }

  // 构建 target → sources 反向边映射（同时记录 source 的 filePath 用于 crossPackage 判断）
  const reverseEdges = new Map<string, string[]>();
  // node id → 调用方 filePath 列表（用于风险分级）
  const nodeCallerFiles = new Map<string, string[]>();
  for (const edge of allEdges) {
    if (edge.kind !== 'CALLS' && edge.kind !== 'IMPORTS' && edge.kind !== 'EXTENDS' && edge.kind !== 'IMPLEMENTS') continue;
    const sources = reverseEdges.get(edge.target) ?? [];
    sources.push(edge.source);
    reverseEdges.set(edge.target, sources);
  }

  // BFS
  const visited = new Set<string>();
  const impacted: CodeMapNode[] = [];
  const impactedFiles = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];

  for (const root of rootNodes) {
    queue.push({ id: root.id, depth: 0 });
    visited.add(root.id);
    impacted.push(root);
    impactedFiles.add(root.filePath);
  }

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    // 找到此节点的所有名称形式
    const node = allNodes.find(n => n.id === id);
    const lookupKeys = [id];
    if (node) lookupKeys.push(node.name);

    for (const key of lookupKeys) {
      const sources = reverseEdges.get(key) ?? [];
      for (const sourceId of sources) {
        if (visited.has(sourceId)) continue;
        visited.add(sourceId);
        const sourceNode = allNodes.find(n => n.id === sourceId);
        if (sourceNode) {
          impacted.push(sourceNode);
          impactedFiles.add(sourceNode.filePath);
          queue.push({ id: sourceId, depth: depth + 1 });
        }
      }
    }
  }

  // Phase 72 Task D3：计算每个受影响节点的风险等级
  // 预构建 node id → callers filePath 列表（仅 impacted 内节点的 CALLS 反向边）
  const impactedIdSet = new Set(impacted.map(n => n.id));
  for (const node of impacted) {
    const lookupKeys = [node.id, node.name];
    const callerFiles: string[] = [];
    for (const key of lookupKeys) {
      const sources = reverseEdges.get(key) ?? [];
      for (const sourceId of sources) {
        // 仅统计 impacted 集合内的 callers（受影响的调用方），避免引入无关节点
        if (impactedIdSet.has(sourceId)) {
          const caller = allNodes.find(n => n.id === sourceId);
          if (caller) callerFiles.push(caller.filePath);
        }
      }
    }
    nodeCallerFiles.set(node.id, callerFiles);
  }

  // 为每个 impacted 节点计算 risk
  const riskPairs: Array<{ node: CodeMapNode; risk: RiskLevel }> = impacted.map(node => {
    const callerFiles = nodeCallerFiles.get(node.id) ?? [];
    // 去重 caller filePath（同一文件多个 caller 只算一次跨包判断，但 callerCount 用原始数）
    const callerCount = callerFiles.length;
    return { node, risk: classifyRisk(node, callerCount, callerFiles) };
  });

  // 按 risk 降序排列（high → medium → low）
  riskPairs.sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk]);

  return {
    root: fileOrSymbol,
    impactedNodes: riskPairs.map(p => p.node),
    impactedFiles: Array.from(impactedFiles),
    maxDepth,
    totalCount: riskPairs.length,
    riskLevels: riskPairs.map(p => p.risk),
  };
}

/** 获取文件/目录的符号树 */
export function getFileStructure(db: DB, filePath?: string): FileNode[] {
  const allFiles = getAllFiles(db);
  const allNodes = getAllNodes(db);

  if (filePath) {
    // 单文件
    const file = allFiles.find(f => f.path === filePath || f.path.endsWith(filePath));
    if (!file) return [];
    const symbols = allNodes.filter(n => n.filePath === file.path);
    return [{
      name: path.basename(file.path),
      path: file.path,
      isDirectory: false,
      symbols,
    }];
  }

  // 全部文件，构建目录树
  const root: FileNode = { name: '', path: '', isDirectory: true, children: [] };

  for (const file of allFiles) {
    const parts = file.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const curPath = parts.slice(0, i + 1).join('/');

      if (isLast) {
        // 文件节点
        const symbols = allNodes.filter(n => n.filePath === file.path);
        current.children!.push({
          name: part,
          path: curPath,
          isDirectory: false,
          symbols,
        });
      } else {
        // 目录节点
        let dir = current.children!.find(c => c.isDirectory && c.name === part);
        if (!dir) {
          dir = { name: part, path: curPath, isDirectory: true, children: [] };
          current.children!.push(dir);
        }
        current = dir;
      }
    }
  }

  return root.children ?? [];
}

/** 获取索引状态 */
export function getStatus(db: DB): IndexStatus {
  return getIndexStatus(db);
}

// ---- 辅助函数 ----

/**
 * PPR 或 rankScore 排序（原 explore 排序逻辑，抽取为辅助函数供增量分支 fail-open 回退复用）
 *
 * Phase 71 Task A3：PPR 上下文感知排序
 * 种子 = git diff 变更文件符号（缓存） + query 关键词匹配符号
 */
function rankByPPROrScore(
  db: DB,
  allNodes: CodeMapNode[],
  filtered: CodeMapNode[],
  maxResults: number,
): CodeMapNode[] {
  const gitSeeds = getSeedNodeIdsFromCache(db);
  const querySeeds = new Set(filtered.map(n => n.id));
  const seedNodeIds = new Set<string>([...gitSeeds, ...querySeeds]);

  if (seedNodeIds.size > 0) {
    // 有种子：用 Personalized PageRank 重排序
    try {
      const allEdges = getAllEdges(db).map(e => ({
        source: e.source,
        target: e.target,
        weight: e.weight,
      })) as RankedEdge[];
      const scores = computePersonalizedPageRank(
        allNodes.map(n => n.id),
        allEdges,
        seedNodeIds,
      );
      return filtered
        .map(n => ({ ...n, rankScore: scores.get(n.id) ?? 0 }))
        .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
        .slice(0, maxResults);
    } catch {
      // PPR 计算失败：fail-open 回退原 rankScore 排序
      return filtered
        .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
        .slice(0, maxResults);
    }
  }
  // 无种子：保留原 rankScore 排序（零回归）
  return filtered
    .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
    .slice(0, maxResults);
}

/** 读取源代码片段 */
async function readSnippetAsync(
  fullPath: string,
  startLine: number,
  endLine: number,
  symbolName?: string,
): Promise<CodeSnippet | null> {
  try {
    const content = await fsp.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, startLine);
    const end = Math.min(lines.length - 1, endLine);
    const snippetLines = lines.slice(start, end + 1);
    return {
      filePath: fullPath,
      startLine: start,
      endLine: end,
      content: snippetLines.join('\n'),
      symbolName,
    };
  } catch {
    return null;
  }
}

/** 同步版读取片段（简化：只读起始行附近） */
function readSnippet(
  fullPath: string,
  startLine: number,
  endLine: number,
  symbolName?: string,
): CodeSnippet | null {
  try {
    const content = require('fs').readFileSync(fullPath, 'utf-8') as string;
    const lines = content.split('\n');
    const start = Math.max(0, startLine);
    const end = Math.min(lines.length - 1, endLine);
    const snippetLines = lines.slice(start, end + 1);
    return {
      filePath: fullPath,
      startLine: start,
      endLine: end,
      content: snippetLines.join('\n'),
      symbolName,
    };
  } catch {
    return null;
  }
}

/** 计算影响半径（简化版：BFS 深度） */
function computeImpactRadius(db: DB, nodeId: string): number {
  const allEdges = getAllEdges(db);
  const reverseEdges = new Map<string, string[]>();
  for (const edge of allEdges) {
    if (edge.kind !== 'CALLS') continue;
    const sources = reverseEdges.get(edge.target) ?? [];
    sources.push(edge.source);
    reverseEdges.set(edge.target, sources);
  }

  const visited = new Set<string>([nodeId]);
  let maxDepth = 0;
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    maxDepth = Math.max(maxDepth, depth);
    if (depth >= 5) continue;
    const sources = reverseEdges.get(id) ?? [];
    for (const sourceId of sources) {
      if (visited.has(sourceId)) continue;
      visited.add(sourceId);
      queue.push({ id: sourceId, depth: depth + 1 });
    }
  }

  return maxDepth;
}

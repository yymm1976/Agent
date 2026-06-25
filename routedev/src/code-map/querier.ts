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
} from './schema.js';
import {
  queryNodes,
  queryEdges,
  getNodeByName,
  getAllFiles,
  getAllNodes,
  getAllEdges,
  getIndexStatus,
  type DB,
} from './database.js';

/** 查询选项 */
export interface QueryOptions {
  /** 最大返回数 */
  maxResults?: number;
  /** 是否包含源代码片段 */
  includeSnippets?: boolean;
  /** 是否包含调用路径 */
  includeCallPaths?: boolean;
  /** 文件过滤提示 */
  fileHint?: string;
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
  const matched = allNodes
    .filter(node => {
      const nameLower = node.name.toLowerCase();
      const sigLower = (node.signature ?? '').toLowerCase();
      return keywords.some(kw => nameLower.includes(kw) || sigLower.includes(kw));
    })
    .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
    .slice(0, maxResults);

  // 收集源代码片段
  const snippets: CodeSnippet[] = [];
  if (options?.includeSnippets !== false) {
    for (const node of matched.slice(0, 10)) {
      const fullPath = path.join(rootDir, node.filePath);
      const snippet = readSnippet(fullPath, node.startLine, node.endLine, node.name);
      if (snippet) snippets.push(snippet);
    }
  }

  // 调用路径
  const callPaths = options?.includeCallPaths !== false
    ? matched.slice(0, 5).map(n => ({ nodeIds: [n.id], symbolNames: [n.name] }))
    : [];

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

  // 构建 target → sources 反向边映射
  const reverseEdges = new Map<string, string[]>();
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

  return {
    root: fileOrSymbol,
    impactedNodes: impacted,
    impactedFiles: Array.from(impactedFiles),
    maxDepth,
    totalCount: impacted.length,
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

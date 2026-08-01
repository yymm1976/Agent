// src/code-map/extractor-utils.ts
// extractor 共享辅助函数与类型（跨语言通用）

import type {
  CodeMapNode,
  CodeMapEdge,
  SymbolKind,
} from './schema.js';
import type { TSNode } from './parser.js';

/** 待解析的调用引用（callee 暂时只知名字，未匹配到定义节点） */
export interface PendingReference {
  /** 调用者节点 ID */
  sourceId: string;
  /** 被调用函数/方法名（来自 call_expression） */
  calleeName: string;
  /** 调用所在行（1-based） */
  line: number;
  /** 调用所在文件路径 */
  filePath: string;
  /**
   * Phase 72 Task D4：该 callee 来自的 import source（若 calleeName 在当前文件 import 列表中）
   * 供 indexer.resolveCrossFileCalls 用 type-resolver 精确解析跨文件 definition
   * 若 callee 是同文件内定义，此字段为 undefined
   */
  importSource?: string;
}

/** 提取结果 */
export interface ExtractionResult {
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
  /** 未解析到定义节点的调用引用（供后续索引补全） */
  unresolvedRefs?: PendingReference[];
}

/** 生成节点 ID */
export function makeNodeId(filePath: string, startLine: number, name: string): string {
  return `${filePath}:${startLine}:${name}`;
}

/** 生成边 ID */
export function makeEdgeId(source: string, target: string, kind: string): string {
  return `${source}->${target}:${kind}`;
}

/** 提取函数签名（简化版：取声明首行） */
export function extractSignature(node: TSNode, kind: SymbolKind): string | undefined {
  if (kind === 'import') return undefined;
  const text = node.text;
  // 取第一个 { 或 : 之前的部分作为签名
  const firstLine = text.split('\n')[0] ?? text;
  // 限制长度
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '...' : firstLine;
}

/** 找到包含某个 AST 节点的最近符号节点 */
export function findEnclosingSymbol(
  node: TSNode,
  filePath: string,
  nodes: CodeMapNode[],
): CodeMapNode | null {
  let current: TSNode | null = node.parent;
  while (current) {
    const matching = nodes.find(
      n =>
        n.filePath === filePath &&
        n.startLine === current!.startPosition.row &&
        n.kind !== 'import' &&
        n.kind !== 'variable',
    );
    if (matching) return matching;
    current = current.parent;
  }
  return null;
}

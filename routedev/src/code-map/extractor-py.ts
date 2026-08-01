// src/code-map/extractor-py.ts
// Python 节点符号提取

import type {
  CodeMapNode,
  CodeMapEdge,
  Language,
} from './schema.js';
import { EDGE_WEIGHTS } from './schema.js';
import type { TSNode } from './parser.js';
import {
  PY_CALL_TYPE,
  getPyNodeName,
  isPyAsync,
  extractPyCallName,
  extractPyImportSource,
  extractPyImportedNames,
  extractPyBases,
} from './languages/python.js';
import {
  makeNodeId,
  makeEdgeId,
  extractSignature,
  findEnclosingSymbol,
} from './extractor-utils.js';
import type { PendingReference } from './extractor-utils.js';

/**
 * 处理 Python 单个 AST 节点的符号提取。
 * 返回 true 表示已自行处理子节点递归（短路），false 表示由调用方继续递归子节点。
 */
export function extractPyNode(
  node: TSNode,
  filePath: string,
  language: Language,
  parentClass: string | null,
  nodes: CodeMapNode[],
  edges: CodeMapEdge[],
  fileNodeId: string,
  pendingReferences: PendingReference[],
  walkAndExtract: (
    node: TSNode,
    filePath: string,
    language: Language,
    parentClass: string | null,
    nodes: CodeMapNode[],
    edges: CodeMapEdge[],
    fileNodeId: string,
    pendingReferences: PendingReference[],
  ) => void,
): boolean {
  const nodeType = node.type;

  // function_definition (top-level or method inside class)
  if (nodeType === 'function_definition') {
    const name = getPyNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, parentClass ? `${parentClass}.${name}` : name);
      const async = isPyAsync(node);
      const kind = parentClass ? 'method' : 'function';
      nodes.push({
        id,
        name,
        kind,
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, kind),
        async,
        className: parentClass ?? undefined,
      });
      edges.push({
        id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
        source: fileNodeId,
        target: id,
        kind: 'CONTAINS',
        weight: EDGE_WEIGHTS.CONTAINS,
      });
    }
  }
  // class_definition
  else if (nodeType === 'class_definition') {
    const name = getPyNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      const bases = extractPyBases(node);
      nodes.push({
        id,
        name,
        kind: 'class',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'class'),
        extends: bases,
      });
      edges.push({
        id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
        source: fileNodeId,
        target: id,
        kind: 'CONTAINS',
        weight: EDGE_WEIGHTS.CONTAINS,
      });
      for (const base of bases) {
        edges.push({
          id: makeEdgeId(id, base, 'EXTENDS'),
          source: id,
          target: base,
          kind: 'EXTENDS',
          weight: EDGE_WEIGHTS.EXTENDS,
        });
      }
      // 递归处理 class body
      for (const child of node.children) {
        if (child.type === 'block') {
          for (const bb of child.children) {
            walkAndExtract(bb, filePath, language, name, nodes, edges, fileNodeId, pendingReferences);
          }
        }
      }
      return true;
    }
  }
  // import_statement / import_from_statement
  else if (nodeType === 'import_statement' || nodeType === 'import_from_statement') {
    const source = extractPyImportSource(node);
    const importedNames = extractPyImportedNames(node);
    const id = makeNodeId(filePath, node.startPosition.row, `import:${source ?? '?'}`);
    nodes.push({
      id,
      name: `import:${source ?? '?'}`,
      kind: 'import',
      filePath,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      sourceModule: source ?? undefined,
      importedNames,
    });
    edges.push({
      id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
      source: fileNodeId,
      target: id,
      kind: 'CONTAINS',
      weight: EDGE_WEIGHTS.CONTAINS,
    });
    if (source) {
      edges.push({
        id: makeEdgeId(fileNodeId, source, 'IMPORTS'),
        source: fileNodeId,
        target: source,
        kind: 'IMPORTS',
        weight: EDGE_WEIGHTS.IMPORTS,
      });
    }
  }
  // call → 收集 pendingReference（在 extractFromTree 末尾解析为 CALLS 边）
  else if (nodeType === PY_CALL_TYPE) {
    const calleeName = extractPyCallName(node);
    if (calleeName) {
      const enclosingSymbol = findEnclosingSymbol(node, filePath, nodes);
      if (enclosingSymbol) {
        pendingReferences.push({
          sourceId: enclosingSymbol.id,
          calleeName,
          line: node.startPosition.row + 1,
          filePath,
        });
      }
    }
  }

  return false;
}

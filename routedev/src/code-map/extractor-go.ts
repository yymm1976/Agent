// src/code-map/extractor-go.ts
// Go 节点符号提取

import type {
  CodeMapNode,
  CodeMapEdge,
  Language,
} from './schema.js';
import { EDGE_WEIGHTS } from './schema.js';
import type { TSNode } from './parser.js';
import {
  GO_CALL_TYPE,
  getGoNodeName,
  extractGoTypeSpecs,
  extractGoStructEmbeddings,
  extractGoImportSources,
  extractGoCallName,
  extractGoReceiverType,
} from './languages/go.js';
import {
  makeNodeId,
  makeEdgeId,
  extractSignature,
  findEnclosingSymbol,
} from './extractor-utils.js';
import type { PendingReference } from './extractor-utils.js';

/**
 * 处理 Go 单个 AST 节点的符号提取。
 * 返回 true 表示已自行处理子节点递归（短路），false 表示由调用方继续递归子节点。
 * Go 分支无短路逻辑，统一返回 false。
 */
export function extractGoNode(
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

  // import_declaration
  if (nodeType === 'import_declaration') {
    const imports = extractGoImportSources(node);
    for (const imp of imports) {
      const id = makeNodeId(filePath, node.startPosition.row, `import:${imp.path}`);
      nodes.push({
        id,
        name: `import:${imp.path}`,
        kind: 'import',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        sourceModule: imp.path,
        importedNames: imp.importedNames,
      });
      edges.push({
        id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
        source: fileNodeId,
        target: id,
        kind: 'CONTAINS',
        weight: EDGE_WEIGHTS.CONTAINS,
      });
      edges.push({
        id: makeEdgeId(fileNodeId, imp.path, 'IMPORTS'),
        source: fileNodeId,
        target: imp.path,
        kind: 'IMPORTS',
        weight: EDGE_WEIGHTS.IMPORTS,
      });
    }
  }
  // function_declaration（top-level）
  else if (nodeType === 'function_declaration') {
    const name = getGoNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      nodes.push({
        id,
        name,
        kind: 'function',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'function'),
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
  // method_declaration
  else if (nodeType === 'method_declaration') {
    const name = getGoNodeName(node);
    const receiverType = extractGoReceiverType(node);
    if (name && receiverType) {
      const id = makeNodeId(filePath, node.startPosition.row, `${receiverType}.${name}`);
      nodes.push({
        id,
        name,
        kind: 'method',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'method'),
        className: receiverType,
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
  // type_declaration → 内部 type_spec 决定是 class（struct）还是 interface
  else if (nodeType === 'type_declaration') {
    const specs = extractGoTypeSpecs(node);
    for (const spec of specs) {
      const id = makeNodeId(filePath, node.startPosition.row, spec.name);
      nodes.push({
        id,
        name: spec.name,
        kind: spec.kind,
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, spec.kind),
      });
      edges.push({
        id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
        source: fileNodeId,
        target: id,
        kind: 'CONTAINS',
        weight: EDGE_WEIGHTS.CONTAINS,
      });
      // struct 嵌入字段 → EXTENDS 边
      if (spec.kind === 'class') {
        const embeddings = extractGoStructEmbeddings(spec.specNode);
        for (const emb of embeddings) {
          edges.push({
            id: makeEdgeId(id, emb, 'EXTENDS'),
            source: id,
            target: emb,
            kind: 'EXTENDS',
            weight: EDGE_WEIGHTS.EXTENDS,
          });
        }
      }
    }
  }
  // call_expression → 收集 pendingReference
  else if (nodeType === GO_CALL_TYPE) {
    const calleeName = extractGoCallName(node);
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

// src/code-map/extractor-java.ts
// Java 节点符号提取

import type {
  CodeMapNode,
  CodeMapEdge,
  Language,
} from './schema.js';
import { EDGE_WEIGHTS } from './schema.js';
import type { TSNode } from './parser.js';
import {
  JAVA_CALL_TYPE,
  getJavaNodeName,
  extractJavaModifiers,
  extractJavaExtends,
  extractJavaImplements,
  extractJavaImportSource,
  extractJavaImportedNames,
  extractJavaCallName,
  extractJavaReturnType,
  extractJavaFieldName,
} from './languages/java.js';
import {
  makeNodeId,
  makeEdgeId,
  extractSignature,
  findEnclosingSymbol,
} from './extractor-utils.js';
import type { PendingReference } from './extractor-utils.js';

/**
 * 处理 Java 单个 AST 节点的符号提取。
 * 返回 true 表示已自行处理子节点递归（短路），false 表示由调用方继续递归子节点。
 */
export function extractJavaNode(
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
    const source = extractJavaImportSource(node);
    const importedNames = extractJavaImportedNames(node);
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
  // class_declaration
  else if (nodeType === 'class_declaration') {
    const name = getJavaNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      const { visibility, static: static_ } = extractJavaModifiers(node);
      const extendsList = extractJavaExtends(node);
      const implementsList = extractJavaImplements(node);
      nodes.push({
        id,
        name,
        kind: 'class',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'class'),
        visibility,
        static: static_,
        extends: extendsList,
        implements: implementsList,
      });
      edges.push({
        id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
        source: fileNodeId,
        target: id,
        kind: 'CONTAINS',
        weight: EDGE_WEIGHTS.CONTAINS,
      });
      for (const ext of extendsList) {
        edges.push({
          id: makeEdgeId(id, ext, 'EXTENDS'),
          source: id,
          target: ext,
          kind: 'EXTENDS',
          weight: EDGE_WEIGHTS.EXTENDS,
        });
      }
      for (const impl of implementsList) {
        edges.push({
          id: makeEdgeId(id, impl, 'IMPLEMENTS'),
          source: id,
          target: impl,
          kind: 'IMPLEMENTS',
          weight: EDGE_WEIGHTS.IMPLEMENTS,
        });
      }
      // 递归处理 class_body（不增加 parentClass，Java method 节点 ID 自带类名前缀）
      for (const child of node.children) {
        if (child.type === 'class_body') {
          for (const mb of child.children) {
            walkAndExtract(mb, filePath, language, name, nodes, edges, fileNodeId, pendingReferences);
          }
        }
      }
      return true;
    }
  }
  // interface_declaration
  else if (nodeType === 'interface_declaration') {
    const name = getJavaNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      const { visibility } = extractJavaModifiers(node);
      nodes.push({
        id,
        name,
        kind: 'interface',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'interface'),
        visibility,
      });
      edges.push({
        id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
        source: fileNodeId,
        target: id,
        kind: 'CONTAINS',
        weight: EDGE_WEIGHTS.CONTAINS,
      });
      // 递归处理 interface_body
      for (const child of node.children) {
        if (child.type === 'interface_body') {
          for (const mb of child.children) {
            walkAndExtract(mb, filePath, language, name, nodes, edges, fileNodeId, pendingReferences);
          }
        }
      }
      return true;
    }
  }
  // method_declaration
  else if (nodeType === 'method_declaration' && parentClass) {
    const name = getJavaNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, `${parentClass}.${name}`);
      const { visibility, static: static_ } = extractJavaModifiers(node);
      const returnType = extractJavaReturnType(node);
      const signature = returnType ? `${returnType} ${name}(...)` : extractSignature(node, 'method');
      nodes.push({
        id,
        name,
        kind: 'method',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature,
        visibility,
        static: static_,
        className: parentClass,
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
  // field_declaration（仅 public 字段）
  else if (nodeType === 'field_declaration' && parentClass) {
    const { visibility } = extractJavaModifiers(node);
    // 仅提取 public 字段（避免把私有字段塞进图里）
    if (visibility === 'public') {
      const name = extractJavaFieldName(node);
      if (name) {
        const id = makeNodeId(filePath, node.startPosition.row, `${parentClass}.${name}`);
        nodes.push({
          id,
          name,
          kind: 'variable',
          filePath,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          visibility,
          className: parentClass,
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
  }
  // method_invocation → 收集 pendingReference
  else if (nodeType === JAVA_CALL_TYPE) {
    const calleeName = extractJavaCallName(node);
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

// src/code-map/extractor-ts.ts
// TypeScript / TSX / JavaScript 节点符号提取

import type {
  CodeMapNode,
  CodeMapEdge,
  Language,
} from './schema.js';
import { EDGE_WEIGHTS } from './schema.js';
import type { TSNode } from './parser.js';
import {
  TS_ARROW_FUNCTION_TYPE,
  TS_CALL_EXPRESSION_TYPE,
  getTsNodeName,
  isTsExported,
  isTsAsync,
  extractTsCallName,
  extractTsImportSource,
  extractTsImportedNames,
} from './languages/typescript.js';
import {
  makeNodeId,
  makeEdgeId,
  extractSignature,
  findEnclosingSymbol,
} from './extractor-utils.js';
import type { PendingReference } from './extractor-utils.js';

/** 判断 TS/JS 变量声明是否是 arrow function */
function isArrowFunctionDeclaration(node: TSNode): boolean {
  // lexical_declaration / variable_declaration -> variable_declarator -> arrow_function
  for (const decl of node.children) {
    if (decl.type === 'variable_declarator') {
      for (const child of decl.children) {
        if (child.type === TS_ARROW_FUNCTION_TYPE) return true;
      }
    }
  }
  return false;
}

/** 从 lexical_declaration 提取变量名（首个 declarator 的 name） */
function getVariableDeclaratorName(node: TSNode): string | null {
  for (const decl of node.children) {
    if (decl.type === 'variable_declarator') {
      const nameNode = decl.childForFieldName('name');
      if (nameNode) return nameNode.text;
    }
  }
  return null;
}

/** 从 lexical_declaration 提取所有变量名 */
function getAllDeclaratorNames(node: TSNode): string[] {
  const names: string[] = [];
  for (const decl of node.children) {
    if (decl.type === 'variable_declarator') {
      const nameNode = decl.childForFieldName('name');
      if (nameNode) names.push(nameNode.text);
    }
  }
  return names;
}

/** 提取 class_heritage 中的 extends / implements */
function extractTsHeritage(node: TSNode): { extends: string[]; implements: string[] } {
  const extendsList: string[] = [];
  const implementsList: string[] = [];
  // class_body 之前可能有 class_heritage
  for (const child of node.children) {
    if (child.type === 'class_heritage') {
      for (const hc of child.children) {
        const text = hc.text;
        if (text.startsWith('extends')) {
          // extends Foo, Bar
          const after = text.slice('extends'.length).trim();
          for (const part of after.split(',')) {
            const trimmed = part.trim();
            if (trimmed) extendsList.push(trimmed);
          }
        } else if (text.startsWith('implements')) {
          const after = text.slice('implements'.length).trim();
          for (const part of after.split(',')) {
            const trimmed = part.trim();
            if (trimmed) implementsList.push(trimmed);
          }
        } else if (hc.type === 'extends_clause') {
          // extends_clause: 取 value 字段
          for (const vc of hc.children) {
            if (vc.type === 'identifier' || vc.type === 'member_expression' || vc.type === 'type_identifier') {
              extendsList.push(vc.text);
            }
          }
        } else if (hc.type === 'implements_clause') {
          for (const vc of hc.children) {
            if (vc.type === 'type_identifier' || vc.type === 'generic_type') {
              implementsList.push(vc.text);
            }
          }
        }
      }
    }
  }
  return { extends: extendsList, implements: implementsList };
}

/** 从 interface_declaration 提取 extends */
function extractTsInterfaceExtends(node: TSNode): string[] {
  const extendsList: string[] = [];
  for (const child of node.children) {
    if (child.type === 'extends_clause' || child.type === 'extends_type_clause') {
      for (const vc of child.children) {
        if (vc.type === 'type_identifier' || vc.type === 'generic_type' || vc.type === 'identifier') {
          extendsList.push(vc.text);
        }
      }
    }
  }
  return extendsList;
}

/** 提取 method 的可见性 */
function extractMethodVisibility(node: TSNode): string | undefined {
  for (const child of node.children) {
    if (child.type === 'accessibility_modifier') {
      return child.text;
    }
  }
  return undefined;
}

/** 判断 method 是否 static */
function isMethodStatic(node: TSNode): boolean {
  for (const child of node.children) {
    if (child.type === 'static_modifier' || child.text === 'static') return true;
  }
  return false;
}

/**
 * 处理 TS/JS 单个 AST 节点的符号提取。
 * 返回 true 表示已自行处理子节点递归（短路），false 表示由调用方继续递归子节点。
 */
export function extractTsNode(
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

  // function_declaration
  if (nodeType === 'function_declaration') {
    const name = getTsNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      const exported = isTsExported(node.parent);
      const async = isTsAsync(node);
      nodes.push({
        id,
        name,
        kind: 'function',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'function'),
        async,
        exported,
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
  // class_declaration
  else if (nodeType === 'class_declaration') {
    const name = getTsNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      const exported = isTsExported(node.parent);
      const heritage = extractTsHeritage(node);
      nodes.push({
        id,
        name,
        kind: 'class',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'class'),
        exported,
        extends: heritage.extends,
        implements: heritage.implements,
      });
      edges.push({
        id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
        source: fileNodeId,
        target: id,
        kind: 'CONTAINS',
        weight: EDGE_WEIGHTS.CONTAINS,
      });
      // EXTENDS / IMPLEMENTS 边
      for (const ext of heritage.extends) {
        edges.push({
          id: makeEdgeId(id, ext, 'EXTENDS'),
          source: id,
          target: ext,
          kind: 'EXTENDS',
          weight: EDGE_WEIGHTS.EXTENDS,
        });
      }
      for (const impl of heritage.implements) {
        edges.push({
          id: makeEdgeId(id, impl, 'IMPLEMENTS'),
          source: id,
          target: impl,
          kind: 'IMPLEMENTS',
          weight: EDGE_WEIGHTS.IMPLEMENTS,
        });
      }
      // 递归处理 class_body 中的 method
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
  // method_definition
  else if (nodeType === 'method_definition' && parentClass) {
    const name = getTsNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, `${parentClass}.${name}`);
      const async = isTsAsync(node);
      const static_ = isMethodStatic(node);
      const visibility = extractMethodVisibility(node);
      nodes.push({
        id,
        name,
        kind: 'method',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'method'),
        async,
        static: static_,
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
  // interface_declaration
  else if (nodeType === 'interface_declaration') {
    const name = getTsNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      const exported = isTsExported(node.parent);
      const extendsList = extractTsInterfaceExtends(node);
      nodes.push({
        id,
        name,
        kind: 'interface',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'interface'),
        exported,
        extends: extendsList,
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
    }
  }
  // type_alias_declaration
  else if (nodeType === 'type_alias_declaration') {
    const name = getTsNodeName(node);
    if (name) {
      const id = makeNodeId(filePath, node.startPosition.row, name);
      const exported = isTsExported(node.parent);
      nodes.push({
        id,
        name,
        kind: 'type_alias',
        filePath,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: extractSignature(node, 'type_alias'),
        exported,
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
  // lexical_declaration / variable_declaration (arrow function 或 普通变量)
  else if (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration') {
    const isArrow = isArrowFunctionDeclaration(node);
    const exported = isTsExported(node.parent);
    if (isArrow) {
      const name = getVariableDeclaratorName(node);
      if (name) {
        const id = makeNodeId(filePath, node.startPosition.row, name);
        const async = isTsAsync(node);
        nodes.push({
          id,
          name,
          kind: 'arrow_function',
          filePath,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          signature: extractSignature(node, 'arrow_function'),
          async,
          exported,
        });
        edges.push({
          id: makeEdgeId(fileNodeId, id, 'CONTAINS'),
          source: fileNodeId,
          target: id,
          kind: 'CONTAINS',
          weight: EDGE_WEIGHTS.CONTAINS,
        });
      }
    } else {
      // 普通变量声明
      const names = getAllDeclaratorNames(node);
      for (const name of names) {
        const id = makeNodeId(filePath, node.startPosition.row, name);
        nodes.push({
          id,
          name,
          kind: 'variable',
          filePath,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          exported,
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
  // import_statement
  else if (nodeType === 'import_statement') {
    const source = extractTsImportSource(node);
    const importedNames = extractTsImportedNames(node);
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
  // call_expression → 收集 pendingReference（在 extractFromTree 末尾解析为 CALLS 边）
  else if (nodeType === TS_CALL_EXPRESSION_TYPE) {
    const calleeName = extractTsCallName(node);
    if (calleeName) {
      // 找到包含此 call 的最近符号节点
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

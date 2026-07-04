// src/code-map/extractor.ts
// AST 符号/边提取器

import type {
  CodeMapNode,
  CodeMapEdge,
  Language,
  SymbolKind,
} from './schema.js';
import { EDGE_WEIGHTS } from './schema.js';
import type { TSNode, TSTree } from './parser.js';
import {
  TS_SYMBOL_NODE_TYPES,
  TS_ARROW_FUNCTION_TYPE,
  TS_FUNCTION_TYPES,
  TS_METHOD_TYPES,
  TS_CALL_EXPRESSION_TYPE,
  getTsNodeName,
  isTsExported,
  isTsAsync,
  extractTsCallName,
  extractTsImportSource,
  extractTsImportedNames,
} from './languages/typescript.js';
import {
  PY_SYMBOL_NODE_TYPES,
  PY_CALL_TYPE,
  getPyNodeName,
  isPyAsync,
  extractPyCallName,
  extractPyImportSource,
  extractPyImportedNames,
  extractPyBases,
} from './languages/python.js';
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
  GO_CALL_TYPE,
  getGoNodeName,
  extractGoTypeSpecs,
  extractGoStructEmbeddings,
  extractGoImportSources,
  extractGoCallName,
  extractGoReceiverType,
} from './languages/go.js';

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
}

/** 提取结果 */
export interface ExtractionResult {
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
  /** 未解析到定义节点的调用引用（供后续索引补全） */
  unresolvedRefs?: PendingReference[];
}

/** 生成节点 ID */
function makeNodeId(filePath: string, startLine: number, name: string): string {
  return `${filePath}:${startLine}:${name}`;
}

/** 生成边 ID */
function makeEdgeId(source: string, target: string, kind: string): string {
  return `${source}->${target}:${kind}`;
}

/** 提取函数签名（简化版：取声明首行） */
function extractSignature(node: TSNode, kind: SymbolKind): string | undefined {
  if (kind === 'import') return undefined;
  const text = node.text;
  // 取第一个 { 或 : 之前的部分作为签名
  const firstLine = text.split('\n')[0] ?? text;
  // 限制长度
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '...' : firstLine;
}

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

/** 递归遍历 AST 提取符号和边 */
function walkAndExtract(
  node: TSNode,
  filePath: string,
  language: Language,
  parentClass: string | null,
  nodes: CodeMapNode[],
  edges: CodeMapEdge[],
  fileNodeId: string,
  pendingReferences: PendingReference[],
): void {
  const nodeType = node.type;

  // ---- 符号提取 ----
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
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
        return;
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
  } else if (language === 'python') {
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
        return;
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
  } else if (language === 'java') {
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
        return;
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
        return;
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
  } else if (language === 'go') {
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
  }

  // 递归遍历子节点
  for (const child of node.children) {
    walkAndExtract(child, filePath, language, parentClass, nodes, edges, fileNodeId, pendingReferences);
  }
}

/** 找到包含某个 AST 节点的最近符号节点 */
function findEnclosingSymbol(
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

/** 从 AST 树提取符号和边 */
export function extractFromTree(
  tree: TSTree,
  filePath: string,
  language: Language,
): ExtractionResult {
  const nodes: CodeMapNode[] = [];
  const edges: CodeMapEdge[] = [];
  const pendingReferences: PendingReference[] = [];
  const unresolvedRefs: PendingReference[] = [];
  const fileNodeId = `file:${filePath}`;

  walkAndExtract(tree.rootNode, filePath, language, null, nodes, edges, fileNodeId, pendingReferences);

  // 解析 pendingReferences：按名字匹配定义节点，匹配成功生成 CALLS 边（target=节点 ID），未匹配存入 unresolvedRefs
  for (const ref of pendingReferences) {
    // 优先精确匹配：同文件作用域内或跨文件 exported
    const def = nodes.find(n =>
      n.name === ref.calleeName &&
      (n.filePath === ref.filePath || n.exported === true),
    );
    if (def) {
      edges.push({
        id: makeEdgeId(ref.sourceId, def.id, 'CALLS'),
        source: ref.sourceId,
        target: def.id, // 修复：target 是节点 ID，不是字符串名字
        kind: 'CALLS',
        weight: EDGE_WEIGHTS.CALLS,
      });
    } else {
      unresolvedRefs.push(ref);
    }
  }

  return { nodes, edges, unresolvedRefs };
}

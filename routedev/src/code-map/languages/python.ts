// src/code-map/languages/python.ts
// Python AST 节点类型映射和提取规则

import type { SymbolKind, EdgeKind } from '../schema.js';

/** Python 符号节点类型映射 */
export const PY_SYMBOL_NODE_TYPES: Record<string, SymbolKind> = {
  function_definition: 'function',
  class_definition: 'class',
  import_statement: 'import',
  import_from_statement: 'import',
};

/** Python 调用节点类型 */
export const PY_CALL_TYPE = 'call';

/** Python 装饰器节点类型 */
export const PY_DECORATOR_TYPE = 'decorator';

/** 获取 Python 节点名称 */
export function getPyNodeName(node: {
  type: string;
  childForFieldName(name: string): { text: string } | null;
}): string | null {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text ?? null;
}

/** 判断 Python 函数是否 async（包含 async 关键字修饰符） */
export function isPyAsync(node: {
  children: Array<{ type: string; text: string }>;
}): boolean {
  for (const child of node.children) {
    if (child.type === 'async' || child.text === 'async') return true;
  }
  return false;
}

/** 边类型权重（Python 专用，复用全局权重） */
export const PY_EDGE_KINDS = {
  CALLS: 'CALLS' as EdgeKind,
  IMPORTS: 'IMPORTS' as EdgeKind,
  EXTENDS: 'EXTENDS' as EdgeKind,
  IMPLEMENTS: 'IMPLEMENTS' as EdgeKind,
  CONTAINS: 'CONTAINS' as EdgeKind,
};

/** 从 call 节点中提取被调用函数名 */
export function extractPyCallName(node: {
  type: string;
  childForFieldName(name: string): { text: string; type: string } | null;
  children: Array<{ type: string; text: string }>;
}): string | null {
  const funcNode = node.childForFieldName('function');
  if (funcNode) {
    return funcNode.text;
  }
  // 回退：第一个子节点
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'attribute') {
      return child.text;
    }
  }
  return null;
}

/** 从 import_statement 提取 module 名 */
export function extractPyImportSource(node: {
  type: string;
  children: Array<{ type: string; text: string }>;
}): string | null {
  // import_statement: "import os" 或 "import os.path as op"
  // import_from_statement: "from foo.bar import baz"
  if (node.type === 'import_statement') {
    // 取第一个 dotted_name
    for (const child of node.children) {
      if (child.type === 'dotted_name') {
        return child.text;
      }
    }
  }
  if (node.type === 'import_from_statement') {
    // module 是 from 后的第一个 dotted_name
    let foundFrom = false;
    for (const child of node.children) {
      if (child.type === 'from') {
        foundFrom = true;
        continue;
      }
      if (foundFrom && child.type === 'dotted_name') {
        return child.text;
      }
    }
  }
  return null;
}

/** 从 import 提取 imported names */
export function extractPyImportedNames(node: {
  type: string;
  children: Array<{ type: string; text: string }>;
}): string[] {
  const names: string[] = [];
  if (node.type === 'import_statement') {
    for (const child of node.children) {
      if (child.type === 'dotted_name') {
        names.push(child.text);
      } else if (child.type === 'aliased_import') {
        // "os.path as op" — 取原始名
        names.push(child.text.split(/\s+as\s+/)[0]);
      }
    }
  }
  if (node.type === 'import_from_statement') {
    // imported names 是 import 关键字之后的 dotted_name / identifier
    let foundImport = false;
    for (const child of node.children) {
      if (child.type === 'import') {
        foundImport = true;
        continue;
      }
      if (!foundImport) continue;
      if (child.type === 'dotted_name' || child.type === 'identifier') {
        names.push(child.text);
      } else if (child.type === 'aliased_import') {
        names.push(child.text.split(/\s+as\s+/)[0]);
      } else if (child.type === 'wildcard_import') {
        names.push('*');
      }
    }
  }
  return names;
}

/** 从 class_definition 提取父类（bases） */
export function extractPyBases(node: {
  children: Array<{ type: string; text: string }>;
}): string[] {
  const bases: string[] = [];
  for (const child of node.children) {
    if (child.type === 'argument_list') {
      // class Foo(Base1, Base2): argument_list 内是父类
      const text = child.text;
      // 去掉括号，按逗号分割
      const inner = text.slice(1, -1).trim();
      if (inner) {
        for (const part of inner.split(',')) {
          const trimmed = part.trim();
          if (trimmed) bases.push(trimmed);
        }
      }
    }
  }
  return bases;
}

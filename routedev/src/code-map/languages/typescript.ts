// src/code-map/languages/typescript.ts
// TypeScript / JavaScript AST 节点类型映射和提取规则

import type { SymbolKind, EdgeKind } from '../schema.js';

/** TS/JS 符号节点类型映射 */
export const TS_SYMBOL_NODE_TYPES: Record<string, SymbolKind> = {
  function_declaration: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type_alias',
  lexical_declaration: 'variable',
  variable_declaration: 'variable',
  import_statement: 'import',
};

/** TS/JS 中会产生 arrow_function 的节点 */
export const TS_ARROW_FUNCTION_TYPE = 'arrow_function';
export const TS_FUNCTION_TYPES = new Set(['function_declaration', 'function', 'arrow_function']);
export const TS_METHOD_TYPES = new Set(['method_definition']);

/** import 语句中的 source 字段（字符串字面量） */
export const TS_IMPORT_SOURCE_FIELD = 'source';

/** class_heritage 子节点类型 */
export const TS_HERITAGE_TYPES = {
  extends: 'class_heritage',
  implements: 'class_heritage',
};

/** 调用表达式节点类型 */
export const TS_CALL_EXPRESSION_TYPE = 'call_expression';

/** 获取节点名称的工具：TS AST 中 name 字段通常是 identifier */
export function getTsNodeName(node: {
  type: string;
  childForFieldName(name: string): { text: string } | null;
}): string | null {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text ?? null;
}

/** 判断 declaration 是否 exported（父节点是 export_statement） */
export function isTsExported(parent: { type: string } | null): boolean {
  if (!parent) return false;
  return parent.type === 'export_statement';
}

/** 判断是否 async（修饰符中包含 async） */
export function isTsAsync(node: {
  text: string;
  startPosition: { column: number };
}): boolean {
  // 简单判断：节点文本以 "async " 开头或包含 "async " 关键字
  return /\basync\b/.test(node.text.slice(0, 50));
}

/** 边类型权重（TS 专用，复用全局权重） */
export const TS_EDGE_KINDS = {
  CALLS: 'CALLS' as EdgeKind,
  IMPORTS: 'IMPORTS' as EdgeKind,
  EXTENDS: 'EXTENDS' as EdgeKind,
  IMPLEMENTS: 'IMPLEMENTS' as EdgeKind,
  CONTAINS: 'CONTAINS' as EdgeKind,
};

/** 从 call_expression 中提取被调用函数名 */
export function extractTsCallName(node: {
  type: string;
  childForFieldName(name: string): { text: string; type: string } | null;
  children: Array<{ type: string; text: string }>;
}): string | null {
  const funcNode = node.childForFieldName('function');
  if (funcNode) {
    return funcNode.text;
  }
  // 回退：第一个非括号子节点
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'member_expression') {
      return child.text;
    }
  }
  return null;
}

/** 从 import_statement 中提取 source module */
export function extractTsImportSource(node: {
  children: Array<{ type: string; text: string }>;
}): string | null {
  for (const child of node.children) {
    if (child.type === 'string') {
      // 去掉引号
      return child.text.replace(/^['"`]|['"`]$/g, '');
    }
  }
  return null;
}

/** 从 import_statement 中提取 imported names */
export function extractTsImportedNames(node: {
  children: Array<{ type: string; text: string; childForFieldName(n: string): { text: string } | null }>;
}): string[] {
  const names: string[] = [];
  for (const child of node.children) {
    if (child.type === 'import_clause') {
      // import_clause 可能包含 named_imports、default_import、namespace_import
      const text = child.text;
      // 简单解析：按逗号分割，去掉 import 关键字
      const parts = text.split(',').map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        // 去掉 type 关键字
        const cleaned = part.replace(/^type\s+/, '').trim();
        if (cleaned) {
          // 提取标识符
          const match = cleaned.match(/([A-Za-z_$][\w$]*)/);
          if (match) names.push(match[1]);
        }
      }
    }
  }
  return names;
}

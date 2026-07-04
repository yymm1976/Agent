// src/code-map/languages/go.ts
// Go AST 节点类型映射和提取规则（tree-sitter-go）

import type { SymbolKind } from '../schema.js';
import type { TSNode } from '../parser.js';

/** Go 符号节点类型映射 */
export const GO_SYMBOL_NODE_TYPES: Record<string, SymbolKind> = {
  function_declaration: 'function',
  method_declaration: 'method',
  type_declaration: 'class', // 内部根据 type_spec 二级判断为 class/interface
  import_declaration: 'import',
};

/** Go 调用表达式节点类型 */
export const GO_CALL_TYPE = 'call_expression';

/** 获取 Go 节点名称（identifier / type_identifier / field_identifier） */
export function getGoNodeName(node: TSNode): string | null {
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;
  // 回退：找 identifier / type_identifier / field_identifier 子节点
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'field_identifier') {
      return child.text;
    }
  }
  return null;
}

/** type_spec 解析结果 */
export interface GoTypeSpecResult {
  name: string;
  kind: 'class' | 'interface';
  specNode: TSNode;
}

/**
 * 从 type_declaration 中提取 type_spec 列表
 * 一个 type_declaration 可能包含多个 type_spec：`type ( A struct{}; B int )`
 */
export function extractGoTypeSpecs(node: TSNode): GoTypeSpecResult[] {
  const results: GoTypeSpecResult[] = [];
  for (const child of node.children) {
    if (child.type !== 'type_spec') continue;
    let name = '';
    let kind: 'class' | 'interface' = 'class';
    let specNode: TSNode | null = null;
    for (const sc of child.children) {
      if (sc.type === 'type_identifier') {
        name = sc.text;
      } else if (sc.type === 'struct_type') {
        kind = 'class';
        specNode = sc;
      } else if (sc.type === 'interface_type') {
        kind = 'interface';
        specNode = sc;
      }
    }
    if (name && specNode) {
      results.push({ name, kind, specNode });
    }
  }
  return results;
}

/** 从 Go struct_type 提取嵌入类型（field_declaration 仅含 type_identifier，无 field_identifier） */
export function extractGoStructEmbeddings(structNode: TSNode): string[] {
  const embeddings: string[] = [];
  for (const child of structNode.children) {
    if (child.type !== 'field_declaration_list') continue;
    for (const fd of child.children) {
      if (fd.type !== 'field_declaration') continue;
      // 嵌入字段：field_declaration 内只有 type_identifier（没有 field_identifier）
      let hasFieldId = false;
      let typeName: string | null = null;
      for (const c of fd.children) {
        if (c.type === 'field_identifier') hasFieldId = true;
        if (c.type === 'type_identifier' || c.type === 'qualified_type' || c.type === 'pointer_type') {
          typeName = c.text;
        }
      }
      if (!hasFieldId && typeName) {
        embeddings.push(typeName);
      }
    }
  }
  return embeddings;
}

/** 从 import_declaration 提取所有 import_spec 的 path */
export function extractGoImportSources(node: TSNode): Array<{ path: string; importedNames: string[] }> {
  const results: Array<{ path: string; importedNames: string[] }> = [];
  for (const child of node.children) {
    if (child.type !== 'import_spec') continue;
    let path = '';
    for (const c of child.children) {
      if (c.type === 'interpreted_string_literal') {
        // 去掉引号
        path = c.text.replace(/^"|"$/g, '');
        break;
      }
    }
    if (path) {
      // imported name = path 末段（package 名）
      const parts = path.split('/');
      const last = parts[parts.length - 1] || path;
      results.push({ path, importedNames: [last] });
    }
  }
  return results;
}

/** 从 call_expression 提取被调用函数名（function field） */
export function extractGoCallName(node: TSNode): string | null {
  const funcNode = node.childForFieldName('function');
  if (funcNode) {
    return funcNode.text;
  }
  // 回退：第一个 identifier
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'call_expression' || child.type === 'selector_expression') {
      return child.text;
    }
  }
  return null;
}

/** 从 method_declaration 提取 receiver 类型名（用于构造 method 节点 ID） */
export function extractGoReceiverType(node: TSNode): string | null {
  const recv = node.childForFieldName('receiver');
  if (!recv) return null;
  // parameter_list ( parameter_declaration ( identifier type_identifier ) )
  for (const child of recv.children) {
    if (child.type === 'parameter_declaration') {
      for (const c of child.children) {
        if (c.type === 'type_identifier' || c.type === 'pointer_type' || c.type === 'qualified_type') {
          // 指针类型 *Foo 也算 Foo
          const text = c.text.replace(/^\*/, '');
          return text;
        }
      }
    }
  }
  return null;
}

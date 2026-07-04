// src/code-map/languages/java.ts
// Java AST 节点类型映射和提取规则（tree-sitter-java）

import type { SymbolKind } from '../schema.js';
import type { TSNode } from '../parser.js';

/** Java 符号节点类型映射 */
export const JAVA_SYMBOL_NODE_TYPES: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  method_declaration: 'method',
  field_declaration: 'variable',
  import_declaration: 'import',
};

/** Java 方法调用节点类型 */
export const JAVA_CALL_TYPE = 'method_invocation';

/**
 * 获取 Java 节点名称
 * Java AST 中 name 字段通常是 identifier 子节点（非 field 命名），需要遍历 children 查找
 */
export function getJavaNodeName(node: TSNode): string | null {
  // 优先尝试 name field（部分节点可能有）
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;
  // 回退：取第一个 identifier 子节点
  for (const child of node.children) {
    if (child.type === 'identifier') return child.text;
  }
  return null;
}

/** 提取 Java 修饰符（visibility + static）
 *  tree-sitter-java 中 modifiers 是子节点类型，但 childForFieldName('modifiers') 可能返回 null
 *  （grammar 中 modifiers 未通过 field() 包裹），因此改为按类型扫描 children
 */
export function extractJavaModifiers(node: TSNode): { visibility?: string; static: boolean } {
  let visibility: string | undefined;
  let static_ = false;
  // 按类型查找 modifiers 节点（兼容 field name 缺失的情况）
  let mods: TSNode | null = node.childForFieldName('modifiers');
  if (!mods) {
    for (const child of node.children) {
      if (child.type === 'modifiers') {
        mods = child;
        break;
      }
    }
  }
  if (mods) {
    for (const m of mods.children) {
      if (m.type === 'public' || m.type === 'private' || m.type === 'protected') {
        visibility = m.type;
      } else if (m.type === 'static') {
        static_ = true;
      }
    }
  }
  return { visibility, static: static_ };
}

/** 从 class_declaration 提取 extends（superclass 子节点的 type_identifier）
 *  tree-sitter-java grammar: field('superclass', $.superclass) - field name 与 node type 相同
 */
export function extractJavaExtends(node: TSNode): string[] {
  let sup: TSNode | null = node.childForFieldName('superclass');
  if (!sup) {
    // 回退：按类型扫描
    for (const child of node.children) {
      if (child.type === 'superclass') {
        sup = child;
        break;
      }
    }
  }
  if (!sup) return [];
  const result: string[] = [];
  for (const child of sup.children) {
    if (child.type === 'type_identifier' || child.type === 'generic_type' || child.type === 'scoped_type') {
      result.push(child.text);
    }
  }
  return result;
}

/** 从 class_declaration 提取 implements（super_interfaces.type_list 中的 type_identifier）
 *  tree-sitter-java grammar: field('interfaces', $.super_interfaces) - field name 是 'interfaces'，node type 是 'super_interfaces'
 *  为兼容性，同时尝试 field name 和按类型扫描
 */
export function extractJavaImplements(node: TSNode): string[] {
  // 先尝试 field name 'interfaces'（grammar 中实际定义）
  let sup: TSNode | null = node.childForFieldName('interfaces');
  if (!sup) {
    // 回退：按类型扫描 'super_interfaces'
    for (const child of node.children) {
      if (child.type === 'super_interfaces') {
        sup = child;
        break;
      }
    }
  }
  if (!sup) return [];
  const result: string[] = [];
  for (const child of sup.children) {
    if (child.type === 'type_list') {
      for (const tc of child.children) {
        if (tc.type === 'type_identifier' || tc.type === 'generic_type' || tc.type === 'scoped_type') {
          result.push(tc.text);
        }
      }
    }
  }
  return result;
}

/** 从 import_declaration 提取 source module（scoped_identifier 文本） */
export function extractJavaImportSource(node: TSNode): string | null {
  for (const child of node.children) {
    if (child.type === 'scoped_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return null;
}

/** 从 import 提取 imported names（取 scoped_identifier 末段） */
export function extractJavaImportedNames(node: TSNode): string[] {
  const source = extractJavaImportSource(node);
  if (!source) return [];
  const parts = source.split('.');
  const last = parts[parts.length - 1];
  return last ? [last] : [];
}

/** 从 method_invocation 提取被调用方法名 */
export function extractJavaCallName(node: TSNode): string | null {
  // method_invocation: identifier (argument_list) 或 member_access . identifier
  for (const child of node.children) {
    if (child.type === 'identifier') {
      return child.text;
    }
  }
  return null;
}

/** 从 method_declaration 提取返回类型文本 */
export function extractJavaReturnType(node: TSNode): string | undefined {
  for (const child of node.children) {
    if (
      child.type === 'void_type' ||
      child.type === 'type_identifier' ||
      child.type === 'generic_type' ||
      child.type === 'scoped_type' ||
      child.type === 'integral_type' ||
      child.type === 'decimal_type' ||
      child.type === 'boolean_type'
    ) {
      return child.text;
    }
  }
  return undefined;
}

/** 从 field_declaration 提取字段名（variable_declarator.identifier） */
export function extractJavaFieldName(node: TSNode): string | null {
  for (const child of node.children) {
    if (child.type === 'variable_declarator') {
      const id = child.childForFieldName('name');
      if (id) return id.text;
      // 回退：取 identifier 子节点
      for (const c of child.children) {
        if (c.type === 'identifier') return c.text;
      }
    }
  }
  return null;
}

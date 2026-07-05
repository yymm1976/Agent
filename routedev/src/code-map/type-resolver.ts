// src/code-map/type-resolver.ts
// Phase 72 Task D4：Hybrid 类型解析（聚焦 TS/Python）
//
// 借鉴 codebase-memory-mcp 的 Hybrid LSP 思路（不引入 LSP 二进制）：
// - 用 extractor 已提取的 import 节点信息（sourceModule + importedNames）建立 file → imports 映射
// - 用 exported 节点建立 symbolName → definitions 映射
// - 对未解析的 CALLS 引用，按 caller 文件的 import 信息精确解析到 definition 节点
//
// 只处理 TS/Python 两种语言（任务约束：不追求 158 语言全覆盖）

import path from 'node:path';
import type { CodeMapNode } from './schema.js';
import type { PendingReference } from './extractor.js';

/** 单文件的 import 信息 */
export interface FileImportInfo {
  /** import 来源模块（如 './foo' / 'foo.bar'） */
  sourceModule: string;
  /** import 的符号名列表（具名 import） */
  importedNames: string[];
}

/** filePath → 该文件的 import 列表 */
export type FileImportMap = Map<string, FileImportInfo[]>;

/** symbolName → exported 节点列表（按 name 索引，跨文件） */
export type ExportedSymbolMap = Map<string, CodeMapNode[]>;

/**
 * 构建 file → import 信息映射
 *
 * 从 nodes 表中筛选 kind='import' 的节点，按 filePath 分组
 * 用于后续按 caller 文件查询"它 import 了哪些符号、来自哪个模块"
 */
export function buildFileImportMap(nodes: CodeMapNode[]): FileImportMap {
  const map: FileImportMap = new Map();
  for (const node of nodes) {
    if (node.kind !== 'import' || !node.sourceModule) continue;
    const list = map.get(node.filePath) ?? [];
    list.push({
      sourceModule: node.sourceModule,
      importedNames: node.importedNames ?? [],
    });
    map.set(node.filePath, list);
  }
  return map;
}

/**
 * 构建 symbolName → exported 节点列表映射
 *
 * 仅索引 exported=true 的节点（跨文件可见的 definition）
 * 用于后续按 calleeName 查找候选 definition 节点
 */
export function buildExportedSymbolMap(nodes: CodeMapNode[]): ExportedSymbolMap {
  const map: ExportedSymbolMap = new Map();
  for (const node of nodes) {
    if (!node.exported) continue;
    // 跳过 import 节点（不是 definition）
    if (node.kind === 'import') continue;
    const list = map.get(node.name) ?? [];
    list.push(node);
    map.set(node.name, list);
  }
  return map;
}

/**
 * 把 import 的 sourceModule 解析为实际文件路径
 *
 * 启发式匹配（不依赖 TS path mapping，保持轻量）：
 * - TS relative import: './foo' → 在 allFilePaths 中找 importerDir/foo.{ts,tsx,js,jsx}
 * - TS relative import: './bar/baz' → importerDir/bar/baz.{...}
 * - Python absolute import: 'foo' → foo.py 或 foo/__init__.py
 * - Python relative import: '.foo' / '..foo.bar' → 相对 importer 目录解析
 * - Python dotted import: 'foo.bar' → foo/bar.py 或 foo.py
 *
 * @param sourceModule import 来源模块字符串
 * @param importerFilePath import 语句所在文件的相对路径（如 'src/code-map/extractor.ts'）
 * @param allFilePaths 项目中所有已索引文件的相对路径集合
 * @returns 匹配到的文件路径；未匹配返回 null
 */
export function resolveImportSource(
  sourceModule: string,
  importerFilePath: string,
  allFilePaths: Set<string>,
): string | null {
  if (!sourceModule) return null;

  // 忽略 node_modules / 标准库（不以 . 或 .. 开头且不是项目内路径）
  // TS 相对 import 以 ./ 或 ../ 开头
  // Python 相对 import 以 . 开头
  const isRelative = sourceModule.startsWith('.') || sourceModule.startsWith('./') || sourceModule.startsWith('../');

  // 候选文件路径列表
  const candidates: string[] = [];

  if (isRelative) {
    // 相对路径：基于 importer 文件目录解析
    const importerDir = path.posix.dirname(importerFilePath);
    // 去掉开头的 ./ 或 ../，用 path.posix.join 正确解析
    const resolved = path.posix.normalize(path.posix.join(importerDir, sourceModule));

    if (sourceModule.endsWith('.py') || importerFilePath.endsWith('.py')) {
      // Python 相对 import：.foo → 同目录 foo.py；..foo → 上级目录
      // Python 的 . 表示当前包（目录），foo 表示模块
      const pyBase = sourceModule.replace(/^\.+/, '');
      const pyPath = pyBase.includes('.')
        ? pyBase.replace(/\./g, '/')  // foo.bar → foo/bar
        : pyBase;
      const pyResolved = path.posix.normalize(path.posix.join(importerDir, pyPath));
      candidates.push(
        `${pyResolved}.py`,
        `${pyResolved}/__init__.py`,
        `${pyPath}.py`,
        `${pyPath}/__init__.py`,
      );
    } else {
      // TS/JS 相对 import：尝试常见扩展
      candidates.push(
        `${resolved}.ts`,
        `${resolved}.tsx`,
        `${resolved}.js`,
        `${resolved}.jsx`,
        `${resolved}.mjs`,
        `${resolved}.cjs`,
        `${resolved}/index.ts`,
        `${resolved}/index.tsx`,
        `${resolved}/index.js`,
      );
    }
  } else {
    // 非相对 import（可能是项目内 absolute import 或外部依赖）
    // Python: 'foo.bar' → foo/bar.py 或 foo.py
    if (sourceModule.endsWith('.py') || importerFilePath.endsWith('.py')) {
      const pyPath = sourceModule.replace(/\./g, '/');
      candidates.push(
        `${pyPath}.py`,
        `${pyPath}/__init__.py`,
        `src/${pyPath}.py`,
        `src/${pyPath}/__init__.py`,
      );
    } else {
      // TS/JS：尝试在 src/ 下找（Node 项目常见结构）
      candidates.push(
        `${sourceModule}.ts`,
        `${sourceModule}.tsx`,
        `src/${sourceModule}.ts`,
        `src/${sourceModule}.tsx`,
      );
    }
  }

  // 在 allFilePaths 中找匹配
  for (const candidate of candidates) {
    if (allFilePaths.has(candidate)) return candidate;
  }

  // fallback：尝试用 sourceModule 末尾段做模糊匹配
  // 例：sourceModule = '@scope/pkg/foo'，取 'foo' 在 allFilePaths 中找以 'foo.ts' 结尾的
  const lastSegment = sourceModule.split(/[/.]/).pop() ?? '';
  if (lastSegment) {
    for (const fp of allFilePaths) {
      const basename = path.posix.basename(fp, path.posix.extname(fp));
      if (basename === lastSegment) return fp;
    }
  }

  return null;
}

/**
 * 用 import 信息精确解析跨文件 CALLS 引用
 *
 * 流程（双路径，优先用 ref.importSource 提示，fallback 用全局 importMap）：
 * 1. 若 ref.importSource 存在（extractor 在解析时已从当前文件 import 节点提取）：
 *    - 用 resolveImportSource 解析 importSource 到实际文件路径
 *    - 在该文件中找名为 ref.calleeName 的 exported 节点
 * 2. 否则或上一步未匹配：查 importMap.get(ref.filePath) 的 import 列表，
 *    找 importedNames 包含 ref.calleeName 的条目，同 Step 1 后续逻辑
 *
 * @param ref 未解析的调用引用（可能带 importSource 提示）
 * @param importMap file → imports 映射（全局，用于 fallback）
 * @param exportMap symbolName → exported 节点列表
 * @param allFilePaths 所有已索引文件路径集合
 * @returns 匹配到的 definition 节点；未匹配返回 null
 */
export function resolveRefByImport(
  ref: PendingReference,
  importMap: FileImportMap,
  exportMap: ExportedSymbolMap,
  allFilePaths: Set<string>,
): CodeMapNode | null {
  // 路径 1：优先用 ref.importSource（extractor 已填充的提示，避免重复查 importMap）
  if (ref.importSource) {
    const resolvedFile = resolveImportSource(ref.importSource, ref.filePath, allFilePaths);
    if (resolvedFile) {
      const candidates = exportMap.get(ref.calleeName);
      if (candidates) {
        const match = candidates.find(n => n.filePath === resolvedFile);
        if (match) return match;
      }
    }
  }

  // 路径 2：fallback 用全局 importMap 重新查（覆盖 ref.importSource 缺失或解析失败的场景）
  const imports = importMap.get(ref.filePath);
  if (!imports || imports.length === 0) return null;

  // 找 importedNames 包含 calleeName 的 import 条目
  for (const imp of imports) {
    if (!imp.importedNames.includes(ref.calleeName)) continue;

    // 解析 sourceModule 到实际文件
    const resolvedFile = resolveImportSource(imp.sourceModule, ref.filePath, allFilePaths);
    if (!resolvedFile) continue;

    // 在该文件的 exported 节点中找 calleeName
    const candidates = exportMap.get(ref.calleeName);
    if (!candidates) continue;

    const match = candidates.find(n => n.filePath === resolvedFile);
    if (match) return match;
  }

  return null;
}

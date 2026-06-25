// src/tools/repo-map.ts
// Phase 34 Task 4：Repo Map 代码检索增强
// Phase 39 Task 1：代码地图增强（多语言/非导出/类方法/import/装饰器 + 增量缓存 + 影响分析）
// 轻量版实现（方案 C）：扫描目录树，用正则提取源文件的 export 名称和函数签名
// 零依赖、多语言友好，适合作为 code_search / file_search 的前置地图

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { walkDir, isIgnoredPath } from './builtin/search-utils.js';

/** 文件依赖条目 */
export interface FileDependency {
  /** 依赖目标（原始 import 路径，如 './bar'） */
  target: string;
  /** 引入的符号列表 */
  symbols: string[];
}

/** 单文件 Repo Map 条目 */
export interface RepoMapFileEntry {
  /** 相对路径 */
  path: string;
  /** 导出的符号列表 */
  exports: string[];
  /** 提取的签名片段（函数/类/接口声明） */
  signatures: string[];
  /** 依赖列表（import 语句提取） */
  dependencies?: FileDependency[];
  /** 源码语言（typescript/javascript/python/java/go） */
  language?: string;
}

/** Repo Map 扫描选项 */
export interface RepoMapOptions {
  /** 扫描根目录 */
  root: string;
  /** 文件扩展名白名单（默认 ts/js/tsx/jsx） */
  extensions?: string[];
  /** 最大文件数 */
  maxFiles?: number;
  /** 每个文件最大签名数 */
  maxSignaturesPerFile?: number;
  /** 每个符号最大字符数 */
  maxSymbolLength?: number;
}

/** 默认扫描扩展名 */
const DEFAULT_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs']);

/** 多语言扩展名映射 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
};

/** 多语言支持的扩展名集合 */
const MULTI_LANG_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go',
]);

/** 缓存文件版本标识 */
const CACHE_VERSION = 'phase39-v1';

/** 缓存文件结构 */
interface CacheData {
  version: string;
  entries: RepoMapFileEntry[];
  mtimes: Record<string, number>;
}

/**
 * 根据源码内容探测语言
 * 保守策略：仅使用各语言独有特征匹配，避免 TypeScript 的 class/import 被误判为 Python
 */
function detectLanguage(source: string): string {
  const lines = source.split('\n').slice(0, 50);
  let pyScore = 0;
  let goScore = 0;
  let javaScore = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Python 独有特征：def foo(...):  /  from X import Y  /  class Foo(Base):
    if (/^def\s+\w+\s*\(.*\)\s*:/.test(trimmed)) pyScore++;
    if (/^from\s+\S+\s+import\s+/.test(trimmed)) pyScore++;
    if (/^class\s+\w+\s*(\([^)]*\))?\s*:/.test(trimmed)) pyScore++;
    // Go 独有特征：package X（无分号）/ func X / import "..."
    if (/^package\s+\w+\s*$/.test(trimmed)) goScore++;
    if (/^func\s+(\w+|\(.*\)\s+\w+)/.test(trimmed)) goScore++;
    if (/^import\s+[""]/.test(trimmed)) goScore++;
    // Java 独有特征：package X;（分号）/ public class X / import X.Y.Z;
    if (/^package\s+[\w.]+\s*;/.test(trimmed)) javaScore++;
    if (/^public\s+(class|interface|enum)\s+\w+/.test(trimmed)) javaScore++;
    if (/^import\s+(?:static\s+)?[\w.]+\s*;/.test(trimmed)) javaScore++;
  }
  if (pyScore > 0 && pyScore >= goScore && pyScore >= javaScore) return 'python';
  if (goScore > 0 && goScore >= javaScore) return 'go';
  if (javaScore > 0) return 'java';
  return 'typescript';
}

/**
 * 从源码中提取 export 名称和签名
 * Phase 39 增强：
 *   - 非导出函数（function foo / const foo = () =>）
 *   - 类成员方法（class Foo { bar() {} }）
 *   - import 依赖 → FileDependency
 *   - 装饰器（@Component）
 *   - 多语言（.py / .java / .go）
 *
 * @param source 源码文本
 * @param maxSignatures 最大签名数
 * @param maxSymbolLength 符号最大长度
 * @param language 语言覆盖（可选，自动探测）
 */
export function extractSignatures(
  source: string,
  maxSignatures: number,
  maxSymbolLength: number,
  language?: string,
): {
  exports: string[];
  signatures: string[];
  dependencies: FileDependency[];
  language: string;
} {
  const exports: string[] = [];
  const signatures: string[] = [];
  const dependencies: FileDependency[] = [];
  const detectedLanguage = language ?? detectLanguage(source);

  const addExport = (name: string, signature: string) => {
    const trimmedName = name.slice(0, maxSymbolLength);
    if (!exports.includes(trimmedName)) {
      exports.push(trimmedName);
    }
    if (signatures.length < maxSignatures) {
      signatures.push(signature.slice(0, maxSymbolLength * 2));
    }
  };

  const addSignatureOnly = (signature: string) => {
    if (signatures.length < maxSignatures) {
      signatures.push(signature.slice(0, maxSymbolLength * 2));
    }
  };

  const addDependency = (target: string, symbols: string[]) => {
    if (!target) return;
    const existing = dependencies.find(d => d.target === target);
    if (existing) {
      for (const s of symbols) {
        if (!existing.symbols.includes(s)) existing.symbols.push(s);
      }
    } else {
      dependencies.push({ target, symbols: [...symbols] });
    }
  };

  const lines = source.split('\n');

  if (detectedLanguage === 'python') {
    extractPython(lines, addExport, addSignatureOnly, addDependency, maxSignatures);
  } else if (detectedLanguage === 'java') {
    extractJava(lines, addExport, addSignatureOnly, addDependency, maxSignatures);
  } else if (detectedLanguage === 'go') {
    extractGo(lines, addExport, addSignatureOnly, addDependency, maxSignatures);
  } else {
    extractTypeScript(lines, addExport, addSignatureOnly, addDependency, maxSignatures);
  }

  return { exports, signatures, dependencies, language: detectedLanguage };
}

/** TypeScript/JavaScript 签名提取 */
function extractTypeScript(
  lines: string[],
  addExport: (name: string, sig: string) => void,
  addSignatureOnly: (sig: string) => void,
  addDependency: (target: string, symbols: string[]) => void,
  _maxSignatures: number,
): void {
  let inClass = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // import 依赖：import { foo, bar } from './module'
    const importNamed = trimmed.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (importNamed) {
      const symbols = importNamed[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop() ?? '').filter(Boolean);
      addDependency(importNamed[2], symbols);
      continue;
    }
    // import 依赖：import foo from './module' / import * as foo from './module'
    const importDefault = trimmed.match(/^import\s+(?:\w+|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (importDefault) {
      addDependency(importDefault[1], ['default']);
      continue;
    }
    // import 依赖：import './module'（副作用导入）
    const importSideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    if (importSideEffect) {
      addDependency(importSideEffect[1], []);
      continue;
    }

    // 装饰器：@Component / @Injectable()
    if (/^@\w+/.test(trimmed)) {
      addSignatureOnly(trimmed.slice(0, 200));
      continue;
    }

    // 跟踪 class 上下文（用于识别成员方法）
    const classOpen = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+\w+/);
    if (classOpen) {
      inClass = true;
    }
    if (inClass && trimmed === '}') {
      inClass = false;
    }

    // export function foo(arg: string): void
    const funcMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)\s*\(/);
    if (funcMatch) {
      addExport(funcMatch[1], trimmed.slice(0, 200));
      continue;
    }

    // export class Foo / export interface Foo / export type Foo / export enum Foo
    const declMatch = trimmed.match(/^export\s+(?:abstract\s+)?(?:class|interface|type|enum)\s+(\w+)/);
    if (declMatch) {
      addExport(declMatch[1], trimmed.slice(0, 200));
      continue;
    }

    // export const foo = ... / export let foo = ... / export var foo = ...
    const varMatch = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)\s*[=:]/);
    if (varMatch) {
      addExport(varMatch[1], trimmed.slice(0, 200));
      continue;
    }

    // export { foo, bar } from './module' / export { foo, bar }
    const namedMatch = trimmed.match(/^export\s+\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop() ?? '').filter(Boolean);
      for (const name of names) {
        addExport(name, trimmed.slice(0, 200));
      }
      if (namedMatch[2]) addDependency(namedMatch[2], names);
      continue;
    }

    // export default function foo() / export default class Foo
    const defaultMatch = trimmed.match(/^export\s+default\s+(?:function\s+(\w+)|class\s+(\w+))/);
    if (defaultMatch) {
      const name = defaultMatch[1] ?? defaultMatch[2] ?? 'default';
      addExport(name, trimmed.slice(0, 200));
      continue;
    }

    // 非导出函数：function foo() / async function foo()
    const nonExportFunc = trimmed.match(/^(?:async\s+)?function\s+(\w+)\s*\(/);
    if (nonExportFunc) {
      addSignatureOnly(trimmed.slice(0, 200));
      continue;
    }

    // 非导出 const 箭头函数：const foo = () => / const foo = async () =>
    const arrowFunc = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?[^=]*=>/);
    if (arrowFunc) {
      addSignatureOnly(trimmed.slice(0, 200));
      continue;
    }

    // 类成员方法：bar() {} / async bar() {} / private bar() {}
    if (inClass) {
      const methodMatch = trimmed.match(/^(?:public|private|protected|static|async|readonly|\s)*(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{?/);
      if (methodMatch && methodMatch[1] !== 'if' && methodMatch[1] !== 'for' && methodMatch[1] !== 'while'
          && methodMatch[1] !== 'switch' && methodMatch[1] !== 'catch' && methodMatch[1] !== 'constructor'
          && methodMatch[1] !== 'return' && methodMatch[1] !== 'class' && methodMatch[1] !== 'function') {
        // 确保是方法定义而非控制流
        if (/\)\s*(?::\s*[^=]+)?\s*\{/.test(trimmed) || /\)\s*$/.test(trimmed)) {
          addSignatureOnly(`  ${trimmed.slice(0, 200)}`);
        }
      }
    }
  }
}

/** Python 签名提取 */
function extractPython(
  lines: string[],
  addExport: (name: string, sig: string) => void,
  addSignatureOnly: (sig: string) => void,
  addDependency: (target: string, symbols: string[]) => void,
  _maxSignatures: number,
): void {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // from foo import bar, baz
    const fromImport = trimmed.match(/^from\s+(\S+)\s+import\s+(.+)/);
    if (fromImport) {
      const symbols = fromImport[2].split(',').map(s => s.trim().split(/\s+as\s+/).pop() ?? '').filter(Boolean);
      addDependency(fromImport[1], symbols);
      continue;
    }
    // import foo, bar
    const plainImport = trimmed.match(/^import\s+(.+)/);
    if (plainImport) {
      const modules = plainImport[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const mod of modules) addDependency(mod, []);
      continue;
    }
    // def foo(...):
    const defMatch = trimmed.match(/^def\s+(\w+)\s*\(/);
    if (defMatch) {
      // Python 没有 export 概念，所有 def 都视为签名
      addSignatureOnly(trimmed.slice(0, 200));
      continue;
    }
    // class Foo(...):
    const classMatch = trimmed.match(/^class\s+(\w+)/);
    if (classMatch) {
      addSignatureOnly(trimmed.slice(0, 200));
    }
  }
}

/** Java 签名提取 */
function extractJava(
  lines: string[],
  addExport: (name: string, sig: string) => void,
  addSignatureOnly: (sig: string) => void,
  addDependency: (target: string, symbols: string[]) => void,
  _maxSignatures: number,
): void {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // import com.example.Foo;
    const importMatch = trimmed.match(/^import\s+(?:static\s+)?([\w.]+);/);
    if (importMatch) {
      const parts = importMatch[1].split('.');
      const symbol = parts[parts.length - 1];
      addDependency(importMatch[1], symbol === '*' ? [] : [symbol]);
      continue;
    }
    // public class Foo / class Foo
    const classMatch = trimmed.match(/^(?:public|private|protected|abstract|final|\s)*class\s+(\w+)/);
    if (classMatch) {
      addExport(classMatch[1], trimmed.slice(0, 200));
      continue;
    }
    // interface Foo / enum Foo
    const ifaceMatch = trimmed.match(/^(?:public|private|protected|abstract|final|\s)*(?:interface|enum)\s+(\w+)/);
    if (ifaceMatch) {
      addExport(ifaceMatch[1], trimmed.slice(0, 200));
      continue;
    }
    // 方法：public void foo(...) / private static int foo(...)
    const methodMatch = trimmed.match(/^(?:public|private|protected|static|final|abstract|synchronized|\s)*(\w+(?:<[^>]+>)?)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w.]+)?\s*\{?/);
    if (methodMatch && methodMatch[2] !== 'class' && methodMatch[2] !== 'interface' && methodMatch[2] !== 'enum') {
      addSignatureOnly(trimmed.slice(0, 200));
    }
  }
}

/** Go 签名提取 */
function extractGo(
  lines: string[],
  addExport: (name: string, sig: string) => void,
  addSignatureOnly: (sig: string) => void,
  addDependency: (target: string, symbols: string[]) => void,
  _maxSignatures: number,
): void {
  let inImportBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    // import "fmt" / import "github.com/foo/bar"
    const singleImport = trimmed.match(/^import\s+[""]([^""]+)[""]/);
    if (singleImport) {
      addDependency(singleImport[1], []);
      continue;
    }
    // import ( ... )
    if (trimmed === 'import (') {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (trimmed === ')') {
        inImportBlock = false;
        continue;
      }
      const blockImport = trimmed.match(/^[""]([^""]+)[""]/);
      if (blockImport) {
        addDependency(blockImport[1], []);
      }
      continue;
    }
    // func foo(...) / func (r *Type) foo(...)
    const funcMatch = trimmed.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/);
    if (funcMatch) {
      // Go 中首字母大写 = 导出
      const name = funcMatch[1];
      if (name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) {
        addExport(name, trimmed.slice(0, 200));
      } else {
        addSignatureOnly(trimmed.slice(0, 200));
      }
      continue;
    }
    // type Foo struct / type Foo interface
    const typeMatch = trimmed.match(/^type\s+(\w+)\s+(?:struct|interface)/);
    if (typeMatch) {
      const name = typeMatch[1];
      if (name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) {
        addExport(name, trimmed.slice(0, 200));
      } else {
        addSignatureOnly(trimmed.slice(0, 200));
      }
    }
  }
}

/**
 * 扫描目录生成 Repo Map
 * M2 修复：添加路径边界校验，防止扫描敏感目录
 * @param options 扫描选项，root 必须是绝对路径
 * @param allowedDirs 允许的目录边界（可选，防御性深度防御）
 */
export async function buildRepoMap(
  options: RepoMapOptions,
  allowedDirs?: string[],
): Promise<RepoMapFileEntry[]> {
  const {
    root,
    extensions = Array.from(DEFAULT_EXTENSIONS),
    maxFiles = 200,
    maxSignaturesPerFile = 20,
    maxSymbolLength = 80,
  } = options;

  // M2 修复：路径边界校验（防御性深度防御）
  if (allowedDirs && allowedDirs.length > 0) {
    const isAllowed = allowedDirs.some(dir =>
      root === dir || root.startsWith(dir + path.sep),
    );
    if (!isAllowed) {
      return [];
    }
  }

  const extSet = new Set(extensions);
  const files = await walkDir(root, maxFiles * 2);
  const entries: RepoMapFileEntry[] = [];

  for (const filePath of files) {
    if (entries.length >= maxFiles) break;

    const rawRelativePath = path.relative(root, filePath);
    if (isIgnoredPath(rawRelativePath)) continue;

    // 统一使用正斜杠，保证跨平台输出一致
    const relativePath = rawRelativePath.replace(/\\/g, '/');

    const ext = path.extname(filePath);
    if (!extSet.has(ext)) continue;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const language = EXTENSION_LANGUAGE[ext] ?? 'typescript';
      const { exports, signatures, dependencies } = extractSignatures(
        content, maxSignaturesPerFile, maxSymbolLength, language,
      );
      if (exports.length > 0 || signatures.length > 0 || dependencies.length > 0) {
        entries.push({ path: relativePath, exports, signatures, dependencies, language });
      }
    } catch {
      // 跳过无法读取的文件
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 将 Repo Map 条目渲染为文本
 * 控制总长度，避免撑爆上下文
 */
export function renderRepoMap(entries: RepoMapFileEntry[], maxLines = 500): string {
  const lines: string[] = [];
  lines.push(`代码地图（共 ${entries.length} 个文件）`);
  lines.push('');

  for (const entry of entries) {
    if (lines.length >= maxLines) break;
    lines.push(`${entry.path}`);
    for (const sig of entry.signatures.slice(0, 3)) {
      lines.push(`  ${sig}`);
    }
    if (entry.exports.length > entry.signatures.slice(0, 3).length) {
      lines.push(`  exports: ${entry.exports.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ============================================================
// Phase 39 Task 1：增量缓存
// ============================================================

/**
 * 加载缓存文件
 * @param cachePath 缓存文件绝对路径
 * @returns 缓存的条目数组，缓存不存在或版本不匹配时返回 null
 */
export function loadCache(cachePath: string): RepoMapFileEntry[] | null {
  try {
    if (!fsSync.existsSync(cachePath)) return null;
    const raw = fsSync.readFileSync(cachePath, 'utf-8');
    const data = JSON.parse(raw) as CacheData;
    if (data.version !== CACHE_VERSION) return null;
    if (!Array.isArray(data.entries)) return null;
    return data.entries;
  } catch {
    return null;
  }
}

/**
 * 保存缓存到文件
 * @param cachePath 缓存文件绝对路径
 * @param entries 条目数组
 * @param mtimes 文件 mtime 映射（可选，由 incrementalScan 内部维护）
 */
export function saveCache(
  cachePath: string,
  entries: RepoMapFileEntry[],
  mtimes?: Record<string, number>,
): void {
  try {
    const dir = path.dirname(cachePath);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    const data: CacheData = {
      version: CACHE_VERSION,
      entries,
      mtimes: mtimes ?? {},
    };
    fsSync.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/**
 * 增量扫描：比对 mtime，只重新解析变更文件
 * @param root 扫描根目录
 * @param options 扫描选项（不含 root）
 * @returns 全量条目数组（含未变更的缓存条目 + 重新解析的变更条目）
 */
export async function incrementalScan(
  root: string,
  options: Omit<RepoMapOptions, 'root'> = {},
): Promise<RepoMapFileEntry[]> {
  const {
    extensions = Array.from(MULTI_LANG_EXTENSIONS),
    maxFiles = 200,
    maxSignaturesPerFile = 20,
    maxSymbolLength = 80,
  } = options;

  const cachePath = path.join(root, '.routedev', 'repo-map-cache.json');
  const extSet = new Set(extensions);

  // 加载缓存
  let cachedEntries: RepoMapFileEntry[] = [];
  let cachedMtimes: Record<string, number> = {};
  try {
    if (fsSync.existsSync(cachePath)) {
      const raw = fsSync.readFileSync(cachePath, 'utf-8');
      const data = JSON.parse(raw) as CacheData;
      if (data.version === CACHE_VERSION) {
        cachedEntries = data.entries ?? [];
        cachedMtimes = data.mtimes ?? {};
      }
    }
  } catch {
    // 缓存损坏，全量扫描
  }

  // 构建缓存索引：path → entry
  const cacheMap = new Map<string, RepoMapFileEntry>();
  for (const e of cachedEntries) cacheMap.set(e.path, e);

  const files = await walkDir(root, maxFiles * 2);
  const currentPaths = new Set<string>();
  const newMtimes: Record<string, number> = {};
  const result: RepoMapFileEntry[] = [];

  for (const filePath of files) {
    if (result.length >= maxFiles) break;

    const rawRelativePath = path.relative(root, filePath);
    if (isIgnoredPath(rawRelativePath)) continue;

    const relativePath = rawRelativePath.replace(/\\/g, '/');
    const ext = path.extname(filePath);
    if (!extSet.has(ext)) continue;

    currentPaths.add(relativePath);

    // 获取当前 mtime
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    const mtime = stat.mtimeMs;
    newMtimes[relativePath] = mtime;

    // 比对 mtime：未变更则用缓存
    const cachedMtime = cachedMtimes[relativePath];
    const cachedEntry = cacheMap.get(relativePath);
    if (cachedEntry && cachedMtime === mtime) {
      result.push(cachedEntry);
      continue;
    }

    // 变更或新增：重新解析
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const language = EXTENSION_LANGUAGE[ext] ?? 'typescript';
      const { exports, signatures, dependencies } = extractSignatures(
        content, maxSignaturesPerFile, maxSymbolLength, language,
      );
      if (exports.length > 0 || signatures.length > 0 || dependencies.length > 0) {
        result.push({ path: relativePath, exports, signatures, dependencies, language });
      }
    } catch {
      // 跳过无法读取的文件
    }
  }

  // 保存缓存
  saveCache(cachePath, result, newMtimes);

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

// ============================================================
// Phase 39 Task 1：影响分析（反向 BFS）
// ============================================================

/**
 * 解析 import 目标到实际文件路径（启发式匹配）
 * @param target 原始 import 路径（如 './bar'、'../utils'）
 * @param importerPath 导入文件的相对路径
 * @returns 规范化后的目标路径（无扩展名）
 */
function resolveDependencyTarget(target: string, importerPath: string): string {
  // 相对路径：相对于 importer 所在目录解析
  let resolved: string;
  if (target.startsWith('./') || target.startsWith('../')) {
    const importerDir = path.dirname(importerPath);
    resolved = path.posix.normalize(path.posix.join(importerDir, target));
  } else {
    // 非相对路径（npm 包名等），直接用 target
    resolved = target;
  }
  // 去除扩展名
  resolved = resolved.replace(/\.\w+$/, '');
  return resolved;
}

/**
 * 分析变更影响：从 targetFile 出发，反向 BFS 收集所有间接依赖者
 * @param entries Repo Map 条目数组
 * @param targetFile 目标文件相对路径
 * @param maxDepth 最大搜索深度（默认 3）
 * @returns 受影响文件列表和实际搜索深度
 */
export function analyzeImpact(
  entries: RepoMapFileEntry[],
  targetFile: string,
  maxDepth: number = 3,
): { affectedFiles: string[]; depth: number } {
  // 构建反向依赖图：被依赖文件 → 依赖它的文件列表
  const reverseDeps = new Map<string, Set<string>>();

  // 构建路径索引（无扩展名 → 完整路径）
  const pathIndex = new Map<string, string>();
  for (const entry of entries) {
    const noExt = entry.path.replace(/\.\w+$/, '');
    pathIndex.set(noExt, entry.path);
    pathIndex.set(entry.path, entry.path);
  }

  for (const entry of entries) {
    if (!entry.dependencies) continue;
    for (const dep of entry.dependencies) {
      const resolved = resolveDependencyTarget(dep.target, entry.path);
      // 匹配到实际文件
      const targetPath = pathIndex.get(resolved);
      if (targetPath) {
        if (!reverseDeps.has(targetPath)) {
          reverseDeps.set(targetPath, new Set());
        }
        reverseDeps.get(targetPath)!.add(entry.path);
      }
    }
  }

  // 反向 BFS
  const affected: string[] = [];
  const visited = new Set<string>([targetFile]);
  let currentLevel: string[] = [targetFile];
  let actualDepth = 0;

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      const dependents = reverseDeps.get(file);
      if (!dependents) continue;
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          affected.push(dep);
          nextLevel.push(dep);
        }
      }
    }
    if (nextLevel.length === 0) break;
    currentLevel = nextLevel;
    actualDepth = depth + 1;
  }

  return { affectedFiles: affected.sort(), depth: actualDepth };
}

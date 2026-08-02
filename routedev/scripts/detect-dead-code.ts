// scripts/detect-dead-code.ts
// Phase 71 Task F1：死代码检测脚本（纪律层核心）
//
// 设计目标：
//   1. 扫描 src/ + desktop/ 下所有 .ts/.tsx 文件，提取 export 项（函数/类/常量/接口/类型/枚举）
//   2. 对每个 export，扫描 src/ + desktop/ + tests/ 查找是否有其他文件 import 它
//   3. 入口文件白名单：app-init.ts、index.ts、main.tsx、App.tsx、server.ts 等
//      的 export 不算死代码（可能被外部消费）
//   4. test-only 标记：只在 tests/ 中被 import 的 export 标记为 warning，不计入 dead
//   5. fail-open：扫描失败时输出错误，不阻塞（退出码 0）
//
// 运行方式：node --import tsx/esm scripts/detect-dead-code.ts
// 输出：dead-code-report.json + 控制台摘要
//
// 设计特点：
//   - 范围：扫描 src/ + desktop/（覆盖 Electron 主进程与渲染进程）
//   - 入口白名单：明确跳过入口文件 export
//   - test-only 区分：避免把"仅测试消费"误判为 dead
//   - fail-open：扫描异常不阻塞流程

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 类型定义
// ============================================================

/** export 项的种类 */
export type ExportKind =
  | 'function'
  | 'class'
  | 'const'
  | 'interface'
  | 'type'
  | 'enum'
  | 'default'
  | 'reexport';

/** 单个 export 项（带文件位置与种类） */
export interface ExportItem {
  /** 文件绝对路径 */
  file: string;
  /** 符号名 */
  name: string;
  /** export 种类 */
  kind: ExportKind;
}

/** 死代码报告项 */
export interface DeadExport {
  /** 文件路径（相对项目根，POSIX 风格） */
  file: string;
  /** 符号名 */
  name: string;
  /** export 种类 */
  type: ExportKind;
}

/** 检测报告 */
export interface DeadCodeReport {
  /** 扫描到的 export 总数 */
  totalExports: number;
  /** 死代码 export（src + tests 中均无 import 消费方） */
  deadExports: DeadExport[];
  /** test-only export（仅 tests 中有消费方，warning） */
  testOnlyExports: DeadExport[];
  /** 入口文件白名单（这些文件的 export 不计入 dead） */
  entryFiles: string[];
}

// ============================================================
// 常量
// ============================================================

/** 待扫描的源码目录（相对项目根，含 src 主逻辑与 desktop Electron 进程） */
const SCAN_DIRS = ['src', 'desktop'];

/** 跳过的子目录名 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'release', 'build', '.git', '.routedev', 'out',
]);

/** 入口文件白名单（按 basename 匹配） */
const ENTRY_FILE_BASENAMES = new Set([
  'index.ts',
  'index.tsx',
  'app-init.ts',
  'main.ts',
  'main.tsx',
  'App.tsx',
  'server.ts',
  'args.ts',
]);

// ============================================================
// 核心实现
// ============================================================

/**
 * 递归收集目录下所有 .ts/.tsx 文件（跳过 .d.ts）
 *
 * fail-open：目录不存在或读取失败时返回空数组
 */
export function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.d.ts')) continue;
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * 判断文件是否为入口文件（白名单匹配 basename）
 */
export function isEntryFile(filePath: string): boolean {
  return ENTRY_FILE_BASENAMES.has(path.basename(filePath));
}

/** export 模式定义 */
interface ExportPattern {
  kind: ExportKind;
  regex: RegExp;
}

/** 命名 export 的正则模式集合 */
const EXPORT_PATTERNS: ExportPattern[] = [
  { kind: 'function', regex: /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm },
  { kind: 'const', regex: /^\s*export\s+(?:const|let|var)\s+(\w+)/gm },
  { kind: 'class', regex: /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm },
  { kind: 'interface', regex: /^\s*export\s+interface\s+(\w+)/gm },
  { kind: 'type', regex: /^\s*export\s+type\s+(\w+)/gm },
  { kind: 'enum', regex: /^\s*export\s+(?:const\s+)?enum\s+(\w+)/gm },
  { kind: 'default', regex: /^\s*export\s+default\s+(?:function|class|const)?\s*(\w+)/gm },
];

/** export { foo, bar as baz } 形式 */
const EXPORT_LIST_PATTERN = /^\s*export\s+\{([^}]+)\}\s*(?:from\s+['"][^'"]+['"])?/gm;

/**
 * 从文件内容中提取所有 export 项
 *
 * @param content 文件文本
 * @param filePath 文件绝对路径（用于返回 ExportItem.file）
 */
export function extractExports(content: string, filePath: string): ExportItem[] {
  const items: ExportItem[] = [];
  const seen = new Set<string>();

  // 命名 export
  for (const { kind, regex } of EXPORT_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (!name) continue;
      const key = `${kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ file: filePath, name, kind });
    }
  }

  // export { foo, bar as baz } 形式（无法直接确定种类，标 'reexport'）
  EXPORT_LIST_PATTERN.lastIndex = 0;
  let listMatch: RegExpExecArray | null;
  while ((listMatch = EXPORT_LIST_PATTERN.exec(content)) !== null) {
    const names = listMatch[1]
      .split(',')
      .map(s => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const name of names) {
      // 若已被命名 export 捕获，跳过（保留更精确的 kind）
      const already = items.some(it => it.name === name);
      if (already) continue;
      const key = `reexport:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ file: filePath, name, kind: 'reexport' });
    }
  }

  return items;
}

/** 转义正则特殊字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单遍提取文件中 import 语句引用的符号名（消费索引用）
 *
 * 覆盖与 isSymbolImportedInFiles 等价的三类形式：
 *   - import { foo, bar as baz, type Qux } from '...'（取原名；`default as X` 取别名 X）
 *   - import foo from '...'（默认导入）
 *   - import { default as foo }（默认导入别名）
 * 注意：`import * as ns` 无法静态解析具体符号名，与旧实现一致不索引。
 */
function extractImportedNames(content: string): Set<string> {
  const names = new Set<string>();
  // import { a, b as c, type D, default as E } from '...'
  const named = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(content)) !== null) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const normalized = trimmed.replace(/^type\s+/, '').trim();
      if (!normalized) continue;
      const [orig, alias] = normalized.split(/\s+as\s+/);
      // 原名是消费符号；`default as X` 消费的是别名 X
      names.add((orig.trim() === 'default' && alias) ? alias.trim() : orig.trim());
    }
  }
  // import foo from '...'（默认导入）
  const def = /import\s+([\w$]+)\s+from/g;
  while ((m = def.exec(content)) !== null) names.add(m[1]);
  return names;
}

/**
 * 在文件列表中查找是否有 import 该符号的语句
 *
 * 匹配以下形式：
 *   - import { foo } / import { foo as bar } / import { type foo }
 *   - import foo from '...'（默认 import）
 *   - import { default as foo }
 */
function isSymbolImportedInFiles(symbolName: string, files: string[], definingFile: string): boolean {
  const patterns = [
    // import { foo, ... } / import { type foo, ... } / import type { foo, ... }
    new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${escapeRegex(symbolName)}\\b[^}]*\\}`, 'g'),
    // import foo from '...'（默认 import）
    new RegExp(`import\\s+${escapeRegex(symbolName)}\\s+from`, 'g'),
    // import { default as foo }
    new RegExp(`import\\s+\\{[^}]*\\bdefault\\s+as\\s+${escapeRegex(symbolName)}\\b[^}]*\\}`, 'g'),
  ];

  for (const file of files) {
    if (file === definingFile) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const p of patterns) {
      p.lastIndex = 0;
      if (p.test(content)) return true;
    }
  }
  return false;
}

/**
 * 检测符号的消费位置
 *
 * @returns 'src' = src 中有消费方；'test' = 仅 tests 中有；'none' = 均无
 */
export function findSymbolConsumption(
  symbolName: string,
  srcFiles: string[],
  testFiles: string[],
  definingFile: string,
): 'src' | 'test' | 'none' {
  if (isSymbolImportedInFiles(symbolName, srcFiles, definingFile)) return 'src';
  if (isSymbolImportedInFiles(symbolName, testFiles, definingFile)) return 'test';
  return 'none';
}

/**
 * 死代码检测主入口
 *
 * fail-open：单文件读取异常跳过，不阻塞整体扫描
 *
 * 复杂度：单遍读取每个文件一次，构建 export 与 import 索引，
 * 每个符号的消费判定为 O(1) 索引查询（原实现对每个 export 重扫全部文件）。
 *
 * @param rootPath 项目根路径（默认为脚本所在目录的上一级）
 */
export function detectDeadCode(rootPath: string = projectRoot): DeadCodeReport {
  const testsDir = path.join(rootPath, 'tests');

  // 扫描 src/ + desktop/ 下所有源码文件（既作为 export 来源，也作为 import 消费方）
  const srcFiles = SCAN_DIRS.flatMap(d => collectTsFiles(path.join(rootPath, d)));
  const testFiles = collectTsFiles(testsDir);

  // 单遍索引：exportsByFile 记录各文件导出；importRefs 记录符号 → 消费方文件集合
  const exportsByFile = new Map<string, ExportItem[]>();
  const importRefs = new Map<string, Set<string>>();
  const entryFiles: string[] = [];
  const readContent = (file: string): string | null => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      // fail-open：读取失败跳过
      return null;
    }
  };
  const indexImports = (file: string, content: string): void => {
    for (const name of extractImportedNames(content)) {
      let set = importRefs.get(name);
      if (!set) {
        set = new Set();
        importRefs.set(name, set);
      }
      set.add(file);
    }
  };

  for (const file of srcFiles) {
    if (isEntryFile(file)) {
      entryFiles.push(path.relative(rootPath, file).replace(/\\/g, '/'));
    }
    const content = readContent(file);
    if (content === null) continue;
    exportsByFile.set(file, extractExports(content, file));
    indexImports(file, content);
  }
  for (const file of testFiles) {
    const content = readContent(file);
    if (content !== null) indexImports(file, content);
  }

  // 消费判定：仅查索引（排除定义文件自身；src 优先于 test 三态判定）
  const srcSet = new Set(srcFiles);
  const testSet = new Set(testFiles);
  const deadExports: DeadExport[] = [];
  const testOnlyExports: DeadExport[] = [];
  let totalExports = 0;

  for (const [file, items] of exportsByFile) {
    // 入口文件 export 跳过（可能被外部消费）
    if (isEntryFile(file)) continue;
    for (const item of items) {
      totalExports += 1;
      const consumers = importRefs.get(item.name);
      const consumedInSrc = consumers !== undefined
        && [...consumers].some(f => f !== file && srcSet.has(f));
      if (consumedInSrc) continue;
      const consumedInTest = consumers !== undefined
        && [...consumers].some(f => testSet.has(f));
      const rel = path.relative(rootPath, file).replace(/\\/g, '/');
      if (consumedInTest) {
        testOnlyExports.push({ file: rel, name: item.name, type: item.kind });
      } else {
        deadExports.push({ file: rel, name: item.name, type: item.kind });
      }
    }
  }

  return {
    totalExports,
    deadExports,
    testOnlyExports,
    entryFiles,
  };
}

// ============================================================
// CLI 入口
// ============================================================

/**
 * 输出可读报告到 stdout + 写入 JSON 文件
 */
function writeReport(report: DeadCodeReport, reportPath: string): void {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('=== RouteDev 死代码检测报告（Phase 71 Task F1）===');
  console.log(`总 export 数: ${report.totalExports}`);
  console.log(`入口文件数: ${report.entryFiles.length}`);
  console.log(`死代码 export 数: ${report.deadExports.length}`);
  console.log(`test-only export 数: ${report.testOnlyExports.length}`);

  if (report.entryFiles.length > 0) {
    console.log('\n--- 入口文件白名单 ---');
    report.entryFiles.forEach(f => console.log(`  - ${f}`));
  }

  if (report.deadExports.length > 0) {
    console.log('\n--- 死代码清单（前 20 项）---');
    report.deadExports.slice(0, 20).forEach((d, i) => {
      console.log(`${i + 1}. [${d.type}] ${d.file} :: ${d.name}`);
    });
    if (report.deadExports.length > 20) {
      console.log(`... 其余 ${report.deadExports.length - 20} 项见报告文件`);
    }
  }

  if (report.testOnlyExports.length > 0) {
    console.log('\n--- test-only 警告（前 10 项）---');
    report.testOnlyExports.slice(0, 10).forEach((d, i) => {
      console.log(`${i + 1}. [${d.type}] ${d.file} :: ${d.name}`);
    });
    if (report.testOnlyExports.length > 10) {
      console.log(`... 其余 ${report.testOnlyExports.length - 10} 项见报告文件`);
    }
  }

  console.log(`\n详细报告已写入: ${path.relative(projectRoot, reportPath)}`);
}

/**
 * CLI 主入口（fail-open：异常时输出错误，退出码 0）
 */
function main(): void {
  try {
    const report = detectDeadCode();
    const reportPath = path.join(projectRoot, 'dead-code-report.json');
    writeReport(report, reportPath);
  } catch (err) {
    // fail-open：输出错误，不阻塞
    console.error(`[error] 死代码检测失败: ${(err as Error).message}`);
    process.exit(0);
  }
}

// CLI 触发判定（直接运行本文件时执行 main）
if (
  import.meta.url === `file://${__filename.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('detect-dead-code.ts')
) {
  main();
}

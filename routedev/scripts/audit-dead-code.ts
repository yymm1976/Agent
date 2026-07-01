// scripts/audit-dead-code.ts
// Phase 53 Task 1：死代码审计脚本
//
// 设计目标：
//   1. 扫描 src/ + desktop/ 下所有 .ts/.tsx 文件的 export 声明
//   2. 对每个 export 符号，grep 全项目是否被 import 引用
//   3. 零引用的 export 标记为 dead
//   4. 区分有测试的死代码（keep-tagged）和无测试的死代码（delete/investigate）
//
// 运行方式：pnpm tsx scripts/audit-dead-code.ts
// 输出：dead-code-report.json + 控制台摘要

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 类型定义
// ============================================================

/** 死代码发现项 */
export interface DeadCodeFinding {
  /** 文件路径（相对项目根） */
  file: string;
  /** 零引用的导出符号列表 */
  exports: string[];
  /** 是否有对应测试文件 */
  hasTests: boolean;
  /** 推荐操作：delete=直接删除 / keep-tagged=保留并标记 / investigate=需人工调查 */
  recommendation: 'delete' | 'keep-tagged' | 'investigate';
}

/** 审计报告 */
export interface DeadCodeReport {
  /** 扫描时间戳 */
  timestamp: number;
  /** 扫描的文件总数 */
  totalFilesScanned: number;
  /** 收集到的导出符号总数 */
  totalExports: number;
  /** 死代码发现项 */
  findings: DeadCodeFinding[];
  /** 摘要：按推荐操作分组 */
  summary: {
    delete: number;
    keepTagged: number;
    investigate: number;
  };
}

// ============================================================
// 核心实现
// ============================================================

/** 扫描目录列表 */
const SCAN_DIRS = ['src', 'desktop'];

/** 跳过的目录（不需要扫描的） */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'release', 'build', '.git', '.routedev',
]);

/** 匹配 export 声明的正则
 *  支持以下形式：
 *    export function foo() {}
 *    export const foo = ...
 *    export class Foo {}
 *    export interface Foo {}
 *    export type Foo = ...
 *    export { foo, bar }
 *    export default foo
 */
const EXPORT_PATTERNS: RegExp[] = [
  /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm,
  /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
  /^\s*export\s+class\s+(\w+)/gm,
  /^\s*export\s+interface\s+(\w+)/gm,
  /^\s*export\s+type\s+(\w+)/gm,
  /^\s*export\s+\{([^}]+)\}/gm,
  /^\s*export\s+default\s+(\w+)/gm,
];

/** 测试文件后缀列表（用于判断 hasTests） */
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

/**
 * 递归收集目录下所有 .ts/.tsx 文件
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        // 跳过 .d.ts 类型声明文件
        if (entry.name.endsWith('.d.ts')) continue;
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * 从文件内容中提取所有 export 符号
 */
function extractExports(content: string, filePath: string): string[] {
  const symbols = new Set<string>();

  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) {
        // export { foo, bar } 形式：按逗号分割
        const names = match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        names.forEach(n => symbols.add(n));
      }
    }
  }

  return Array.from(symbols);
}

/**
 * 检查符号是否在项目中被 import 引用（排除定义文件自身）
 *
 * 简化策略：grep 搜索符号名出现在 import 语句中的情况
 */
function isSymbolReferenced(symbolName: string, allFiles: string[], definingFile: string): boolean {
  // 构造 import 模式：import { symbolName } 或 import symbolName
  // 注意：符号名可能作为子串出现，需要边界匹配
  const importPattern = new RegExp(
    `import\\s+(?:\\*\\s+as\\s+\\w+\\s+from|\\{[^}]*\\b${escapeRegex(symbolName)}\\b[^}]*\\}|\\w+\\s+from)`,
    'gm'
  );

  // 再检查裸引用（非 import 上下文，但来自其他文件）
  // 例如：Foo.bar() 中 Foo 来自其他文件的 import
  const usagePattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'g');

  for (const file of allFiles) {
    if (file === definingFile) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      // 优先匹配 import 语句
      if (importPattern.test(content)) return true;
      importPattern.lastIndex = 0;
      // 再匹配普通使用（放宽以减少假阴性）
      if (usagePattern.test(content)) return true;
      usagePattern.lastIndex = 0;
    } catch {
      // 读取失败（二进制文件等），跳过
    }
  }
  return false;
}

/** 转义正则特殊字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 检查文件是否有对应测试
 */
function hasCorrespondingTest(filePath: string): boolean {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  // 测试约定：foo.ts → foo.test.ts / foo.spec.ts（同目录或 tests/ 镜像目录）
  for (const suffix of TEST_SUFFIXES) {
    // 同目录测试
    if (fs.existsSync(base + suffix)) return true;
    // tests/ 镜像目录测试（src/foo.ts → tests/foo.test.ts）
    const testsMirror = base.replace(/^src[\\/]/, 'tests' + path.sep) + suffix;
    if (fs.existsSync(testsMirror)) return true;
  }
  return false;
}

/**
 * 主审计入口
 */
export function auditDeadCode(projectRootPath: string = projectRoot): DeadCodeReport {
  const findings: DeadCodeFinding[] = [];
  const allFiles: string[] = [];

  // 1. 收集所有源文件
  for (const dir of SCAN_DIRS) {
    const fullDir = path.join(projectRootPath, dir);
    allFiles.push(...collectSourceFiles(fullDir));
  }

  // 2. 提取每个文件的 export 符号
  let totalExports = 0;
  const fileExports: Array<{ file: string; exports: string[] }> = [];

  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const exports = extractExports(content, file);
      if (exports.length > 0) {
        fileExports.push({ file, exports });
        totalExports += exports.length;
      }
    } catch {
      // 读取失败，跳过
    }
  }

  // 3. 对每个 export 检查引用
  for (const { file, exports } of fileExports) {
    const deadExports: string[] = [];
    for (const symbol of exports) {
      if (!isSymbolReferenced(symbol, allFiles, file)) {
        deadExports.push(symbol);
      }
    }
    if (deadExports.length === 0) continue;

    const hasTests = hasCorrespondingTest(file);
    let recommendation: DeadCodeFinding['recommendation'];

    if (hasTests) {
      // 有测试 → 保留并标记（不能直接删，会破坏测试）
      recommendation = 'keep-tagged';
    } else {
      // 无测试 → 可直接删除
      recommendation = 'delete';
    }

    findings.push({
      file: path.relative(projectRootPath, file).replace(/\\/g, '/'),
      exports: deadExports,
      hasTests,
      recommendation,
    });
  }

  // 4. 摘要
  const summary = {
    delete: findings.filter(f => f.recommendation === 'delete').length,
    keepTagged: findings.filter(f => f.recommendation === 'keep-tagged').length,
    investigate: findings.filter(f => f.recommendation === 'investigate').length,
  };

  return {
    timestamp: Date.now(),
    totalFilesScanned: allFiles.length,
    totalExports,
    findings,
    summary,
  };
}

// ============================================================
// CLI 入口
// ============================================================

if (import.meta.url === `file://${__filename.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('audit-dead-code.ts')) {
  const report = auditDeadCode();
  const reportPath = path.join(projectRoot, 'dead-code-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('=== RouteDev 死代码审计报告 ===');
  console.log(`扫描文件数: ${report.totalFilesScanned}`);
  console.log(`导出符号总数: ${report.totalExports}`);
  console.log(`死代码文件数: ${report.findings.length}`);
  console.log(`  - 可直接删除: ${report.summary.delete}`);
  console.log(`  - 保留并标记: ${report.summary.keepTagged}`);
  console.log(`  - 需人工调查: ${report.summary.investigate}`);
  console.log(`\n详细报告已写入: ${path.relative(projectRoot, reportPath)}`);

  if (report.findings.length > 0) {
    console.log('\n--- 死代码清单（前 20 项）---');
    report.findings.slice(0, 20).forEach((f, i) => {
      console.log(`${i + 1}. [${f.recommendation}] ${f.file}`);
      console.log(`   导出: ${f.exports.join(', ')}`);
      console.log(`   有测试: ${f.hasTests ? '是' : '否'}`);
    });
  }

  // 退出码：有死代码则返回 1（可用于 CI 卡点）
  process.exit(report.findings.length > 0 ? 1 : 0);
}

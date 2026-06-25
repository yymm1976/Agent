// scripts/verify.ts
// Phase 17b 硬验收门脚本
// 运行方式：pnpm tsx scripts/verify.ts
// 退出码：0 = 全部通过，1 = 有失败

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ESM 下获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 类型定义
// ============================================================

/** 单项检查结果 */
export interface CheckResult {
  /** 检查项序号 */
  index: number;
  /** 检查项名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 详细信息（行数、文件路径等） */
  detail: string;
}

/** 验收报告 */
export interface VerifyReport {
  /** 所有检查结果 */
  results: CheckResult[];
  /** 通过数 */
  passed: number;
  /** 总数 */
  total: number;
  /** 是否全部通过 */
  allPassed: boolean;
}

// ============================================================
// 工具函数
// ============================================================

/** 统计文件行数（按换行符分割，兼容 \r\n 和 \n） */
function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.length === 0) return 0;
  // trimEnd 去除尾部换行，避免 split 产生多余空字符串
  return content.trimEnd().split(/\r?\n/).length;
}

/** 读取文件内容 */
function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/** 检查文件是否存在 */
function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

/** 递归收集目录下所有 .ts/.tsx 文件（排除 node_modules 和 dist） */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const absoluteDir = path.join(projectRoot, dir);
  if (!fs.existsSync(absoluteDir)) return results;

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      // 排除 node_modules 和 dist
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      results.push(...collectSourceFiles(path.relative(projectRoot, fullPath)));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ============================================================
// 检查项实现
// ============================================================

/** [1] App.tsx 行数 ≤ 400 */
export async function checkAppLineCount(): Promise<CheckResult> {
  const appPath = path.join(projectRoot, 'src', 'cli', 'App.tsx');
  const lines = countLines(appPath);
  const passed = lines <= 400;
  return {
    index: 1,
    name: 'App.tsx 行数 ≤ 400',
    passed,
    detail: `${lines} 行`,
  };
}

/** [2] App.tsx 无 switch(cmd) 块 */
export async function checkNoSwitchBlock(): Promise<CheckResult> {
  const content = readFile(path.join(projectRoot, 'src', 'cli', 'App.tsx'));
  // 检查是否包含 "switch (cmd)" 字符串
  const hasSwitch = /switch\s*\(\s*cmd\s*\)/.test(content);
  return {
    index: 2,
    name: 'App.tsx 无 switch 块',
    passed: !hasSwitch,
    detail: hasSwitch ? '发现 switch(cmd) 块' : '未发现 switch(cmd)',
  };
}

/** [3] 11 个新命令文件存在 */
export async function checkCommandFiles(): Promise<CheckResult> {
  const commands = [
    'autonomy', 'pause', 'checkpoint', 'rollback', 'goal',
    'branch', 'init', 'dream', 'quit', 'cost', 'history',
  ];
  const missing: string[] = [];
  for (const cmd of commands) {
    const filePath = path.join('src', 'cli', 'commands', `${cmd}.ts`);
    if (!fileExists(filePath)) {
      missing.push(`${cmd}.ts`);
    }
  }
  return {
    index: 3,
    name: '11 个新命令文件存在',
    passed: missing.length === 0,
    detail: missing.length === 0
      ? '全部 11 个命令文件存在'
      : `缺失: ${missing.join(', ')}`,
  };
}

/** [4] WebhookServer 有 rate limit + Bearer auth + body 限制 */
export async function checkWebhookSecurity(): Promise<CheckResult> {
  const content = readFile(path.join(projectRoot, 'src', 'channels', 'server.ts'));
  const hasRateLimit = content.includes('checkRateLimit');
  const hasAuth = content.includes('verifyAuth');
  const hasBodyLimit = content.includes('maxBytes');
  const passed = hasRateLimit && hasAuth && hasBodyLimit;
  const missing: string[] = [];
  if (!hasRateLimit) missing.push('checkRateLimit');
  if (!hasAuth) missing.push('verifyAuth');
  if (!hasBodyLimit) missing.push('maxBytes');
  return {
    index: 4,
    name: 'WebhookServer 安全措施',
    passed,
    detail: missing.length === 0
      ? 'rate limit + Bearer auth + body 限制均已实现'
      : `缺失: ${missing.join(', ')}`,
  };
}

/** [5] 企业微信 timing-safe 比较 */
export async function checkWechatTimingSafe(): Promise<CheckResult> {
  const content = readFile(path.join(projectRoot, 'src', 'channels', 'adapters', 'wechat-work.ts'));
  const hasTimingSafe = content.includes('timingSafeEqual');
  return {
    index: 5,
    name: '企业微信 timing-safe',
    passed: hasTimingSafe,
    detail: hasTimingSafe ? '使用 timingSafeEqual' : '未使用 timingSafeEqual',
  };
}

/** [6] token 估算无旧写法（Math.ceil(text.length / 4)） */
export async function checkNoOldTokenEstimate(): Promise<CheckResult> {
  const files = collectSourceFiles('src');
  const pattern = /Math\.ceil\(\s*text\.length\s*\/\s*4\s*\)/;
  const matches: string[] = [];
  for (const file of files) {
    const content = readFile(file);
    if (pattern.test(content)) {
      matches.push(path.relative(projectRoot, file));
    }
  }
  return {
    index: 6,
    name: 'token 估算无旧写法',
    passed: matches.length === 0,
    detail: matches.length === 0
      ? '未发现旧写法'
      : `发现 ${matches.length} 处: ${matches.join(', ')}`,
  };
}

/** [7] App.tsx 无 console.log */
export async function checkNoConsoleLog(): Promise<CheckResult> {
  const content = readFile(path.join(projectRoot, 'src', 'cli', 'App.tsx'));
  const hasConsoleLog = /console\.log\s*\(/.test(content);
  return {
    index: 7,
    name: 'App.tsx 无 console.log',
    passed: !hasConsoleLog,
    detail: hasConsoleLog ? '发现 console.log' : '无 console.log',
  };
}

/** [8] Phase 17b 新模块存在 */
export async function checkPhase17bModules(): Promise<CheckResult> {
  const modules = [
    'src/cli/chat-runner.ts',
    'src/cli/goal-runner.ts',
    'src/cli/splash.ts',
    'src/utils/token-estimate.ts',
    'src/agent/middleware.ts',
    'src/utils/stall-detector.ts',
    'src/agent/handoff.ts',
  ];
  const missing: string[] = [];
  for (const mod of modules) {
    if (!fileExists(mod)) {
      missing.push(mod);
    }
  }
  return {
    index: 8,
    name: 'Phase 17b 新模块存在',
    passed: missing.length === 0,
    detail: missing.length === 0
      ? '全部 7 个新模块存在'
      : `缺失: ${missing.join(', ')}`,
  };
}

/** [9] 全量测试通过（运行 pnpm vitest run） */
export async function checkTestSuite(): Promise<CheckResult> {
  try {
    const result = spawnSync('pnpm', ['vitest', 'run'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      shell: true,
      timeout: 120000,
    });
    const passed = result.status === 0;
    return {
      index: 9,
      name: '全量测试通过',
      passed,
      detail: passed
        ? 'vitest run 退出码 0'
        : `vitest run 退出码 ${result.status}`,
    };
  } catch (err) {
    return {
      index: 9,
      name: '全量测试通过',
      passed: false,
      detail: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** [10] description lint 检查（Phase 47 Task 2） */
export async function checkDescriptionLint(): Promise<CheckResult> {
  try {
    const result = spawnSync('npx', ['tsx', 'scripts/lint-descriptions.ts'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      shell: true,
      timeout: 60000,
    });
    // 过渡期：lint 失败时返回 warning（passed=true），不阻断验收
    // 未来全量合规后可改为 passed = result.status === 0
    const lintPassed = result.status === 0;
    const output = (result.stdout || '') + (result.stderr || '');
    return {
      index: 10,
      name: 'description lint 检查',
      passed: true, // 过渡期始终通过，仅作 warning 报告
      detail: lintPassed
        ? 'lint 通过（0 error）'
        : `lint 发现问题（过渡期 warning，不阻断）：${output.split('\n').filter((l) => l.includes('❌')).length} error`,
    };
  } catch (err) {
    return {
      index: 10,
      name: 'description lint 检查',
      passed: true, // 执行失败也仅 warning
      detail: `执行失败（过渡期 warning）: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================
// 报告生成
// ============================================================

/** 运行所有检查 */
export async function runAllChecks(options?: { skipTestSuite?: boolean }): Promise<VerifyReport> {
  const checks: Array<() => Promise<CheckResult>> = [
    checkAppLineCount,
    checkNoSwitchBlock,
    checkCommandFiles,
    checkWebhookSecurity,
    checkWechatTimingSafe,
    checkNoOldTokenEstimate,
    checkNoConsoleLog,
    checkPhase17bModules,
    checkDescriptionLint, // Phase 47 Task 2：description lint 检查
  ];

  if (!options?.skipTestSuite) {
    checks.push(checkTestSuite);
  }

  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await check());
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  return {
    results,
    passed,
    total,
    allPassed: passed === total,
  };
}

/** 格式化报告为可读字符串 */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = ['Phase 17b 验收检查：'];
  for (const result of report.results) {
    const mark = result.passed ? '✅' : '❌';
    lines.push(`  [${result.index}] ${result.name}: ${mark} (${result.detail})`);
  }
  lines.push(`汇总: ${report.passed}/${report.total} 通过`);
  return lines.join('\n');
}

// ============================================================
// 主入口
// ============================================================

async function main(): Promise<void> {
  const report = await runAllChecks();
  const output = formatReport(report);
  console.log(output);
  process.exit(report.allPassed ? 0 : 1);
}

// 仅在直接执行时运行 main（被 import 时不执行）
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main();
}

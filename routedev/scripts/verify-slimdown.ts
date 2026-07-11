// scripts/verify-slimdown.ts
// Phase 85 Task 1：瘦身门禁脚本
// 运行方式：pnpm tsx scripts/verify-slimdown.ts
// 退出码：0 = 全部通过，1 = 有失败
//
// 设计约束：
//   - 不实际运行 tsc/vitest（太慢），改为检查文件存在性和配置值
//   - 每项检查输出 [PASS] 或 [FAIL]
//   - 仅依赖 Node.js 内置模块（fs/path/url）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM 下获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 工具函数
// ============================================================

/** 读取项目内文件内容（相对路径） */
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf-8');
}

/** 检查文件是否存在（相对路径） */
function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

/** 检查目录是否存在（相对路径） */
function dirExists(relativePath: string): boolean {
  const absPath = path.join(projectRoot, relativePath);
  return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
}

/** 递归收集目录下匹配指定模式的文件（排除 node_modules 和 dist） */
function collectFiles(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      results.push(...collectFiles(fullPath, pattern));
    } else if (entry.isFile() && pattern.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/** 单项检查结果 */
interface CheckResult {
  /** 检查项名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 详细信息 */
  detail: string;
}

// ============================================================
// 检查项实现
// ============================================================

/** [1] TypeScript 编译环境（tsconfig.json 存在，作为 tsc --noEmit 的代理检查） */
function checkTsConfig(): CheckResult {
  const exists = fileExists('tsconfig.json');
  return {
    name: 'TypeScript 编译环境',
    passed: exists,
    detail: exists ? 'tsconfig.json 存在' : 'tsconfig.json 缺失',
  };
}

/** [2] 核心测试套件（检查测试文件存在，作为 vitest run 的代理检查） */
function checkTestFiles(): CheckResult {
  const testDirs = ['tests', 'src'];
  let testCount = 0;
  for (const dir of testDirs) {
    const absDir = path.join(projectRoot, dir);
    testCount += collectFiles(absDir, /\.test\.ts$/).length;
  }
  return {
    name: '核心测试套件',
    passed: testCount > 0,
    detail: testCount > 0 ? `发现 ${testCount} 个测试文件` : '未发现测试文件',
  };
}

/** [3] 默认注册工具数 ≤ 10（统计 app-init-tools.ts 中 Core 工具注册数） */
function checkCoreToolCount(): CheckResult {
  const content = readFile('src/runtime/app-init-tools.ts');

  // 找到 Core 工具区域（--- Core 工具 --- 到 if (isFullProfile) 之间）
  const coreStartIdx = content.indexOf('// --- Core 工具');
  const fullProfileIdx = content.indexOf('if (isFullProfile)');
  if (coreStartIdx === -1 || fullProfileIdx === -1 || fullProfileIdx < coreStartIdx) {
    return { name: '默认注册工具数 ≤ 10', passed: false, detail: '未找到 Core 工具区域' };
  }

  const coreSection = content.slice(coreStartIdx, fullProfileIdx);

  let toolCount = 0;

  // 统计 forEach 数组中的工具数（如 [FileReadTool, FileSearchTool, GitOpTool, CodeSearchTool].forEach）
  const forEachMatch = coreSection.match(/\[([^\]]+)\]\s*\.forEach/);
  if (forEachMatch) {
    const tools = forEachMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
    toolCount += tools.length;
  }

  // 统计单独的 registry.register 调用（排除 forEach 行）
  const registerLines = coreSection.split('\n').filter(line =>
    line.includes('registry.register(') && !line.includes('.forEach'),
  );
  toolCount += registerLines.length;

  const passed = toolCount > 0 && toolCount <= 10;
  return {
    name: '默认注册工具数 ≤ 10',
    passed,
    detail: `Core 工具 ${toolCount} 个${passed ? '' : '（超出上限）'}`,
  };
}

/** [4] 默认 packs.* 全 false（验证 defaults.ts 中 packs 区段无 enabled: true） */
function checkPacksAllFalse(): CheckResult {
  const content = readFile('src/config/defaults.ts');

  // 使用括号匹配提取 packs 区段
  const packsStart = content.indexOf('packs: {');
  if (packsStart === -1) {
    return { name: '默认 packs.* 全 false', passed: false, detail: '未找到 packs 配置' };
  }

  let depth = 0;
  let packsEnd = -1;
  for (let i = packsStart + 7; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      if (depth === 0) { packsEnd = i; break; }
      depth--;
    }
  }
  if (packsEnd === -1) {
    return { name: '默认 packs.* 全 false', passed: false, detail: 'packs 区段未闭合' };
  }

  const packsSection = content.slice(packsStart, packsEnd);
  const hasEnabledTrue = /enabled:\s*true/.test(packsSection);

  return {
    name: '默认 packs.* 全 false',
    passed: !hasEnabledTrue,
    detail: hasEnabledTrue ? '发现 enabled: true' : '全部 packs 默认 false',
  };
}

/** [5] Freeze 模块无默认装配（app-init-agent.ts 中 TrustGradient 被 packs.trustGradient.enabled 门控） */
function checkFreezeNoDefaultAssembly(): CheckResult {
  const content = readFile('src/runtime/app-init-agent.ts');

  const hasTrustGradient = content.includes('TrustGradientManager');
  if (!hasTrustGradient) {
    return { name: 'Freeze 模块无默认装配', passed: true, detail: '无 TrustGradient 装配' };
  }

  const hasGating = content.includes('packs?.trustGradient?.enabled') ||
                    content.includes('packs.trustGradient.enabled');
  return {
    name: 'Freeze 模块无默认装配',
    passed: hasGating,
    detail: hasGating
      ? 'TrustGradient 已被 packs.trustGradient.enabled 门控'
      : 'TrustGradient 未被门控（存在默认装配风险）',
  };
}

/** [6] Extended Pack 文件存在（3 个：goal-advanced / multi-agent / adversarial-review） */
function checkExtendedPacks(): CheckResult {
  const packs = [
    'src/plugins/packs/goal-advanced-pack.ts',
    'src/plugins/packs/multi-agent-pack.ts',
    'src/plugins/packs/adversarial-review-pack.ts',
  ];
  const missing = packs.filter(p => !fileExists(p));
  return {
    name: 'Extended Pack 文件存在',
    passed: missing.length === 0,
    detail: missing.length === 0
      ? '全部 3 个 Extended Pack 文件存在'
      : `缺失: ${missing.join(', ')}`,
  };
}

/** [7] Standard Pack 文件存在（3 个：browser-web / code-map / harness） */
function checkStandardPacks(): CheckResult {
  const packs = [
    'src/plugins/packs/browser-web-pack.ts',
    'src/plugins/packs/code-map-pack.ts',
    'src/plugins/packs/harness-pack.ts',
  ];
  const missing = packs.filter(p => !fileExists(p));
  return {
    name: 'Standard Pack 文件存在',
    passed: missing.length === 0,
    detail: missing.length === 0
      ? '全部 3 个 Standard Pack 文件存在'
      : `缺失: ${missing.join(', ')}`,
  };
}

/** [8] TrustGradient 不可达（搜索 src/ 下未门控的 TrustGradientManager 实例化） */
function checkTrustGradientUnreachable(): CheckResult {
  const srcDir = path.join(projectRoot, 'src');
  const files = collectFiles(srcDir, /\.ts$/);

  const unguarded: string[] = [];
  for (const file of files) {
    const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
    // 排除测试文件
    if (relPath.endsWith('.test.ts')) continue;

    const content = fs.readFileSync(file, 'utf-8');
    // 查找 TrustGradientManager 实例化（new ...TrustGradientManager）
    const hasInstantiation = /new\s+\w*\.?TrustGradientManager\s*\(/.test(content);
    if (!hasInstantiation) continue;

    // 检查是否被 packs.trustGradient.enabled 门控
    const hasGating = content.includes('packs?.trustGradient?.enabled') ||
                      content.includes('packs.trustGradient.enabled');
    if (!hasGating) {
      unguarded.push(relPath);
    }
  }

  return {
    name: 'TrustGradient 不可达',
    passed: unguarded.length === 0,
    detail: unguarded.length === 0
      ? '所有 TrustGradientManager 实例化已被门控'
      : `未门控的文件: ${unguarded.join(', ')}`,
  };
}

/** [9] 会话分支命令存在（session-commands.ts） */
function checkSessionCommands(): CheckResult {
  const exists = fileExists('src/session/session-commands.ts');
  return {
    name: '会话分支命令存在',
    passed: exists,
    detail: exists ? 'session-commands.ts 存在' : 'session-commands.ts 缺失',
  };
}

/** [10] 用户自建 Pack 示例存在（docs/packs/example-pack/ 目录） */
function checkExamplePack(): CheckResult {
  const exists = dirExists('docs/packs/example-pack');
  return {
    name: '用户自建 Pack 示例存在',
    passed: exists,
    detail: exists ? 'example-pack 目录存在' : 'example-pack 目录缺失',
  };
}

/** [11] AGENTS.md 存在 */
function checkAgentsMd(): CheckResult {
  const exists = fileExists('AGENTS.md');
  return {
    name: 'AGENTS.md 存在',
    passed: exists,
    detail: exists ? 'AGENTS.md 存在' : 'AGENTS.md 缺失',
  };
}

// ============================================================
// 主入口
// ============================================================

function main(): void {
  const checks: Array<() => CheckResult> = [
    checkTsConfig,
    checkTestFiles,
    checkCoreToolCount,
    checkPacksAllFalse,
    checkFreezeNoDefaultAssembly,
    checkExtendedPacks,
    checkStandardPacks,
    checkTrustGradientUnreachable,
    checkSessionCommands,
    checkExamplePack,
    checkAgentsMd,
  ];

  const results: CheckResult[] = checks.map(check => check());
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;

  console.log('Phase 85 瘦身门禁检查：');
  results.forEach((r, i) => {
    const mark = r.passed ? '[PASS]' : '[FAIL]';
    console.log(`  [${i + 1}] ${r.name}: ${mark} ${r.detail}`);
  });
  console.log(`汇总: ${passed}/${total} 通过`);

  process.exit(allPassed ? 0 : 1);
}

// 仅在直接执行时运行 main（被 import 时不执行）
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main();
}

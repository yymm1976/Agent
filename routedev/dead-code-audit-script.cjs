// dead-code-audit-script.js
// 自动化死代码审查脚本

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const SRC_DIR = path.join(ROOT, 'src');
const DESKTOP_DIR = path.join(ROOT, 'desktop');
const TESTS_DIR = path.join(ROOT, 'tests');

// 目标目录（排除 src/agent/）
const TARGET_DIRS = [
  'src/agents',
  'src/cite',
  'src/code-map',
  'src/config',
  'src/evaluation',
  'src/harness',
  'src/hooks',
  'src/import',
  'src/macros',
  'src/mcp',
  'src/memory',
  'src/observability',
  'src/plugins',
  'src/policies',
  'src/prompts',
  'src/router',
  'src/runtime',
  'src/security',
  'src/skills',
  'src/tools',
];

// 已知活代码保护清单：文件路径 -> 原因
const KNOWN_LIVE_FILES = {
  'src/policies/intent-guard.ts': '被 app-init.ts 静态 import（createBuiltinIntentGuardPolicies）',
  'src/policies/playbook.ts': '被 app-init.ts 静态 import（createBuiltinPlaybookPolicies）',
  'src/policies/policy-engine.ts': '被 app-init.ts 静态 import（PolicyEngine）',
  'src/policies/tool-approval.ts': '被 app-init.ts 静态 import（createBuiltinToolApprovalPolicies）',
  'src/policies/tool-guide.ts': '被 app-init.ts 静态 import（createBuiltinToolGuidePolicies）',
  'src/import/anthropic-skills-loader.ts': '被 app-init.ts 动态 import',
  'src/import/claude-plugin-importer.ts': '被 app-init.ts 动态 import',
  'src/import/codex-importer.ts': '被 app-init.ts 动态 import',
  'src/import/tool-name-mapper.ts': '被 import 模块内部使用（间接动态加载）',
  'src/mcp/claude-bridge.ts': '被 app-init.ts 动态 import（ClaudeMCPBridge）',
  'src/code-map/fallback.ts': '被 app-init.ts 动态 import（CodeMapFallback）',
  'src/skills/bundled-skill-extractor.ts': '被 src/skills/market-manager.ts 动态 import（extractBundledSkill）',
  'src/skills/security-gate.ts': '被 engine-bridge.ts / app-init.ts 动态 import（SkillSecurityGate）',
  'src/security/integrity-manifest.ts': '被 engine-bridge.ts / app-init.ts 动态 import（IntegrityManifest）',
};

// 由 app-init.ts 静态 import 注册的内置工具（默认活代码）
const APP_INIT_STATIC_TOOLS = [
  'src/tools/builtin/ask-user.ts',
  'src/tools/builtin/browser.ts',
  'src/tools/builtin/ccr-retrieve.ts',
  'src/tools/builtin/code-graph-query.ts',
  'src/tools/builtin/code-search.ts',
  'src/tools/builtin/config-guard.ts',
  'src/tools/builtin/edit-history.ts',
  'src/tools/builtin/file-edit.ts',
  'src/tools/builtin/file-read.ts',
  'src/tools/builtin/file-search.ts',
  'src/tools/builtin/file-write.ts',
  'src/tools/builtin/git-op.ts',
  'src/tools/builtin/list-directory.ts',
  'src/tools/builtin/notes-tool.ts',
  'src/tools/builtin/repo-map.ts',
  'src/tools/builtin/search-utils.ts',
  'src/tools/builtin/shell-exec.ts',
  'src/tools/builtin/spawn-agent.ts',
  'src/tools/builtin/todo-store.ts',
  'src/tools/builtin/todo-write.ts',
  'src/tools/builtin/web-fetch.ts',
  'src/tools/builtin/web-search.ts',
];

for (const f of APP_INIT_STATIC_TOOLS) {
  KNOWN_LIVE_FILES[f] = '被 app-init.ts 静态 import 并注册到 ToolRegistry';
}

// 已知核心记忆模块（活代码）
const MEMORY_CORE = [
  'src/memory/memory-store.ts',
  'src/memory/hybrid-retriever.ts',
  'src/memory/local-maintenance.ts',
  'src/memory/project-memory.ts',
  'src/memory/unified-memory.ts',
  'src/memory/provenance-graph.ts',
  'src/memory/codebase-memory.ts',
  'src/memory/eval-metrics.ts',
  'src/memory/bm25-index.ts',
];
for (const f of MEMORY_CORE) {
  KNOWN_LIVE_FILES[f] = 'src/memory/* 核心记忆模块（被 app-init.ts 或相关模块引用）';
}

// 已知核心路由模块（活代码）
const ROUTER_CORE = [
  'src/router/router.ts',
  'src/router/classifier.ts',
  'src/router/config.ts',
  'src/router/tracker.ts',
  'src/router/types.ts',
  'src/router/llm/index.ts',
  'src/router/llm/base.ts',
  'src/router/orchestrator.ts',
  'src/router/routing-history.ts',
  'src/router/routing-memory.ts',
  'src/router/embedder.ts',
  'src/router/execution-verifier.ts',
  'src/router/regret-tracker.ts',
];
for (const f of ROUTER_CORE) {
  KNOWN_LIVE_FILES[f] = 'src/router/* 核心路由模块（被 engine-bridge.ts / app-init.ts 静态引用）';
}

function normalize(p) {
  return p.replace(/\\/g, '/');
}

function relativeToRoot(p) {
  return normalize(path.relative(ROOT, p));
}

function isTestFile(p) {
  return p.endsWith('.test.ts') || p.includes('/tests/');
}

function collectFiles(dir, includeTests = false) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, includeTests));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      if (includeTests || !entry.name.endsWith('.test.ts')) {
        results.push(full);
      }
    }
  }
  return results;
}

function parseRuntimeExports(filePath, content) {
  const exports = [];
  const lines = content.split('\n');

  // 匹配 export class Name
  // export function Name
  // export const Name
  // export let Name
  // export var Name
  // export { Name1, Name2 }
  // export default class Name / function Name
  // export abstract class Name
  // export class Name<T>
  // export async function Name

  const patterns = [
    { type: 'class', regex: /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { type: 'function', regex: /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { type: 'const', regex: /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g },
  ];

  for (const { type, regex } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      const lineIdx = content.substring(0, match.index).split('\n').length;
      exports.push({ name, type, line: lineIdx });
    }
  }

  // export { a, b as c }
  const exportBlockRegex = /export\s*\{([^}]+)\}/g;
  let blockMatch;
  while ((blockMatch = exportBlockRegex.exec(content)) !== null) {
    const items = blockMatch[1].split(',');
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // a as b -> export name is b
      const parts = trimmed.split(/\s+as\s+/);
      const name = parts[parts.length - 1].trim();
      const lineIdx = content.substring(0, blockMatch.index).split('\n').length;
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
        exports.push({ name, type: 'named-export', line: lineIdx });
      }
    }
  }

  // export default class Name / function Name
  const defaultRegex = /export\s+default\s+(?:class|function)\s+([A-Za-z_$][\w$]*)/g;
  let dm;
  while ((dm = defaultRegex.exec(content)) !== null) {
    const name = dm[1];
    const lineIdx = content.substring(0, dm.index).split('\n').length;
    exports.push({ name, type: 'default', line: lineIdx });
  }

  return exports;
}

function getFileContent(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function grepInDir(dir, pattern) {
  // 使用 PowerShell 或 Node 实现递归搜索
  let count = 0;
  const files = collectFiles(dir);
  for (const file of files) {
    if (isTestFile(file)) continue;
    const content = getFileContent(file);
    const re = new RegExp(pattern, 'g');
    const matches = content.match(re);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

function grepStaticImport(fileBaseName, dir) {
  // 搜索 from '.../filename' 或 from ".../filename"
  const pattern = `from\s*['\"][^'\"]*${fileBaseName}['\"]`;
  return grepInDir(dir, pattern);
}

function grepSymbol(symbol, dir, excludeFile) {
  // 搜索符号名，但排除 import/export 语句本身？
  // 任务要求：在 src/ + desktop/ 中搜索类名/函数名
  // 这里简单搜索符号名作为独立标识符出现
  const files = collectFiles(dir);
  let count = 0;
  for (const file of files) {
    if (isTestFile(file)) continue;
    if (normalize(file) === normalize(excludeFile)) continue;
    const content = getFileContent(file);
    const re = new RegExp(`\\b${symbol}\\b`, 'g');
    const matches = content.match(re);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

function grepInAppInit(fileBaseName) {
  const appInitPath = path.join(SRC_DIR, 'runtime', 'app-init.ts');
  const content = getFileContent(appInitPath);
  const re = new RegExp(fileBaseName, 'g');
  return (content.match(re) || []).length;
}

function grepTests(symbol) {
  if (!fs.existsSync(TESTS_DIR)) return 0;
  const files = collectFiles(TESTS_DIR, true);
  let count = 0;
  for (const file of files) {
    const content = getFileContent(file);
    const re = new RegExp(`\\b${symbol}\\b`, 'g');
    const matches = content.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

// 收集所有目标文件
const targetFiles = [];
for (const dir of TARGET_DIRS) {
  const fullDir = path.join(ROOT, dir);
  if (fs.existsSync(fullDir)) {
    targetFiles.push(...collectFiles(fullDir));
  }
}

const trueDead = [];
const testOnly = [];
const exclusions = [];

for (const file of targetFiles) {
  const relFile = relativeToRoot(file);
  const content = getFileContent(file);
  const exports = parseRuntimeExports(file, content);

  if (exports.length === 0) continue;

  // 如果整个文件是已知活代码，记录排除说明并跳过
  if (KNOWN_LIVE_FILES[relFile]) {
    exclusions.push({
      file: relFile,
      reason: KNOWN_LIVE_FILES[relFile],
      refs: '见 app-init.ts / engine-bridge.ts',
    });
    continue;
  }

  const fileBaseName = path.basename(file, '.ts');
  const staticImportSrc = grepStaticImport(fileBaseName, SRC_DIR);
  const staticImportDesktop = grepStaticImport(fileBaseName, DESKTOP_DIR);
  const appInitHits = grepInAppInit(fileBaseName);

  for (const exp of exports) {
    const symbolSrc = grepSymbol(exp.name, SRC_DIR, file);
    const symbolDesktop = grepSymbol(exp.name, DESKTOP_DIR, file);
    const testHits = grepTests(exp.name);

    const staticImportHits = staticImportSrc + staticImportDesktop;
    const symbolHits = symbolSrc + symbolDesktop;

    // 判定逻辑
    const totalHits = staticImportHits + appInitHits + symbolHits;

    if (totalHits === 0) {
      if (testHits > 0) {
        testOnly.push({ file: relFile, name: exp.name, type: exp.type, testHits });
      } else {
        trueDead.push({
          file: relFile,
          name: exp.name,
          type: exp.type,
          cause: '静态 import / app-init 动态 import / 符号引用 均为 0 命中',
          staticImportHits,
          appInitHits,
          symbolHits,
          testHits,
        });
      }
    }
  }
}

// 输出结果
console.log('## True-Dead（纯死文件/导出）');
console.log('| 文件 | 导出名 | 死因 | 验证命令 | 命中数 |');
console.log('|------|--------|------|----------|--------|');
for (const item of trueDead) {
  const cmd = `rg -n "\\b${item.name}\\b" src/ desktop/ --type ts -g '!tests/' -g '!*.test.ts' -c`;
  console.log(`| ${item.file} | ${item.name} | ${item.cause} | \`${cmd}\` | static=${item.staticImportHits}, appInit=${item.appInitHits}, symbol=${item.symbolHits}, tests=${item.testHits} |`);
}

console.log('\n## Test-Only（仅测试引用）');
console.log('| 文件 | 导出名 | 说明 |');
console.log('|------|--------|------|');
for (const item of testOnly) {
  console.log(`| ${item.file} | ${item.name} | ${item.type}，仅 tests/ 命中 ${item.testHits} 次 |`);
}

console.log('\n## 排除说明（易误判的活代码）');
console.log('| 文件 | 误判原因 | 实际引用位置 |');
console.log('|------|----------|--------------|');
for (const item of exclusions) {
  console.log(`| ${item.file} | ${item.reason} | ${item.refs} |`);
}

console.log(`\n统计：True-Dead ${trueDead.length} 项，Test-Only ${testOnly.length} 项，排除 ${exclusions.length} 项。`);

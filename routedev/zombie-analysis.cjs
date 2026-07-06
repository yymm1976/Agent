const fs = require('fs');
const path = require('path');

const root = __dirname;
const appInitPath = path.join(root, 'src', 'runtime', 'app-init.ts');
const engineBridgePath = path.join(root, 'desktop', 'main', 'engine-bridge.ts');
const goalRunnerPath = path.join(root, 'src', 'runtime', 'goal-runner.ts');
const srcDir = path.join(root, 'src');
const desktopDir = path.join(root, 'desktop');

// 字段名与在 app-init.ts return 对象中的起始行号
const fields = [
  { name: 'registry', line: 2253 },
  { name: 'mcpManager', line: 2254 },
  { name: 'securityChecker', line: 2255 },
  { name: 'toolExecutor', line: 2256 },
  { name: 'adapter', line: 2257 },
  { name: 'workModeController', line: 2258 },
  { name: 'guardedAdapter', line: 2259 },
  { name: 'agentLoop', line: 2260 },
  { name: 'middlewarePipeline', line: 2261 },
  { name: 'pluginRegistry', line: 2262 },
  { name: 'skillsRouter', line: 2263 },
  { name: 'filesystemDiscovery', line: 2264 },
  { name: 'permissionEngine', line: 2265 },
  { name: 'orchestrator', line: 2266 },
  { name: 'workerExecutor', line: 2267 },
  { name: 'checkpointManager', line: 2268 },
  { name: 'checkpointWriter', line: 2269 },
  { name: 'contextManager', line: 2270 },
  { name: 'visionAssistant', line: 2271 },
  { name: 'branchManager', line: 2272 },
  { name: 'prompts', line: 2273 },
  { name: 'blackboard', line: 2274 },
  { name: 'trace', line: 2275 },
  { name: 'audit', line: 2276 },
  { name: 'projectMemory', line: 2277 },
  { name: 'goalParser', line: 2278 },
  { name: 'goalVerifier', line: 2279 },
  { name: 'hookRunner', line: 2280 },
  { name: 'primaryClient', line: 2281 },
  { name: 'checkpointClient', line: 2282 },
  { name: 'profiler', line: 2283 },
  { name: 'taskOrchestrator', line: 2285 },
  { name: 'requirementsGatherer', line: 2286 },
  { name: 'complexityAnalyzer', line: 2287 },
  { name: 'unifiedReviewer', line: 2288 },
  { name: 'completionGate', line: 2289 },
  { name: 'readTracker', line: 2290 },
  { name: 'resultSanitizer', line: 2291 },
  { name: 'sharedSystemPromptRef', line: 2293 },
  { name: 'goalAuditor', line: 2295 },
  { name: 'goalPersistence', line: 2296 },
  { name: 'subAgentLifecycle', line: 2299 },
  { name: 'subAgentScoreCardCollector', line: 2300 },
  { name: 'skillLifecycleManager', line: 2302 },
  { name: 'activityStore', line: 2304 },
  { name: 'compositionalRouter', line: 2305 },
  { name: 'pathRouter', line: 2307 },
  { name: 'dualLoopOrchestratorRef', line: 2309 },
  { name: 'dagEngineRef', line: 2311 },
  { name: 'experimentManager', line: 2313 },
  { name: 'routingHistory', line: 2353 },
  { name: 'routingMemory', line: 2353 },
  { name: 'routingOrchestrator', line: 2353 },
  { name: 'executionVerifier', line: 2353 },
  { name: 'routingRegretTracker', line: 2353 },
  { name: 'memoryStore', line: 2398 },
  { name: 'hybridRetriever', line: 2398 },
  { name: 'localMaintenance', line: 2398 },
  { name: 'provenanceGraph', line: 2414 },
  { name: 'kanObstacleChecker', line: 2425 },
  { name: 'quantitativeGate', line: 2437 },
  { name: 'classifyOperation', line: 2441 },
  { name: 'buildRegimeTransition', line: 2442 },
  { name: 'toolOutputBudgetManager', line: 2466 },
  { name: 'messageGrouper', line: 2470 },
  { name: 'actionChainDetector', line: 2474 },
  { name: 'autoCompactGuardian', line: 2478 },
  { name: 'compactPromptEngine', line: 2482 },
  { name: 'sessionMemoryStore', line: 2486 },
];

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function stripComments(text) {
  // 移除单行注释 // 与多行注释 /* ... */（简单处理，足够排除注释中的伪命中）
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function countMatches(text, regex, excludeComments = false) {
  const source = excludeComments ? stripComments(text) : text;
  const re = new RegExp(regex, 'g');
  return (source.match(re) || []).length;
}

function escape(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const engineBridgeText = readText(engineBridgePath);
const goalRunnerText = readText(goalRunnerPath);

// 递归收集 src / desktop 下的 .ts 文件，排除 tests/、*.test.ts、app-init.ts、goal-runner.ts、engine-bridge.ts
function collectTsFiles(dir, list = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'node_modules' || entry.name === '.git') continue;
      collectTsFiles(full, list);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      if (full === appInitPath || full === goalRunnerPath || full === engineBridgePath) continue;
      list.push(full);
    }
  }
  return list;
}

const otherFiles = [...collectTsFiles(srcDir), ...collectTsFiles(desktopDir)];

const results = fields.map((f) => {
  const e = escape(f.name);

  // engine-bridge.ts：this.deps.<field> / this.deps?.<field>
  const engineCount = countMatches(engineBridgeText, `this\\.deps\\??\\.${e}\\b`);

  // goal-runner.ts：deps.<field> / deps?.<field> | field(?:?|!)?.method( | field(
  const goalDeps = countMatches(goalRunnerText, `\\bdeps\\??\\.${e}\\b`);
  const goalMethod = countMatches(goalRunnerText, `\\b${e}(?:\\?|!)?\\.[\\w]+\\(`, true);
  const goalCall = countMatches(goalRunnerText, `\\b${e}\\s*\\(`, true);
  // pathRouter / dualLoopOrchestratorRef 在 goal-runner 中有直接读取（非方法调用）
  let goalDirectRead = 0;
  if (f.name === 'pathRouter') {
    goalDirectRead = countMatches(goalRunnerText, `\\bpathRouter\\b`, true);
  } else if (f.name === 'dualLoopOrchestratorRef') {
    goalDirectRead = countMatches(goalRunnerText, `\\bdualLoopOrchestratorRef\\b`, true);
  }
  let goalCount = goalDeps + goalMethod + goalCall + goalDirectRead;
  // audit 字段在 goal-runner 中会被 `goalAuditor.audit()` 的方法名误命中，需剔除
  if (f.name === 'audit') {
    goalCount -= countMatches(goalRunnerText, 'goalAuditor\\.audit\\s*\\(', true);
  }

  // 其它文件：deps.<field> / deps?.<field> / this.deps.<field> / this.deps?.<field> | field(?:?|!)?.method( | field(
  let otherCount = 0;
  const declRe = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${e}\\s*\\(`, 'm');
  for (const file of otherFiles) {
    const t = readText(file);
    otherCount += countMatches(t, `\\bdeps\\??\\.${e}\\b`);
    otherCount += countMatches(t, `this\\.deps\\??\\.${e}\\b`);
    otherCount += countMatches(t, `\\b${e}(?:\\?|!)?\\.[\\w]+\\(`, true);
    otherCount += countMatches(t, `\\b${e}\\s*\\(`, true);
    // 函数字段自身的 export function 定义不算消费
    otherCount -= (t.match(declRe) || []).length;
  }

  const total = engineCount + goalCount + otherCount;
  const verdict = total === 0 ? 'Zombie-Field' : 'Live';

  const cmd = `rg -n "(this\\.deps|deps)\\??\\.${e}\\b|\\b${e}(?:\\?|!)?\\.[\\w]+\\(|\\b${e}\\s*\\(" src desktop --type ts -g '!tests/' -g '!*.test.ts'`;

  return {
    ...f,
    engineCount,
    goalCount,
    otherCount,
    total,
    verdict,
    cmd,
  };
});

console.log('| 字段名 | app-init.ts 返回行号 | engine-bridge.ts | goal-runner.ts | 其它 src/desktop | 判定结果 | 关键验证命令 / 命中数 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  console.log(`| ${r.name} | ${r.line} | ${r.engineCount} | ${r.goalCount} | ${r.otherCount} | ${r.verdict} | \`${r.cmd}\`（命中 ${r.total} 处） |`);
}

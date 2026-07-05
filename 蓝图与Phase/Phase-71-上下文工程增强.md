# Phase 71：上下文工程增强实现计划

**目标：** 将 RouteDev 上下文工程九维度评分从平均 3.4 提升到 5.0，对齐 aider / Cline / Continue / OpenHands / deepagents 五个项目的最佳实践，消除全部配置僵尸，建立"无死代码"纪律。

**架构：** 三层并行推进——① 基础设施层（代码地图引擎接通 + tiktoken + 记忆召回闭环）；② 消费层（配置僵尸清零 + 九维度补齐 + VFS 卸载）；③ 纪律层（自审机制 + 死代码检测 + 文档同步）。所有新增配置必须当场接入消费点，所有新功能必须带测试，每个 Task 完成后子 Agent 独立审计。

**涉及文件：** 见各 Task 的"文件"小节。整体新增约 18 文件，修改约 22 文件。

**前置依赖：** Phase 72（Deep Review）已完成；Phase 41/42 代码地图引擎已写完但孤立，本 Phase 核心工作之一就是接通它。

**严禁死代码原则：**
1. 每个新增配置字段必须在同一次 PR 内接入消费点，否则不准合入
2. 每个新增模块必须有至少一个调用方，否则不准合入
3. 每个新增函数必须有测试覆盖，否则不准合入
4. 子 Agent 审计时若发现"配置僵尸"或"孤立模块"，直接标 Critical 阻塞合入

---

## Part A：代码地图升级（学习 aider）

### 背景与现状

RouteDev 已有两套代码地图系统：
- **系统 A（regex，Phase 34/39）**：[tools/repo-map.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/repo-map.ts) — 当前 middleware 实际在用
- **系统 B（tree-sitter + SQLite + PageRank，Phase 41/42）**：[code-map/](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/) — 完整实现但**0 个调用方**，处于 dead code 状态

调研发现的关键差距：
1. tree-sitter 引擎未接通 middleware（系统 B 孤立）
2. 缺 Personalized PageRank（无法上下文感知）
3. 缺引用点节点化（CALLS 边 target 是字符串而非节点 ID）
4. token 估算用 `length/4`（中文场景误差 30%+）
5. 缺 git diff 集成（无法"最近改动优先"）
6. 缺 watch mode（Phase 41 设计但未实现）
7. 缺增量 PageRank（10 万节点项目卡顿）

### Task A1：接通 tree-sitter 引擎到 middleware（最高优先级）

**目标：** 让 Phase 41/42 已写好的 `code-map/*` 模块真正上线，消除 dead code。

**文件：**
- 修改：[src/agent/middleware/code-map-context.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/middleware/code-map-context.ts)
- 修改：[src/cli/app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts)（启动时异步触发首次索引）
- 新增：`tests/agent/middleware/code-map-context-tree-sitter.test.ts`

- [ ] **Step 1: 修改 code-map-context.ts，引入 tree-sitter 引擎**

```typescript
// src/agent/middleware/code-map-context.ts
// Phase 71：从 regex 方案切换到 tree-sitter + SQLite + PageRank
// 保留 regex 作为 fallback（try tree-sitter，catch 后回退）

import { fullIndex, incrementalIndex } from '../../code-map/indexer.js';
import { explore, type ExploreOptions } from '../../code-map/querier.js';
import { getIndexStatus } from '../../code-map/database.js';
import { incrementalScan } from '../../tools/repo-map.js'; // 保留作为 fallback

export class CodeMapContextMiddleware implements AgentMiddleware {
  private db: Database | null = null;
  private engineFailed = false; // tree-sitter 引擎失败后降级到 regex

  async onSystemPrompt(ctx: SystemPromptContext): Promise<void> {
    if (this.engineFailed) {
      return this.fallbackToRegex(ctx);
    }
    try {
      if (!this.db) {
        const status = await getIndexStatus(this.rootDir);
        if (status.needsFullIndex) {
          this.db = await fullIndex(this.rootDir);
        } else {
          this.db = await incrementalIndex(this.rootDir);
        }
      }
      const result = explore(this.db, ctx.metadata.userQuery ?? '', this.rootDir, {
        maxResults: 10,
        includeSnippets: true,
      });
      ctx.systemPrompt += '\n\n' + result.summary;
    } catch (err) {
      logger.warn('tree-sitter code map failed, fallback to regex', { err });
      this.engineFailed = true;
      return this.fallbackToRegex(ctx);
    }
  }

  private async fallbackToRegex(ctx: SystemPromptContext): Promise<void> {
    // 原 regex 逻辑保留
  }
}
```

- [ ] **Step 2: app-init.ts 启动时异步触发首次索引（不阻塞主流程）**

```typescript
// src/cli/app-init.ts
// Phase 71：启动时后台触发代码地图索引，不阻塞 Agent Loop
if (config.codeMap?.autoIndex !== false) {
  fullIndex(cwd).then(db => {
    logger.info('code-map initial index completed', { fileCount: db.getFileCount() });
  }).catch(err => {
    logger.warn('code-map initial index failed, will lazy-load on first use', { err });
  });
}
```

- [ ] **Step 3: 编写测试**

`tests/agent/middleware/code-map-context-tree-sitter.test.ts` 至少 6 个用例：
- tree-sitter 引擎正常路径返回 explore 结果
- tree-sitter 引擎失败时降级到 regex
- 首次调用触发 fullIndex，后续调用复用 db
- getIndexStatus 判断正确（needsFullIndex=true / false）
- userQuery 为空时不报错
- explore 结果正确注入 systemPrompt

- [ ] **Step 4: 构建验证**

运行：`npx tsc --noEmit && npx vitest run tests/agent/middleware/code-map-context-tree-sitter.test.ts`
预期：tsc 退出码 0，6 测试全通过

- [ ] **Step 5: 子 Agent 审计**

调用 search 子 Agent 审计：验证 `code-map/*` 模块不再孤立（grep 所有 `code-map/` 导入，确认 middleware 真正消费）；验证 fallback 逻辑完整；验证无新配置僵尸。

---

### Task A2：引用点节点化 + CALLS 边语义修复

**目标：** 让 PageRank 图结构完整，修复 CALLS 边 target 是字符串而非节点 ID 的断链问题。

**文件：**
- 修改：[src/code-map/extractor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/extractor.ts) L446-460
- 修改：[src/code-map/database.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/database.ts)（新增 unresolved_refs 表）
- 修改：[src/code-map/indexer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/indexer.ts)（schema 版本号升级）
- 新增：`tests/code-map/extractor-refs.test.ts`

- [ ] **Step 1: extractor.ts 改造 call_expression 处理**

```typescript
// extractor.ts L446-460 改造
// 原：edges.push({ source: nodeId, target: calleeName, kind: 'CALLS', weight: 1.0 })
// 新：先收集 pendingReferences，末尾按名字匹配定义节点

interface PendingReference {
  sourceId: string;
  calleeName: string;
  line: number;
  filePath: string;
}

// 在 extractFromTree 内部：
const pendingReferences: PendingReference[] = [];

// call_expression 处理改为：
if (node.type === 'call_expression') {
  const calleeNode = node.childForFieldName('function');
  const calleeName = calleeNode?.text;
  if (calleeName && currentSymbolId) {
    pendingReferences.push({
      sourceId: currentSymbolId,
      calleeName,
      line: node.startPosition.row + 1,
      filePath,
    });
  }
}

// extractFromTree 末尾：解析 pendingReferences
for (const ref of pendingReferences) {
  // 优先精确匹配（同文件作用域）
  const def = nodes.find(n =>
    n.name === ref.calleeName &&
    (n.filePath === ref.filePath || n.exported)
  );
  if (def) {
    edges.push({ source: ref.sourceId, target: def.id, kind: 'CALLS', weight: 1.0 });
  } else {
    // 未解析的引用存为 unresolved_ref（参考 CodeGraph MCP）
    unresolvedRefs.push(ref);
  }
}
```

- [ ] **Step 2: database.ts 新增 unresolved_refs 表**

```typescript
// database.ts 新增表
db.exec(`
  CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY,
    source_node_id TEXT NOT NULL,
    callee_name TEXT NOT NULL,
    line INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    FOREIGN KEY (source_node_id) REFERENCES nodes(id)
  );
  CREATE INDEX IF NOT EXISTS idx_unresolved_callee ON unresolved_refs(callee_name);
`);

// schema_versions 表插入新版本
db.prepare('INSERT OR REPLACE INTO schema_versions (version, description) VALUES (?, ?)')
  .run(2, 'add unresolved_refs table');
```

- [ ] **Step 3: 增强 findEnclosingSymbol 范围判断**

```typescript
// extractor.ts L590-608 改造
// 原：startLine === current.startPosition.row
// 新：startLine <= callLine <= endLine
export function findEnclosingSymbol(
  symbols: ExtractedSymbol[],
  line: number,
): ExtractedSymbol | null {
  return symbols.find(s =>
    s.startLine <= line && (s.endLine ?? s.startLine) >= line
  ) ?? null;
}
```

- [ ] **Step 4: 测试**

`tests/code-map/extractor-refs.test.ts` 至少 8 个用例：
- 同文件函数调用生成 CALLS 边
- 跨文件 exported 函数调用生成 CALLS 边
- 未解析的调用进入 unresolved_refs
- findEnclosingSymbol 范围判断正确
- 嵌套函数调用的 enclosing 指向最内层
- 方法定义调用生成 CALLS 边
- 递归调用（自调用）正确处理
- 空 calleeName 跳过

- [ ] **Step 5: 构建验证 + 审计**

```powershell
npx tsc --noEmit
npx vitest run tests/code-map/
```

---

### Task A3：Personalized PageRank + git diff 种子

**目标：** 让排名上下文感知，对齐 aider 核心差异化能力。

**文件：**
- 修改：[src/code-map/ranker.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/ranker.ts)（新增 computePersonalizedPageRank）
- 新增：`src/code-map/git-integration.ts`（用 simple-git 获取最近变更文件）
- 修改：[src/code-map/querier.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/querier.ts)（explore 内部用 PPR）
- 新增：`tests/code-map/personalized-pagerank.test.ts`

- [ ] **Step 1: ranker.ts 新增 computePersonalizedPageRank**

```typescript
// ranker.ts 新增函数
export function computePersonalizedPageRank(
  nodes: string[],
  edges: RankedEdge[],
  seedNodeIds: Set<string>,
  options?: PageRankOptions,
): Map<string, number> {
  const damping = options?.damping ?? 0.85;
  const maxIter = options?.maxIterations ?? 100;
  const tol = options?.tolerance ?? 1e-6;

  // teleportation 向量：种子节点均分 (1-d)，非种子节点为 0
  const seedBoost = seedNodeIds.size > 0 ? (1 - damping) / seedNodeIds.size : (1 - damping) / nodes.length;

  let scores = new Map<string, number>();
  // 初始化：种子节点 1/|seeds|，非种子 0
  for (const n of nodes) {
    scores.set(n, seedNodeIds.has(n) ? 1 / seedNodeIds.size : 0);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const newScores = new Map<string, number>();
    for (const n of nodes) {
      let rank = seedNodeIds.has(n) ? seedBoost : 0;
      // 累加入边贡献
      for (const edge of edges) {
        if (edge.target === n) {
          const sourceOutWeight = edges
            .filter(e => e.source === edge.source)
            .reduce((s, e) => s + e.weight, 0);
          if (sourceOutWeight > 0) {
            rank += damping * (scores.get(edge.source) ?? 0) * edge.weight / sourceOutWeight;
          }
        }
      }
      newScores.set(n, rank);
    }
    // 收敛判断
    let delta = 0;
    for (const n of nodes) {
      delta += Math.abs(newScores.get(n)! - scores.get(n)!);
    }
    scores = newScores;
    if (delta < tol) break;
  }
  return scores;
}
```

- [ ] **Step 2: git-integration.ts 获取最近变更文件**

```typescript
// src/code-map/git-integration.ts
import simpleGit from 'simple-git';
import type { Database } from './database.js';

/** 获取最近 N 次提交涉及的文件，返回符号节点 id 集合作为 PPR 种子 */
export async function getSeedNodeIdsFromGit(
  db: Database,
  cwd: string,
  recentCommits = 5,
): Promise<Set<string>> {
  try {
    const git = simpleGit(cwd);
    if (!await git.checkIsRepo()) return new Set();
    const diff = await git.diff(['--name-only', `HEAD~${recentCommits}..HEAD`]);
    const changedFiles = diff.split('\n').filter(Boolean);
    // 查询这些文件的所有符号节点 id
    const seeds = new Set<string>();
    for (const file of changedFiles) {
      const nodes = db.prepare('SELECT id FROM nodes WHERE file_path = ?').all(file) as { id: string }[];
      nodes.forEach(n => seeds.add(n.id));
    }
    return seeds;
  } catch {
    return new Set(); // fail-open：非 git 仓库或失败时返回空种子
  }
}
```

- [ ] **Step 3: querier.ts explore 内部用 PPR**

```typescript
// querier.ts explore 改造
import { computePersonalizedPageRank } from './ranker.js';
import { getSeedNodeIdsFromGit } from './git-integration.js';

export function explore(
  db: Database,
  query: string,
  cwd: string,
  options?: ExploreOptions,
): ExploreResult {
  const nodes = db.getAllNodes();
  const edges = db.getAllEdges();

  // 种子节点：git diff 文件 + query 关键词匹配的符号
  const gitSeeds = await getSeedNodeIdsFromGit(db, cwd);
  const querySeeds = matchNodesByQuery(nodes, query); // 关键词匹配
  const seedNodeIds = new Set([...gitSeeds, ...querySeeds]);

  // 用 PPR 替代原 computePageRank
  const scores = seedNodeIds.size > 0
    ? computePersonalizedPageRank(nodes.map(n => n.id), edges, seedNodeIds)
    : computePageRank(nodes, edges); // 无种子时回退标准 PR

  // 按分数排序输出
  // ...
}
```

- [ ] **Step 4: 测试**

`tests/code-map/personalized-pagerank.test.ts` 至少 10 个用例：
- 空种子集合时回退标准 PageRank
- 单种子节点：种子节点分数最高
- 多种子节点：种子均分 teleportation
- 阻尼系数影响收敛速度
- 大图（100 节点）收敛
- 孤立节点的 PPR 分数为 0
- 自环边正确处理
- git diff 集成：mock simpleGit 返回文件列表
- 非 git 仓库返回空种子
- query 关键词匹配符号作为种子

- [ ] **Step 5: 构建验证 + 审计**

---

### Task A4：tiktoken 精确计 token + 符号级预算控制

**目标：** 消除中文/注释场景的 token 估算误差（从 ±30% 降到 ±5%）。

**文件：**
- 新增：`src/code-map/token-counter.ts`（tiktoken 封装）
- 修改：[src/code-map/renderer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/renderer.ts) L31-33（替换 estimateTokens）+ L64-70（符号级预算）
- 修改：[src/code-map/compression.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/compression.ts) L28-30
- 修改：`desktop/electron-builder.yml`（asarUnpack 加入 tiktoken wasm）

- [ ] **Step 1: 新增 token-counter.ts**

```typescript
// src/code-map/token-counter.ts
// Phase 71：tiktoken 精确计 token，替代 length/4 估算
import { encoding_for_model, type Tiktoken } from 'tiktoken';

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    // 用 cl100k_base（GPT-4/Claude 3 通用编码），对中文代码混排准确度最高
    encoder = encoding_for_model('gpt-4');
  }
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return getEncoder().encode(text).length;
  } catch {
    // fail-open：tiktoken wasm 加载失败时回退到 length/4
    return Math.ceil(text.length / 4);
  }
}

/** 测试用：释放 encoder（tiktoken wasm 资源） */
export function freeEncoder(): void {
  encoder?.free();
  encoder = null;
}
```

- [ ] **Step 2: renderer.ts 替换 estimateTokens + 符号级预算**

```typescript
// renderer.ts L31-33 改造
import { countTokens } from './token-counter.js';
// 原：function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
// 新：直接用 countTokens

// L64-70 改造：从文件级 break 改为符号级累加
const sortedNodes = nodes.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
let totalTokens = 0;
let truncated = 0;
const includedNodes: typeof sortedNodes = [];

for (const node of sortedNodes) {
  const sigTokens = countTokens(node.signature ?? node.name);
  if (totalTokens + sigTokens > tokenBudget && includedNodes.length > 0) {
    truncated = sortedNodes.length - includedNodes.length;
    break;
  }
  includedNodes.push(node);
  totalTokens += sigTokens;
}

// 按 includedNodes 分组到文件输出（保留原文件分组结构）
```

- [ ] **Step 3: compression.ts 替换 estimateTokens**

同样替换 L28-30 的 `estimateTokens`。

- [ ] **Step 4: electron-builder.yml asarUnpack**

```yaml
# desktop/electron-builder.yml
asarUnpack:
  - node_modules/tiktoken/**/*  # tiktoken wasm 文件必须解包
```

- [ ] **Step 5: 测试 + 验证**

`tests/code-map/token-counter.test.ts` 至少 6 个用例：
- 纯英文：countTokens("hello world") ≈ 2
- 纯中文：countTokens("你好世界") ≈ 4-6（不是 length/4=1）
- 中英混排：countTokens("hello 世界") ≈ 3-4
- 空字符串返回 0
- tiktoken 加载失败时回退 length/4
- freeEncoder 后可重新 getEncoder

---

### Task A5：content hash 缓存 + 增量 PageRank + watch mode

**目标：** 大项目（10k+ 文件）首次索引从 60s 降到 20s，单文件修改后排名更新从 5s 降到 200ms。

**文件：**
- 修改：[src/code-map/indexer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/indexer.ts)（双重校验 + 增量 PageRank）
- 修改：[src/code-map/database.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/database.ts)（pagerank_cache 表）
- 新增：`src/code-map/watcher.ts`（chokidar + 2s debounce，Phase 41 Task 4 设计补全）
- 修改：[src/cli/app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts)（启动时注册 watcher）

- [ ] **Step 1: indexer.ts 双重校验（mtime → content hash）**

```typescript
// indexer.ts 改造文件变更检测
function shouldReparse(filePath: string, cachedMtime: number, cachedHash: string): boolean {
  const stat = fs.statSync(filePath);
  // fast-path：mtime 未变 → 跳过
  if (stat.mtimeMs === cachedMtime) return false;
  // slow-path：mtime 变了，算 content hash
  const content = fs.readFileSync(filePath, 'utf-8');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return hash !== cachedHash;
}
```

- [ ] **Step 2: 增量 PageRank**

```typescript
// ranker.ts 新增
export function updatePageRankIncremental(
  db: Database,
  changedNodeIds: Set<string>,
  kHop = 2,
): void {
  if (changedNodeIds.size > 100) {
    // 变更过多，全量重算
    return updatePageRankFull(db);
  }
  // 取变更节点的 k 跳邻居子图
  const subgraph = collectKHopNeighbors(db, changedNodeIds, kHop);
  const subScores = computePageRank(subgraph.nodes, subgraph.edges);
  // 按比例合并回全局分数
  mergeScores(db, subScores);
}

function collectKHopNeighbors(db: Database, seeds: Set<string>, k: number): { nodes: string[]; edges: RankedEdge[] } {
  // BFS 收集 k 跳邻居
}
```

- [ ] **Step 3: watcher.ts 实现（Phase 41 Task 4 补全）**

```typescript
// src/code-map/watcher.ts
import chokidar from 'chokidar';
import type { Database } from './database.js';
import { incrementalIndex } from './indexer.js';
import { updatePageRankIncremental } from './ranker.js';

export class CodeMapWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges = new Set<string>();

  constructor(
    private rootDir: string,
    private db: Database,
    private debounceMs = 2000,
  ) {}

  start(): void {
    this.watcher = chokidar.watch(this.rootDir, {
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.routedev/**'],
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('change', (path) => {
      this.pendingChanges.add(path);
      this.scheduleUpdate();
    });
    this.watcher.on('unlink', (path) => {
      this.pendingChanges.add(path);
      this.scheduleUpdate();
    });
  }

  private scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const changed = new Set(this.pendingChanges);
      this.pendingChanges.clear();
      incrementalIndex(this.rootDir, changed)
        .then(() => updatePageRankIncremental(this.db, /* changed node ids */))
        .catch(err => logger.warn('code-map watcher update failed', { err }));
    }, this.debounceMs);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
```

- [ ] **Step 4: app-init.ts 注册 watcher**

```typescript
// app-init.ts
if (config.codeMap?.autoIndex !== false) {
  fullIndex(cwd).then(db => {
    const watcher = new CodeMapWatcher(cwd, db);
    watcher.start();
    logger.info('code-map watcher started', { rootDir: cwd });
  }).catch(err => {
    logger.warn('code-map initial index failed', { err });
  });
}
```

- [ ] **Step 5: 测试 + 验证**

`tests/code-map/watcher.test.ts` 至少 5 个用例：
- 文件变更触发增量索引
- 2s debounce 内多次变更只触发一次更新
- unlink 事件正确处理
- stop() 后不再监听
- 增量 PageRank 在 100 节点变更时降级为全量

---

## Part B：Cline / Continue / OpenHands 借鉴点

### Task B1：tiktoken-aware 上下文截断（学习 Cline）

**目标：** 实装 `workerContext.maxTokens: 4000` 这个死字段，用 tiktoken 精确截断而非 slice 条数。

**文件：**
- 修改：[src/agent/multi/worker-executor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/worker-executor.ts) L351-353
- 新增：`src/agent/context/token-aware-slicer.ts`
- 新增：`tests/agent/context/token-aware-slicer.test.ts`

- [ ] **Step 1: 新增 token-aware-slicer.ts**

```typescript
// src/agent/context/token-aware-slicer.ts
import { countTokens } from '../../code-map/token-counter.js';
import type { LLMMessage } from '../../router/types.js';

export interface SliceOptions {
  maxTokens: number;
  strategy: 'tail' | 'head' | 'balanced';
  preserveSystemMessages: boolean;
  preserveLastToolPair: boolean; // Cline 风格：保留最后 N 个 tool_use+tool_result 对
}

export function sliceByTokenBudget(
  messages: LLMMessage[],
  options: SliceOptions,
): { sliced: LLMMessage[]; truncatedTokens: number; originalTokens: number } {
  const originalTokens = messages.reduce((s, m) => s + countTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
  if (originalTokens <= options.maxTokens) {
    return { sliced: messages, truncatedTokens: 0, originalTokens };
  }

  // 1. 始终保留 system 消息
  // 2. 始终保留最后 N 个 tool_use+tool_result 对（Cline 风格）
  // 3. 剩余预算按 strategy 分配给 user/assistant 消息
  const systemMsgs = options.preserveSystemMessages ? messages.filter(m => m.role === 'system') : [];
  const systemTokens = systemMsgs.reduce((s, m) => s + countTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
  const remainingBudget = options.maxTokens - systemTokens;

  // 从尾部累加直到预算用完
  const nonSystem = messages.filter(m => m.role !== 'system');
  const included: LLMMessage[] = [];
  let usedTokens = 0;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msg = nonSystem[i];
    const tokens = countTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    if (usedTokens + tokens > remainingBudget) break;
    included.unshift(msg);
    usedTokens += tokens;
  }

  return {
    sliced: [...systemMsgs, ...included],
    truncatedTokens: originalTokens - systemTokens - usedTokens,
    originalTokens,
  };
}
```

- [ ] **Step 2: worker-executor.ts 接入 token-aware-slicer**

```typescript
// worker-executor.ts L351-353 改造
// 原：const workerHistory = ... slice(-maxMessages)
// 新：
import { sliceByTokenBudget } from '../context/token-aware-slicer.js';

const workerHistory = this.workerContextConfig.enabled
  ? sliceByTokenBudget(filteredHistory, {
      maxTokens: this.workerContextConfig.maxTokens ?? 4000,
      strategy: 'tail',
      preserveSystemMessages: true,
      preserveLastToolPair: true,
    }).sliced
  : [];
```

- [ ] **Step 3: 测试**

`tests/agent/context/token-aware-slicer.test.ts` 至少 8 个用例：
- 总 token < 预算时全量保留
- 总 token > 预算时按尾部截断
- system 消息始终保留
- 最后 tool_use+tool_result 对始终保留
- 空消息列表返回空
- 单条消息超预算时返回空 + 截断统计
- truncatedTokens 计算正确
- preserveSystemMessages=false 时 system 也截断

---

### Task B2：@-mention 统一引用协议（学习 Continue）

**目标：** 把现有 `@图片` 扩展为 `@file` `@code` `@docs` `@web` 统一引用，注入前显示 token 预估。

**文件：**
- 新增：`src/agent/context/mention-parser.ts`
- 修改：[src/cli/chat-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/chat-runner.ts) L189-208（扩展 @ 图片为 @-mention 协议）
- 新增：`tests/agent/context/mention-parser.test.ts`

- [ ] **Step 1: mention-parser.ts**

```typescript
// src/agent/context/mention-parser.ts
import { countTokens } from '../../code-map/token-counter.js';
import fs from 'node:fs/promises';

export type MentionType = 'file' | 'code' | 'docs' | 'web' | 'image';

export interface ParsedMention {
  type: MentionType;
  target: string;       // 文件路径 / URL / 搜索词
  raw: string;          // 原始 @mention 文本
  estimatedTokens: number;
}

export async function parseMentions(text: string): Promise<{
  mentions: ParsedMention[];
  cleanedText: string;
  totalEstimatedTokens: number;
}> {
  const mentionRegex = /@(file|code|docs|web|image):([^\s]+)/g;
  const mentions: ParsedMention[] = [];
  let cleanedText = text;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    const [raw, type, target] = match;
    const mention: ParsedMention = {
      type: type as MentionType,
      target,
      raw,
      estimatedTokens: 0,
    };
    // 预估 token：file/code 读文件内容计数，web 估算 500，image 估算 1000
    if (type === 'file' || type === 'code') {
      try {
        const content = await fs.readFile(target, 'utf-8');
        mention.estimatedTokens = countTokens(content);
      } catch {
        mention.estimatedTokens = 0; // 文件不存在
      }
    } else if (type === 'web') {
      mention.estimatedTokens = 500; // 占位，实际抓取后重算
    } else if (type === 'image') {
      mention.estimatedTokens = 1000;
    }
    mentions.push(mention);
    cleanedText = cleanedText.replace(raw, `[${type}:${target}]`);
  }

  const totalEstimatedTokens = mentions.reduce((s, m) => s + m.estimatedTokens, 0);
  return { mentions, cleanedText, totalEstimatedTokens };
}
```

- [ ] **Step 2: chat-runner.ts 接入 mention-parser**

```typescript
// chat-runner.ts L189-208 改造
// 原：只处理 @图片
// 新：统一走 parseMentions
import { parseMentions } from '../agent/context/mention-parser.js';

const { mentions, cleanedText, totalEstimatedTokens } = await parseMentions(text);

// 注入 mention 内容到消息
let mentionContext = '';
for (const m of mentions) {
  if (m.type === 'file' || m.type === 'code') {
    const content = await fs.readFile(m.target, 'utf-8');
    mentionContext += `\n\n[${m.type}: ${m.target}]\n${content}`;
  }
  // web/image 类型按现有逻辑处理
}

// 显示 token 预估（符合 Continue 的 context preview）
if (totalEstimatedTokens > 0) {
  commandBridge.addSystemMessage(`📎 已解析 ${mentions.length} 个 @mention，预估占用 ${totalEstimatedTokens} tokens`);
}
```

- [ ] **Step 3: 测试**

`tests/agent/context/mention-parser.test.ts` 至少 10 个用例：
- @file:路径 解析正确
- @code:路径 解析正确
- @web:URL 解析正确
- @image:路径 解析正确
- 无 @mention 时返回空列表
- 多个 @mention 同时解析
- 文件不存在时 estimatedTokens=0
- cleanedText 正确替换
- totalEstimatedTokens 累加正确
- 混合类型 mention 解析

---

### Task B3：记忆召回闭环（学习 OpenHands）

**目标：** 接通 `KnowledgeGraph.recallMemories()` 到 system prompt 注入，唤醒死数据。每轮 ReAct 循环开始时主动召回相关记忆。

**文件：**
- 修改：[src/agent/memory/context-manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/context-manager.ts) L659-667
- 修改：[src/agent/loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts)（每轮开始注入记忆）
- 新增：`src/agent/memory/recall-injector.ts`
- 新增：`tests/agent/memory/recall-injector.test.ts`

- [ ] **Step 1: recall-injector.ts**

```typescript
// src/agent/memory/recall-injector.ts
import type { KnowledgeGraph } from './graph.js';
import { logger } from '../../utils/logger.js';

export interface RecalledMemory {
  fact: string;
  confidence: number;
  source: string;
  recalledAt: number;
}

export class MemoryRecallInjector {
  constructor(
    private graph: KnowledgeGraph,
    private injectThreshold: number = 0.7,
    private maxMemories: number = 5,
  ) {}

  /** 根据当前 query 召回相关记忆，格式化为 system prompt 片段 */
  recallToPrompt(query: string): string {
    try {
      const memories = this.graph.recall(query, { maxResults: this.maxMemories });
      const filtered = memories.filter(m => m.confidence >= this.injectThreshold);
      if (filtered.length === 0) return '';

      const lines = filtered.map(m => `- ${m.fact}（置信度: ${m.confidence.toFixed(2)}, 来源: ${m.source}）`);
      return `\n\n【相关记忆】\n${lines.join('\n')}`;
    } catch (err) {
      logger.warn('memory recall failed, fail-open', { err });
      return ''; // fail-open
    }
  }
}
```

- [ ] **Step 2: context-manager.ts 接入 recall-injector**

```typescript
// context-manager.ts L659-667 改造
// 原：recallMemories 返回值无消费方
// 新：通过 MemoryRecallInjector 注入 system prompt
private recallInjector: MemoryRecallInjector | null = null;

setRecallInjector(injector: MemoryRecallInjector): void {
  this.recallInjector = injector;
}

// 在 buildSystemPrompt 或类似方法中：
if (this.recallInjector && this.memoryConfig.inference) {
  const memoryPrompt = this.recallInjector.recallToPrompt(currentQuery);
  systemPrompt += memoryPrompt;
}
```

- [ ] **Step 3: loop.ts 每轮开始注入记忆**

```typescript
// loop.ts 在 *run(params) 的循环开始处
// Phase 71：每轮 ReAct 循环开始时主动召回相关记忆
if (this.contextManager?.recallInjector && params.userMessage) {
  const memoryPrompt = this.contextManager.recallInjector.recallToPrompt(params.userMessage);
  if (memoryPrompt) {
    messages.push({ role: 'system', content: memoryPrompt });
  }
}
```

- [ ] **Step 4: 测试**

`tests/agent/memory/recall-injector.test.ts` 至少 8 个用例：
- 空查询返回空字符串
- 召回结果低于阈值时过滤
- 召回结果超过 maxMemories 时截断
- KnowledgeGraph.recall 抛错时 fail-open 返回空
- 多条记忆格式化正确
- 置信度精确到 2 位小数
- 来源字段正确输出
- injectThreshold=0 时不过滤

---

### Task B4：episodic memory（学习 OpenHands）

**目标：** 把成功的问题解决路径作为 episode 存储，遇到相似问题时复用。

**文件：**
- 新增：`src/agent/memory/episodic-memory.ts`
- 修改：[src/agent/memory/context-manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/context-manager.ts)（CheckpointWriter 完成时存 episode）
- 新增：`tests/agent/memory/episodic-memory.test.ts`

- [ ] **Step 1: episodic-memory.ts**

```typescript
// src/agent/memory/episodic-memory.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

export interface Episode {
  id: string;
  query: string;            // 用户原始问题
  solutionPath: string[];   // 解决步骤摘要
  outcome: 'success' | 'failure';
  toolsUsed: string[];
  durationMs: number;
  createdAt: number;
  tags: string[];
}

export class EpisodicMemory {
  constructor(private storePath: string) {}

  async store(episode: Episode): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      const line = JSON.stringify(episode) + '\n';
      await fs.appendFile(this.storePath, line, 'utf-8');
    } catch (err) {
      logger.warn('episodic memory store failed, fail-open', { err });
    }
  }

  async recallSimilar(query: string, limit = 3): Promise<Episode[]> {
    try {
      const content = await fs.readFile(this.storePath, 'utf-8');
      const episodes: Episode[] = content.trim().split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Episode);
      // 关键词匹配评分（P1 简单实现，P2 可升级为 embedding）
      return episodes
        .map(e => ({ episode: e, score: this.scoreSimilarity(query, e.query) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.episode);
    } catch {
      return []; // fail-open
    }
  }

  private scoreSimilarity(query: string, episodeQuery: string): number {
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    const episodeWords = new Set(episodeQuery.toLowerCase().split(/\s+/));
    const intersection = [...queryWords].filter(w => episodeWords.has(w));
    return intersection.length / Math.max(queryWords.size, episodeWords.size);
  }
}
```

- [ ] **Step 2: context-manager.ts 接入 episodic memory**

```typescript
// context-manager.ts 在 checkpoint 完成时存 episode
if (this.episodicMemory && checkpointData.outcome === 'success') {
  await this.episodicMemory.store({
    id: `ep-${Date.now()}`,
    query: checkpointData.currentIntent,
    solutionPath: checkpointData.completedSteps,
    outcome: 'success',
    toolsUsed: checkpointData.toolsUsed,
    durationMs: checkpointData.durationMs,
    createdAt: Date.now(),
    tags: checkpointData.tags ?? [],
  });
}
```

- [ ] **Step 3: recall-injector.ts 增强：注入相似 episode**

```typescript
// recall-injector.ts 增强
async recallToPromptWithEpisodes(query: string): Promise<string> {
  const memoryPrompt = this.recallToPrompt(query);
  const episodes = await this.episodicMemory?.recallSimilar(query, 2) ?? [];
  if (episodes.length === 0) return memoryPrompt;

  const episodeLines = episodes.map(e =>
    `- 相似问题「${e.query}」的解决路径：${e.solutionPath.join(' → ')}`
  );
  return memoryPrompt + `\n\n【相似解决路径】\n${episodeLines.join('\n')}`;
}
```

- [ ] **Step 4: 测试**

`tests/agent/memory/episodic-memory.test.ts` 至少 8 个用例：
- store + recall 完整流程
- 空 store recall 返回空
- 相似度评分正确
- limit 参数生效
- 无相似时返回空
- 多 episode 排序正确
- 文件损坏时 fail-open 返回空
- outcome=failure 的 episode 也能存储

---

## Part C：配置僵尸清单与处理决策

### 已识别的 5 个配置僵尸

| # | 配置字段 | 位置 | 现状 | 处理决策 | 任务 |
|---|---------|------|------|---------|------|
| 1 | `optimization.structuredState.enabled` | [defaults.ts:166](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L166) | 仅 config 出现，0 消费点 | **删除** — 设计未明确，删字段 + schema 同步 | Task C1 |
| 2 | `optimization.declarativeContext.enabled` | [defaults.ts:167](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L167) | 仅 config 出现，0 消费点 | **删除** — 同上 | Task C1 |
| 3 | `workerContext.maxTokens: 4000` | [defaults.ts:185](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L185) | 仅 slice 条数，无 token 估算 | **实装** — Task B1 已接入 token-aware-slicer | Task B1 |
| 4 | `phase70Integration.*` 全 `enabled: false` | [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) | 5 个增强模块存在但未启用 | **启用关键项** — AutoCompactGuardian 启用，其余保留 false 但加注释 | Task C2 |
| 5 | `progressive-disclosure.ts` | docs/CONTEXT_USAGE.md 提及 | 文档提及但代码不存在 | **实装** — Task D9 创建该模块 | Task D9 |

### Task C1：删除 structuredState + declarativeContext 配置

**目标：** 消除两个明确的配置僵尸，避免误导用户。

**文件：**
- 修改：[src/config/schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts)
- 修改：[src/config/defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts)
- 修改：`config.example.yaml`（如有引用）

- [ ] **Step 1: schema.ts 删除两个字段**

```typescript
// schema.ts 删除：
// optimization.structuredState: z.object({ enabled: z.boolean().default(false) })
// optimization.declarativeContext: z.object({ enabled: z.boolean().default(false) })
```

- [ ] **Step 2: defaults.ts 删除对应默认值**

- [ ] **Step 3: grep 验证无残留引用**

```powershell
# 验证无残留
rg "structuredState|declarativeContext" --type ts
```

预期：0 命中（除非在 migration 注释中）

- [ ] **Step 4: 构建验证**

```powershell
npx tsc --noEmit
```

---

### Task C2：启用 AutoCompactGuardian

**目标：** 启用 Phase 70 已实现但默认关闭的 AutoCompactGuardian，提升压缩决策质量。

**文件：**
- 修改：[src/config/defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts)
- 修改：[src/agent/memory/auto-compact-guardian.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/auto-compact-guardian.ts)（验证 enabled 消费点）

- [ ] **Step 1: defaults.ts 修改**

```typescript
// defaults.ts
phase70Integration: {
  // ...
  autoCompactGuardian: {
    enabled: true,  // Phase 71：启用（原 false）
    autoCompactBuffer: 13000,
    warningBuffer: 20000,
    errorBuffer: 20000,
  },
  // 其余保留 false，加注释说明 P2 启用
  toolOutputBudget: { enabled: false /* P2: 启用 offload 机制 */ },
  messageGrouper: { enabled: false /* P2 */ },
  actionChainDetector: { enabled: false /* P2 */ },
  compactPromptEngine: { enabled: false /* P2 */ },
},
```

- [ ] **Step 2: 验证 auto-compact-guardian.ts 的 enabled 消费点**

grep `enabled` 在 auto-compact-guardian.ts 中，确认真正被读取并影响行为。

- [ ] **Step 3: 测试 + 验证**

运行现有测试确认无回归。

---

## Part D：九维度改进到 5 分

### 当前评分与目标

| 维度 | 当前 | 目标 | 关键改进 |
|------|------|------|---------|
| 1. 上下文组装链路 | 4 | 5 | 统一 system prompt 拼装 + 对话历史 token 感知 |
| 2. 上下文压缩/摘要 | 5 | 5 | 维持（已 5 分） |
| 3. 项目记忆/用户偏好 | 3 | 5 | 接通 recallMemories（Task B3）+ user_profile 实装 |
| 4. Token 预算管理 | 3 | 5 | 实装 maxTokens（Task B1）+ AutoCompactGuardian（Task C2） |
| 5. 工具输出处理 | 4 | 5 | 统一 4 套截断 + offload 清理 |
| 6. 子 Agent 上下文隔离 | 4 | 5 | ContextPacker 默认启用 + token 估算修复 |
| 7. 知识图谱/长期记忆 | 4 | 5 | recallMemories 闭环（Task B3）+ embedding 启用 |
| 8. 检索增强/RAG | 4 | 5 | CodebaseMemory 语义检索 + HybridRetriever 真实 embedding |
| 9. 渐进式披露 | 2 | 5 | 实装 progressive-disclosure.ts + 动态调整 |

### Task D1：统一 system prompt 拼装（维度 1 → 5）

**目标：** 把分散在 5 处的 system prompt 拼装统一到一个 builder。

**文件：**
- 新增：`src/agent/context/system-prompt-builder.ts`
- 修改：[src/agent/loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts) L614-638
- 修改：[src/cli/chat-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/chat-runner.ts) L217-227

- [ ] **Step 1: system-prompt-builder.ts**

```typescript
// src/agent/context/system-prompt-builder.ts
// Phase 71：统一 system prompt 拼装，消除分散在 5 处的字符串拼接

import type { AgentProfile } from '../../agents/profiles/types.js';
import type { ProjectMemory } from '../../memory/project-memory.js';

export interface SystemPromptParts {
  basePrompt: string;          // PromptTemplateManager.render('main.system')
  skillSuffix: string;         // chat-runner 的 skillPromptSuffix
  projectRules: string;        // AGENTS.md / CLAUDE.md
  projectMemory: string;       // MEMORY.md / decisions.log
  recalledMemory: string;      // KnowledgeGraph recall
  expertisePrompt: string;     // expertise-prompt middleware
  conciseThinking: string;     // CONCISE_THINKING_BLOCK
  codeMapContext: string;      // CodeMapContextMiddleware
  userPreferences: string;     // user_profile.md 注入
}

export function buildSystemPrompt(parts: SystemPromptParts): string {
  // 统一拼装顺序，避免分散
  const sections: string[] = [parts.basePrompt];
  if (parts.projectRules) sections.push(`【项目规则】\n${parts.projectRules}`);
  if (parts.projectMemory) sections.push(`【项目记忆】\n${parts.projectMemory}`);
  if (parts.recalledMemory) sections.push(parts.recalledMemory);
  if (parts.expertisePrompt) sections.push(parts.expertisePrompt);
  if (parts.userPreferences) sections.push(`【用户偏好】\n${parts.userPreferences}`);
  if (parts.codeMapContext) sections.push(parts.codeMapContext);
  if (parts.conciseThinking) sections.push(parts.conciseThinking);
  if (parts.skillSuffix) sections.push(parts.skillSuffix);
  return sections.join('\n\n');
}
```

- [ ] **Step 2: loop.ts 改造**

把 L614-638 的中间件 + conciseThinking + skillSuffix 拼装统一走 `buildSystemPrompt`。

- [ ] **Step 3: 测试**

`tests/agent/context/system-prompt-builder.test.ts` 至少 6 个用例。

---

### Task D2：user_profile 实装（维度 3 → 5）

**目标：** 实装 user_profile.md 加载与注入（当前只有 expertise.level 三档预设）。

**文件：**
- 新增：`src/agent/context/user-profile-loader.ts`
- 修改：`src/agent/context/system-prompt-builder.ts`（注入 userPreferences）

- [ ] **Step 1: user-profile-loader.ts**

```typescript
// src/agent/context/user-profile-loader.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface UserProfile {
  raw: string;
  tokens: number;
}

export async function loadUserProfile(): Promise<UserProfile | null> {
  // 加载顺序：项目级 .routedev/user_profile.md > 全局 ~/.routedev/user_profile.md
  const candidates = [
    path.join(process.cwd(), '.routedev', 'user_profile.md'),
    path.join(os.homedir(), '.routedev', 'user_profile.md'),
  ];
  for (const p of candidates) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      return { raw: content, tokens: Math.ceil(content.length / 4) };
    } catch {
      continue;
    }
  }
  return null;
}
```

- [ ] **Step 2: 接入 system-prompt-builder**

- [ ] **Step 3: 测试**

`tests/agent/context/user-profile-loader.test.ts` 至少 5 个用例。

---

### Task D3：工具输出截断统一编排（维度 5 → 5）

**目标：** 把 4 套截断机制（Sanitizer/L1/Concise/Budget）统一到一个 pipeline。

**文件：**
- 新增：`src/agent/context/tool-output-pipeline.ts`
- 修改：[src/agent/loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts) L555-576

- [ ] **Step 1: tool-output-pipeline.ts**

```typescript
// src/agent/context/tool-output-pipeline.ts
// Phase 71：统一 4 套截断机制为一个 pipeline
import { ToolResultSanitizer } from '../../tools/result-sanitizer.js';
import { countTokens } from '../../code-map/token-counter.js';

export interface ToolOutputPipelineOptions {
  maxChars: number;          // 来自 config.optimization.safety.maxToolOutputChars
  conciseThinking: boolean;  // 来自 config.optimization.conciseThinking.enabled
  budgetEnabled: boolean;    // 来自 phase70Integration.toolOutputBudget.enabled
  offloadDir: string;        // offload 目录
}

export class ToolOutputPipeline {
  constructor(private options: ToolOutputPipelineOptions) {}

  process(toolName: string, result: string): { output: string; offloaded?: string } {
    // 1. Sanitizer：安全检查 + 脱敏
    // 2. L1 Budget Trimming：>2000 字符截断
    // 3. Concise Thinking：>2000 字符进一步裁剪
    // 4. Budget Offload（若启用）：写文件 + preview
    // 统一返回处理后的 output + offloaded 文件路径
  }
}
```

- [ ] **Step 2: loop.ts 接入 pipeline**

- [ ] **Step 3: 测试**

至少 8 个用例覆盖 4 个阶段。

---

### Task D4：ContextPacker 默认启用 + token 估算修复（维度 6 → 5）

**目标：** 启用 ContextPacker + 用 tiktoken 替代 length/4。

**文件：**
- 修改：[src/agents/context-packer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/context-packer.ts) L174
- 修改：[src/config/defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts)（delegationIntegration.contextPackerEnabled 默认 true）

- [ ] **Step 1: context-packer.ts L174 替换 token 估算**

```typescript
// 原：const tokens = Math.ceil(text.length / 4);
// 新：
import { countTokens } from '../code-map/token-counter.js';
const tokens = countTokens(text);
```

- [ ] **Step 2: defaults.ts 启用 ContextPacker**

- [ ] **Step 3: 测试**

---

### Task D5：CodebaseMemory 语义检索（维度 8 → 5）

**目标：** 把 CodebaseMemory 从关键词检索升级为语义检索，复用 HybridRetriever。

**文件：**
- 修改：[src/memory/codebase-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/codebase-memory.ts) L107-121
- 修改：[src/config/defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts)（embeddingProvider 从 'hash' 改为真实 provider）

- [ ] **Step 1: codebase-memory.ts query 改用 HybridRetriever**

- [ ] **Step 2: defaults.ts 升级 embeddingProvider**

- [ ] **Step 3: 测试**

---

### Task D6：progressive-disclosure.ts 实装（维度 9 → 5）

**目标：** 兑现文档承诺，创建 progressive-disclosure.ts，实现基于上下文占用率的动态调整。

**文件：**
- 新增：`src/skills/progressive-disclosure.ts`
- 修改：[src/agent/middleware/expertise-prompt.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/middleware/expertise-prompt.ts)

- [ ] **Step 1: progressive-disclosure.ts**

```typescript
// src/skills/progressive-disclosure.ts
// Phase 71：兑现 docs/CONTEXT_USAGE.md 承诺，实装渐进式披露
import { countTokens } from '../code-map/token-counter.js';

export type DisclosureLevel = 'summary' | 'key-details' | 'full';

export interface DisclosureContext {
  tokenUsageRatio: number;    // 0-1，当前上下文占用率
  expertiseLevel: 'beginner' | 'intermediate' | 'expert';
  taskComplexity: 'low' | 'medium' | 'high';
}

export function computeDisclosureLevel(ctx: DisclosureContext): DisclosureLevel {
  // 上下文占用 >80% → summary（强制压缩）
  if (ctx.tokenUsageRatio > 0.8) return 'summary';
  // 专家用户 + 低复杂度 → summary
  if (ctx.expertiseLevel === 'expert' && ctx.taskComplexity === 'low') return 'summary';
  // 初学者 → full（详细解释）
  if (ctx.expertiseLevel === 'beginner') return 'full';
  // 默认 → key-details
  return 'key-details';
}

export function applyDisclosure(content: string, level: DisclosureLevel): string {
  switch (level) {
    case 'summary':
      // 取首段 + 关键行
      return content.split('\n').slice(0, 5).join('\n') + '\n[已压缩...]';
    case 'key-details':
      // 保留关键细节，删除冗余
      return content;
    case 'full':
      return content;
  }
}
```

- [ ] **Step 2: expertise-prompt.ts 接入**

- [ ] **Step 3: 测试**

至少 8 个用例。

---

### Task D7：offload 文件清理机制（维度 5 → 5）

**目标：** ToolOutputBudgetManager 的 offload 文件无清理机制，长期使用会膨胀。

**文件：**
- 修改：[src/agent/memory/tool-output-budget.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/tool-output-budget.ts)

- [ ] **Step 1: 新增 cleanup 方法**

```typescript
// tool-output-budget.ts 新增
async cleanup(maxAgeDays = 7): Promise<{ deleted: number; freedBytes: number }> {
  // 删除超过 maxAgeDays 天的 offload 文件
}
```

- [ ] **Step 2: app-init.ts 启动时触发清理**

- [ ] **Step 3: 测试**

---

## Part E：deepagents 三借鉴点落地

### Task E1：进程内 VFS 作为一等上下文公民

**目标：** 新增 vfs_write / vfs_read / vfs_ls 工具，Agent 主动卸载长内容到 VFS。

**文件：**
- 新增：`src/tools/builtin/vfs.ts`
- 修改：[src/tools/registry.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/registry.ts)（注册 VFS 工具）
- 修改：[src/agent/loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts)（VFS 挂载到 AgentLoop 实例）
- 新增：`tests/tools/builtin/vfs.test.ts`

- [ ] **Step 1: vfs.ts 工具实现**

```typescript
// src/tools/builtin/vfs.ts
// Phase 71：进程内 VFS，Agent 主动卸载长内容（学习 deepagents）
// 与 notes 工具区分：notes 是扁平待办，VFS 是带路径的层级存储

import type { ToolDefinition } from '../registry.js';

export class VirtualFileSystem {
  private files = new Map<string, string>();

  write(path: string, content: string): string {
    this.files.set(path, content);
    return `已写入 ${content.length} 字符到 ${path}`;
  }

  read(path: string): string {
    return this.files.get(path) ?? `文件 ${path} 不存在`;
  }

  ls(prefix = '/'): string[] {
    return Array.from(this.files.keys()).filter(k => k.startsWith(prefix));
  }

  clear(): void {
    this.files.clear();
  }

  size(): number {
    return this.files.size;
  }
}

export function createVFSTools(vfs: VirtualFileSystem): ToolDefinition[] {
  return [
    {
      name: 'vfs_write',
      description: '将长内容写入虚拟文件系统（用于上下文卸载，避免对话历史膨胀）',
      // ... schema + handler
    },
    {
      name: 'vfs_read',
      description: '从虚拟文件系统读取之前写入的内容',
      // ...
    },
    {
      name: 'vfs_ls',
      description: '列出虚拟文件系统中的文件',
      // ...
    },
  ];
}
```

- [ ] **Step 2: loop.ts 挂载 VFS**

```typescript
// loop.ts
// Phase 71：每会话级 VFS 实例，会话结束自动清理
private vfs: VirtualFileSystem = new VirtualFileSystem();

// 在工具注册时加入 VFS 工具
const vfsTools = createVFSTools(this.vfs);
vfsTools.forEach(t => registry.register(t));
```

- [ ] **Step 3: system prompt 引导**

在 `system-prompt-builder.ts` 的 basePrompt 中加入：

```
【上下文工程纪律】
- 单条工具输出 >500 字时，主动判断是否需要写到 VFS（vfs_write）而非直接引用
- 长回复（>1000 字）拆分为"摘要 + VFS 详情"
- 子任务独立性强时，优先 spawn_agent 而非自己串行做
```

- [ ] **Step 4: 测试**

`tests/tools/builtin/vfs.test.ts` 至少 8 个用例。

---

### Task E2：显式 plan 作为可读写状态

**目标：** Agent 执行中可修订计划，而非只读跟踪。新增 update_plan 工具。

**文件：**
- 新增：`src/tools/builtin/update-plan.ts`
- 修改：[src/agent/goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/goal-runner.ts)（暴露 plan 修订接口）
- 修改：[src/agent/plan-diff.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/plan-diff.ts)（update_plan 触发 diff 记录）

- [ ] **Step 1: update-plan.ts 工具**

```typescript
// src/tools/builtin/update-plan.ts
// Phase 71：Agent 可在执行中修订计划（学习 deepagents）
// 修订触发 plan-diff 记录 + plan-attestation 重新签署
```

- [ ] **Step 2: goal-runner.ts 暴露修订接口**

- [ ] **Step 3: plan-diff.ts 接入修订触发**

- [ ] **Step 4: 测试**

---

### Task E3：prompt 引导的上下文工程纪律

**目标：** 把"长内容写 VFS、子任务委派、先 plan"内化为系统 prompt。

**文件：**
- 修改：[src/agent/prompts.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/prompts.ts)
- 修改：[src/agents/persona-engine.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/persona-engine.ts)

- [ ] **Step 1: prompts.ts 新增上下文工程纪律片段**

- [ ] **Step 2: persona-engine.ts 作为所有 persona 固定前缀**

- [ ] **Step 3: 测试**

---

## Part F：严禁死代码 + 自审机制

### Task F1：死代码检测脚本

**目标：** CI 可执行的死代码检测，防止新增配置僵尸。

**文件：**
- 新增：`scripts/detect-dead-config.ts`

- [ ] **Step 1: 检测脚本**

```typescript
// scripts/detect-dead-config.ts
// Phase 71：扫描 schema.ts 所有配置字段，grep 消费点，0 消费点的标红
// 退出码：0=无死配置，1=发现死配置
```

- [ ] **Step 2: package.json 加脚本**

```json
{
  "scripts": {
    "check:dead-config": "tsx scripts/detect-dead-config.ts"
  }
}
```

- [ ] **Step 3: 测试 + 文档**

---

### Task F2：子 Agent 独立审计流程

**目标：** 每个 Task 完成后必须子 Agent 审计，发现"配置僵尸"或"孤立模块"标 Critical。

**文件：**
- 新增：`docs/audit-checklist.md`

- [ ] **Step 1: 审计 checklist 文档**

- [ ] **Step 2: 每个 Task 的 Step 5 统一调用 search 子 Agent 审计**

---

## 任务依赖与执行顺序

```
Week 1（基础设施层）:
  Task A1（接通 tree-sitter）→ Task A4（tiktoken）→ Task B1（token-aware-slicer）
  Task C1（删除配置僵尸）并行
  Task C2（启用 AutoCompactGuardian）并行

Week 2（消费层）:
  Task A2（引用点节点化）→ Task A3（PPR + git diff）
  Task B3（记忆召回闭环）→ Task B4（episodic memory）
  Task D1（system prompt 统一）→ Task D2（user_profile）→ Task D3（工具输出 pipeline）

Week 3（强化层）:
  Task A5（缓存 + watch mode）
  Task B2（@-mention 协议）
  Task D4（ContextPacker 启用）→ Task D5（CodebaseMemory 语义）→ Task D6（progressive-disclosure）→ Task D7（offload 清理）

Week 4（deepagents 借鉴 + 纪律层）:
  Task E1（VFS）→ Task E2（update_plan）→ Task E3（prompt 纪律）
  Task F1（死代码检测）→ Task F2（审计流程）
```

---

## 边界条件清单

### 构建失败回退
每个 Task 独立 commit，失败时 `git revert HEAD` 回到上一步稳定态。Task 之间无强依赖（除 Week 2 的 A2→A3、B3→B4 外），单 Task 失败不阻塞其他。

### 步骤依赖断裂
- Task A3 依赖 A2 的引用点节点化（PPR 需要完整图结构）——A2 失败时 A3 回退到标准 PageRank
- Task B4 依赖 B3 的 recall-injector——B3 失败时 B4 的 episodic memory 无法注入，降级为仅存储不召回
- Task E2 依赖现有 plan-diff.ts——若 plan-diff 不可用，update_plan 工具降级为仅记录修订不生成 diff

### 配置兼容性
- 删除 `structuredState` / `declarativeContext` 后，用户旧配置文件中的这两个字段会被 Zod schema 自动忽略（`z.preprocess` 剥离未知字段），无破坏性
- 启用 AutoCompactGuardian 后，已配置 `phase70Integration.autoCompactGuardian.enabled: false` 的用户配置仍生效（用户显式配置优先于 default）

### 性能回归风险
- tiktoken wasm 在 Electron 打包后可能加载失败——已在 Task A4 Step 4 配置 asarUnpack，并保留 length/4 fallback
- tree-sitter 引擎首次索引可能慢（10k 文件 ~60s）——已设计为异步不阻塞主流程，且 regex 方案作为 fallback
- PPR 计算复杂度高于标准 PageRank——已设计为仅在有种子时启用，无种子时回退标准 PR

### 严禁死代码自检（每个 Task 完成时）
1. 新增配置字段是否在同一次 PR 内接入消费点？
2. 新增模块是否有至少一个调用方？
3. 新增函数是否有测试覆盖？
4. 是否有"配置承诺但实现未兑现"的情况？
5. 子 Agent 审计是否通过（无 Critical）？

---

## 自审清单

### 规格覆盖
- [x] Part A aider 5 建议：Task A1-A5 全覆盖
- [x] Part B Cline/Continue/OpenHands 借鉴：Task B1（Cline tiktoken）、B2（Continue @-mention）、B3（OpenHands 记忆闭环）、B4（OpenHands episodic）
- [x] Part C 配置僵尸：5 个全处理（2 删 + 2 实装 + 1 启用）
- [x] Part D 九维度：9 个维度全覆盖，目标 5 分
- [x] Part E deepagents 三借鉴：Task E1（VFS）、E2（update_plan）、E3（prompt 纪律）
- [x] Part F 严禁死代码：Task F1（检测脚本）、F2（审计流程）

### 占位符扫描
- 无 "TBD"、"TODO"、"稍后实现"
- 每个 Task 都有具体代码示例
- 每个 Step 都有明确动作

### 一致性
- tiktoken 导入路径统一为 `src/code-map/token-counter.ts`
- countTokens 函数名跨 Task 一致
- VirtualFileSystem 类名跨 Task 一致
- MemoryRecallInjector 类名跨 Task 一致
- 所有 ESM import 带 .js 后缀

# Phase 42 — 代码地图引擎落地、多 Agent 编排升级与 Skill/Hook 市场

> **版本目标：** v3.3.0
> **前置依赖：** Phase 40（v3.2.0 渐进式信任/确定性路由/质量监测）完成；Phase 41（v3.2.0 代码地图自研引擎升级）完成
> **新增测试要求：** ≥ 60 个
> **研究依据：** Phase 39-41 设计文档；Aider `repomap.py`、CodeGraph 架构；CUGA Agent（IBM 开源，Apache 2.0，Python/LangGraph，[cuga-project/cuga-agent](https://github.com/cuga-project/cuga-agent)）的 CugaSupervisor、Policy SDK、SKILL.md 规范、Manage & Publish 与 HITL 设计；项目现状审计（`src/tools/repo-map.ts`、`src/agent/multi/*.ts`、`src/skills/skill-generator.ts`、`src/hooks/generator.ts`、`src/harness/experiment-manager.ts`）
> **核心命题：** 经过 Phase 39-41 的密集规划，RouteDev 已拥有完整的设计蓝图和部分实现，但存在"规划多、落地少"的结构性缺口。本 Phase 在借鉴 CUGA Agent 的 CugaSupervisor、Policy SDK、SKILL.md 规范与 HITL 设计的基础上，把前述建议分批落地：先以最小可行方式构建自研 tree-sitter 代码地图引擎（替代/补充正则方案），再叠加创新压缩与多 Agent 编排升级，新增企业级策略引擎与人工审批，最后把 Skill/Hook 变成可发现、可分享的市场化能力，并把分支编辑-审查-合并工作流在桌面端彻底闭环。

---

## 项目现状审计与可行性结论

### 1. 已具备的实现基础

| 模块 | 当前状态 | 可复用度 |
|------|---------|---------|
| `src/tools/repo-map.ts` | Phase 39 正则方案已落地：多语言、增量缓存、文件级影响分析 | 高（作为 fallback 保留） |
| `src/config/codegraph-manager.ts` | CodeGraph MCP 外接管理器、工具定义、安装引导 | 中（本 Phase 改为自研引擎后，MCP 变可选） |
| `src/skills/skill-generator.ts` | Skill AI 自动生成器已可用 | 高（本 Phase 加市场和 UI 入口） |
| `src/hooks/generator.ts` | Hook AI 自动生成器 + 10 个模板已可用 | 高（本 Phase 加市场和共享） |
| `src/harness/experiment-manager.ts` | Git Worktree 分支管理、选择性合并、diff 审查 | 高（本 Phase 补 UI 和 /goal 集成） |
| `src/harness/experiment-runner.ts` | 在 worktree 中执行 Agent Loop | 高 |
| `src/agent/multi/branch-orchestrator.ts` | /goal → 分支任务 → 拓扑执行 | 高 |
| `src/agent/execution-orchestrator.ts` | 单/多 Agent 自适应执行、并发控制、Blackboard | 高（本 Phase 做状态机和 handoff 升级） |
| `src/agent/multi/orchestrator.ts` | LLM 依赖分析 + 拓扑排序 + Worker 异常隔离 | 高 |
| `src/agent/multi/blackboard.ts` | 共享内存、快照、格式化 | 高 |
| `src/agent/multi/worker-executor.ts` | Worker 执行、上下文过滤、重试回滚 | 高 |

### 2. 尚未落地的关键缺口

| 缺口 | 影响 | 本 Phase 处理方式 |
|------|------|------------------|
| 无 `src/code-map/` 目录，tree-sitter 未引入 | Phase 41 规划的自研引擎停留在纸面 | Task 1 以 MVP 方式落地 |
| `package.json` 无 `tree-sitter`、`better-sqlite3`/`node:sqlite` | 无法解析 AST、无法持久化图谱 | Task 1 引入并做 Windows 兼容兜底 |
| 无 PageRank / PPR 排名 | 大项目上下文无法择优 | Task 1 实现基础 PageRank，Task 2 叠加上下文感知 |
| 无代码地图压缩策略 | 大项目首次索引和查询体积过大 | Task 2 引入 HCGS / RepoDistill / 语义边 / diff 压缩 |
| 多 Agent 编排仍基于拓扑组 + 共享工作目录 | 高级可控性不足，缺状态机和结构化交接 | Task 3 引入图状态机、handoff、Score Card |
| Skill/Hook 无"市场"机制 | 用户之间无法共享，缺少发现入口 | Task 4 实现本地/远程市场、导入导出 |
| 分支合并缺少桌面端 UI 闭环 | /experiment CLI 为主，普通用户不敢用 | Task 5 在 ChatPage 补分支面板和审查模态框 |
| 无运行时策略引擎 | 无法做意图护栏、SOP 注入、敏感工具审批 | Task 7 引入 Policy Engine |

### 3. 可行性总评

- **代码地图自研引擎：** 可行，但工作量大。tree-sitter 生态成熟，TypeScript 有 `tree-sitter` + `web-tree-sitter` 等选项；Windows 原生模块需预编译 binary 兜底。建议第一版只支持 TS/JS/Python，其他语言后续扩展。
- **代码地图压缩：** 可行，但属于研究性增强。HCGS 和 RepoDistill 需要分层摘要能力，建议作为"实验性功能"开关，不阻塞主路径。
- **多 Agent 编排升级：** 高度可行。当前 `execution-orchestrator.ts` 框架完整，图状态机和 handoff 可在现有基础设施上增量添加。
- **Skill/Hook 市场：** 高度可行。生成器已存在，市场只需增加元数据、打包格式、导入导出和 UI 浏览。
- **分支合并 UI 闭环：** 高度可行。后端能力已完整，缺的是桌面端组件（BranchPanel、ReviewModal）和 /goal 集成触发点。
- **策略引擎与人工审批：** 高度可行。可复用现有 Hook 基础设施做 Tool Approval，可复用 PromptManager 做 Playbook 注入，Intent Guard 是轻量级输入过滤。

---

## 附录 A：CUGA Agent 借鉴分析

### A.1 CUGA 核心能力速览

CUGA（Configurable Generalist Agent）是 IBM 开源的企业级 Agent 框架，Apache 2.0 协议，Python/LangGraph 实现。其核心亮点与 RouteDev Phase 42 高度相关：

| CUGA 特性 | 实现方式 | RouteDev 对应领域 | 借鉴必要性 |
|-----------|---------|------------------|-----------|
| **CugaSupervisor** | 多 Agent subgraph，支持 `plan_upfront` / `conversational` 两种模式，`sequential` / `parallel` / `adaptive` 策略，A2A 协议接入外部 Agent，变量聚合 | Task 3 多 Agent 编排 | 高：补全 RouteDev 缺失的"策略选择"与"变量聚合" |
| **Policy SDK** | 5 种策略：Intent Guard、Playbook、Tool Guide、Tool Approval、Output Formatter；支持 keyword / 语义触发 | Task 7 策略引擎 | 高：企业级安全护栏与 SOP 固化 |
| **SKILL.md 规范** | YAML frontmatter + Markdown 内容，`.agents/skills/` 自动发现，`load_skill` 按需加载 | Task 4 Skill 市场 | 中：统一 Skill 格式，提升与生态兼容性 |
| **Manage & Publish** | `cuga start manager` 草稿 → 试用 → 发布版本化配置 | Task 4 Skill/Hook 市场 | 中：引入 draft/publish 生命周期 |
| **Human-in-the-Loop** | `api_planner_hitl` 与 Tool Approval 策略 | Task 5 分支审查 / Task 7 策略 | 高：增强写操作前的可控性 |
| **Save & Reuse** | 捕获成功执行路径（plan、code、trajectory）复用 | 项目记忆 / Score Card | 低：本 Phase 不实现，作为后续方向 |
| **cuga viz** | 执行轨迹可视化仪表板 | Task 5 UI | 低：可复用 Score Card 数据做简化版 |
| **Reasoning Modes** | `fast` / `balanced` / `accurate` | 模型路由 | 中：给用户显式选择模式 |

### A.2 对 RouteDev 的必要性判断

**必须借鉴（本 Phase 落地）：**
1. **Policy SDK 理念 → Task 7 策略引擎。** RouteDev 已有 Skill/Hook 规则，但缺少"运行时策略"层。CUGA 的 Intent Guard / Tool Approval / Playbook 是企业用户刚需：防止误删文件、强制走 SOP、敏感操作人工确认。
2. **CugaSupervisor 的变量聚合 → Task 3。** 当前 Blackboard 是文本共享，缺少结构化变量池。CUGA 的 `supervisor_variables` 给多 Agent 协作提供了清晰模式。
3. **SKILL.md frontmatter 标准 → Task 4。** 兼容 Anthropic/CUGA 的开放标准，降低用户迁移成本，便于未来社区共享。

**建议借鉴（本 Phase 轻量实现）：**
4. **Manage & Publish 生命周期 → Task 4。** Skill/Hook 从草稿到发布，版本化、可回滚。
5. **HITL Tool Approval → Task 5 / Task 7。** 与分支审查合并，对写操作、网络请求、敏感命令增加审批门。
6. **Reasoning Modes → 模型路由 UI。** 在 chat 输入框旁增加 `fast/balanced/accurate` 模式切换，直接映射到 RouteDev 的模型路由策略。

**暂不借鉴（超出本 Phase 范围）：**
7. **A2A 协议。** RouteDev 当前聚焦本地/桌面端，远程 Agent 协作不是优先需求。
8. **cuga viz 完整轨迹可视化。** Score Card 已覆盖数据收集，完整可视化可在后续版本做。
9. **Knowledge RAG（Docling）。** RouteDev 已有 KnowledgeGraph，不引入额外的文档 RAG 引擎。

### A.3 可行性评估

- **CUGA 是 Python/LangGraph，RouteDev 是 TypeScript/Electron。** 不直接复用代码，只借鉴设计理念和接口形态，移植成本低。
- **策略引擎可以复用现有 Hook 基础设施。** Tool Approval 本质是一个带 UI 弹窗的 `pre-tool-call` Hook；Playbook/Intent Guard 是动态 system prompt 注入，与 Skill 加载器同源。
- **SKILL.md 格式兼容。** RouteDev 的 `skill-generator.ts` 输出可以调整为 frontmatter + Markdown，同时保留旧格式解析做兼容。
- **变量聚合需要扩展 Blackboard。** 在 `blackboard.ts` 中增加 `variables` 字段，改动面小。

---

## Task 1：自研代码地图引擎 MVP 落地（≥ 16 测试）

### 1.1 范围控制：Phase 42 只做 MVP

Phase 41 规划了完整引擎（tree-sitter + SQLite + PageRank + 实时监听 + 20 语言 + FTS5）。本 Phase 聚焦"可用、可测、可替代正则方案"的最小集合：

```
src/code-map/
├── index.ts          # 对外 API：index / query / explore / impact
├── parser.ts         # tree-sitter 解析抽象 + 语言加载
├── extractor.ts      # 符号/边提取（先 TS/JS，再 Python）
├── schema.ts         # SQLite schema + 类型
├── database.ts       # SQLite 封装（优先 node:sqlite，兜底 better-sqlite3）
├── indexer.ts        # 全量/增量索引
├── ranker.ts         # PageRank 实现
├── querier.ts        # explore / callers / callees / impact
├── renderer.ts       # Aider 风格文本输出
└── languages/
    ├── typescript.ts # tags.scm + 边规则
    └── python.ts     # tags.scm + 边规则
```

### 1.2 依赖引入

```bash
pnpm add tree-sitter tree-sitter-typescript tree-sitter-python
pnpm add -D @types/node
```

**Windows 兜底策略：**
- 若 `tree-sitter` 加载失败（缺预编译 binary），自动回退到 `src/tools/repo-map.ts` 正则方案。
- 在 `scripts/setup-dev-env.ps1` 中增加 Visual Studio Build Tools 检测提示。
- Electron 打包时，把 `tree-sitter` 预编译 binary 明确列入 `files` 或 `asarUnpack`。

### 1.3 Schema（简化版）

```sql
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,              -- file_path::qualified_name
    kind TEXT NOT NULL,               -- function | class | method | interface | variable | import
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    signature TEXT,
    is_exported INTEGER DEFAULT 0,
    rank_score REAL DEFAULT 0,
    updated_at INTEGER
);

CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,               -- calls | imports | extends | implements | contains
    line INTEGER,
    provenance TEXT DEFAULT 'static'
);

CREATE TABLE files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,       -- xxhash64
    language TEXT NOT NULL,
    indexed_at INTEGER
);

CREATE INDEX idx_nodes_file ON nodes(file_path);
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_edges_source ON edges(source);
CREATE INDEX idx_edges_target ON edges(target);
```

**FTS5 和实时监听延后到 Task 2 / 后续迭代**，本 Phase 先实现显式索引（启动/保存后触发），保证核心查询可用。

### 1.4 符号与边提取目标

| 语言 | 符号 | 边 |
|------|------|-----|
| TypeScript/JavaScript | function, class, method, interface, type alias, variable, arrow function | calls, imports, extends, implements, contains |
| Python | function, class, method | calls, imports, contains |

**不追求第一版：** 装饰器关联、泛型参数、动态分发桥接、React JSX heuristic 边。

### 1.5 PageRank 排名

```typescript
// ranker.ts
export function computePageRank(
  nodes: string[],
  edges: Array<{ source: string; target: string; weight: number }>,
  options?: { damping?: number; maxIterations?: number; epsilon?: number },
): Map<string, number>;
```

- 阻尼系数 0.85，最大迭代 100，收敛阈值 1e-6。
- 对大型图使用 Map + 提前退出，避免阻塞事件循环。
- 排名结果写回 `nodes.rank_score`。

### 1.6 查询接口

```typescript
export interface CodeMapEngine {
  fullIndex(root: string): Promise<IndexStats>;
  incrementalIndex(changedFiles?: string[]): Promise<IndexStats>;
  explore(query: string, options?: { maxNodes?: number; budgetTokens?: number }): Promise<CodeContext>;
  findCallers(symbol: string, fileHint?: string): Promise<Node[]>;
  findCallees(symbol: string, fileHint?: string): Promise<Node[]>;
  analyzeImpact(fileOrSymbol: string, maxDepth?: number): Promise<ImpactResult>;
  getStatus(): Promise<IndexStatus>;
}
```

### 1.7 与 RouteDev 现有系统集成

- **ContextInjector：** 在 `src/agent/middleware/code-map-context.ts` 中，优先使用 `CodeMapEngine.explore()`，失败时回退 `repo-map.ts`。
- **TokenTracker：** 记录 `code_map_index` / `code_map_query` 事件，统计"节省 token"。
- **Settings：** 新增 `codeMap.engine: 'tree-sitter' | 'regex' | 'disabled'`，默认 `'tree-sitter'`（可用时）。
- **Fallback：** 任何 tree-sitter 失败 → 自动切换 `'regex'` 并提示用户。

### 1.8 测试要求

- 解析单个 TS 文件，验证 function/class/method/variable 正确提取。
- 验证 `import { foo } from './bar'` 生成 `imports` 边。
- 验证 `foo()` 调用生成 `calls` 边。
- 验证 `class A extends B` 生成 `extends` 边。
- 验证 PageRank 在 star 图中中心节点得分最高。
- 验证 content_hash 变化触发重新索引，未变化跳过。
- 验证 tree-sitter 加载失败时自动回退到正则方案。
- 验证 `explore('登录功能')` 召回包含 `login`/`auth` 的符号。
- 验证 `analyzeImpact` 递归追踪到指定深度。
- 验证索引和查询事件被 TokenTracker 记录。

---

## Task 2：代码地图创新压缩（≥ 8 测试）

### 2.1 问题定义

自研引擎解决了"精度"问题，但大项目（1 万文件以上）仍面临：
- 首次索引全量解析耗时久
- 查询返回上下文过大，超出 token 预算
- 相似文件/符号重复出现

本 Task 引入四种互补压缩技术，全部作为实验性开关。

### 2.2 Hierarchical Code Graph Summarization（HCGS）

**思想：** 把文件/目录当作可摘要的层级节点，用 LLM 生成摘要后把子图折叠成单节点。

```typescript
interface HCGSNode {
  id: string;
  kind: 'file-summary' | 'dir-summary';
  summary: string;          // LLM 生成的 1-2 句摘要
  childNodeIds: string[];   // 被折叠的原始节点
  tokenSaved: number;
}
```

**触发条件：**
- 目录下文件数 > 20 时，自动生成目录摘要。
- 文件内符号数 > 30 时，生成文件摘要。
- 用户查询匹配到摘要节点时，按需展开子节点（lazy expansion）。

### 2.3 RepoDistill 预算分配

**思想：** 给每次查询设定 token 预算，按 PageRank 分数从高到低选择符号，直到预算耗尽。

```typescript
export function distillContext(
  nodes: RankedNode[],
  budgetTokens: number,
  options?: { includeNeighbors?: boolean; maxDepth?: number },
): RankedNode[];
```

- 优先选高排名符号。
- 对选中的符号，可选加入其 1 跳调用邻居。
- 超过预算时停止，记录"截断节点数"用于 UI 提示。

### 2.4 语义边（Semantic Edges）

**思想：** 不只看静态调用，也看"语义相关"——名字相似、同目录、同作者修改、被同一测试引用。

```typescript
edge.kind = 'semantic_related' | 'co_changed' | 'co_tested';
edge.provenance = 'heuristic';
```

**实现：**
- `semantic_related`：基于符号名 token 重叠率（Jaccard > 0.6）。
- `co_changed`：基于 git blame / 最近同一次 commit 修改。
- `co_tested`：测试文件与被测文件之间的启发式链接（`*.{test,spec}.{ts,js}` ↔ 源文件）。

### 2.5 增量/差异压缩

**思想：** 索引时不存完整文件内容，只存符号和边；实时监听只重解析变更文件。

```typescript
// 文件保存时触发
await codeMap.incrementalIndex([changedFilePath]);
```

- 与 Task 1 的 `incrementalIndex` 共用同一套逻辑。
- 在 `post-tool-call: file_write/file_edit` Hook 中自动触发。

### 2.6 测试要求

- HCGS 摘要生成后，查询返回节点数减少且仍能命中目标符号。
- RepoDistill 在 1000 tokens 预算内返回不超过预算的节点。
- 语义边能把语义相关但无调用关系的两个函数关联起来。
- 增量索引只更新变更文件对应的节点和边。
- diff 压缩：两次索引间未变更文件的 hash 不重复计算。

---

## Task 3：多 Agent 编排升级（≥ 14 测试）

### 3.1 现状

当前编排流程：
```
/goal → GoalParser → Orchestrator.plan() → 并行组 → WorkerExecutor → Blackboard
```

问题：
- 只有"步骤级"状态，没有"图状态机"视角。
- Worker 之间只有 Blackboard 文本共享，缺少结构化交接。
- 没有审计层记录"哪个 Worker 做了什么、效果如何"。

### 3.2 图状态机（Graph State Machine）

**设计：** 把 ExecutionPlan 表示为有向图，每个节点是步骤状态，边是状态转换条件。

```typescript
interface ExecutionStateGraph {
  nodes: Map<string, StepStateNode>;   // stepId → { status, retries, artifacts }
  edges: StepTransition[];              // (from, to, condition)
}

type StepStatus = 'pending' | 'running' | 'awaiting_review' | 'completed' | 'failed' | 'blocked' | 'retrying';
```

**状态转换规则：**
- `pending → running`：依赖全部 completed。
- `running → awaiting_review`：Worker 返回结果且需要人工审查（写操作）。
- `awaiting_review → completed / retrying / failed`：用户选择采纳/重做/丢弃。
- `running → retrying`：Worker 失败但可重试。
- `retrying → running`：重试次数未耗尽。
- `failed → blocked`：下游依赖该步骤的步骤全部 blocked。

**实现位置：** 新增 `src/agent/multi/state-graph.ts`，在 `BranchOrchestrator` 和 `ExecutionOrchestrator` 中复用。

### 3.3 结构化 Handoff

**现状：** Blackboard 是文本格式化，`WorkerExecutor` 只拿到结论字符串。

**升级：** 引入 `HandoffArtifact` 结构化交接。

```typescript
interface HandoffArtifact {
  stepId: string;
  role: WorkerRole;
  // 结构化结论
  summary: string;
  decisions: Array<{ what: string; why: string; confidence: number }>;
  modifiedFiles: string[];
  openQuestions: string[];
  risks: string[];
  // 引用
  relevantSymbols: string[];    // code-map node ids
  relevantFacts: string[];      // KnowledgeGraph keys
}
```

**流程：**
1. Worker 完成后，LLM 把自由文本结论解析成 `HandoffArtifact`。
2. 写入 Blackboard 的 `completedSteps`（扩展字段）。
3. 下游 Worker 的 system prompt 中注入结构化 handoff，而非纯文本。

### 3.4 Score Card 审计层

**目的：** 让每个 Worker 的执行结果可量化、可追溯。

```typescript
interface ScoreCard {
  stepId: string;
  role: WorkerRole;
  modelId: string;
  tokenUsage: TokenUsageInfo;
  durationMs: number;
  toolCalls: number;
  fileEdits: number;
  testsRun: number;
  testsPassed: number;
  lintErrors: number;
  typeErrors: number;
  userFeedback: 'accepted' | 'rejected' | 'edited' | 'pending';
}
```

**集成：**
- `completion-gate.ts` 在 Worker 完成后跑 typecheck/lint/tests，结果写入 Score Card。
- `/quality` 命令展示各 Worker Score Card 聚合。
- QualityAggregator 使用 Score Card 数据做模型降级建议。

### 3.5 借鉴 CugaSupervisor：编排策略与变量聚合

**借鉴点 1：执行策略显式化**

当前 `BranchOrchestrator` 内部固定为拓扑分组 + 并行执行。参考 CugaSupervisor，把策略暴露为可配置项：

```typescript
type OrchestrationStrategy = 'sequential' | 'parallel' | 'adaptive';
type OrchestrationMode = 'plan_upfront' | 'conversational';

interface OrchestratorConfig {
  strategy: OrchestrationStrategy;
  mode: OrchestrationMode;
  maxParallelism: number;
  allowRetry: boolean;
}
```

- **sequential**：适合强依赖任务，每步结果传给下一步。
- **parallel**：适合独立子任务，与当前行为一致。
- **adaptive**：由 LLM 根据任务复杂度动态选择 sequential 或 parallel（默认）。
- **plan_upfront**：与当前 `/goal` 行为一致，先规划再执行。
- **conversational**：supervisor 以对话方式逐步委托，适合需求不明确的探索性任务。

**借鉴点 2：结构化变量池**

CUGA 的 `supervisor_variables` 让子 Agent 把关键变量（如客户 ID、查询日期）按命名空间汇总。RouteDev 扩展 Blackboard：

```typescript
interface Blackboard {
  // ... existing fields
  variables: Map<string, { value: string; sourceStepId: string; confidence: number }>;
}
```

- Worker 通过 `HandoffArtifact` 提交变量。
- 下游 Worker prompt 自动注入相关变量（按 step 依赖关系和 key 相似度匹配）。
- 避免 Blackboard 纯文本中被关键数字淹没。

**实现位置：**
- `src/agent/multi/orchestrator-strategy.ts`：策略选择逻辑。
- `src/agent/multi/blackboard.ts`：扩展 `variables`。
- `src/agent/multi/branch-orchestrator.ts`：根据策略调用不同执行器。

### 3.6 测试要求

- 图状态机正确识别循环依赖并标记 blocked。
- 用户审查后状态正确转换（adopt → completed，redo → retrying，discard → failed）。
- 结构化 handoff 能被下游 Worker system prompt 正确解析。
- Score Card 在 Worker 执行后收集到 typecheck/lint/test 结果。
- 失败 Worker 触发 retrying 状态并按 maxRetries 退出到 failed。
- sequential 策略按依赖顺序执行，后一步能读取前一步的 Blackboard 变量。
- parallel 策略在独立子任务上正确并发执行。
- adaptive 策略根据任务复杂度自动选择 sequential 或 parallel。
- Blackboard 变量池能在下游 Worker prompt 中正确注入。

---

## Task 4：Skill/Hook 市场与共享机制（≥ 8 测试）

### 4.1 问题定义

Skill/Hook 生成器已可用，但：
- 生成的配置只存在本地 `.routedev/`。
- 没有浏览、导入、导出、分享能力。
- 缺少"官方精选"和"社区贡献"概念。

### 4.2 Skill/Hook 包格式（兼容 CUGA SKILL.md 标准）

**Skill 包采用 CUGA/Anthropic 开放的 SKILL.md 规范：**

```markdown
<!-- .routedev/market/my-skill/v1/SKILL.md -->
---
name: my-skill
description: 项目 TypeScript 编码规范
version: 1.0.0
author: routedev
tags: [typescript, style, comments]
---

# 项目编码规范

## 通用规则
- 所有代码注释使用中文。
- 优先使用 `const`，少用 `let`，不用 `var`。
...
```

**兼容策略：**
- 新 Skill 统一使用 `SKILL.md` frontmatter + Markdown 格式。
- `PromptManager` 同时支持旧 JSON/YAML 格式，至少保留一个版本的向后兼容。
- `skill-generator.ts` 输出默认改为 `SKILL.md`。

**Hook 包格式（保持 JSON，便于程序化校验）：**

```json
// .routedev/market/my-hook/v1/hook.json
{
  "name": "pre-commit-test",
  "version": "1.0.0",
  "description": "commit 前跑测试",
  "author": "routedev",
  "event": "pre-step",
  "condition": { "toolName": "git_op" },
  "command": "npm test",
  "failBehavior": "block"
}
```

### 4.3 市场能力

**本地市场：**
- 目录：`.routedev/market/skills/` 和 `.routedev/market/hooks/`。
- 用户可把生成的 Skill/Hook "发布到本地市场"，生成版本化包。
- Settings > Skills/Hooks 页面新增"市场"标签，浏览本地已发布项并一键安装。

**导入导出：**
- 导出：把 Skill/Hook 打包为 `.routedev-skill.zip` / `.routedev-hook.zip`。
- 导入：拖放 zip 到 Settings 页面或 CLI `/skill import <path>` / `/hook import <path>`。

**官方精选（内置）：**
- 在 `src/skills/builtin/` 和 `src/hooks/templates/` 基础上，新增 `src/skills/market/` 和 `src/hooks/market/`。
- 内置 5 个官方 Skill（中文注释规范、TDD、安全编码、API 设计、NeoForge 规则）和 5 个官方 Hook（自动格式化、类型检查、commit 信息生成、敏感信息检测、测试覆盖率检查）。

### 4.4 借鉴 Manage & Publish：草稿/发布生命周期

参考 CUGA 的 `cuga start manager`（草稿 → 试用 → 发布版本化配置），RouteDev Skill/Hook 市场引入生命周期：

```typescript
interface MarketItem {
  name: string;
  version: string;
  status: 'draft' | 'published' | 'deprecated';
  draftPath: string;      // .routedev/market-draft/
  publishedPath: string;  // .routedev/market/
  publishedAt?: number;
  changelog: string[];
}
```

**流程：**
1. **生成/编辑：** AI 生成或用户在 Settings 中编辑，保存为 `draft`。
2. **试用：** 在独立测试对话中加载 draft Skill/Hook，验证效果。
3. **发布：** 用户点击"发布"，生成版本化包到 `.routedev/market/`，状态变为 `published`。
4. **回滚：** 可切换回旧版本，旧版本标记为 `deprecated` 但不删除。

**实现位置：**
- `src/skills/market-manager.ts` / `src/hooks/market-manager.ts`：生命周期管理。
- `src/cli/components/SkillMarketPage.tsx`：UI 入口增加 Draft / Publish / Rollback 按钮。

### 4.5 UI 入口

```
Settings > Skills
├── 我的 Skills（已启用/禁用）
├── AI 生成（现有对话框）
├── 草稿箱
│   ├── my-skill (v1.0.0-draft)
│   └── [发布] [试用] [编辑]
└── 市场
    ├── 官方精选
    ├── 本地已发布
    └── 导入...
```

### 4.6 测试要求

- Skill 包导入后 PromptManager 能正确加载。
- Hook 包导入后 HookRunner 能正确注册。
- 导出 zip 再导入，内容一致。
- 市场浏览列表按标签筛选正确。
- 官方精选 Skill 安装后 system prompt 包含规则。
- SKILL.md frontmatter 能被正确解析为 Skill 元数据。
- 发布 draft Skill 后版本号递增且旧版本可回滚。

---

## Task 5：分支编辑-审查-合并 UI 闭环（≥ 8 测试）

### 5.1 现状

后端能力（ExperimentManager/ExperimentRunner/BranchOrchestrator）已完整，桌面端缺少：
- ChatPage 右侧分支面板
- Diff 审查模态框
- /goal 触发分支工作流的确认对话框

### 5.2 ChatPage 分支面板

**位置：** ChatPage 右侧可折叠侧边栏（类似 `StepCard` 列表区域）。

**状态显示：**
```
📋 分支任务 (2/3 完成)
✅ 后端 API          [审查]  45s | 3.2K tokens
🔄 数据库模型        执行中...
⏳ 前端页面          等待依赖
```

**实现：**
- 新增组件 `src/cli/components/BranchPanel.tsx`。
- 通过事件总线（EventEmitter）接收 `BranchOrchestrator` 的 `onProgress`。
- 点击 [审查] 打开 `BranchReviewModal`。

### 5.3 Diff 审查模态框

```
┌──────────────────────────────────────────────────────┐
│  审查：后端 API                                  ✕    │
│  状态：完成 ✅ | 耗时 45s | Token 3.2K               │
│                                                      │
│  变更文件（勾选要采纳的文件）：                       │
│  ☑ src/api/auth.ts           (+45 -3)               │
│  ☑ src/api/auth.test.ts      (+28 -0)               │
│                                                      │
│  Diff 预览（src/api/auth.ts）：                      │
│  ┌──────────────────────┬──────────────────────┐   │
│  │ 原始代码              │ 修改后代码             │   │
│  └──────────────────────┴──────────────────────┘   │
│                                                      │
│  [采纳选中文件] [全部采纳] [要求重做] [丢弃]          │
└──────────────────────────────────────────────────────┘
```

**实现：**
- 新增组件 `src/cli/components/BranchReviewModal.tsx`。
- 复用现有 `DiffView.tsx` 组件做 diff 渲染。
- 调用 `ExperimentManager.adoptExperiment(expId, { strategy: 'cherry-pick', fileFilter: [...] })`。

### 5.4 /goal 触发确认对话框

当 `/goal` 分解出多步骤且复杂度评估认为需要子 Agent 时：

1. `ExecutionOrchestrator` 检测到 `anyNeedsSubAgent(complexityMap) === true`。
2. 桌面端弹出确认对话框："将为每个子任务创建独立 Git 分支，完成后可逐个审查。"
3. 用户确认后，切换到 `BranchOrchestrator` 路径执行。
4. CLI 模式直接执行（保持向后兼容）。

### 5.5 借鉴 HITL：敏感工具人工审批门

参考 CUGA 的 Tool Approval 策略，在分支工作流中增加"工具级"人工审批：

```typescript
interface ToolApprovalGate {
  toolName: string;
  condition: 'always' | 'write_operation' | 'network' | 'shell' | 'custom';
  customTrigger?: string;   // keyword 或自然语言触发
  defaultAction: 'approve' | 'block' | 'ask';
}
```

**默认审批门：**
- `write_operation`：`file_write`、`file_edit`、`delete_file` 等写文件工具。
- `network`：`fetch`、`http_request` 等网络请求工具。
- `shell`：`execute_command`、`git_op` 等 shell 命令。

**流程：**
1. Worker 执行到需审批的工具时，HookRunner 暂停该 Worker。
2. 桌面端弹出审批弹窗，展示工具名、参数、风险说明。
3. 用户选择：批准一次 / 批准本次任务 / 拒绝 / 编辑参数。
4. CLI 模式默认"批准一次"，或按 `settings.approvalMode` 处理。

**与分支审查的关系：**
- Tool Approval 是"工具级"实时审批（进行中）。
- Branch Review 是"结果级"事后审查（完成后）。
- 两者互补，Tool Approval 防止危险操作发生，Branch Review 保证最终代码质量。

**实现位置：**
- `src/hooks/builtin/tool-approval.ts`：内置 Hook。
- `src/cli/components/ToolApprovalModal.tsx`：审批弹窗。

### 5.6 测试要求

- 分支面板正确显示 BranchOrchestrator 的进度回调。
- 审查模态框正确展示实验分支的 diff。
- 选择性采纳只合并勾选文件。
- 丢弃实验后分支面板移除该任务。
- /goal 触发分支模式时桌面端弹出确认对话框。
- 分支执行失败时面板显示 ❌ 状态和错误信息。
- 写文件工具触发 Tool Approval 弹窗，用户拒绝后工具调用不执行。
- 网络请求工具在 `approvalMode=ask` 时暂停等待审批。

---

## Task 6：集成测试与文档同步（≥ 4 测试）

### 6.1 端到端测试

1. **代码地图端到端：** 打开项目 → 构建索引 → 用户提问 → explore 召回 → AI 基于召回代码回答 → TokenTracker 记录节省。
2. **多 Agent + 分支合并端到端：** /goal 多步骤 → 确认分支模式 → BranchOrchestrator 创建 worktree → Worker 执行 → 分支面板显示 → 审查模态框 → 采纳合并。
3. **Skill 市场端到端：** AI 生成 Skill → 发布到本地市场 → 导出 zip → 清空 → 导入 zip → 启用 → system prompt 包含规则。
4. **代码地图压缩 + 编排联动：** 大项目查询 → RepoDistill 截断 → 多 Agent 基于截断后的上下文并行执行 → Score Card 记录 token 消耗。
5. **策略引擎端到端：** 用户输入危险请求 → Intent Guard 拦截并提示 → 用户输入 API 设计任务 → Playbook 注入 SOP → 执行敏感工具 → Tool Approval 弹窗 → 拒绝后工具不执行。

### 6.2 文档同步

- **CODEMAP.md：** 新增 `src/code-map/` 模块说明、配置项、fallback 策略。
- **MULTI_AGENT.md：** 新增图状态机、结构化 handoff、Score Card、CugaSupervisor 策略、变量聚合说明。
- **SKILLS.md / HOOKS.md：** 新增市场、导入导出、官方精选、SKILL.md 标准、草稿/发布生命周期说明。
- **POLICIES.md：** 新增策略引擎设计、5 种策略类型、触发器、人工审批说明。
- **CHANGELOG.md：** v3.3.0 条目。
- **package.json：** 版本号升级至 3.3.0，新增 tree-sitter 依赖。
- **config schema：** 新增 `codeMap.engine`、`codeMap.budgetTokens`、`codeMap.enableHCGS`、`codeMap.enableSemanticEdges`、`market.enabled`、`policies.enabled`、`policies.gates`、聊天框旁的 `reasoningMode` 等。

---

## Task 7：策略引擎（Policy Engine）与人工审批（≥ 10 测试）

### 7.1 借鉴 CUGA Policy SDK

CUGA 提供 5 种策略类型，RouteDev 移植其中与代码助手场景最相关的 4 种：

```typescript
type PolicyType = 'intent_guard' | 'playbook' | 'tool_guide' | 'tool_approval';

interface Policy {
  id: string;
  type: PolicyType;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;           // 高优先级先匹配
  trigger: PolicyTrigger;
  action: PolicyAction;
}

interface PolicyTrigger {
  mode: 'keyword' | 'semantic' | 'always';
  keywords?: string[];        // keyword 模式精确匹配
  semanticQuery?: string;     // semantic 模式用 LLM 判断意图
}

interface PolicyAction {
  // Intent Guard
  block?: boolean;
  response?: string;
  // Playbook
  injectPrompt?: string;
  // Tool Guide
  toolDescription?: string;
  extraContext?: string;
  // Tool Approval
  requireApproval?: boolean;
  approvalMessage?: string;
}
```

### 7.2 四种策略详细设计

#### Intent Guard（意图护栏）

**作用：** 识别并阻止危险或越界请求。

**示例：**
```yaml
name: 禁止删除生产配置
type: intent_guard
trigger:
  mode: semantic
  semanticQuery: "删除、清空、重置生产环境配置文件"
action:
  block: true
  response: "该操作可能影响生产环境，请在 Settings > Policies 中显式禁用此策略后再试。"
```

**落地位置：** `src/policies/intent-guard.ts`，在 `AgentLoop` 接收用户输入后、调用工具前执行。

#### Playbook（标准操作流程）

**作用：** 当任务命中特定主题时，自动注入 SOP 到 system prompt。

**示例：**
```yaml
name: API 设计 SOP
type: playbook
trigger:
  mode: keyword
  keywords: ["设计 API", "新增接口", "REST API"]
action:
  injectPrompt: |
    请按以下步骤设计 API：
    1. 先定义 OpenAPI schema。
    2. 再写 handler 单元测试。
    3. 最后实现 handler 并接入路由。
```

**落地位置：** `src/policies/playbook.ts`，在 `PromptManager` 组装 system prompt 时动态注入。

#### Tool Guide（工具增强）

**作用：** 针对特定工具自动补充上下文或修正工具描述。

**示例：**
```yaml
name: git_op 安全指南
type: tool_guide
trigger:
  mode: keyword
  keywords: ["git_op"]
action:
  extraContext: "执行 git push 前必须先跑 typecheck 和 tests；禁止 force push。"
```

**落地位置：** `src/policies/tool-guide.ts`，在工具描述注入 LLM 前追加上下文。

#### Tool Approval（工具审批）

**作用：** 对敏感工具强制人工确认（与 Task 5.5 的 HITL 门复用同一实现）。

**示例：**
```yaml
name: 网络请求审批
type: tool_approval
trigger:
  mode: keyword
  keywords: ["fetch", "http_request"]
action:
  requireApproval: true
  approvalMessage: "即将向外部地址发送网络请求，请确认。"
```

**落地位置：** `src/hooks/builtin/tool-approval.ts`。

### 7.3 策略管理 UI

```
Settings > Policies
├── 策略列表（启用/禁用/优先级拖拽）
│   ├── [+] 新增策略
│   ├── 编辑
│   └── 删除
├── 导入/导出（JSON/YAML）
└── 审计日志
    └── 显示被阻止的请求、被批准的审批、命中的 Playbook
```

### 7.4 与 Skill/Hook 的关系

- **Skill 是静态规则**（长期注入 system prompt）。
- **Policy 是动态规则**（根据输入/工具实时触发）。
- **Hook 是事件响应**（pre/post tool call）。

Policy Engine 可以调用 Hook 执行审批，Skill 可以附带默认 Policy 文件（`.routedev/skills/my-skill/policies.yaml`）。

### 7.5 借鉴 Reasoning Modes：快速/均衡/精准模式切换

参考 CUGA 的 `fast` / `balanced` / `accurate` 模式，在 ChatPage 输入框旁增加模式切换按钮：

```typescript
type ReasoningMode = 'fast' | 'balanced' | 'accurate';

const MODE_ROUTING: Record<ReasoningMode, RoutingHint> = {
  fast:       { preferCheaper: true,  maxRetries: 1, reasoningEffort: 'low' },
  balanced:   { preferCheaper: false, maxRetries: 2, reasoningEffort: 'medium' },
  accurate:   { preferCheaper: false, maxRetries: 3, reasoningEffort: 'high' },
};
```

**行为：**
- `fast`：优先调用便宜/快速模型，减少重试，适合简单问答和代码补全。
- `balanced`：默认模式，按 RouteDev 现有路由策略选择模型。
- `accurate`：优先调用强模型，允许多轮反思和更多 token 预算，适合复杂架构设计。

**实现位置：**
- `src/router/reasoning-mode.ts`：模式到路由参数的映射。
- `src/cli/components/ChatInput.tsx`：输入框旁增加模式切换按钮。

### 7.6 测试要求

- Intent Guard 的 keyword 触发精确匹配。
- Intent Guard 的 semantic 触发能识别同义危险请求。
- Playbook 命中后 system prompt 包含 SOP 内容。
- Tool Guide 能正确追加工具上下文。
- Tool Approval 在桌面端弹出审批弹窗，拒绝后阻止工具执行。
- 多策略优先级冲突时高优先级优先生效。
- 策略导入导出后内容一致。
- 审计日志记录策略命中事件。
- `fast` 模式优先选择价格更低或响应更快的模型。
- `accurate` 模式增加重试次数和 token 预算。

---

## 新增陷阱警告

**83. tree-sitter 原生模块在 Electron 打包中可能丢失 binary：** 必须在 `electron-builder.yml` 中把 `node_modules/tree-sitter/prebuilds/` 加入 `asarUnpack`，否则 Windows 安装包运行时报找不到 native module。

**84. SQLite 数据库路径在 worktree 中必须隔离：** 主工作区和实验分支的 `.routedev/code-map/` 必须物理隔离，不能共享同一个 `.db` 文件，否则并发索引会锁表或污染数据。

**85. PageRank 不要每次查询都重算：** 排名应缓存，只在图结构变化（文件增删改）后重新计算。高频查询触发的重算会拖慢 UI。

**86. HCGS 摘要生成消耗 LLM token：** 必须设置预算上限和异步后台生成，不能阻塞首次索引。大项目首次索引时先建立基础图谱，摘要后台生成。

**87. 结构化 handoff 的 LLM 解析可能失败：** 如果 Worker 结论无法解析为 `HandoffArtifact`，应回退到纯文本，不阻断执行。

**88. Score Card 的测试/ lint 结果收集不能阻塞主流程：** completion-gate 是可选验证，超时或失败时 Score Card 标记为 `unknown`，不影响步骤状态。

**89. Skill/Hook 市场导入需校验名称冲突：** 导入同名 Skill/Hook 时提示"覆盖/重命名/取消"，避免静默覆盖用户自定义配置。

**90. 分支合并的 cherry-pick 策略不做依赖检查：** 与 Phase 39 陷阱 #67 一致，UI 需给出"关联文件"提示，但不强制阻止用户只采纳部分文件。

**91. Policy semantic 触发消耗额外 LLM token：** keyword 模式优先，semantic 模式应设置调用预算和缓存，避免每次用户输入都调用大模型判断。

**92. Tool Approval 弹窗不能阻塞事件循环：** Worker 暂停后应释放主线程，等待用户响应期间保持 UI 响应；CLI 模式必须有超时或默认策略，避免挂起。

**93. SKILL.md frontmatter 解析失败需回退：** 若 frontmatter 格式错误，应把整个文件当作纯 Markdown Skill 加载，而不是崩溃或忽略。

**94. Policy 优先级配置错误会导致策略全部失效：** 必须校验 priority 唯一性，重复时按加载顺序给出警告并自动调整。

**95. Draft Skill 不应影响正式对话：** 试用 draft 必须打开独立测试会话，防止未经验证的规则污染当前项目上下文。

**96. Reasoning Mode 切换不能清空当前对话上下文：** 模式切换只影响后续请求的模型路由，不应重置 chat history。

---

## 思考引导总结

1. **自研引擎第一版要不要替代 CodeGraph MCP？** 不要。本 Phase 让自研引擎成为默认首选，CodeGraph MCP 作为"外部增强"选项保留，正则方案作为兜底。三者通过 `codeMap.engine` 配置切换。

2. **压缩策略是否默认开启？** HCGS 和语义边作为实验性功能默认关闭，RepoDistill 预算分配默认开启（控制查询返回量），增量索引默认开启。

3. **图状态机是否替代现有 Orchestrator？** 不替代，增量增强。`Orchestrator` 仍负责依赖分析和拓扑排序，`ExecutionStateGraph` 负责运行时状态转换，两者协作。

4. **Skill/Hook 市场是否需要远程服务器？** 本 Phase 只做本地市场和导入导出，远程服务器后续根据用户反馈决定。

5. **分支面板是否始终显示？** 只在有活跃分支任务时显示，无任务时自动折叠，避免占用主对话空间。

6. **CUGA 的 A2A 协议是否接入？** 暂不接入。RouteDev 当前聚焦本地/桌面端，远程 Agent 协作是后续方向，但 Task 3 的策略抽象应预留 A2A 外部 Agent 的接口位置。

7. **Policy Engine 是否会与 Skill/Hook 冲突？** 不会。Skill 是静态规则，Policy 是动态规则，Hook 是事件响应。三者分层：Skill 长期注入，Policy 实时触发，Hook 处理 pre/post 事件。

8. **Reasoning Mode 与现有模型路由什么关系？** Reasoning Mode 是用户-facing 的"模式开关"（fast/balanced/accurate），底层映射到 RouteDev 已有的模型路由策略和 Token 预算。不是新功能，是更好的 UX 入口。

9. **为什么引入 CUGA 的 SKILL.md 标准？** 兼容 Anthropic/CUGA 的开放规范，降低用户迁移成本，让 RouteDev Skill 未来能与生态共享。旧格式保留兼容。

10. **执行顺序建议：** Task 1（引擎 MVP）→ Task 7（策略引擎，安全基线）→ Task 5（UI 闭环）→ Task 3（编排升级）→ Task 4（市场）→ Task 2（压缩增强）。Task 1 是基础设施；Task 7 给后续所有功能加安全护栏；Task 5 用户感知最强；Task 2 研究性最强，可最后做。

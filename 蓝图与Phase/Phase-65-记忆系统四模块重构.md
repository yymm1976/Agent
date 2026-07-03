# Phase 65 — 记忆系统四模块重构

> **版本目标：** v4.6.4
> **前置依赖：** Phase 64（组合技能 SAD 迭代分解）完成，复用其 Bi-encoder 检索基础设施
> **后继依赖：** 无（本 Phase 是记忆系统独立重构，可与 Phase 66-68 并行）
> **新增测试要求：** ≥ 45 个
> **研究依据：** 精读 arXiv:2606.24775《Are We Ready For An Agent-Native Memory System?》（上海交大 + 清华 + MemTensor，2026-06-23）全文，代码开源在 https://github.com/OpenDataBox/MemoryData 。论文提出四模块分析框架：**M1 记忆表示与存储**（Token 序列/图树拓扑/异构复合；瞬态上下文/单引擎/多引擎）、**M2 记忆抽取**（原始拼接/无模式/模式约束——LLM Topic/三元组/实体关系）、**M3 记忆检索与路由**（原生注意力/语义/拓扑子图/Agent 路由/多阶段混合）、**M4 记忆维护**（时间戳多版本/容量驱动淘汰/LLM 驱动语义合并）。评测 12 个系统（MemoChat/Mem0/Mem0^g/Zep/Cognee/MemTree/LightMem/A-MEM/Letta(MemGPT)/MemOS(MemoryOS)/MEM1(MemAgent)）。**核心发现**：(1) 没有单一架构通吃——复合混合在对话 QA 领先，图基擅长单跳事实但时序推理弱；(2) 检索精度随时间距离显著退化（纯相似度检索的根本局限）；(3) 图基方法处理知识更新最可靠（Zep/Mem0^g/Cognee），纯追加存储返回过期事实导致"过去幻觉"；(4) 高结构化系统延迟极高（Cognee 155s、Zep 116s vs 轻量局部维护秒级）——精度提升不成正比；(5) 局部维护比全局重组更 cost-efficient。**关键警告（反模式）**：覆盖式维护导致"过去幻觉"；摘要破坏时序线索——对时间依赖查询，原始长上下文检索仍优于大多数记忆方法；精细抽取损害多跳推理（同一系统"快速记忆"25.5 分 vs "细记忆"2.5 分）；**写入端"晚过滤"原则——别在写入时激进裁剪，保住原文比"更抽象、更分层"更重要**。
> **核心命题：** RouteDev 的记忆系统当前是**纯文件 + grep 检索 + 覆盖式维护**——[project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 把 MEMORY.md/decisions.log/context.md 当文本文件读写，检索靠关键词匹配，更新直接覆盖。这正是论文警告的"过去幻觉"与"时序线索破坏"反模式。Phase 65 按论文四模块框架重构：M1 用 SQLite + 向量索引替代纯文件、M2 改会话末尾抽取为 compose-pipeline 每阶段增量抽取、M3 用 embedding kNN + BM25 混合检索替代 grep、M4 用 valid_from/superseded_at 时间戳多版本替代覆盖、被拒替代保留、成本感知局部维护。所有改动紧扣论文"晚过滤 + 保原文 + 局部维护"三原则。

---

## 项目现状审计与可行性结论

### 1. 论文四模块与 RouteDev 缺口的映射

| 论文模块 | 核心 Contribution / 反模式 | RouteDev 现状缺口 | Phase 65 Task |
|---------------|-------------------|-------------------|---------------|
| M1 存储分离 | 复合混合（图+向量+原文）领先；纯文件无结构 | [project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 纯 .md/.log 文件，无 SQLite/向量索引 | Task 1（SQLite + 向量索引） |
| M2 增量抽取 | 模式约束（LLM Topic/三元组）优于无模式；写入端晚过滤 | 抽取集中在会话末尾，compose-pipeline 每阶段无增量抽取钩子 | Task 2（每阶段增量抽取） |
| M3 混合检索 | 检索精度随时间距离退化；纯相似度根本局限 | 检索靠关键词匹配（grep 式），无 embedding kNN + BM25 混合 | Task 3（混合检索） |
| M4 保守合并 | 覆盖式→"过去幻觉"；时间戳多版本最可靠 | graph.ts 已有 supersededBy/validUntil 雏形，但 project-memory 直接覆盖 | Task 4（时间戳多版本） |
| 被拒替代保留 | 论文未直接涉及，但"晚过滤 + 保原文"原则延伸 | CrossModelReviewer 否决的方案丢弃，无 rejected alternative 留存 | Task 5（被拒替代保留） |
| 局部维护 | 局部维护比全局重组 cost-efficient；高结构化延迟极高（Cognee 155s） | topics 超阈值时无局部重组策略，要么不维护要么全量重写 | Task 6（成本感知局部维护） |
| 评测指标 | 证据级检索保真度 / 时序更新鲁棒性 | 无记忆系统自评指标 | Task 7（评测指标） |

### 2. 可行性总评

- **Task 1（M1 SQLite + 向量索引）：** 高度可行。Node 内置 `node:sqlite`（Node 22+）或 `better-sqlite3`；向量索引复用 Phase 64 的 Bi-encoder embedding + 内存内积（记忆条目 <10K 规模足够）。纯文件作为冷备份保留，热查询走 SQLite。
- **Task 2（M2 增量抽取）：** 可行。[compose-pipeline.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/compose-pipeline.ts) 的 `evaluateAdvance` / `advance` 已是阶段切换钩子，插入增量抽取调用即可。模式约束用 LLM Topic 抽取（轻量，避免 Cognee 式 155s 延迟）。
- **Task 3（M3 混合检索）：** 可行。复用 Phase 64 的 `BiEncoderSkillRetriever` embedding 基础设施；BM25 用纯 TS 实现（tokenize + IDF + TF）。混合分数 = α×BM25 + (1-α)×embedding cosine。
- **Task 4（M4 时间戳多版本）：** 高度可行。[graph.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/graph.ts) 已有 `supersededBy`/`validUntil`/时间衰减字段，扩展到 project-memory 即可。论文警告"覆盖式→过去幻觉"，本 Task 严格不覆盖。
- **Task 5（被拒替代保留）：** 可行。在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 否决路径增加 `rejectedAlternative` 落库，可检索但标记 `rejected`。
- **Task 6（成本感知局部维护）：** 可行。topics 超阈值时只重组最旧/最少访问部分，避免全局重组高延迟。复用 [consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts) 的归纳逻辑但限定范围。
- **Task 7（配置收口 + 评测指标）：** 高度可行。遵循 Phase 51 反写死原则；评测指标含证据级检索保真度与时序更新鲁棒性。

---

## 核心设计原则

### 原则 1：写入端晚过滤，保原文优先于抽象

论文明确警告：写入端"晚过滤"原则——别在写入时激进裁剪；保住原文比"更抽象、更分层"更重要。同一系统"快速记忆"25.5 分 vs "细记忆"2.5 分（精细抽取损害多跳推理）。Phase 65 的 M2 抽取必须**同时保存原文与抽取结果**，检索时优先返回原文片段，抽取结果仅作索引用。

### 原则 2：保守合并 + 时间戳多版本，禁止覆盖

论文核心警告：覆盖式维护导致"过去幻觉"——纯追加存储返回过期事实。图基方法（Zep/Mem0^g/Cognee）因显式 supersede 关系处理知识更新最可靠。Phase 65 的 M4 必须用 `valid_from`/`superseded_at` 时间戳多版本，新旧知识共存，旧知识标记 superseded 但不删除（保留时序线索）。

### 原则 3：局部维护优先于全局重组

论文发现高结构化系统延迟极高（Cognee 155s、Zep 116s），精度提升不成正比；局部维护比全局重组更 cost-efficient。Phase 65 的 Task 6 必须按"最旧/最少访问"局部重组，避免全量重写。

### 原则 4：混合检索对抗时间距离退化

论文发现检索精度随时间距离显著退化（纯相似度检索的根本局限）。Phase 65 的 M3 必须用 embedding kNN + BM25 混合检索，BM25 提供精确词项匹配锚点，embedding 提供语义泛化，二者互补。

### 原则 5：反写死与 Fail-open（延续 Phase 51/64）

所有新增能力（SQLite / 增量抽取 / 混合检索 / 多版本 / 被拒保留 / 局部维护）必须有配置开关、设置页面入口。默认关闭，纯文件路径作为降级保留。SQLite 不可用时降级纯文件，embedding 不可用时降级 BM25。

### 原则 6：死代码防护与执行人自审（延续 Phase 51/53）

**死代码零容忍**：本 Phase 新增的每个类、函数、配置字段、接口必须有明确的消费方（调用点或读取点）。

**执行人自审硬性要求**（每个 Task 完成后必须执行，未通过不得提交）：

1. **新增模块消费验证**：用 `rtk grep` 搜索新增类/函数名，确认至少有一个调用点（测试文件除外）
2. **配置字段消费验证**：新增的每个 zod schema 字段，必须确认有读取方（`rtk grep` 字段名确认非零引用）
3. **导出必要性验证**：新增的 `export` 必须有外部消费者；同文件内使用的 schema 用 `const` 而非 `export const`（延续 Phase 53 类型清理）
4. **knip 扫描**：Task 完成后运行 `npx knip`，新增文件不得出现在"未引用"列表中（动态 import 接线的 policy 文件除外，需在自审报告中说明）
5. **自审报告**：每个 Task 的最后一个 Step 必须是"死代码自审"，在提交信息中附自审结论（如"knip 通过，新增 5 个 export 均有消费方"）

**禁止**：
- 禁止新增"未来可能用到"的配置字段（YAGNI）
- 禁止新增未被调用的工具函数
- 禁止 export 仅供同文件使用的常量/类型

---

## Task 1：M1 存储分离——SQLite + 向量索引替代纯文件（≥ 8 测试）

### 1.1 论文借鉴

论文 M1 模块分析框架：记忆表示分 Token 序列/图树拓扑/异构复合；存储分瞬态上下文/单引擎/多引擎。评测结论：复合混合（图+向量+原文）在对话 QA 领先，纯文件无结构最差。RouteDev 的 [project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 当前把 MEMORY.md/decisions.log/context.md 当纯文本文件读写，无结构化存储与向量索引。

### 1.2 设计

新增 `MemoryStore`（SQLite 后端，纯文件降级）：

```ts
// src/memory/memory-store.ts
import type { SkillMetadata } from '../skills/skill-md-parser.js';

/**
 * 记忆存储引擎（M1）
 *
 * 论文：复合混合（图+向量+原文）领先；纯文件无结构最差
 * RouteDev 落地：
 *   - SQLite 主存储（node:sqlite 或 better-sqlite3），结构化查询
 *   - 向量索引：复用 Phase 64 Bi-encoder embedding，内存内积（<10K 规模）
 *   - 纯文件冷备份：MEMORY.md/decisions.log 仍写，作为降级与可读性保留
 *   - 三表设计：memories（原文+元数据）、memory_versions（多版本）、memory_embeddings（向量）
 */
export class MemoryStore {
  private db: Database | null = null;
  private embeddings = new Map<string, number[]>(); // memoryId → embedding
  private readonly embedder: Embedder | null;

  constructor(private readonly config: {
    enabled: boolean;
    dbPath: string;          // 默认 '.routedev/memory.db'
    backend: 'sqlite' | 'file'; // 默认 'sqlite'，降级 'file'
    embeddingProvider: 'bi-encoder' | 'hash' | 'none';
  }) {}

  /** 初始化（建表 / 加载已有数据） */
  async initialize(): Promise<void>;

  /** 写入一条记忆（含原文 + 元数据 + 可选 embedding） */
  async write(entry: MemoryEntry): Promise<string /* memoryId */>;

  /** 按 ID 读取（含版本历史） */
  async read(memoryId: string): Promise<MemoryEntry | null>;

  /** 全文搜索（BM25 由 Task 3 实现，此处提供 LIKE 降级） */
  async searchFullText(query: string, limit: number): Promise<MemoryEntry[]>;

  /** 向量搜索（kNN 内积，由 Task 3 调用） */
  async searchVector(queryEmbedding: number[], limit: number): Promise<MemoryEntry[]>;

  /** 关闭并持久化 */
  async close(): Promise<void>;
}

/** 记忆条目（M1 表示） */
export interface MemoryEntry {
  id?: string;
  /** 原文（论文：保原文优先于抽象） */
  content: string;
  /** 类型 */
  type: 'fact' | 'decision' | 'error_fix' | 'topic' | 'rejected_alternative';
  /** 来源（compose 阶段 / 工具 / 用户） */
  source: string;
  /** 时间戳（M4 多版本用） */
  validFrom: number;
  supersededAt?: number;
  /** 元数据 */
  metadata?: Record<string, string>;
  /** 关联主题（Task 6 局部维护用） */
  topics?: string[];
}
```

**表结构**：
- `memories(id TEXT PK, content TEXT, type TEXT, source TEXT, valid_from INT, superseded_at INT, metadata JSON, topics JSON)`
- `memory_versions(memory_id TEXT, version INT, content TEXT, valid_from INT, superseded_at INT)`（Task 4 用）
- `memory_embeddings(memory_id TEXT PK, embedding BLOB)`（向量序列化）

### 1.3 接线点

- 新增：`src/memory/memory-store.ts`
- 修改：`src/memory/project-memory.ts` — `MemoryStore` 启用时，写操作同时落 SQLite 与文件（双写降级）；读操作优先 SQLite
- 复用：Phase 64 的 `Embedder` 接口（`src/skills/embedder.ts`）
- 依赖：`node:sqlite`（Node 22+ 内置）或 `better-sqlite3`（package.json 按需）

### 1.4 Step 分解

- [ ] **Step 1: 选择 SQLite 驱动与建表**

优先用 Node 22+ 内置 `node:sqlite`（无原生依赖），降级 `better-sqlite3`。`initialize` 建三表 + 索引（type/topics/valid_from）。

- [ ] **Step 2: 实现 write 与 read**

`write` 插入 memories 表，生成 UUID；若有 embedder 则算 embedding 存 memory_embeddings。`read` 按 id 查询，附带版本历史（LEFT JOIN memory_versions）。

- [ ] **Step 3: 实现 searchFullText（LIKE 降级）**

`SELECT * FROM memories WHERE content LIKE '%query%' LIMIT n`。BM25 由 Task 3 实现，此处仅降级路径。

- [ ] **Step 4: 实现 searchVector（kNN 内积）**

遍历 memory_embeddings，与 queryEmbedding 算内积，取 top-K。L2 归一化使内积等价 cosine。

- [ ] **Step 5: 双写降级与文件冷备份**

`MemoryStore` 启用时，`project-memory.ts` 的写操作同时调 `store.write` 与原文件写入（保留可读性 + 降级）。读操作优先 `store.read`，失败降级文件读取。

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `MemoryStoreConfig`（隶属 MemorySystemConfig，Task 7 收口）。默认 `enabled: false`、`backend: 'sqlite'`、`dbPath: '.routedev/memory.db'`。

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/memory-store.test.ts`，覆盖：
- initialize 建表正确
- write + read 往返一致性
- searchFullText LIKE 匹配
- searchVector kNN 正确性
- 向量 L2 归一化
- backend='file' 降级（回退纯文件）
- 双写一致性（SQLite 与文件同步）
- 空查询降级

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-65): M1 存储分离 SQLite + 向量索引

新增 MemoryStore，SQLite 三表结构 + 向量索引替代纯文件
论文借鉴：arXiv:2606.24775 复合混合（图+向量+原文）领先
降级：SQLite 不可用回退纯文件，双写保留可读性"
```

---

## Task 2：M2 增量抽取——compose-pipeline 每阶段结束触发（≥ 7 测试）

### 2.1 论文借鉴

论文 M2 模块：抽取分原始拼接/无模式/模式约束（LLM Topic/三元组/实体关系）。模式约束优于无模式，但精细抽取损害多跳推理（同一系统"快速记忆"25.5 分 vs "细记忆"2.5 分）。**写入端晚过滤原则**：别在写入时激进裁剪，保原文比"更抽象、更分层"更重要。

RouteDev 当前抽取集中在会话末尾，[compose-pipeline.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/compose-pipeline.ts) 的四阶段（requirements/coding/testing/review）切换时无增量抽取钩子，导致阶段间产出丢失。

### 2.2 设计

新增 `IncrementalExtractor`，挂在 compose-pipeline 阶段切换钩子：

```ts
// src/memory/incremental-extractor.ts

/**
 * 增量抽取器（M2）
 *
 * 论文：模式约束（LLM Topic）优于无模式；但写入端晚过滤——保原文
 * RouteDev 落地：
 *   - compose-pipeline 每阶段结束触发，抽取该阶段产出的 facts/decisions/error_fix
 *   - 模式约束：LLM Topic 抽取（轻量，避免 Cognee 155s 延迟）
 *   - 晚过滤：原文与抽取结果同时存 MemoryStore，抽取结果仅作索引用
 *   - 失败不阻塞主流程（fail-open）
 */
export class IncrementalExtractor {
  constructor(
    private readonly store: MemoryStore,
    private readonly config: {
      enabled: boolean;
      /** 抽取模式：'topic'（LLM Topic 轻量）/ 'none'（仅存原文） */
      mode: 'topic' | 'none';
      /** 抽取 LLM 模型（默认 fast tier） */
      modelId: string;
    },
  ) {}

  /**
   * 阶段结束时触发增量抽取
   * @param phase compose 阶段
   * @param phaseOutput 该阶段的产出文本（需求文档/代码/测试报告/审查报告）
   */
  async extractFromPhase(phase: ComposePhase, phaseOutput: string): Promise<{
    extracted: number;
    memoryIds: string[];
  }>;
}
```

**晚过滤实现**：`extractFromPhase` 先把 `phaseOutput` 原文写入 MemoryStore（type 按 phase 映射：requirements→topic、coding→decision、testing→error_fix、review→decision），再调 LLM Topic 抽取生成 topics 索引字段。**原文 content 不被抽取结果替换**，topics 仅作检索辅助。

### 2.3 接线点

- 新增：`src/memory/incremental-extractor.ts`
- 修改：`src/agent/compose-pipeline.ts` — `evaluateAdvance` 与 `advance` 在阶段切换前调用 `extractor.extractFromPhase(currentPhase, phaseOutput)`
- 修改：`src/cli/app-init.ts` — 装配 IncrementalExtractor 单例，注入 ComposePipeline
- 复用：Task 1 的 `MemoryStore.write`

### 2.4 Step 分解

- [ ] **Step 1: 实现阶段产出收集**

在 [compose-pipeline.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/compose-pipeline.ts) 的 `evaluateAdvance` / `advance` 中，阶段切换前收集当前阶段产出（从 trace 或最近 ToolResult 提取文本）。

- [ ] **Step 2: 实现原文优先写入（晚过滤）**

`extractFromPhase` 首先把 `phaseOutput` 原文调 `store.write`，type 按 phase 映射。**不裁剪原文**，保住多跳推理线索。

- [ ] **Step 3: 实现 LLM Topic 抽取（模式约束）**

`mode: 'topic'` 时，调 LLM（fast tier）从 phaseOutput 抽取 3-5 个 topic 关键词，作为 `MemoryEntry.topics` 字段。抽取失败 fail-open，topics 留空。`mode: 'none'` 时跳过抽取，仅存原文。

- [ ] **Step 4: 接入 compose-pipeline 钩子**

在 `evaluateAdvance` 检测到 `shouldAdvance` 时、`controller.advanceComposePhase()` 调用前，触发 `extractor.extractFromPhase`。`advance`（手动推进）同样触发。异步执行不阻塞阶段切换（fire-and-forget + 错误日志）。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `IncrementalExtractorConfig`（隶属 MemorySystemConfig）。默认 `enabled: false`、`mode: 'topic'`。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/incremental-extractor.test.ts`，覆盖：
- 四阶段产出 type 映射正确
- 原文优先写入（content 不被替换）
- LLM Topic 抽取生成 topics
- mode='none' 仅存原文
- 抽取失败 fail-open（topics 留空，原文已存）
- 阶段切换钩子触发（mock ComposePipeline）
- 异步不阻塞阶段切换

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-65): M2 增量抽取 compose-pipeline 每阶段触发

新增 IncrementalExtractor，挂 compose-pipeline 阶段切换钩子
论文借鉴：arXiv:2606.24775 模式约束 + 写入端晚过滤（保原文）
晚过滤：原文与抽取结果同时存，topics 仅作索引"
```

---

## Task 3：M3 语义检索替代 grep——embedding kNN + BM25 混合（≥ 8 测试）

### 3.1 论文借鉴

论文 M3 模块：检索分原生注意力/语义/拓扑子图/Agent 路由/多阶段混合。**核心发现：检索精度随时间距离显著退化**（纯相似度检索的根本局限）。多阶段混合检索领先。

RouteDev 当前记忆检索靠关键词匹配（grep 式），无 embedding 语义检索，无 BM25 词项匹配。论文证明纯相似度有时序退化局限，必须混合。

### 3.2 设计

新增 `HybridRetriever`（embedding kNN + BM25）：

```ts
// src/memory/hybrid-retriever.ts

/**
 * 混合检索器（M3）
 *
 * 论文：检索精度随时间距离退化；多阶段混合领先
 * RouteDev 落地：
 *   - BM25：精确词项匹配锚点（纯 TS 实现，tokenize + IDF + TF）
 *   - embedding kNN：语义泛化（复用 Phase 64 Bi-encoder）
 *   - 混合分数：score = α×BM25_norm + (1-α)×cosine_norm（默认 α=0.4）
 *   - 时间衰减：论文发现时间距离退化，加 exponential decay（半衰期 30 天）
 */
export class HybridRetriever {
  private bm25: BM25Index;
  constructor(
    private readonly store: MemoryStore,
    private readonly embedder: Embedder | null,
    private readonly config: {
      enabled: boolean;
      bm25Weight: number;       // 默认 0.4
      embeddingWeight: number;  // 默认 0.6
      timeDecayHalfLifeDays: number; // 默认 30
      topK: number;             // 默认 10
    },
  ) {}

  /**
   * 混合检索
   * @param query 查询文本
   * @returns 按混合分数降序的记忆条目
   */
  async retrieve(query: string): Promise<Array<MemoryEntry & { score: number; bm25Score: number; embeddingScore: number; timeDecay: number }>>;
}

/** BM25 索引（纯 TS 实现） */
export class BM25Index {
  constructor(private readonly k1: number = 1.5, private readonly b: number = 0.75) {}
  /** 索引文档 */
  index(docs: Array<{ id: string; content: string }>): void;
  /** 查询 */
  search(query: string, limit: number): Array<{ id: string; score: number }>;
}
```

**混合分数计算**：
```
bm25_norm = bm25 / max_bm25（归一化到 [0,1]）
cosine_norm = (cosine + 1) / 2（从 [-1,1] 映射到 [0,1]）
timeDecay = exp(-ln(2) × ageDays / halfLifeDays)
score = (α × bm25_norm + (1-α) × cosine_norm) × timeDecay
```

### 3.3 接线点

- 新增：`src/memory/hybrid-retriever.ts`
- 新增：`src/memory/bm25-index.ts`（纯 TS BM25）
- 修改：`src/memory/project-memory.ts` — 记忆注入路径用 `HybridRetriever.retrieve` 替代关键词匹配
- 复用：Phase 64 的 `Embedder`、Task 1 的 `MemoryStore.searchVector`

### 3.4 Step 分解

- [ ] **Step 1: 实现 BM25Index**

纯 TS：tokenize（复用 compositional-router 的 extractKeywords，含 CJK bigram）→ IDF = log(N / df) → TF 饱和 = (k1+1)×tf / (tf + k1×(1-b+b×dl/avgdl)) → BM25 = Σ IDF × TF。`index` 建倒排，`search` 返回 top-K。

- [ ] **Step 2: 实现 HybridRetriever.retrieve**

对 query 同时跑 BM25（store 全文）与 embedding kNN（store.searchVector）。按 memoryId 合并，算混合分数。embedder 不可用时降级纯 BM25（α=1）。

- [ ] **Step 3: 实现时间衰减**

`timeDecay = exp(-ln(2) × ageDays / halfLifeDays)`，ageDays 从 MemoryEntry.validFrom 算。乘到混合分数上，对抗论文发现的"时间距离退化"。

- [ ] **Step 4: 接入 project-memory 注入路径**

[project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的记忆注入（autoInject）改用 `HybridRetriever.retrieve`，替代现有关键词匹配。fail-open：检索失败降级原关键词逻辑。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `HybridRetrieverConfig`（隶属 MemorySystemConfig）。默认 `enabled: false`、`bm25Weight: 0.4`、`embeddingWeight: 0.6`、`timeDecayHalfLifeDays: 30`。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/hybrid-retriever.test.ts`，覆盖：
- BM25 索引与查询正确性
- BM25 TF 饱和与 IDF
- embedding kNN 与 cosine
- 混合分数加权
- 时间衰减（旧记忆分数降低）
- embedder 不可用降级纯 BM25
- 检索失败降级关键词
- 空查询返回空

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-65): M3 混合检索 embedding kNN + BM25

新增 HybridRetriever + BM25Index，替代 grep 关键词匹配
论文借鉴：arXiv:2606.24775 检索精度随时间距离退化，多阶段混合领先
时间衰减：半衰期 30 天，对抗时序退化"
```

---

## Task 4：M4 保守合并 + 时间戳多版本——valid_from/superseded_at 不覆盖（≥ 8 测试）

### 4.1 论文借鉴

论文 M4 模块：维护分时间戳多版本/容量驱动淘汰/LLM 驱动语义合并。**核心警告：覆盖式维护导致"过去幻觉"**——纯追加存储返回过期事实。图基方法（Zep/Mem0^g/Cognee）因显式 supersede 关系处理知识更新最可靠。

RouteDev 的 [graph.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/graph.ts) 已有 `supersededBy`/`validUntil`/时间衰减雏形（Phase 36/38 落地），但 [project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 直接覆盖写入，无多版本。本 Task 把 graph.ts 的保守合并模式扩展到 project-memory。

### 4.2 设计

新增 `ConservativeMerger`，扩展 MemoryStore 的版本管理：

```ts
// src/memory/conservative-merger.ts

/**
 * 保守合并器（M4）
 *
 * 论文：覆盖式→过去幻觉；时间戳多版本最可靠
 * RouteDev 落地：
 *   - 写入新版本时，不删除旧版本，仅设 supersededAt
 *   - 检索默认只返回未被 supersede 的最新版本，但可查询历史
 *   - 冲突检测：同 topic 新旧矛盾 → 新版本 supersede 旧版本
 *   - 复用 graph.ts 的 supersedeNode 思路
 */
export class ConservativeMerger {
  constructor(private readonly store: MemoryStore) {}

  /**
   * 写入新版本，保守合并
   * @param entry 新记忆
   * @param matchKey 匹配键（同 topic + 同 type 视为同条目新版本）
   * @returns 新版本 ID + 被 supersede 的旧版本 ID 列表
   */
  async writeWithVersion(entry: MemoryEntry, matchKey: { topics: string[]; type: string }): Promise<{
    newVersionId: string;
    supersededOldIds: string[];
  }>;

  /**
   * 查询某条目的版本历史
   */
  async getVersionHistory(memoryId: string): Promise<MemoryEntry[]>;

  /**
   * 检索时默认过滤 superseded（latestOnly=true），可选查全部
   */
  async retrieveLatest(matchKey: { topics: string[]; type: string }): Promise<MemoryEntry | null>;
}
```

**不覆盖保证**：`writeWithVersion` 先查同 matchKey 的现有条目，若有则把旧条目 `supersededAt = now`（不删除），新条目 `validFrom = now` 插入。冲突检测复用 [consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts) 的 `isConflicting`。

### 4.3 接线点

- 新增：`src/memory/conservative-merger.ts`
- 修改：`src/memory/memory-store.ts` — `MemoryStore.write` 增加 `matchKey` 可选参数，启用时走 `ConservativeMerger.writeWithVersion`
- 修改：`src/memory/project-memory.ts` — 写操作改用 `ConservativeMerger.writeWithVersion`，读操作默认 `retrieveLatest`
- 复用：[graph.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/graph.ts) 的 `supersedeNode` 思路、[consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts) 的 `isConflicting`/`findSimilarNode`

### 4.4 Step 分解

- [ ] **Step 1: 实现 writeWithVersion 不覆盖**

查同 matchKey（topics 交集 + type 相同）的现有条目。若有，旧条目 `supersededAt = now`（UPDATE memory_versions），新条目插入。无则直接插入。

- [ ] **Step 2: 实现冲突检测**

复用 [consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts) 的 `isConflicting(existing.content, new.content)`。冲突时强制 supersede（旧标 supersededAt）；不冲突但同 topic 时合并（旧 content 追加 `[补充] new`，不 supersede）。

- [ ] **Step 3: 实现 getVersionHistory 与 retrieveLatest**

`getVersionHistory` 按 matchKey 查 memory_versions 全部记录，按 validFrom 排序。`retrieveLatest` 返回 `supersededAt IS NULL` 的最新版本。

- [ ] **Step 4: 修改 MemoryStore.write 支持 matchKey**

`MemoryStore.write(entry, matchKey?)`：matchKey 提供时委托 `ConservativeMerger.writeWithVersion`，否则直接插入（兼容旧调用）。

- [ ] **Step 5: 接入 project-memory**

[project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的写操作（addMemory/addDecision）改用 `writeWithVersion`，matchKey 用 `{topics: [currentTopic], type: entry.type}`。读操作（getRelevantMemory）改用 `retrieveLatest`。

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `ConservativeMergerConfig`（隶属 MemorySystemConfig）。默认 `enabled: false`。

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/conservative-merger.test.ts`，覆盖：
- writeWithVersion 不删除旧版本（supersededAt 设置但记录保留）
- 同 matchKey 多次写入生成版本链
- 冲突检测强制 supersede
- 不冲突同 topic 合并追加
- getVersionHistory 按 validFrom 排序
- retrieveLatest 只返回未 supersede
- 检索可查历史版本
- 旧调用兼容（无 matchKey 直接插入）

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-65): M4 保守合并 + 时间戳多版本

新增 ConservativeMerger，valid_from/superseded_at 不覆盖
论文借鉴：arXiv:2606.24775 覆盖式→过去幻觉，时间戳多版本最可靠
复用：graph.ts supersedeNode 思路 + consolidation.ts isConflicting"
```

---

## Task 5：被拒替代保留——CrossModelReviewer 否决方案作 rejected alternative 保留（≥ 6 测试）

### 5.1 论文借鉴

论文未直接涉及"被拒替代保留"，但其"写入端晚过滤 + 保原文"原则延伸：CrossModelReviewer 否决的方案不是垃圾，是未来相似任务的"反例参考"。论文警告"精细抽取损害多跳推理"——保留被拒方案原文（不摘要）有助于多跳推理时避开已知错误路径。

RouteDev 的 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 否决方案后直接丢弃，无 rejected alternative 留存。

### 5.2 设计

新增 `RejectedAlternativeStore`：

```ts
// src/memory/rejected-alternative-store.ts

/**
 * 被拒替代保留
 *
 * 论文晚过滤原则延伸：被否决的方案是反例参考，不是垃圾
 * RouteDev 落地：
 *   - CrossModelReviewer 否决（passed=false）时，把被否方案落 MemoryStore
 *   - type='rejected_alternative'，metadata 含否决理由与 issue 列表
 *   - 可检索（HybridRetriever），标记 rejected 不注入主上下文
 *   - 相似任务检索时作为"避坑参考"附在上下文末尾
 */
export class RejectedAlternativeStore {
  constructor(private readonly store: MemoryStore) {}

  /**
   * 记录被否决的方案
   * @param params 否决上下文
   */
  async recordRejection(params: {
    /** 被否决的方案原文（保原文，不摘要） */
    proposal: string;
    /** 否决理由摘要 */
    rejectionReason: string;
    /** CrossModelReviewer 的 issue 列表 */
    issues: CodeReviewIssue[];
    /** 关联主题 */
    topics: string[];
    /** 来源 compose 阶段 */
    source: string;
  }): Promise<string /* memoryId */>;

  /**
   * 检索相似被拒方案（供避坑参考）
   * @param query 当前任务
   * @param limit 返回条数
   */
  async findSimilarRejections(query: string, limit: number): Promise<Array<MemoryEntry & { score: number }>>;
}
```

### 5.3 接线点

- 新增：`src/memory/rejected-alternative-store.ts`
- 修改：`src/agent/cross-model-reviewer.ts` — `review()` 返回 `passed=false` 时调 `rejectedStore.recordRejection`
- 修改：技能执行入口 — 相似任务检索时调 `findSimilarRejections`，结果附在上下文末尾作"避坑参考"
- 复用：Task 1 的 `MemoryStore.write`（type='rejected_alternative'）、Task 3 的 `HybridRetriever.retrieve`

### 5.4 Step 分解

- [ ] **Step 1: 实现 recordRejection**

构造 MemoryEntry：content=proposal（原文），type='rejected_alternative'，metadata={rejectionReason, issues: JSON.stringify}，topics。调 `store.write`。**不摘要**（保原文原则）。

- [ ] **Step 2: 实现 findSimilarRejections**

调 `HybridRetriever.retrieve`，过滤 type='rejected_alternative'，返回 top-K。分数供调用方决定是否附上下文。

- [ ] **Step 3: 接入 CrossModelReviewer 否决路径**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 的 `review()` 返回前，若 `result.passed === false` 且 `rejectedStore` 启用，调 `recordRejection`。异步 fire-and-forget，失败仅日志不阻塞审查流程。

- [ ] **Step 4: 接入避坑参考注入**

技能执行前检索时，除正常记忆外调 `findSimilarRejections`，top-3 附在上下文末尾，标注"以下方案曾被否决，请规避类似路径"。注入 token 计入预算。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `RejectedAlternativeConfig`（隶属 MemorySystemConfig）。默认 `enabled: false`。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/rejected-alternative-store.test.ts`，覆盖：
- recordRejection 落库（type=rejected_alternative）
- 原文保留不摘要
- findSimilarRejections 相似检索
- 避坑参考注入 top-3
- CrossModelReviewer 否决路径触发（mock）
- 配置关闭时审查流程不受影响

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-65): 被拒替代保留

新增 RejectedAlternativeStore，CrossModelReviewer 否决方案落库可检索
论文借鉴：arXiv:2606.24775 晚过滤原则延伸，被否方案是反例参考
保原文：不摘要，避坑参考注入 top-3"
```

---

## Task 6：成本感知局部维护——topics 超阈值时只重组最旧/最少访问（≥ 6 测试）

### 6.1 论文借鉴

论文核心发现：**高结构化系统延迟极高**（Cognee 155s、Zep 116s vs 轻量局部维护秒级）——精度提升不成正比；**局部维护比全局重组更 cost-efficient**。

RouteDev 的 [consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts) 的 `consolidateToGraph` 是全量重组，topics 超阈值时无局部重组策略。

### 6.2 设计

新增 `LocalMaintenancePolicy`：

```ts
// src/memory/local-maintenance.ts

/**
 * 成本感知局部维护策略
 *
 * 论文：局部维护比全局重组 cost-efficient；高结构化延迟极高
 * RouteDev 落地：
 *   - topics 超阈值（默认 500 条）时触发维护
 *   - 只重组最旧（validFrom 最久远）+ 最少访问（accessCount 最低）的部分
 *   - 重组范围默认 top-20% 最旧，避免全量重写
 *   - 重组用 consolidation.ts 的归纳逻辑但限定范围
 */
export class LocalMaintenancePolicy {
  constructor(
    private readonly store: MemoryStore,
    private readonly config: {
      enabled: boolean;
      /** 触发阈值（条数） */
      triggerThreshold: number;      // 默认 500
      /** 重组比例（最旧占比） */
      reorganizeRatio: number;        // 默认 0.2（top-20% 最旧）
      /** 最少访问阈值（accessCount 低于此值纳入候选） */
      minAccessCount: number;         // 默认 2
    },
  ) {}

  /**
   * 检查是否需要维护
   */
  shouldMaintain(): { needed: boolean; currentCount: number; threshold: number };

  /**
   * 执行局部维护
   * @returns 重组统计
   */
  async maintain(): Promise<{
    reorganized: number;
    merged: number;
    superseded: number;
    durationMs: number;
  }>;
}
```

**局部维护算法**：
1. 查 `shouldMaintain`：count > triggerThreshold
2. 选候选：`ORDER BY validFrom ASC, accessCount ASC LIMIT count × reorganizeRatio`
3. 对候选集调 [consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts) 的归纳逻辑（合并同类 + 冲突 supersede + 时效淘汰）
4. 重组后写回，旧条目标 archived（不删除）

### 6.3 接线点

- 新增：`src/memory/local-maintenance.ts`
- 修改：`src/memory/project-memory.ts` — 写操作后调 `shouldMaintain`，需要时触发 `maintain`（异步 fire-and-forget）
- 复用：[consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts) 的 `consolidateToGraph`、`findSimilarNode`、`isConflicting`

### 6.4 Step 分解

- [ ] **Step 1: 实现 shouldMaintain**

查 MemoryStore 总条数，与 triggerThreshold 比较。返回 needed 标志与当前计数。

- [ ] **Step 2: 实现候选选择**

SQL：`SELECT * FROM memories WHERE supersededAt IS NULL ORDER BY validFrom ASC, accessCount ASC LIMIT ?`（? = count × reorganizeRatio）。accessCount 需要 MemoryStore 增加 `access_count` 字段（retrieve 时 +1）。

- [ ] **Step 3: 实现局部归纳**

对候选集调 consolidation.ts 的归纳三步（合并同类 + 冲突 supersede + 时效淘汰），但**仅限候选集范围**，不触全局。重组后旧条目 `metadata.archived = true`（不删除，保时序线索）。

- [ ] **Step 4: 接入 project-memory 写后钩子**

[project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的写操作后，异步调 `shouldMaintain`，needed 时触发 `maintain`。fire-and-forget，失败仅日志。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `LocalMaintenanceConfig`（隶属 MemorySystemConfig）。默认 `enabled: false`、`triggerThreshold: 500`、`reorganizeRatio: 0.2`、`minAccessCount: 2`。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/local-maintenance.test.ts`，覆盖：
- shouldMaintain 阈值判定
- 候选选择（最旧 + 最少访问）
- 局部归纳不触全局
- 重组后旧条目标 archived 不删除
- 异步 fire-and-forget 不阻塞写
- 维护统计（reorganized/merged/superseded）

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-65): 成本感知局部维护

新增 LocalMaintenancePolicy，超阈值只重组最旧/最少访问部分
论文借鉴：arXiv:2606.24775 局部维护比全局重组 cost-efficient
避免 Cognee 155s 式高延迟，重组比例默认 20%"
```

---

## Task 7：配置收口、评测指标与全量验证（≥ 4 测试）

### 7.1 目标

收口 Phase 65 所有配置项，新增评测指标，全量验证通过。

### 7.2 Step 分解

- [ ] **Step 1: 配置 schema 收口**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加顶层 `memorySystem` 字段，聚合 Task 1-6 的所有子配置：

```ts
memorySystem: z.object({
  enabled: z.boolean().default(false), // 总开关
  store: z.object({
    enabled: z.boolean().default(false),
    dbPath: z.string().default('.routedev/memory.db'),
    backend: z.enum(['sqlite', 'file']).default('sqlite'),
    embeddingProvider: z.enum(['bi-encoder', 'hash', 'none']).default('hash'),
  }).default({}),
  incrementalExtractor: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(['topic', 'none']).default('topic'),
    modelId: z.string().default('deepseek-v4-flash'),
  }).default({}),
  hybridRetriever: z.object({
    enabled: z.boolean().default(false),
    bm25Weight: z.number().min(0).max(1).default(0.4),
    embeddingWeight: z.number().min(0).max(1).default(0.6),
    timeDecayHalfLifeDays: z.number().int().min(1).default(30),
    topK: z.number().int().min(1).max(50).default(10),
  }).default({}),
  conservativeMerger: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  rejectedAlternative: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  localMaintenance: z.object({
    enabled: z.boolean().default(false),
    triggerThreshold: z.number().int().min(50).default(500),
    reorganizeRatio: z.number().min(0.05).max(0.5).default(0.2),
    minAccessCount: z.number().int().min(0).default(2),
  }).default({}),
}).default({}),
```

- [ ] **Step 2: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加对应默认值。

- [ ] **Step 3: 评测指标**

新增 `tests/memory/eval-metrics.test.ts` 与 `src/memory/eval-metrics.ts`，实现两个论文级评测指标：

```ts
// src/memory/eval-metrics.ts
/**
 * 证据级检索保真度
 * 论文：检索精度评测
 * 计算：top-K 检索结果中包含 ground-truth 证据的比例
 */
export function retrievalFidelity(retrieved: MemoryEntry[], groundTruthIds: string[], k: number): number;

/**
 * 时序更新鲁棒性
 * 论文：知识更新后是否返回最新版本而非过期事实
 * 计算：更新后检索返回最新版本（supersededAt IS NULL）的比例
 */
export function temporalUpdateRobustness(
  retriever: HybridRetriever,
  updates: Array<{ matchKey: { topics: string[]; type: string }; newContent: string }>,
): Promise<{ robustness: number; returnedLatest: number; returnedStale: number }>;
```

- [ ] **Step 4: 设置页 UI**

在 desktop renderer 设置页 Memory Tab 增加"记忆系统重构"分区：
- 总开关
- 子开关（SQLite 存储 / 增量抽取 / 混合检索 / 保守合并 / 被拒保留 / 局部维护）
- 参数（dbPath / bm25Weight / timeDecayHalfLifeDays / triggerThreshold / reorganizeRatio）
- 记忆统计仪表盘（总条数 / 版本链数 / 被拒替代数 / 上次维护时间）
- "立即触发局部维护"按钮
- "导出记忆库"按钮（SQLite → JSON 降级可读）

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 5: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 45 个测试通过。

- [ ] **Step 6: 文档同步**

更新 [docs/CONTEXT_USAGE.md](file:///c:/Users/杨铭/Desktop/Agent/routedev/docs/CONTEXT_USAGE.md) 与 [docs/DUAL_LOOP.md](file:///c:/Users/杨铭/Desktop/Agent/routedev/docs/DUAL_LOOP.md)，说明记忆系统四模块重构架构。

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/eval-metrics.test.ts`，覆盖：
- retrievalFidelity top-K 包含 ground-truth
- temporalUpdateRobustness 更新后返回最新版本
- schema 默认值正确
- defaults 与 schema 一致性

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-65): 配置收口、评测指标与全量验证

记忆系统总开关 + 6 子开关 + 参数 + 仪表盘 + 评测指标
论文借鉴：arXiv:2606.24775 四模块框架完整落地
评测：证据级检索保真度 + 时序更新鲁棒性
版本：v4.6.4"
```

---

## 风险与回滚

### 风险 1：SQLite 锁竞争 / 原生依赖问题
- **缓解**：优先 Node 22+ 内置 `node:sqlite`（无原生依赖）；`better-sqlite3` 同步 API 无锁竞争；WAL 模式提升并发
- **回滚**：`backend: 'file'` 降级纯文件，SQLite 不可用时双写路径仍保留文件可读

### 风险 2：增量抽取 LLM 调用拖慢 compose 阶段切换
- **缓解**：异步 fire-and-forget，不阻塞阶段切换；抽取失败 fail-open（仅存原文）；论文警告精细抽取损害多跳推理，默认 mode='topic' 轻量
- **回滚**：关闭 `memorySystem.incrementalExtractor.enabled`，回到会话末尾抽取

### 风险 3：混合检索 embedding 不可用
- **缓解**：embedder 不可用降级纯 BM25（α=1）；BM25 纯 TS 无依赖
- **回滚**：关闭 `memorySystem.hybridRetriever.enabled`，降级关键词匹配

### 风险 4：保守合并导致版本膨胀
- **缓解**：Task 6 局部维护归档最旧版本；memory_versions 表定期 VACUUM；superseded 条目检索默认过滤
- **回滚**：关闭 `memorySystem.conservativeMerger.enabled`，回到覆盖写入（接受"过去幻觉"风险）

### 风险 5：被拒替代保留污染上下文
- **缓解**：type='rejected_alternative' 标记，注入时明确标注"避坑参考"；top-3 上限；token 计入预算
- **回滚**：关闭 `memorySystem.rejectedAlternative.enabled`，否决方案丢弃

### 风险 6：局部维护误删时序线索
- **缓解**：重组后旧条目 `metadata.archived=true` 不删除；仅候选集范围重组（默认 20%）；论文警告摘要破坏时序，本 Task 不摘要仅合并
- **回滚**：关闭 `memorySystem.localMaintenance.enabled`，回到全量重组或不维护

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 45 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] 记忆系统总开关默认关闭，设置页可开启
- [ ] SQLite 存储可用，不可用时降级纯文件（双写保留可读性）
- [ ] compose-pipeline 每阶段结束触发增量抽取（异步不阻塞）
- [ ] 混合检索（BM25 + embedding kNN + 时间衰减）可用，embedding 不可用降级纯 BM25
- [ ] 保守合并不覆盖旧版本（valid_from/superseded_at 多版本）
- [ ] 被拒替代保留可检索，注入时标注"避坑参考"
- [ ] 局部维护只重组最旧/最少访问部分，不全量重写
- [ ] 评测指标可用（证据级检索保真度 / 时序更新鲁棒性）
- [ ] fail-open：各模块失败时降级，不阻塞主流程
- [ ] docs/CONTEXT_USAGE.md 与 docs/DUAL_LOOP.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中

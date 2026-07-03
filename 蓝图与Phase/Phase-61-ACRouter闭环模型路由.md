# Phase 61 — ACRouter 闭环模型路由

> **版本目标：** v4.6.0
> **前置依赖：** Phase 60（花架子去除工程五：A 档打磨与全量验收发布）完成
> **后继依赖：** 无（本 Phase 是独立能力增强，可与 Phase 62-68 并行）
> **新增测试要求：** ≥ 40 个
> **研究依据：** 精读 arXiv:2606.22902《Agent-as-a-Router: Agentic Model Routing for Coding Tasks》（NUS + 阿里达摩院 + UC Berkeley + HKUST + 浙大，2026-06）全文。论文核心论断：LLM 路由器的真正瓶颈是**信息缺失（information deficit）**而非推理能力不足——仅向零样本 LLM 路由器喂入"各模型在各维度的实测性能统计"，AvgPerf 从 41.41 跳到 47.74（相对 +15.3%），甚至超过编码了同样维度先验的启发式基线 DimensionBest（47.50）。论文将模型路由形式化为 **C-A-F 循环**（Context → Action → Feedback → Context），等价于上下文老虎机，因此**累积遗憾**（cumulative regret）成为自然评测指标。论文落地 **ACRouter**（Orchestrator + Verifier + Memory 三模块），在 ID 测试取得路由器最高 AvgPerf（49.98-50.14%）和最低累积遗憾，在 OOD agentic 编程测试上（62.50-73.30%）显著超过所有静态学习器（普遍低于随机）。
> **核心命题：** RouteDev 的 [model-router](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/router) 当前是**开环的**——选完模型就结束，没有"这个模型在这类任务上的历史表现"反馈回路。Phase 61 把 ACRouter 的 C-A-F 闭环落地，让路由器从"一次性判断"升级为"在 loop 中进化的 agent"。

---

## 项目现状审计与可行性结论

### 1. 论文与 RouteDev 缺口的映射

| ACRouter 组件 | 核心 Contribution | RouteDev 现状缺口 | Phase 61 Task |
|---------------|-------------------|-------------------|---------------|
| Information Deficit 诊断 | 瓶颈是信息缺失非推理能力（+15.3%） | 路由器无任何历史执行信息反馈 | Task 1（routingHistory） |
| Memory 模块 | 在线向量库，task embedding 为 key，cosine kNN top-10，FIFO 20K | 无路由记忆，每次从零决策 | Task 2（RoutingMemory） |
| Orchestrator | 整合先验+记忆邻居+元数据，加权投票决策 | classifier 仅看当前 query，不看历史邻居 | Task 3（邻居加权决策） |
| Verifier | 沙盒原生多路信号聚合打分，不依赖 ground-truth | CrossModelReviewer 仅高风险事后审查，无 routing feedback | Task 4（Verifier 信号聚合） |
| 累积遗憾指标 | 替代单次准确率评测 router | 无 router 自评指标 | Task 5（自评仪表盘） |
| OOD 泛化 | 静态路由器 OOD 集体崩溃，ACRouter 62.50-73.30% | 路由规则在 OOD 任务上无适应能力 | Task 3 + Task 6 |

### 2. 可行性总评

- **Task 1（routingHistory 数据结构）：** 高度可行。现有 ModelRouter 已有 route 方法返回 RoutingResult，只需在调用方记录执行结果。
- **Task 2（RoutingMemory 向量库）：** 可行。项目已有 [CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的内容寻址经验，可复用 embedding 基础设施。
- **Task 3（邻居加权决策）：** 可行。在现有 classifier.classify 后插入"查 memory → 取 top-k 邻居 → 加权投票"环节。
- **Task 4（Verifier 信号聚合）：** 中等可行。需扩展 [CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 为常规化验证，并聚合多路信号（编译/测试/类型检查）。
- **Task 5（累积遗憾自评）：** 可行。需定义 oracle（每题最优模型）和 regret 累积计算。
- **Task 6（配置开关与设置页）：** 高度可行。遵循 Phase 51 反写死原则。

---

## 核心设计原则

### 原则 1：闭环优先于开环

论文核心诊断——information deficit 是瓶颈。Phase 61 的每个 Task 都要回答："这个决策能否参考历史执行反馈？" 如果能，设计为闭环；如果不能，说明原因。

### 原则 2：不依赖 ground-truth 的验证

论文 Verifier 用沙盒原生多路信号聚合打分（编译成功/测试通过/类型检查/执行时长），不依赖人工标注的 ground-truth。Phase 61 的验证模块必须可在线运行，不阻塞主流程。

### 原则 3：累积遗憾优先于单次准确率

论文证明单次准确率无法区分"运气好选对一次"和"持续接近最优"。Phase 61 的 router 自评必须用累积遗憾，记录每题相对于 oracle 的差距累积。

### 原则 4：反写死原则（延续 Phase 51）

所有新增能力必须有配置开关、设置页面入口、明确代码接线点。默认关闭，用户在设置页开启。

### 原则 5：Fail-open

Memory 查询失败、Verifier 信号缺失时，路由降级为现有 classifier 逻辑，不阻塞主流程。

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

## Task 1：routingHistory 数据结构与写入（≥ 6 测试）

### 1.1 论文借鉴

ACRouter 的 Memory 模块存储每条路由记录：(task embedding, chosen model, quality score, cost, latency, verification trace)。RouteDev 当前 [model-router](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/router) 的 `route()` 方法返回 RoutingResult 后无任何持久化。

### 1.2 设计

新增 `RoutingRecord` 类型：

```ts
// src/router/routing-history.ts
export interface RoutingRecord {
  /** 任务签名（query 的语义指纹，见 Task 2） */
  taskSignature: string;
  /** 任务 embedding（用于 Memory kNN 检索，见 Task 2） */
  taskEmbedding?: number[];
  /** 选择的模型 ID */
  modelId: string;
  /** 执行质量分（0-1，由 Verifier 聚合，见 Task 4） */
  qualityScore?: number;
  /** Token 成本（input + output） */
  tokenCost?: number;
  /** 执行时长（ms） */
  latencyMs?: number;
  /** 验证轨迹摘要（编译/测试/类型检查结果） */
  verificationTrace?: {
    compiled: boolean;
    testsPassed: boolean;
    typeCheckPassed: boolean;
  };
  /** 时间戳 */
  timestamp: number;
  /** 是否用户手动覆盖了路由决策 */
  userOverride?: boolean;
}
```

新增 `RoutingHistory` 类（持久化到 `.routedev/routing-history.jsonl`，与 AuditChain 同目录）：

```ts
export class RoutingHistory {
  private records: RoutingRecord[] = [];
  private readonly maxRecords: number; // 默认 20000（论文 FIFO 20K）

  /** 追加一条路由记录（执行完成后调用） */
  append(record: RoutingRecord): void;

  /** 按模型 ID 聚合统计（用于 Orchestrator 先验） */
  getStatsByModel(): Map<string, {
    avgQuality: number;
    avgCost: number;
    avgLatency: number;
    sampleCount: number;
  }>;

  /** 按模型 + 任务维度聚合（论文的"维度级性能统计"） */
  getStatsByModelAndDimension(dimension: string): Map<string, Map<string, Stats>>;

  /** 持久化到 jsonl */
  flush(): Promise<void>;

  /** 从 jsonl 恢复 */
  load(): Promise<void>;
}
```

### 1.3 接线点

- 新增：`src/router/routing-history.ts`
- 修改：`src/cli/goal-runner.ts` — 在 LLM 调用完成后，构造 RoutingRecord 并 append
- 修改：`src/cli/app-init.ts` — 装配 RoutingHistory 单例

### 1.4 Step 分解

- [ ] **Step 1: 定义 RoutingRecord 类型与 RoutingHistory 类**

新建 `src/router/routing-history.ts`，实现上述接口。`maxRecords` 默认 20000，FIFO 淘汰。

- [ ] **Step 2: 持久化与恢复**

实现 `flush()`（追加写 jsonl）和 `load()`（启动时读取）。文件路径 `.routedev/routing-history.jsonl`，与 [AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent) 同目录。

- [ ] **Step 3: 聚合统计方法**

实现 `getStatsByModel()` 和 `getStatsByModelAndDimension()`。dimension 暂定：`'simple'|'medium'|'complex'|'reasoning'`（复用现有 classifier tier）。

- [ ] **Step 4: 接入 goal-runner**

在 [goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts) 的 LLM 调用完成后，构造 RoutingRecord：
- taskSignature：query 的 hash（简单实现）或 embedding（Task 2 后）
- modelId：从 RoutingResult.model.id 取
- qualityScore / verificationTrace：由 Task 4 的 Verifier 填充（Task 4 前先留 undefined）
- tokenCost / latencyMs：从 LLM 响应取

- [ ] **Step 5: 装配单例**

在 [app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) 装配 RoutingHistory，启动时 load，退出时 flush。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/router/routing-history.test.ts`，覆盖：
- append + FIFO 淘汰
- getStatsByModel 聚合正确性
- flush + load 往返一致性
- 空记录降级

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-61): routingHistory 数据结构与持久化

新增 RoutingRecord/RoutingHistory，记录每次路由决策的执行反馈
论文借鉴：ACRouter Memory 模块的 FIFO 20K 设计
落地：.routedev/routing-history.jsonl 持久化"
```

---

## Task 2：RoutingMemory 向量库与 kNN 检索（≥ 8 测试）

### 2.1 论文借鉴

ACRouter Memory 用 task embedding 为 key，cosine kNN 取 top-10 邻居。论文证明"喂入各模型各维度性能统计"即可 +15.3%，说明历史邻居信息是路由决策的关键输入。

### 2.2 设计

新增 `RoutingMemory` 类（基于 RoutingHistory 之上）：

```ts
// src/router/routing-memory.ts
export class RoutingMemory {
  constructor(
    private readonly history: RoutingHistory,
    private readonly embedder: (text: string) => Promise<number[]>,
    private readonly config: {
      topK: number;          // 默认 10（论文值）
      minSimilarity: number; // 默认 0.3，低于此不算邻居
      enabled: boolean;      // 配置开关，默认 false
    },
  ) {}

  /** 查询任务的 k 个最相似历史路由记录 */
  async queryNeighbors(query: string): Promise<RoutingRecord[]>;

  /** 获取邻居按模型聚合的统计（用于 Orchestrator 加权） */
  async queryModelStats(query: string): Promise<Map<string, {
    neighborCount: number;
    avgQuality: number;
    avgCost: number;
    avgLatency: number;
    weightedScore: number; // 按相似度加权
  }>>;
}
```

**Embedding 来源**：复用现有 LLM provider 的 embedding API（若配置了 OpenAI/通义等），或降级为 TF-IDF / hash trick（无 embedding 能力时）。

### 2.3 接线点

- 新增：`src/router/routing-memory.ts`
- 修改：`src/router/routing-history.ts` — RoutingRecord 增加 `taskEmbedding` 字段写入
- 修改：`src/cli/goal-runner.ts` — 路由前调用 queryModelStats，传给 Orchestrator（Task 3）

### 2.4 Step 分解

- [ ] **Step 1: 定义 embedder 接口与降级实现**

新增 `src/router/embedder.ts`：
- `Embedder` 接口：`embed(text: string): Promise<number[]>`
- `OpenAIEmbedder`：调用 OpenAI embedding API
- `HashEmbedder`：降级实现，用 hash trick 生成 384 维稀疏向量（参考 SkillWeaver 的 all-MiniLM-L6-v2 维度）

- [ ] **Step 2: 实现 RoutingMemory.queryNeighbors**

L2 归一化后 cosine 相似度等价于内积，用简单数组计算（20000 条以内不需要 FAISS）。top-K=10，过滤相似度 < 0.3 的。

- [ ] **Step 3: 实现 queryModelStats**

对 neighbors 按模型聚合，weightedScore = Σ(similarity × qualityScore) / Σ(similarity)。

- [ ] **Step 4: 接入 goal-runner**

在 [goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts) 路由决策前，调用 `memory.queryModelStats(query)`，结果传给 Task 3 的 Orchestrator 增强。fail-open：memory 查询失败时降级为现有 classifier。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 RouterConfigSchema 增加：

```ts
routingMemory: z.object({
  enabled: z.boolean().default(false),
  topK: z.number().int().min(1).max(50).default(10),
  minSimilarity: z.number().min(0).max(1).default(0.3),
  embeddingProvider: z.enum(['openai', 'hash']).default('hash'),
}).default({}),
```

- [ ] **Step 6: 设置页入口**

在 desktop renderer 设置页 Router Tab 增加"路由记忆"开关与参数配置（参考 Phase 51 设置页模式）。

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/router/routing-memory.test.ts`，覆盖：
- queryNeighbors top-K 与相似度过滤
- queryModelStats 聚合与加权
- embedding 降级（HashEmbedder）
- fail-open（memory 查询失败降级）
- 配置开关关闭时跳过

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-61): RoutingMemory 向量库与 kNN 检索

新增 RoutingMemory，task embedding 为 key，cosine kNN top-10 邻居
论文借鉴：ACRouter Memory 模块的 kNN 检索 + 信息缺失诊断
降级：无 embedding API 时用 hash trick"
```

---

## Task 3：Orchestrator 邻居加权决策（≥ 8 测试）

### 3.1 论文借鉴

ACRouter Orchestrator 整合三类信息：(1) 先验（各模型全局统计）、(2) 记忆邻居（当前任务的 k 个相似历史）、(3) 元数据（模型 tier/cost/latency）。用加权投票做最终决策。论文证明 OOD 上静态路由器集体崩溃，ACRouter 62.50-73.30%——邻居信息是 OOD 适应的关键。

### 3.2 设计

新增 `RoutingOrchestrator` 类，包装现有 ModelRouter：

```ts
// src/router/orchestrator.ts
export class RoutingOrchestrator {
  constructor(
    private readonly baseRouter: ModelRouter,
    private readonly memory: RoutingMemory,
    private readonly history: RoutingHistory,
    private readonly config: {
      enabled: boolean;
      neighborWeight: number;  // 邻居权重，默认 0.6
      priorWeight: number;     // 先验权重，默认 0.3
      baseWeight: number;      // base classifier 权重，默认 0.1
    },
  ) {}

  async route(query: string, context?: RouteContext): Promise<RoutingResult>;
}
```

**决策算法**：
1. 调用 baseRouter.route 得到 baseDecision（含 classifier tier）
2. 调用 memory.queryModelStats(query) 得到 neighborStats
3. 调用 history.getStatsByModel 得到 priorStats
4. 对每个候选模型计算综合分：
   ```
   score = baseWeight × baseScore
         + priorWeight × priorScore
         + neighborWeight × neighborScore
   ```
5. 选 score 最高的模型；若 neighborStats 为空（冷启动），降级为 baseDecision

### 3.3 接线点

- 新增：`src/router/orchestrator.ts`
- 修改：`src/cli/app-init.ts` — 用 RoutingOrchestrator 包装现有 ModelRouter
- 修改：`src/cli/goal-runner.ts` — 调用 orchestrator.route 替代 modelRouter.route

### 3.4 Step 分解

- [ ] **Step 1: 实现 RoutingOrchestrator.route**

按上述算法实现。baseScore 来自 classifier 的 tier 匹配度；priorScore 来自 getStatsByModel 的 avgQuality；neighborScore 来自 queryModelStats 的 weightedScore。三者归一化到 [0,1]。

- [ ] **Step 2: 冷启动处理**

neighborStats 为空（无历史）时，降级为 baseDecision。priorStats 为空（首次用某模型）时，priorScore 给默认 0.5。

- [ ] **Step 3: 用户覆盖记录**

若用户在执行前手动切换了模型，记录 `userOverride: true`，该条记录不参与邻居加权（避免污染），但参与先验统计。

- [ ] **Step 4: 接线**

在 [app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) 用 RoutingOrchestrator 包装 ModelRouter，注入 goal-runner。

- [ ] **Step 5: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/router/orchestrator.test.ts`，覆盖：
- 三方加权决策正确性
- 冷启动降级（无历史）
- 邻居主导（历史充足）
- 用户覆盖不污染邻居
- 配置权重可调

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat(phase-61): Orchestrator 邻居加权路由决策

新增 RoutingOrchestrator，整合 base classifier + 先验 + 邻居三方加权
论文借鉴：ACRouter Orchestrator 的三方信息整合 + OOD 适应
冷启动：无历史时降级为 base classifier"
```

---

## Task 4：Verifier 多路信号聚合（≥ 8 测试）

### 4.1 论文借鉴

ACRouter Verifier 在沙盒中聚合多路原生信号（编译/测试/类型检查/执行时长）打分，**不依赖 ground-truth**。RouteDev 的 [CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 当前仅高风险事后审查，用 LLM 判断质量，无结构化信号聚合。

### 4.2 设计

新增 `ExecutionVerifier` 类，聚合可在线运行的确定性信号：

```ts
// src/router/execution-verifier.ts
export class ExecutionVerifier {
  constructor(private readonly config: {
    enabled: boolean;
    signals: ('compile' | 'test' | 'typecheck' | 'latency')[];
    timeoutMs: number; // 默认 30000
  }) {}

  /**
   * 验证一次执行结果，返回 0-1 质量分
   * 不依赖 ground-truth，仅用沙盒原生信号
   */
  async verify(params: {
    modifiedFiles: string[];
    projectPath: string;
    executionMs: number;
  }): Promise<{
    qualityScore: number;
    trace: {
      compiled: boolean;
      testsPassed: boolean;
      typeCheckPassed: boolean;
      latencyMs: number;
    };
  }>;
}
```

**质量分计算**：
```
qualityScore = 0.3 × compileOk
             + 0.3 × testsPassed
             + 0.2 × typeCheckPassed
             + 0.2 × latencyScore
```
其中 latencyScore = max(0, 1 - latencyMs / budgetMs)。

### 4.3 接线点

- 新增：`src/router/execution-verifier.ts`
- 修改：`src/cli/goal-runner.ts` — 执行完成后调用 verify，结果写入 RoutingRecord（Task 1）
- 复用：现有 [completion-gate.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 的 spawnSync 经验（注意 C2 修复：Windows 不用 shell:true）

### 4.4 Step 分解

- [ ] **Step 1: 实现 ExecutionVerifier.verify**

按信号列表并行执行（用 Promise.allSettled），每个信号独立 try/catch，fail-open（信号失败不算 0 分，跳过该信号并重归一化权重）。

- [ ] **Step 2: 信号实现**

- compile：`tsc --noEmit` 退出码 0 → true
- test：`pnpm test --run` 退出码 0 → true（或仅跑受影响测试，超时 30s）
- typecheck：复用 compile 信号（TypeScript 项目）
- latency：直接取 executionMs

注意 Windows 安全：参考 [completion-gate.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 的 C2 修复，用 `npx.cmd` 而非 `shell: true`。

- [ ] **Step 3: 质量分归一化**

按权重计算，fail-open 时重归一化（如 compile 失败则剩余权重和为 0.7，归一化到 [0,1]）。

- [ ] **Step 4: 接入 goal-runner**

在 [goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts) 执行完成后，若 config 启用，调用 verify，结果填入 RoutingRecord.qualityScore 和 verificationTrace。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 ExecutionVerifierConfig：

```ts
executionVerifier: z.object({
  enabled: z.boolean().default(false),
  signals: z.array(z.enum(['compile', 'test', 'typecheck', 'latency'])).default(['compile', 'typecheck', 'latency']),
  timeoutMs: z.number().int().default(30000),
}).default({}),
```

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/router/execution-verifier.test.ts`，覆盖：
- 全信号通过 → 高分
- 部分信号失败 → 中分
- 信号超时 fail-open
- Windows 命令安全（不用 shell:true）
- 配置关闭时跳过

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-61): Verifier 多路信号聚合验证

新增 ExecutionVerifier，沙盒聚合 compile/test/typecheck/latency 信号
论文借鉴：ACRouter Verifier 不依赖 ground-truth 的多路信号聚合
安全：Windows 不用 shell:true（复用 Phase 53 C2 修复）"
```

---

## Task 5：累积遗憾自评指标与仪表盘（≥ 6 测试）

### 5.1 论文借鉴

论文证明单次准确率无法区分"运气好选对一次"和"持续接近最优"，用**累积遗憾**（cumulative regret）替代——每题相对于 oracle（每题最优模型）的差距累积。CodeRouterBench 预采集"每题×每模型"结果矩阵使流式累积遗憾可计算。

### 5.2 设计

新增 `RoutingRegretTracker` 类：

```ts
// src/router/regret-tracker.ts
export class RoutingRegretTracker {
  constructor(private readonly history: RoutingHistory) {}

  /**
   * 计算累积遗憾
   * regret_t = Σ_{i=1..t} (oracleQuality_i - chosenQuality_i)
   * 其中 oracleQuality_i = max over all models of (历史记录中该模型在该任务上的 qualityScore)
   */
  computeCumulativeRegret(): {
    regret: number;
    regretCurve: { timestamp: number; cumulativeRegret: number }[];
    perModelRegret: Map<string, number>;
  };

  /**
   * 计算 regret 的移动平均（滑动窗口，默认 50 题）
   */
  computeMovingAverageRegret(windowSize?: number): number;
}
```

**Oracle 近似**：由于 RouteDev 无法对每题跑所有模型，oracle 用"历史中该 task signature 上所有模型的最大 qualityScore"近似。若无历史对比，该题不计入 regret。

### 5.3 接线点

- 新增：`src/router/regret-tracker.ts`
- 新增：`src/cli/commands/router-stats.ts` — 新增 `/router-stats` 命令展示 regret
- 修改：desktop renderer — 设置页 Router Tab 增加 regret 仪表盘

### 5.4 Step 分解

- [ ] **Step 1: 实现 computeCumulativeRegret**

遍历 history.records，对每条记录查"同 task signature 的所有模型最大 qualityScore"作 oracle，累加 (oracle - chosen)。

- [ ] **Step 2: 实现 computeMovingAverageRegret**

滑动窗口 50，返回近期 regret 趋势。

- [ ] **Step 3: /router-stats 命令**

新增 CLI 命令，输出：
- 总累积遗憾
- 近 50 题移动平均遗憾
- 各模型 regret 贡献（哪个模型拖后腿）
- 各 classifier tier 的 regret 分布

- [ ] **Step 4: 仪表盘**

在 desktop renderer 设置页 Router Tab 增加图表：
- 累积遗憾曲线
- 各模型平均 quality / cost / latency 对比
- 邻居命中率（查询有多少返回了邻居）

- [ ] **Step 5: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/router/regret-tracker.test.ts`，覆盖：
- 单题无对比 → 不计入 regret
- 多题对比 → regret 累积正确
- 移动平均窗口
- perModelRegret 聚合
- 空历史降级

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat(phase-61): 累积遗憾自评指标与仪表盘

新增 RoutingRegretTracker + /router-stats 命令
论文借鉴：ACRouter 用累积遗憾替代单次准确率评测 router
oracle 近似：同 task signature 历史最大 qualityScore"
```

---

## Task 6：配置收口、设置页与全量验证（≥ 4 测试）

### 6.1 目标

收口 Phase 61 所有配置项，确保设置页可调，全量验证通过。

### 6.2 Step 分解

- [ ] **Step 1: 配置 schema 收口**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 RouterConfigSchema 增加顶层 `closedLoopRouting` 字段，聚合 Task 1-5 的所有子配置：

```ts
closedLoopRouting: z.object({
  enabled: z.boolean().default(false), // 总开关
  history: z.object({
    maxRecords: z.number().int().default(20000),
    persistPath: z.string().default('.routedev/routing-history.jsonl'),
  }).default({}),
  memory: z.object({
    enabled: z.boolean().default(false),
    topK: z.number().int().min(1).max(50).default(10),
    minSimilarity: z.number().min(0).max(1).default(0.3),
    embeddingProvider: z.enum(['openai', 'hash']).default('hash'),
  }).default({}),
  orchestrator: z.object({
    neighborWeight: z.number().min(0).max(1).default(0.6),
    priorWeight: z.number().min(0).max(1).default(0.3),
    baseWeight: z.number().min(0).max(1).default(0.1),
  }).default({}),
  verifier: z.object({
    enabled: z.boolean().default(false),
    signals: z.array(z.enum(['compile', 'test', 'typecheck', 'latency'])).default(['compile', 'typecheck', 'latency']),
    timeoutMs: z.number().int().default(30000),
  }).default({}),
}).default({}),
```

- [ ] **Step 2: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加对应默认值。

- [ ] **Step 3: 设置页 UI**

在 desktop renderer 设置页 Router Tab 增加"闭环路由"分区：
- 总开关
- 子开关（Memory / Verifier）
- 参数滑块（topK / minSimilarity / 三方权重）
- regret 仪表盘（Task 5）
- "立即清除路由历史"按钮

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 4: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 40 个测试通过。

- [ ] **Step 5: 文档同步**

更新 README.md 与 ARCHITECTURE.md，说明闭环路由架构。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat(phase-61): 配置收口、设置页与全量验证

闭环路由总开关 + 子开关 + 参数滑块 + regret 仪表盘
论文借鉴：ACRouter C-A-F 闭环路由完整落地
版本：v4.6.0"
```

---

## 风险与回滚

### 风险 1：Memory 查询拖慢路由决策
- **缓解**：Memory 查询设超时（默认 500ms），超时降级为 base classifier
- **回滚**：关闭 `closedLoopRouting.enabled` 总开关

### 风险 2：Verifier 执行编译/测试拖慢主流程
- **缓解**：Verifier 异步执行，不阻塞用户响应；超时 30s fail-open
- **回滚**：关闭 `closedLoopRouting.verifier.enabled`

### 风险 3：routing-history.jsonl 膨胀
- **缓解**：FIFO 20000 条上限；提供"立即清除"按钮
- **回滚**：删除 `.routedev/routing-history.jsonl`

### 风险 4：邻居加权决策劣于原 classifier
- **缓解**：累积遗憾监控，若近 50 题 regret 高于关闭闭环时的基线，自动降级
- **回滚**：关闭 `closedLoopRouting.memory.enabled`，仅保留 history 记录

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 40 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] 闭环路由总开关默认关闭，设置页可开启
- [ ] 开启后路由决策参考历史邻居（可从 /router-stats 命令查看邻居命中率）
- [ ] Verifier 异步执行不阻塞主流程
- [ ] 累积遗憾仪表盘可查看
- [ ] routing-history.jsonl 持久化与恢复正常
- [ ] fail-open：Memory/Verifier 失败时降级为现有 classifier
- [ ] README.md 与 ARCHITECTURE.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中

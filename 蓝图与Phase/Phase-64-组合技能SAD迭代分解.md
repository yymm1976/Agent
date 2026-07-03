# Phase 64 — 组合技能 SAD 迭代分解

> **版本目标：** v4.6.3
> **前置依赖：** Phase 63 完成
> **后继依赖：** Phase 65（记忆系统四模块重构）依赖本 Phase 的 Bi-encoder 检索基础设施
> **新增测试要求：** ≥ 40 个
> **研究依据：** 精读 arXiv:2606.18051《Compositional Skill Routing for LLM Agents: Decompose, Retrieve, and Compose》（Xueping Gao，2026-06）全文。论文将组合式技能路由形式化为 q → (D 分解, σ 映射, G 执行DAG)，**核心发现是分解质量是首要瓶颈**——标准 LLM 分解在 2209 真实 MCP 技能上仅 34.2% 步骤级类别召回。论文落地 **SAD（Skill-Aware Decomposition）**：检索增强反馈回路将检索到的技能作为 hints 反馈回分解输入（input-side feedback，区别于 Self-RAG/ReAct 的 output-side feedback），用不动点迭代保证收敛。SAD 单次迭代 DA 从 51.0% → 67.7%（+32.7%，Wilcoxon p<10⁻⁶），且**增益完全来自粒度修正**——在两种方法都产生正确步数的 128 个查询上 CatR@1 统计相同（41.7% vs 40.9%, p=0.97）。上下文窗口从全技能 884K tokens 压缩到平均 1,160 tokens（99.9% 减少）。Bi-encoder 用 all-MiniLM-L6-v2（384 维）+ FAISS 精确内积，metadata-only 编码即达 CatR@10=69.0%。论文揭示级联瓶颈结构：分解粒度 → 门控检索质量 → 门控执行质量；Oracle step-count baseline 给定完美步数 DA=99.3% 但 CatR@1 仅 39.8%，暴露独立的表示级瓶颈（40% top-1 vs 79% top-10）。
> **核心命题：** RouteDev 的 [compositional-router](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) 当前虽有 `decomposeWithSkillAwareness` 迭代，但是**输出侧**重分解——只对"未匹配的子任务"再分解，没有把检索到的候选技能作为 hints 反馈到分解器的输入。论文 SAD 的关键创新是**输入侧反馈**：Pass1 分解整查询 → 检索候选 → 构建 hint set H → 若 Jaccard(Hⁱ, Hⁱ⁻¹) > τ=0.6 则收敛 → 否则带 H 重分解整查询。Phase 64 把 SAD 的 two-pass 输入侧反馈、Bi-encoder 检索、分解粒度审计、兼容性感知 DAG 组合、上下文窗口优化完整落地。

---

## 项目现状审计与可行性结论

### 1. 论文与 RouteDev 缺口的映射

| SAD 组件 | 核心 Contribution | RouteDev 现状缺口 | Phase 64 Task |
|---------------|-------------------|-------------------|---------------|
| 输入侧 hint 反馈回路 | 检索候选作为 hints 反馈到分解器输入（区别于 output-side） | `decomposeWithSkillAwareness` 仅对未匹配子任务 output-side 重分解，无 hint 反馈到整查询 | Task 1（SAD two-pass） |
| Bi-encoder 检索 | all-MiniLM-L6-v2（384 维）+ FAISS 精确内积，metadata-only 编码 CatR@10=69.0% | `retrieveSkill` 用关键词匹配 + Jaccard 模拟语义，无 embedding | Task 2（Bi-encoder + FAISS） |
| 分解粒度审计 | SAD 增益完全来自粒度修正（14B 模型 4.72 步 → SAD 3.18 步） | 无分解步数合理性检查；CrossModelReviewer 5 维度无"粒度"维度 | Task 3（DA 指标 + 粒度审计） |
| 兼容性感知组合 | DAG 节点间 I/O 兼容性影响执行质量 | `composeDAG` 仅按类别串行 + 数据依赖提示词，无 I/O 类型兼容性评分 | Task 4（兼容性感知 DAG） |
| 上下文窗口优化 | 全技能 884K → 平均 1,160 tokens（99.9% 减少） | 路由时暴露全部 24+ 类别技能，上下文膨胀 | Task 5（按子任务检索 2-5 技能） |
| 收敛与不动点 | Jaccard(Hⁱ, Hⁱ⁻¹) > τ=0.6 终止；Round 1 捕获全部 DA 提升 | 现有迭代按 maxIterations 硬终止，无收敛检测 | Task 1（收敛判定） |

### 2. 可行性总评

- **Task 1（SAD two-pass 输入侧反馈）：** 高度可行。`decomposeWithSkillAwareness` 已有迭代骨架，只需把"重分解未匹配子任务"改为"检索候选→构建 hint set→带 hint 重分解整查询 + 收敛判定"。
- **Task 2（Bi-encoder + FAISS）：** 可行。Node 生态用 `@xenova/transformers`（Transformers.js）在进程内加载 all-MiniLM-L6-v2 生成 384 维向量；FAISS 原生无 Node 绑定，降级为内存内积矩阵（技能库 <1K 规模足够），可选 `hnswlib-wasm` 做近邻。复用 [ccr-cache.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 hash 思路做 embedding 缓存。
- **Task 3（DA 指标 + 粒度审计）：** 可行。在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 增加第 6 维度"分解粒度合理性"，并新增 DA（步骤级类别召回）离线指标。
- **Task 4（兼容性感知 DAG）：** 可行。在 `composeDAG` 调 `topologicalSort` 前插入 I/O 类型 / 类别 Jaccard / 关键词共现的兼容性评分，低兼容性边降权或剪枝。
- **Task 5（上下文窗口优化）：** 可行。按子任务检索 top-2~5 技能而非暴露全库；复用 Task 2 的 Bi-encoder。
- **Task 6（配置收口与全量验证）：** 高度可行。遵循 Phase 51 反写死原则，所有新能力默认关闭。

---

## 核心设计原则

### 原则 1：输入侧反馈优先于输出侧重分解

论文 SAD 的核心创新是把检索到的候选技能作为 hints 反馈到分解器的**输入**（input-side），而非对未匹配子任务做 output-side 再分解。RouteDev 现有 `decomposeWithSkillAwareness` 是 output-side，Phase 64 的 Task 1 必须把 hint 反馈到整查询的分解 prompt，让 LLM 在"看见技能库轮廓"的前提下调整粒度。

### 原则 2：粒度是首要瓶颈，表示是次要瓶颈

论文证明 SAD 增益完全来自粒度修正（同正确步数下 CatR@1 统计相同），但 Oracle step-count 给完美步数时 CatR@1 仍仅 39.8%（top-10 才 79%）——表示级瓶颈独立存在。Phase 64 必须双管齐下：Task 1/3 攻粒度，Task 2 攻表示。

### 原则 3：收敛优先于固定迭代轮数

论文 Algorithm 1 用 Jaccard(Hⁱ, Hⁱ⁻¹) > τ=0.6 判定收敛，Round 1 即捕获全部 DA 提升。Phase 64 的迭代必须实现收敛判定，避免无意义的多轮 LLM 调用（延迟敏感场景默认 T=1 two-pass）。

### 原则 4：反写死原则（延续 Phase 51）

所有新增能力（SAD 回路 / Bi-encoder / 粒度审计 / 兼容性评分 / 上下文优化）必须有配置开关、设置页面入口、明确代码接线点。默认关闭，用户在设置页开启。

### 原则 5：Fail-open 与降级

Bi-encoder 模型加载失败 / FAISS 不可用 / 收敛判定异常时，降级为现有关键词 + Jaccard 检索，不阻塞主流程。论文 metadata-only 编码已足够强，降级路径不会显著劣化体验。

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

## Task 1：SAD two-pass 输入侧反馈回路（≥ 8 测试）

### 1.1 论文借鉴

论文 Algorithm 1 的 SAD 不动点迭代：
1. D⁽⁰⁾ ← LLM(q)（Pass1：零样本分解整查询）
2. 对 D⁽⁰⁾ 每个子任务检索候选技能 → 构建 hint set H⁽⁰⁾
3. 若 Jaccard(H⁽ⁱ⁾, H⁽ⁱ⁻¹⁾) > τ=0.6 → 收敛，返回 D⁽ⁱ⁾
4. 否则 D⁽ⁱ⁺¹⁾ ← LLM(q, H⁽ⁱ⁾)（Pass2+：带 hint 重分解整查询）

RouteDev 现有 [decomposeWithSkillAwareness](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) 是 output-side：只对 `retrieveSkill` 返回 null 的子任务调 `decomposeFn(sub.description)` 再分解，**没有把候选技能作为 hint 反馈到整查询的分解 prompt**。论文证明这种 input-side 反馈才是 SAD 增益的来源（DA 51.0% → 67.7%）。

### 1.2 设计

新增 `decomposeWithSAD` 函数（与现有 `decomposeWithSkillAwareness` 并存，配置切换）：

```ts
// src/skills/sad-decomposer.ts
/**
 * SAD 不动点迭代分解（输入侧 hint 反馈）
 *
 * 论文 Algorithm 1：
 *   Pass1: D⁽⁰⁾ ← LLM(q)
 *   检索候选 → 构建 hint set H
 *   若 Jaccard(Hⁱ, Hⁱ⁻¹) > τ → 收敛
 *   否则 D⁽ⁱ⁺¹⁾ ← LLM(q, Hⁱ)  ← 关键：hint 进输入
 *
 * @param task 整查询
 * @param availableSkills 可用技能库
 * @param config SAD 配置
 * @param decomposeFn 分解器（注入，支持带 hints 的重载）
 * @param retrieveFn 检索器（注入，Task 2 后用 Bi-encoder，否则降级关键词）
 */
export async function decomposeWithSAD(
  task: string,
  availableSkills: Array<{ id: string; name: string; description: string; category: string }>,
  config: SADConfig,
  decomposeFn: (task: string, hints?: string[]) => Promise<AtomicSubTask[]>,
  retrieveFn: (subTask: AtomicSubTask, skills: typeof availableSkills) => SkillMatch | null,
): Promise<{ subTasks: AtomicSubTask[]; iterations: number; converged: boolean; hintJaccard: number[] }> {
  const maxIter = Math.max(1, config.maxIterations); // 默认 T=1（two-pass）
  const tau = config.convergenceTau;                  // 默认 0.6（论文值）

  // Pass1：零样本分解整查询
  let currentSubTasks = await decomposeFn(task);
  if (currentSubTasks.length === 0) {
    return { subTasks: [], iterations: 0, converged: true, hintJaccard: [] };
  }

  let prevHintSet = new Set<string>();
  const hintJaccardHistory: number[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    // 为每个子任务检索候选，构建 hint set
    const currentHintSet = new Set<string>();
    for (const sub of currentSubTasks) {
      const match = retrieveFn(sub, availableSkills);
      if (match && match.confidence > 0) {
        // hint = 命中技能的 name⊕category（论文用 metadata 编码）
        currentHintSet.add(`${match.skillName}:${match.category}`);
      }
    }

    // 收敛判定：Jaccard(Hⁱ, Hⁱ⁻¹) > τ
    const jac = jaccardSimilarity(currentHintSet, prevHintSet);
    hintJaccardHistory.push(jac);
    if (iter > 0 && jac > tau) {
      return { subTasks: currentSubTasks, iterations: iter + 1, converged: true, hintJaccard: hintJaccardHistory };
    }

    // 未收敛且未达上限 → 带 hint 重分解整查询（输入侧反馈）
    if (iter + 1 < maxIter) {
      const hints = Array.from(currentHintSet);
      try {
        const refined = await decomposeFn(task, hints);
        if (refined.length > 0) {
          currentSubTasks = refined;
        }
      } catch (err) {
        // 重分解失败 → 保留当前结果，终止迭代（fail-open）
        logger.warn('SAD: 带 hint 重分解失败，终止迭代', { error: err instanceof Error ? err.message : String(err) });
        return { subTasks: currentSubTasks, iterations: iter + 1, converged: false, hintJaccard: hintJaccardHistory };
      }
    }
    prevHintSet = currentHintSet;
  }

  return { subTasks: currentSubTasks, iterations: maxIter, converged: false, hintJaccard: hintJaccardHistory };
}

/** SAD 配置 */
export interface SADConfig {
  /** 最大迭代次数（论文默认 T=1 即 two-pass；T=2 精度优先） */
  maxIterations: number;
  /** 收敛 Jaccard 阈值（论文 τ=0.6） */
  convergenceTau: number;
  /** 是否启用输入侧 hint 反馈（false 时降级为 output-side 重分解） */
  inputSideFeedback: boolean;
}
```

### 1.3 接线点

- 新增：`src/skills/sad-decomposer.ts`
- 修改：`src/skills/compositional-router.ts` — 导出 `jaccardSimilarity` 供复用（当前为模块私有）
- 修改：调用方（如 `compose-pipeline` 或 skill 调度入口）— 配置启用 SAD 时调 `decomposeWithSAD`，否则保留 `decomposeWithSkillAwareness`

### 1.4 Step 分解

- [ ] **Step 1: 导出 jaccardSimilarity 与定义 SADConfig**

在 [compositional-router.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) 把 `jaccardSimilarity` 从模块私有改为 `export`。新建 `src/skills/sad-decomposer.ts` 定义 `SADConfig` 与 `decomposeWithSAD` 签名。

- [ ] **Step 2: 实现 Pass1 零样本分解与 hint set 构建**

`decomposeWithSAD` 首轮调用 `decomposeFn(task)`（无 hints）得到 D⁽⁰⁾；遍历子任务调 `retrieveFn`，把命中技能的 `name:category` 加入 `currentHintSet`。

- [ ] **Step 3: 实现收敛判定**

计算 `jaccardSimilarity(currentHintSet, prevHintSet)`，记录到 `hintJaccardHistory`。首轮（iter=0）无前序，跳过收敛判定。`iter > 0 && jac > tau` → 返回 converged=true。

- [ ] **Step 4: 实现输入侧 hint 反馈重分解**

未收敛且未达上限时，调 `decomposeFn(task, Array.from(currentHintSet))` 带 hint 重分解整查询。`decomposeFn` 的第二参数 hints 由调用方拼接到 prompt（如"已检索到以下候选技能，请据此调整分解粒度：..."）。重分解失败 fail-open，保留当前结果。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `SADConfig`（隶属 SkillRoutingConfig，Task 6 收口）。默认 `maxIterations: 1`、`convergenceTau: 0.6`、`inputSideFeedback: true`（与 Task 6 schema 收口保持一致）。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/sad-decomposer.test.ts`，覆盖：
- Pass1 单轮即收敛（hint set 为空时 Jaccard=0，不触发收敛，但 maxIter=1 直接返回）
- Pass2 带 hint 重分解整查询（验证 decomposeFn 第二参数被传入）
- 收敛判定（Jaccard > τ 提前终止，不耗尽 maxIter）
- 不动点保证（有限技能库 → hint set 有限 → 必收敛）
- 重分解失败 fail-open（保留 Pass1 结果）
- maxIter=1 时只做 two-pass 不再迭代
- inputSideFeedback=false 时降级为 output-side（复用现有逻辑）
- 空 D⁽⁰⁾ 直接返回

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-64): SAD two-pass 输入侧 hint 反馈回路

新增 decomposeWithSAD，检索候选作为 hints 反馈到分解器输入
论文借鉴：arXiv:2606.18051 Algorithm 1（input-side feedback）
收敛：Jaccard(Hⁱ, Hⁱ⁻¹) > τ=0.6 不动点判定
默认 T=1 two-pass，降级保留 output-side 重分解"
```

---

## Task 2：Bi-encoder 技能检索 + FAISS 索引（≥ 8 测试）

### 2.1 论文借鉴

论文 Bi-encoder 用 all-MiniLM-L6-v2（384 维）对每个技能的 metadata（name⊕description）编码，FAISS 精确内积搜索。关键数据：metadata-only 编码即达 CatR@10=69.0%；全技能 884K tokens → 平均 1,160 tokens（99.9% 减少）。论文证明表示级瓶颈独立存在（Oracle step-count 时 CatR@1 仅 39.8% vs top-10 79%），Bi-encoder 是攻表示瓶颈的核心手段。

RouteDev 现有 [retrieveSkill](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) 用关键词匹配率 + Jaccard 模拟语义，无真实 embedding。

### 2.2 设计

新增 `BiEncoderSkillRetriever`：

```ts
// src/skills/bi-encoder-retriever.ts
import type { SkillMetadata } from './skill-md-parser.js';

/**
 * Bi-encoder 技能检索器
 *
 * 论文：all-MiniLM-L6-v2（384 维）+ FAISS 精确内积
 * RouteDev 落地：
 *   - 进程内 embedding 用 @xenova/transformers 加载 all-MiniLM-L6-v2
 *   - FAISS 无 Node 原生绑定 → 降级为内存内积矩阵（技能库 <1K 足够）
 *   - 可选 hnswlib-wasm 做近似近邻（技能库 >1K 时启用）
 *   - embedding 缓存：以 skill.id + metadata hash 为 key（复用 ccr-cache 思路）
 */
export class BiEncoderSkillRetriever {
  private index: Float32Array[] = [];     // 每行 384 维
  private skillIds: string[] = [];
  private embedder: Embedder | null = null;
  private readonly cache = new Map<string, number[]>(); // hash → embedding

  constructor(private readonly config: {
    enabled: boolean;
    modelId: string;          // 默认 'Xenova/all-MiniLM-L6-v2'
    topK: number;             // 默认 10
    minScore: number;         // 默认 0.2
    backend: 'memory' | 'hnswlib'; // 默认 'memory'
  }) {}

  /** 异步初始化（加载模型 + 构建索引） */
  async initialize(skills: Array<{ id: string; metadata: SkillMetadata; category: string }>): Promise<void>;

  /** 检索子任务最匹配的技能（替代 retrieveSkill） */
  async retrieve(subTask: AtomicSubTask): Promise<SkillMatch | null>;

  /** 批量检索 top-K（供 Task 5 上下文优化用） */
  async retrieveTopK(subTask: AtomicSubTask, k: number): Promise<SkillMatch[]>;

  /** 索引是否就绪（未就绪时调用方降级关键词检索） */
  isReady(): boolean;
}

/** Embedder 接口（与 Phase 61 HashEmbedder 复用） */
export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

**降级策略**：模型加载失败 / 索引未就绪时，`retrieve` 返回 null，调用方降级为现有 `retrieveSkill`（关键词 + Jaccard）。

### 2.3 接线点

- 新增：`src/skills/bi-encoder-retriever.ts`
- 新增：`src/skills/embedder.ts`（与 Phase 61 的 `src/router/embedder.ts` 统一接口，可后续合并）
- 修改：`src/skills/compositional-router.ts` — `decomposeWithSAD` 与 `decomposeWithSkillAwareness` 的 `retrieveFn` 参数可注入 BiEncoderSkillRetriever
- 复用：[ccr-cache.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 hash 缓存思路
- 依赖：`@xenova/transformers`（package.json 新增，按需 dynamic import 避免阻塞启动）

### 2.4 Step 分解

- [ ] **Step 1: 添加依赖与 Embedder 接口**

在 [package.json](file:///c:/Users/杨铭/Desktop/Agent/routedev/package.json) 增加 `@xenova/transformers`（peer optional，按需 dynamic import）。新建 `src/skills/embedder.ts` 定义 `Embedder` 接口，提供 `TransformersEmbedder`（加载 all-MiniLM-L6-v2）与 `HashEmbedder`（降级，复用 Phase 61 hash trick 384 维稀疏）。

- [ ] **Step 2: 实现 BiEncoderSkillRetriever.initialize**

遍历技能库，对每个技能 `metadata.name + ' ' + metadata.description` 编码（论文 metadata-only），存入 `this.index`（Float32Array[]）。embedding 缓存以 `skill.id + ':' + sha256(text).slice(0,12)` 为 key。L2 归一化使内积等价于 cosine。

- [ ] **Step 3: 实现 retrieve 与 retrieveTopK**

子任务 description 编码 → 与索引逐行算内积（memory 后端）→ 取 top-K → 过滤 score < minScore → 返回 SkillMatch。`backend: 'hnswlib'` 时用 hnswlib-wasm 建索引（技能库 >1K 启用）。

- [ ] **Step 4: fail-open 与降级**

模型加载失败 / 索引未就绪 → `isReady()` 返回 false → `retrieve` 返回 null → 调用方降级 `retrieveSkill`（关键词 + Jaccard）。所有异常 try/catch 不抛出。

- [ ] **Step 5: 接入 SAD 回路**

在 SAD 调度入口，若 `biEncoder.enabled && retriever.isReady()`，注入 `retriever.retrieve.bind(retriever)` 作为 `retrieveFn`；否则注入现有 `retrieveSkill`。

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `BiEncoderConfig`（隶属 SkillRoutingConfig）：

```ts
biEncoder: z.object({
  enabled: z.boolean().default(false),
  modelId: z.string().default('Xenova/all-MiniLM-L6-v2'),
  topK: z.number().int().min(1).max(50).default(10),
  minScore: z.number().min(0).max(1).default(0.2),
  backend: z.enum(['memory', 'hnswlib']).default('memory'),
}).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/bi-encoder-retriever.test.ts`，覆盖：
- initialize 构建索引正确（embedding 维度 384）
- retrieve top-K 与 minScore 过滤
- L2 归一化使内积等价 cosine
- 模型加载失败 fail-open（isReady=false，retrieve 返回 null）
- 索引未就绪降级
- embedding 缓存命中（同输入返回同向量）
- 空技能库降级
- 批量 retrieveTopK 正确性

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-64): Bi-encoder 技能检索 + FAISS 索引

新增 BiEncoderSkillRetriever，all-MiniLM-L6-v2 metadata-only 编码
论文借鉴：arXiv:2606.18051 Bi-encoder CatR@10=69.0%
降级：模型不可用时回退关键词+Jaccard检索
缓存：复用 ccr-cache hash 思路"
```

---

## Task 3：分解粒度审计 DA 指标（≥ 6 测试）

### 3.1 论文借鉴

论文核心发现：**SAD 增益完全来自粒度修正**——在两种方法都产生正确步数的 128 个查询上 CatR@1 统计相同（41.7% vs 40.9%, p=0.97）。14B 模型倾向过度分解（4.72 步 vs ground truth 2.94），SAD 修正到 3.18 步。论文定义 DA（Decompose Accuracy）= 步骤级类别召回，标准 LLM 分解仅 34.2%，SAD 单次迭代 67.7%。

RouteDev 的 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 当前 5 维度（安全/性能/可读/边界/错误处理）无"分解粒度合理性"维度。

### 3.2 设计

新增 `DecompositionGranularityAuditor`（独立模块，供 CrossModelReviewer 调用）：

```ts
// src/skills/granularity-auditor.ts

/**
 * 分解粒度审计器
 *
 * 论文：SAD 增益来自粒度修正；过度分解（步数 >> ground truth）与
 * 欠分解（步数 << ground truth）都损害 CatR@1。
 *
 * 审计维度：
 *   1. 步数合理性：步数是否在 [minExpected, maxExpected] 区间
 *   2. 子任务粒度一致性：是否混入"过粗"（一个子任务需多技能）或"过细"（多子任务合一更合理）
 *   3. 类别覆盖：expectedSkillCategory 是否覆盖查询的显式需求类别
 */
export class DecompositionGranularityAuditor {
  constructor(private readonly config: {
    enabled: boolean;
    /** 经验步数区间（默认按查询长度启发式：短查询 1-3 步，长查询 2-6 步） */
    stepCountHeuristic: (query: string) => { min: number; max: number };
  }) {}

  /**
   * 审计分解结果，返回粒度问题清单
   */
  audit(params: {
    query: string;
    subTasks: AtomicSubTask[];
  }): GranularityIssue[];

  /**
   * 计算 DA（步骤级类别召回）——离线评测用
   * 需要 ground truth 类别列表
   */
  computeDA(predicted: AtomicSubTask[], groundTruthCategories: string[]): {
    da: number;           // 步骤级类别召回
    stepCount: number;
    overDecomposed: boolean;
  };
}

export interface GranularityIssue {
  severity: 'critical' | 'warning' | 'info';
  type: 'over_decomposed' | 'under_decomposed' | 'inconsistent_granularity' | 'missing_category';
  description: string;
  suggestedStepCount?: number;
}
```

**CrossModelReviewer 扩展**：在现有 5 维度后增加第 6 维度"分解粒度合理性"，调用 `auditor.audit`，把 `GranularityIssue` 转为 `CodeReviewIssue`（severity 映射）。

### 3.3 接线点

- 新增：`src/skills/granularity-auditor.ts`
- 修改：`src/agent/cross-model-reviewer.ts` — `CROSS_MODEL_REVIEW_SYSTEM_PROMPT` 增加第 6 维度；审查入口调用 `auditor.audit`
- 修改：`src/agent/dual-loop-types.ts` — `CrossModelReviewParams` 增加可选 `decomposition?: { query: string; subTasks: AtomicSubTask[] }` 字段

### 3.4 Step 分解

- [ ] **Step 1: 实现 stepCountHeuristic**

按查询 token 数启发式：`<20 token → 1-2 步`、`20-60 → 2-4 步`、`60-120 → 3-6 步`、`>120 → 4-8 步`。可配置覆盖。

- [ ] **Step 2: 实现 audit**

步数超出 [min, max] → over_decomposed / under_decomposed。子任务 description 长度方差过大 → inconsistent_granularity。查询显式类别词（如"测试""审查""重构"）未在 expectedSkillCategory 出现 → missing_category。

- [ ] **Step 3: 实现 computeDA**

`da = |predicted 类别 ∩ groundTruth 类别| / |groundTruth 类别|`。`overDecomposed = predicted.length > groundTruth.length * 1.5`。

- [ ] **Step 4: 接入 CrossModelReviewer**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 审查入口，若 `params.decomposition` 存在且 `auditor.config.enabled`，调 `auditor.audit`，把结果转为 `CodeReviewIssue[]` 合并到 `reviewResult.issues`。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `GranularityAuditConfig`（隶属 SkillRoutingConfig）。默认 `enabled: false`。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/granularity-auditor.test.ts`，覆盖：
- 短查询步数区间启发式
- 长查询步数区间启发式
- 过度分解检测（步数 >> max）
- 欠分解检测（步数 << min）
- 粒度不一致检测（description 长度方差大）
- missing_category 检测
- computeDA 类别召回计算
- 配置关闭时跳过

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-64): 分解粒度审计 DA 指标

新增 DecompositionGranularityAuditor，CrossModelReviewer 增加第 6 维度
论文借鉴：arXiv:2606.18051 SAD 增益完全来自粒度修正
指标：DA 步骤级类别召回，过度分解检测（14B 模型 4.72 步→3.18 步）"
```

---

## Task 4：兼容性感知 DAG 组合（≥ 6 测试）

### 4.1 论文借鉴

论文级联瓶颈结构：分解粒度 → 门控检索质量 → 门控执行质量。DAG 组合是"执行质量"环节——即使分解和检索正确，节点间 I/O 不兼容也会导致执行失败。论文未深入 DAG 兼容性，但 Oracle step-count baseline 暴露的表示级瓶颈提示：节点间连接质量独立影响结果。

RouteDev 现有 [composeDAG](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) 仅按类别串行（control 边）+ 数据依赖提示词（data 边），无 I/O 类型兼容性评分。

### 4.2 设计

新增 `CompatibilityScorer`，在 `composeDAG` 调 `topologicalSort` 前对候选边评分：

```ts
// src/skills/compatibility-scorer.ts

/**
 * 兼容性评分器
 *
 * 在 composeDAG 构造边前，对每对 (前驱, 后继) 计算兼容性分数：
 *   1. I/O 类型兼容：前驱产出类型 ⊇ 后继输入类型（基于 SkillMetadata.tags 启发式）
 *   2. 类别 Jaccard：expectedSkillCategory 集合的 Jaccard 相似度
 *   3. 关键词共现：description 关键词重叠率
 *
 * 低兼容性边降权（control 边权重 *= score）或剪枝（score < threshold 不加边）
 */
export class CompatibilityScorer {
  constructor(private readonly config: {
    enabled: boolean;
    /** 低于此分数的边剪枝（默认 0.15） */
    pruneThreshold: number;
    /** 三因子权重 */
    weights: { ioType: number; categoryJaccard: number; keywordCoOccur: number };
  }) {}

  /**
   * 计算两节点的兼容性分数（0-1）
   */
  score(predecessor: SkillDAGNode, successor: SkillDAGNode): number;

  /**
   * 对候选边列表过滤 + 降权
   */
  filterEdges(
    candidates: Array<{ from: SkillDAGNode; to: SkillDAGNode; dependencyType: 'data' | 'control' }>,
  ): Array<{ from: string; to: string; dependencyType: 'data' | 'control'; weight: number }>;
}
```

**composeDAG 增强**：构造边时调 `scorer.filterEdges`，低兼容性 control 边剪枝（不同类技能本就该并行，剪枝符合"不同类并行"语义）；data 边保留但带 weight 供后续调度参考。

### 4.3 接线点

- 新增：`src/skills/compatibility-scorer.ts`
- 修改：`src/skills/compositional-router.ts` — `composeDAG` 增加可选 `scorer?: CompatibilityScorer` 参数；构造边后调 `scorer.filterEdges`
- 复用：`extractKeywords`、`jaccardSimilarity`（从 compositional-router 导出）

### 4.4 Step 分解

- [ ] **Step 1: 实现 score 三因子**

ioType：前驱 tags 与后继 tags 的包含关系（前驱产出 ⊇ 后继输入 → 1.0，部分重叠 → 0.5，无重叠 → 0）。categoryJaccard：expectedSkillCategory 集合 Jaccard。keywordCoOccur：description 关键词重叠率。加权求和归一化到 [0,1]。

- [ ] **Step 2: 实现 filterEdges**

遍历候选边，`score < pruneThreshold` 剪枝；保留边附 `weight = score`。data 边因有显式依赖提示词，pruneThreshold 降至 0.05（避免误剪真实数据依赖）。

- [ ] **Step 3: 接入 composeDAG**

在 [composeDAG](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) 构造 control 边与 data 边后，若 `scorer` 注入且 `enabled`，调 `scorer.filterEdges`。`SkillDAGPlan.edges` 类型扩展增加可选 `weight` 字段（向后兼容，现有逻辑忽略 weight）。

- [ ] **Step 4: 环检测保护**

剪枝后重新调 `hasCycle` 确认无环（剪枝只会减边，理论上不会引入环，但防御性检查）。若意外成环（不应发生），保留全部边并 warn。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `CompatibilityScorerConfig`（隶属 SkillRoutingConfig）。默认 `enabled: false`。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/compatibility-scorer.test.ts`，覆盖：
- score 三因子加权正确性
- I/O 类型完全兼容 → 高分
- 类别无交集 → 低分
- 关键词无重叠 → 低分
- filterEdges 剪枝低分边
- data 边低阈值保护（不误剪）
- 配置关闭时 composeDAG 行为不变
- 剪枝后无环

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-64): 兼容性感知 DAG 组合

新增 CompatibilityScorer，composeDAG 调 topologicalSort 前评分剪枝
三因子：I/O 类型 / 类别 Jaccard / 关键词共现
论文借鉴：arXiv:2606.18051 级联瓶颈结构（执行质量环节）"
```

---

## Task 5：上下文窗口优化（≥ 6 测试）

### 5.1 论文借鉴

论文关键数据：全技能库 884K tokens → SkillWeaver 平均 1,160 tokens（99.9% 减少）。机制：按子任务检索 top-2~5 候选技能注入上下文，而非暴露全库。RouteDev 当前路由时暴露全部 24+ 类别技能（[mcp-catalog.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/main/mcp-catalog.ts) 的 CATALOG），上下文膨胀。

### 5.2 设计

新增 `SkillContextOptimizer`：

```ts
// src/skills/context-optimizer.ts

/**
 * 技能上下文优化器
 *
 * 论文：按子任务检索 2-5 技能注入，而非暴露全 24+ 类别
 * 机制：
 *   1. 对每个子任务用 Bi-encoder（Task 2）检索 top-K（默认 3）
 *   2. 跨子任务去重（同技能只注入一次）
 *   3. 合并后总 token 超预算时按 confidence 降序裁剪
 *   4. 输出紧凑的"技能摘要"（name + description，不含正文）
 */
export class SkillContextOptimizer {
  constructor(
    private readonly retriever: BiEncoderSkillRetriever,
    private readonly config: {
      enabled: boolean;
      perSubTaskTopK: number;    // 默认 3
      maxTotalSkills: number;    // 默认 8
      maxTokens: number;         // 默认 1200（论文 1160）
    },
  ) {}

  /**
   * 为子任务列表构建紧凑技能上下文
   */
  async buildContext(subTasks: AtomicSubTask[]): Promise<{
    skills: Array<{ id: string; name: string; description: string; category: string; confidence: number }>;
    estimatedTokens: number;
    truncated: boolean;
  }>;
}
```

**token 估算**：复用 [token-counter.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/router/token-counter.ts)。超预算时按 confidence 降序裁剪，保留 `maxTotalSkills` 上限。

### 5.3 接线点

- 新增：`src/skills/context-optimizer.ts`
- 修改：技能调度入口 — SAD 分解后调 `buildContext`，把紧凑技能列表注入执行 prompt（替代全库注入）
- 复用：Task 2 的 `BiEncoderSkillRetriever.retrieveTopK`、`token-counter.ts`

### 5.4 Step 分解

- [ ] **Step 1: 实现 buildContext 主流程**

遍历 subTasks，对每个调 `retriever.retrieveTopK(sub, perSubTaskTopK)`，跨子任务去重（Map by skillId）。合并后按 confidence 降序排序。

- [ ] **Step 2: token 预算裁剪**

估算每个技能摘要（name + description）的 token 数，累加超 `maxTokens` 时按 confidence 降序裁剪，同时不超过 `maxTotalSkills`。`truncated=true` 标记。

- [ ] **Step 3: 降级处理**

`retriever.isReady()` 为 false 时，降级为按 expectedSkillCategory 过滤全库（返回该类别全部技能，但仍受 maxTokens 约束）。

- [ ] **Step 4: 接入调度入口**

在 SAD 分解完成后、技能执行前，调 `buildContext`，把返回的紧凑技能列表序列化为 prompt 片段注入。原全库注入逻辑加配置开关，默认关闭走优化路径。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 `SkillContextOptimizerConfig`（隶属 SkillRoutingConfig）。默认 `enabled: false`。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/context-optimizer.test.ts`，覆盖：
- 单子任务检索 top-K
- 多子任务去重
- token 预算裁剪（超 maxTokens 按 confidence 降序）
- maxTotalSkills 上限
- retriever 未就绪降级（按 category 过滤）
- 空子任务列表返回空
- truncated 标记正确

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-64): 上下文窗口优化

新增 SkillContextOptimizer，按子任务检索 2-5 技能注入
论文借鉴：arXiv:2606.18051 全技能 884K→平均 1160 tokens（99.9% 减少）
裁剪：token 预算 + maxTotalSkills 双约束，按 confidence 降序"
```

---

## Task 6：配置收口、设置页与全量验证（≥ 6 测试）

### 6.1 目标

收口 Phase 64 所有配置项，确保设置页可调，全量验证通过。

### 6.2 Step 分解

- [ ] **Step 1: 配置 schema 收口**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加顶层 `skillRouting` 字段，聚合 Task 1-5 的所有子配置：

```ts
skillRouting: z.object({
  enabled: z.boolean().default(false), // 总开关
  sad: z.object({
    enabled: z.boolean().default(false),
    maxIterations: z.number().int().min(1).max(5).default(1),
    convergenceTau: z.number().min(0).max(1).default(0.6),
    inputSideFeedback: z.boolean().default(true),
  }).default({}),
  biEncoder: z.object({
    enabled: z.boolean().default(false),
    modelId: z.string().default('Xenova/all-MiniLM-L6-v2'),
    topK: z.number().int().min(1).max(50).default(10),
    minScore: z.number().min(0).max(1).default(0.2),
    backend: z.enum(['memory', 'hnswlib']).default('memory'),
  }).default({}),
  granularityAudit: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  compatibilityScorer: z.object({
    enabled: z.boolean().default(false),
    pruneThreshold: z.number().min(0).max(1).default(0.15),
    weights: z.object({
      ioType: z.number().min(0).max(1).default(0.4),
      categoryJaccard: z.number().min(0).max(1).default(0.3),
      keywordCoOccur: z.number().min(0).max(1).default(0.3),
    }).default({}),
  }).default({}),
  contextOptimizer: z.object({
    enabled: z.boolean().default(false),
    perSubTaskTopK: z.number().int().min(1).max(10).default(3),
    maxTotalSkills: z.number().int().min(1).max(30).default(8),
    maxTokens: z.number().int().min(200).max(5000).default(1200),
  }).default({}),
}).default({}),
```

- [ ] **Step 2: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加对应默认值。

- [ ] **Step 3: 设置页 UI**

在 desktop renderer 设置页 Skills Tab 增加"组合技能路由"分区：
- 总开关
- 子开关（SAD / Bi-encoder / 粒度审计 / 兼容性评分 / 上下文优化）
- 参数滑块（maxIterations / convergenceTau / topK / minScore / pruneThreshold / perSubTaskTopK / maxTokens）
- Bi-encoder 模型状态指示（已加载 / 加载中 / 不可用降级）
- "立即重建技能索引"按钮

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 4: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 40 个测试通过。

- [ ] **Step 5: 文档同步**

更新 [docs/ROUTING.md](file:///c:/Users/杨铭/Desktop/Agent/routedev/docs/ROUTING.md) 与 [docs/SKILLFLOW.md](file:///c:/Users/杨铭/Desktop/Agent/routedev/docs/SKILLFLOW.md)，说明 SAD 迭代分解与 Bi-encoder 检索架构。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/skill-routing-config.test.ts`，覆盖：
- schema 默认值正确
- 总开关关闭时所有子模块跳过
- 各子配置边界值校验
- defaults 与 schema 一致性
- 配置热加载（复用 watcher 模式）
- 设置页 IPC 往返

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-64): 配置收口、设置页与全量验证

组合技能路由总开关 + 5 子开关 + 参数滑块 + Bi-encoder 状态指示
论文借鉴：arXiv:2606.18051 SAD 完整落地
版本：v4.6.3"
```

---

## 风险与回滚

### 风险 1：SAD 多轮迭代拖慢分解延迟
- **缓解**：默认 T=1（two-pass），收敛判定提前终止；论文证明 Round 1 即捕获全部 DA 提升
- **回滚**：关闭 `skillRouting.sad.enabled`，降级为现有 output-side `decomposeWithSkillAwareness`

### 风险 2：Bi-encoder 模型加载拖慢启动 / 内存占用
- **缓解**：`@xenova/transformers` 按需 dynamic import，首次调用才加载；embedding 缓存复用
- **回滚**：关闭 `skillRouting.biEncoder.enabled`，降级关键词 + Jaccard 检索

### 风险 3：FAISS 无 Node 绑定，memory 后端在技能库 >1K 时性能下降
- **缓解**：技能库 >1K 时切 `backend: 'hnswlib'`（hnswlib-wasm）；<1K 用 memory 内积矩阵足够
- **回滚**：`backend` 配置可切换，最差降级关键词检索

### 风险 4：兼容性评分剪枝误删真实数据依赖边
- **缓解**：data 边 pruneThreshold 降至 0.05；剪枝后重新 `hasCycle` 检查；剪枝只会减边不会引入环
- **回滚**：关闭 `skillRouting.compatibilityScorer.enabled`，恢复原 composeDAG 逻辑

### 风险 5：上下文优化裁剪掉关键技能
- **缓解**：按 confidence 降序裁剪；maxTotalSkills 上限保护；truncated 标记提示用户
- **回滚**：关闭 `skillRouting.contextOptimizer.enabled`，恢复全库注入

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 40 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] 组合技能路由总开关默认关闭，设置页可开启
- [ ] SAD two-pass 输入侧 hint 反馈回路可用（可从日志查看 hintJaccard 历史）
- [ ] Bi-encoder 检索可用，模型不可用时降级关键词检索
- [ ] 分解粒度审计接入 CrossModelReviewer 第 6 维度
- [ ] 兼容性感知 DAG 组合剪枝低分边且不引入环
- [ ] 上下文窗口优化把技能注入 token 控制在 maxTokens 内
- [ ] fail-open：各模块失败时降级为现有逻辑，不阻塞主流程
- [ ] docs/ROUTING.md 与 docs/SKILLFLOW.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中

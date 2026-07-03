# Phase 67 — 推理质量诊断与 SNR 过滤

> **版本目标：** v4.6.6
> **前置依赖：** Phase 66（策略管道编号分段与治理）完成——本 Phase 的 AuditChain RV/MI 指标记录依赖 Phase 66 的 StateSnapshotChain
> **后继依赖：** 无（本 Phase 是独立能力增强）
> **新增测试要求：** ≥ 45 个
> **研究依据：** 精读 arXiv:2604.06268《RAGEN-2: Reasoning Collapse in Agentic RL》（Northwestern + UIUC + Stanford + Microsoft，2026-04）全文 + arXiv:2603.24472《Why Does Self-Distillation (Sometimes) Degrade the Reasoning Capability of LLMs?》（Microsoft Research + KAIST + SNU，2026-03）全文。论文 1 核心论断：**Template Collapse 是 Agentic RL 的隐性失败模式**——模型推理单输入内看似多样（条件熵 H(Z|X) 高），但跨输入变得 input-agnostic（互信息 I(X;Z) 趋零），生成"流畅但样板文"。Shannon 恒等式 H(Z) = I(X;Z) + H(Z|X) 表明熵类指标只 proxy H(Z|X)，对 I(X;Z) 下降一无所知——**MI 与最终性能 Spearman +0.39，而熵是 −0.11 到 −0.14（方向相反）**。论文用 **In-Batch Cross-Scoring** 构造打分矩阵 L[i,k,j] = log p(Z_{i,k}|X_j) 计算 Retrieval-Acc 与 MI-ZScore-EMA 代理，坍缩时 Retrieval-Acc 趋向 1/P 随机水平。机理上，PPO/GRPO 中 KL 散度与熵正则项 input-agnostic，低 RV（reward variance）→ gtask≈0 但 greg 恒定 → 更新被正则噪声主导 → 抹除跨输入差异；Cauchy-Schwarz 上界 ‖gtask(x)‖ ≤ √Var(R|X=x) · √E[‖s(z;x)‖²|X=x]。论文的 **SNR-Aware Top-p 过滤**（按 per-prompt reward 方差排序，top-p=0.9 保留高信号子集）跨 7 环境/4 算法/4 尺度/2 模态一致提升 +0.8 到 +6.9，**Top-p 优于 Top-k**——多数 prompt 方差近零时 top-p 拒绝整个 batch（天然保护退化更新），top-k 仍强制保留 k 个稀释信号；per-step 时间降 26%-41%。论文 2 核心论断：**Epistemic Verbalization 不是风格冗余，而是 self-Bayesian reasoning 的关键信号**——"Wait"、"Hmm" 等 10 个 epistemic token 表达不确定性、保留备选假设、渐进降不确定性。DeepSeek-R1-Distill-Qwen-7B 上 unguided epistemic token 182.5 → solution-guided 8.8，AIME24 暴跌 40%；跨 4 个模型均观察最高 40% 下降。信息丰富度形式化 I(y*;c|x) = H(y*|x) − H(y*|x,c)，四种生成设置不等式链 (1)<(3)≤(4)≤(2)。结论：仅强化正确答案 trace 不够，post-training 目标必须显式保留不确定性感知的推理行为。论文 1 代码：https://github.com/RAGEN-AI/RAGEN；论文 2 代码：https://github.com/beanie00/self-distillation-analysis。
> **核心命题：** RouteDev 当前**没有任何推理质量诊断机制**——[execution-orchestrator](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 并行派发 worker 后只看 reward 数值高低，不看 reward 方差分布（低 RV 是退化更新的预警）；[context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) L2 Snipping 删除旧消息时不管内容里是否有 epistemic token（"Wait"、"Hmm" 这类不确定性信号被无脑裁掉）；[cross-model-reviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 审查代码时不检查推理过程的 epistemic token 频率变化（过度压缩风险不可见）；[AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 仅记录事件不记录 RV/MI 指标（事后无法分析退化）。Phase 67 把 RAGEN-2 的 MI 代理族 + SNR-Aware Top-p 过滤、Self-Distillation 的 Epistemic Token 保护四套机制落地，让推理质量从"看不见"变成"可诊断、可过滤、可保护、可审计"。

---

## 项目现状审计与可行性结论

### 1. 论文与 RouteDev 缺口的映射

| 论文机制 | 核心 Contribution | RouteDev 现状缺口 | Phase 67 Task |
|---------|-------------------|-------------------|---------------|
| MI 代理族（In-Batch Cross-Scoring） | Retrieval-Acc + MI-ZScore-EMA，坍缩时趋向 1/P 随机水平 | 无任何 Template Collapse 诊断 | Task 1（MI 代理预警） |
| SNR-Aware Top-p 过滤 | top-p=0.9 保留高 RV 子集，top-p 优于 top-k | execution-orchestrator 派发 worker 不看 RV 分布 | Task 2（Top-p 过滤接入） |
| Epistemic Token 邻域保护 | 10 token 列表，L2 snipping 保护前后 N 行 | context-compaction L2 无脑删除旧消息，不保护 epistemic token | Task 3（L2 邻域保护） |
| Epistemic Token 完整性审查 | 对比原始与审查后 epistemic token 频率变化 | CrossModelReviewer 不检查 epistemic token 频率 | Task 4（审查器完整性检查） |
| L5 摘要保留不确定性表达 | post-training 目标必须显式保留不确定性感知推理行为 | L5 summarize prompt 不要求保留 epistemic token 与备选假设 | Task 5（L5 prompt 改造） |
| RV/MI 指标审计 | 每次迭代记录 reward variance + MI proxy | AuditChain 仅记录事件，不记录 RV/MI 指标 | Task 6（AuditChain 指标记录） |
| 配置收口 | 跨 7 环境/4 算法一致提升 | RV/MI/epistemic 参数散落各处 | Task 7（配置收口） |

### 2. 可行性总评

- **Task 1（MI 代理 Template Collapse 预警）：** 中等可行。PolicyEngine 当前无 cross-scoring 能力，需新增 `MICrossScorer` 类，对 P 个 prompt 各采样 G 条推理构造打分矩阵 L[i,k,j]。打分矩阵需要 log p(Z|X) 概率，可降级为 LLM 打分（用 reviewer 模型对推理打分）。
- **Task 2（SNR-Aware Top-p 接入 execution-orchestrator）：** 可行。execution-orchestrator 已有并行 worker 派发逻辑，只需在派发前对候选 worker 任务预估 reward 方差，按 top-p=0.9 过滤。
- **Task 3（Epistemic Token 邻域保护接入 L2）：** 高度可行。context-compaction L2 Snipping 当前是"保留最近 10 条 + system，删除中间"，只需在删除前扫描 epistemic token，命中则保护前后 N 行。
- **Task 4（Epistemic Token 完整性审查接入 CrossModelReviewer）：** 可行。CrossModelReviewer 已有 review 方法，扩展为对比原始推理与审查后推理的 epistemic token 频率，下降超阈值标记"过度压缩风险"。
- **Task 5（L5 摘要 prompt 保留不确定性表达）：** 高度可行。L5 summarize 是单一 LLM 调用，prompt 显式要求保留 epistemic token 与备选假设分支即可。
- **Task 6（AuditChain 记录 RV 与 MI 指标）：** 可行。AuditLogger 已有 log 方法，扩展 audit entry 附加 (reward_variance, mi_proxy, conditional_entropy) 三字段。
- **Task 7（配置收口）：** 高度可行。遵循 Phase 51 反写死原则。

---

## 核心设计原则

### 原则 1：MI 优先于熵

论文 1 核心发现——Shannon 恒等式 H(Z) = I(X;Z) + H(Z|X) 表明熵类指标只 proxy H(Z|X)，对 I(X;Z) 下降一无所知。Phase 67 的诊断指标必须用 MI 代理（Retrieval-Acc / MI-ZScore-EMA），不用熵。

### 原则 2：Top-p 优先于 Top-k

论文 1 关键论断——多数 prompt 方差近零时 top-p 拒绝整个 batch（天然保护退化更新），top-k 仍强制保留 k 个稀释信号。Phase 67 的过滤策略必须用 top-p，不用 top-k。

### 原则 3：低 RV 是退化预警

论文 1 机理——低 RV（reward variance）→ gtask≈0 但 greg 恒定 → 更新被正则噪声主导 → 抹除跨输入差异。Phase 67 的过滤逻辑必须把低 RV 视为退化预警，不是"刚好够用"。

### 原则 4：Epistemic Token 不是风格冗余

论文 2 核心论断——"Wait"、"Hmm" 等 epistemic token 是 self-Bayesian reasoning 中保留备选假设、渐进降不确定性的关键信号。Phase 67 的压缩与审查逻辑必须显式保护 epistemic token，不当作可裁剪的风格装饰。

### 原则 5：仅强化正确答案 trace 不够

论文 2 结论——post-training 目标必须显式保留不确定性感知的推理行为。Phase 67 的 L5 摘要 prompt 必须显式要求保留 epistemic token 与备选假设分支，不能只摘"最终结论"。

### 原则 6：反写死原则（延续 Phase 51）

所有新增能力必须有配置开关、设置页面入口、明确代码接线点。MI 诊断、Top-p 过滤、epistemic 保护默认关闭，用户在设置页开启。

### 原则 7：Fail-open

MI 打分失败、Top-p 过滤无可信子集、epistemic token 扫描失败时，降级为现有逻辑，不阻塞主流程。

### 原则 8：死代码防护与执行人自审（延续 Phase 51/53）

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

## Task 1：MI 代理 Template Collapse 早期预警（≥ 8 测试）

### 1.1 论文借鉴

RAGEN-2 的 Template Collapse 失败模式——模型推理单输入内看似多样（条件熵 H(Z|X) 高），但跨输入变得 input-agnostic（互信息 I(X;Z) 趋零），生成"流畅但样板文"。Shannon 恒等式 H(Z) = I(X;Z) + H(Z|X) 表明熵类指标只 proxy H(Z|X)，对 I(X;Z) 下降一无所知——**MI 与最终性能 Spearman +0.39，而熵是 −0.11 到 −0.14（方向相反）**。论文用 **In-Batch Cross-Scoring** 构造打分矩阵：

- 对 P 个 prompt 各采样 G 条推理
- 构造打分矩阵 L[i,k,j] = log p(Z_{i,k}|X_j)（第 i 个 prompt 的第 k 条推理在第 j 个 prompt 下的对数概率）
- **Retrieval-Acc = (1/PG) Σ 1[argmaxⱼ L[i,k,j] = i]**（坍缩时趋向 1/P 随机水平）
- **MI-ZScore-EMA**：z-score 归一化 + EMA 平滑（α=0.9）

RouteDev 当前 [PolicyEngine](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 无任何 cross-scoring 能力，无法诊断"Agent 输出是否在跨任务时变得 input-agnostic"。

### 1.2 设计

新增 `MICrossScorer` 类，实现 In-Batch Cross-Scoring：

```ts
// src/evaluation/mi-cross-scorer.ts
import { logger } from '../utils/logger.js';

/** 单条推理的打分结果 */
export interface ReasoningScore {
  /** prompt 索引 */
  promptIndex: number;
  /** 采样索引（同一 prompt 的第几条采样） */
  sampleIndex: number;
  /** 推理文本 */
  reasoning: string;
  /** 该推理在每个 prompt 下的对数概率（或降级为 LLM 打分） */
  logProbsByPrompt: number[];
}

/** MI 代理指标快照 */
export interface MIProxySnapshot {
  /** Retrieval-Acc（坍缩时趋向 1/P） */
  retrievalAcc: number;
  /** 随机水平基线（1/P） */
  randomBaseline: number;
  /** MI-ZScore（z-score 归一化后的 MI 代理值） */
  miZScore: number;
  /** MI-ZScore-EMA（α=0.9 平滑） */
  miZScoreEma: number;
  /** 条件熵 H(Z|X) 代理（仅用于对照，不作为主指标） */
  conditionalEntropy: number;
  /** 采样时间戳 */
  timestamp: number;
  /** 是否触发 Template Collapse 预警 */
  collapseWarning: boolean;
}

/**
 * MI Cross-Scorer
 *
 * 借鉴 RAGEN-2 的 In-Batch Cross-Scoring：
 *   1. 对 P 个 prompt 各采样 G 条推理
 *   2. 构造打分矩阵 L[i,k,j] = log p(Z_{i,k}|X_j)
 *   3. Retrieval-Acc = (1/PG) Σ 1[argmaxⱼ L[i,k,j] = i]
 *   4. MI-ZScore-EMA：z-score 归一化 + EMA 平滑（α=0.9）
 *
 * 降级策略：
 *   - 无 log p(Z|X) 能力时，用 LLM 打分（reviewer 模型对推理打 0-1 分）替代
 *   - LLM 打分也失败时，用文本相似度（余弦）替代
 */
export class MICrossScorer {
  /** MI-ZScore-EMA 历史值（用于 EMA 平滑） */
  private miZScoreEmaHistory: number | null = null;
  /** EMA 平滑系数（论文值 0.9） */
  private readonly emaAlpha = 0.9;
  /** z-score 归一化的历史均值与标准差 */
  private zScoreStats = { mean: 0, std: 1, sampleCount: 0 };

  constructor(private readonly config: {
    /** 是否启用 */
    enabled: boolean;
    /** 触发 Template Collapse 预警的 Retrieval-Acc 阈值（接近 1/P 时触发） */
    collapseThreshold: number; // 默认 1.5/P（即 Retrieval-Acc < 1.5/P 时预警）
    /** 最小 prompt 数（P < 2 时无法 cross-scoring，降级为不诊断） */
    minPrompts: number; // 默认 2
    /** 采样数 G（论文值，默认 4） */
    samplesPerPrompt: number; // 默认 4
  }) {}

  /**
   * 计算 MI 代理指标
   *
   * @param prompts P 个 prompt
   * @param samples 每个 prompt 的 G 条推理（samples[i][k] = 第 i 个 prompt 的第 k 条推理）
   * @param scorer 打分函数，返回 log p(Z_{i,k}|X_j) 或降级为 LLM 打分
   */
  async computeMIProxy(
    prompts: string[],
    samples: string[][],
    scorer: (reasoning: string, promptIndex: number) => Promise<number>,
  ): Promise<MIProxySnapshot> {
    const P = prompts.length;
    if (!this.config.enabled || P < this.config.minPrompts) {
      // 降级：不诊断，返回占位快照
      return {
        retrievalAcc: 0,
        randomBaseline: 1 / Math.max(P, 1),
        miZScore: 0,
        miZScoreEma: this.miZScoreEmaHistory ?? 0,
        conditionalEntropy: 0,
        timestamp: Date.now(),
        collapseWarning: false,
      };
    }

    const G = this.config.samplesPerPrompt;
    // 构造打分矩阵 L[i,k,j] = log p(Z_{i,k}|X_j)
    const scores: ReasoningScore[] = [];
    for (let i = 0; i < P; i++) {
      for (let k = 0; k < Math.min(G, samples[i].length); k++) {
        const reasoning = samples[i][k];
        const logProbsByPrompt: number[] = [];
        for (let j = 0; j < P; j++) {
          // 对每个 prompt j 计算该推理的对数概率（或降级打分）
          const score = await scorer(reasoning, j);
          logProbsByPrompt.push(score);
        }
        scores.push({ promptIndex: i, sampleIndex: k, reasoning, logProbsByPrompt });
      }
    }

    // Retrieval-Acc = (1/PG) Σ 1[argmaxⱼ L[i,k,j] = i]
    let correctRetrieval = 0;
    let totalSamples = 0;
    for (const score of scores) {
      const argmax = this.argmax(score.logProbsByPrompt);
      if (argmax === score.promptIndex) correctRetrieval++;
      totalSamples++;
    }
    const retrievalAcc = totalSamples > 0 ? correctRetrieval / totalSamples : 0;
    const randomBaseline = 1 / P;

    // 条件熵 H(Z|X) 代理：每个 prompt 内采样的平均打分方差（仅对照用）
    const conditionalEntropy = this.estimateConditionalEntropy(scores, P);

    // MI-ZScore：z-score 归一化
    const rawMi = retrievalAcc - randomBaseline; // MI 代理 = Retrieval-Acc - 1/P
    const miZScore = this.zScoreNormalize(rawMi);

    // MI-ZScore-EMA：α=0.9 平滑
    this.miZScoreEmaHistory = this.emaSmooth(miZScore);
    const miZScoreEma = this.miZScoreEmaHistory;

    // Template Collapse 预警：Retrieval-Acc 接近 1/P 时触发
    const collapseWarning = retrievalAcc < this.config.collapseThreshold * randomBaseline
      || (this.zScoreStats.sampleCount > 5 && miZScoreEma < -1.5); // EMA 显著低于均值

    logger.info('MICrossScorer: computed MI proxy', {
      P, G, retrievalAcc, randomBaseline, miZScore, miZScoreEma, conditionalEntropy, collapseWarning,
    });

    return {
      retrievalAcc,
      randomBaseline,
      miZScore,
      miZScoreEma,
      conditionalEntropy,
      timestamp: Date.now(),
      collapseWarning,
    };
  }

  /** argmax 工具 */
  private argmax(arr: number[]): number {
    let maxIdx = 0;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] > arr[maxIdx]) maxIdx = i;
    }
    return maxIdx;
  }

  /** 估算条件熵 H(Z|X) 代理：每个 prompt 内采样的打分方差均值 */
  private estimateConditionalEntropy(scores: ReasoningScore[], P: number): number {
    const perPromptVariances: number[] = [];
    for (let i = 0; i < P; i++) {
      const promptScores = scores.filter(s => s.promptIndex === i);
      if (promptScores.length < 2) continue;
      const mean = promptScores.reduce((sum, s) => sum + s.logProbsByPrompt[i], 0) / promptScores.length;
      const variance = promptScores.reduce((sum, s) => sum + Math.pow(s.logProbsByPrompt[i] - mean, 2), 0) / promptScores.length;
      perPromptVariances.push(variance);
    }
    return perPromptVariances.length > 0
      ? perPromptVariances.reduce((a, b) => a + b, 0) / perPromptVariances.length
      : 0;
  }

  /** z-score 归一化（增量更新均值与标准差） */
  private zScoreNormalize(rawValue: number): number {
    const stats = this.zScoreStats;
    stats.sampleCount++;
    const delta = rawValue - stats.mean;
    stats.mean += delta / stats.sampleCount;
    const delta2 = rawValue - stats.mean;
    stats.std = Math.sqrt(((stats.sampleCount - 2) * Math.pow(stats.std, 2) + delta * delta2) / Math.max(stats.sampleCount - 1, 1));
    return stats.std > 0 ? (rawValue - stats.mean) / stats.std : 0;
  }

  /** EMA 平滑（α=0.9） */
  private emaSmooth(rawValue: number): number {
    if (this.miZScoreEmaHistory === null) return rawValue;
    return this.emaAlpha * this.miZScoreEmaHistory + (1 - this.emaAlpha) * rawValue;
  }

  /** 重置历史（新会话或配置变更时调用） */
  reset(): void {
    this.miZScoreEmaHistory = null;
    this.zScoreStats = { mean: 0, std: 1, sampleCount: 0 };
  }
}
```

### 1.3 接线点

- 新增：`src/evaluation/mi-cross-scorer.ts`
- 修改：`src/policies/policy-engine.ts` — 新增可选 `miScorer: MICrossScorer` 注入点，定期触发 cross-scoring
- 修改：`src/agent/execution-orchestrator.ts` — 多 Agent 模式下，worker 完成后收集推理样本，批量调用 `miScorer.computeMIProxy`
- 修改：`src/cli/app-init.ts` — 装配 MICrossScorer 单例

### 1.4 Step 分解

- [ ] **Step 1: 定义 MIProxySnapshot 与 ReasoningScore 接口**

新建 `src/evaluation/mi-cross-scorer.ts`，按 1.2 定义 MIProxySnapshot（含 retrievalAcc、randomBaseline、miZScore、miZScoreEma、conditionalEntropy、collapseWarning）。

- [ ] **Step 2: 实现 computeMIProxy 主流程**

按 1.2 实现：构造打分矩阵 L[i,k,j] → 计算 Retrieval-Acc → 计算 randomBaseline=1/P → 估算 conditionalEntropy → z-score 归一化 → EMA 平滑。

- [ ] **Step 3: 实现 z-score 增量归一化**

zScoreNormalize 使用 Welford 算法增量更新均值与标准差，避免全量重算。

- [ ] **Step 4: 实现 EMA 平滑**

emaSmooth：首次返回原值，后续 α=0.9 平滑。

- [ ] **Step 5: 实现 Template Collapse 预警**

collapseWarning = retrievalAcc < collapseThreshold × randomBaseline 或 EMA 显著低于均值（z-score < -1.5）。

- [ ] **Step 6: 降级策略**

无 log p(Z|X) 能力时，scorer 回调由调用方提供 LLM 打分或文本相似度。P < minPrompts 时返回占位快照不诊断。

- [ ] **Step 7: 接入 execution-orchestrator**

在 [execution-orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 多 Agent 模式下，worker 完成后：
- 收集 P 个 worker 的推理样本（每个 worker 一条 prompt）
- 若配置开启，调用 `miScorer.computeMIProxy(prompts, samples, scorer)`
- collapseWarning=true 时在状态栏显示"Template Collapse 预警"

- [ ] **Step 8: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 MICrossScorerConfig：

```ts
miCrossScorer: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 MI 代理诊断（默认 false） */
  enabled: z.boolean().default(false),
  /** Collapse 预警阈值（Retrieval-Acc < threshold × 1/P 时触发） */
  collapseThreshold: z.number().min(1).max(5).default(1.5),
  /** 最小 prompt 数（P < 此值时降级不诊断） */
  minPrompts: z.number().int().min(2).default(2),
  /** 每个 prompt 的采样数 G（论文值 4） */
  samplesPerPrompt: z.number().int().min(1).max(16).default(4),
})).default({}),
```

- [ ] **Step 9: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/evaluation/mi-cross-scorer.test.ts`，覆盖：
- Retrieval-Acc 计算正确性（全部正确检索 → 1.0）
- Retrieval-Acc 坍缩场景（全部错误检索 → 接近 1/P）
- randomBaseline = 1/P
- z-score 归一化增量更新
- EMA 平滑（α=0.9）
- collapseWarning 触发条件
- 降级：P < minPrompts 返回占位快照
- 配置关闭时跳过诊断

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "feat(phase-67): MI 代理 Template Collapse 早期预警

新增 MICrossScorer，实现 RAGEN-2 的 In-Batch Cross-Scoring
论文借鉴：RAGEN-2 的 Retrieval-Acc + MI-ZScore-EMA
预警：Retrieval-Acc < 1.5/P 或 EMA z-score < -1.5 时触发
降级：无 log p 能力时用 LLM 打分，P < 2 时不诊断"
```

---

## Task 2：SNR-Aware Top-p 过滤接入 execution-orchestrator（≥ 8 测试）

### 2.1 论文借鉴

RAGEN-2 的 SNR-Aware Filtering——每次迭代按 per-prompt reward 方差排序，**top-p=0.9 保留高信号子集**。论文关键论断：

- **Top-p 优于 Top-k**：当 batch 内多数 prompt 方差近零时，top-p 拒绝整个 batch（天然保护退化更新），top-k 仍强制保留 k 个稀释信号
- **per-step 时间降 26%-41%**（过滤后 group 减少）
- 跨 7 环境/4 算法/4 尺度/2 模态一致提升 +0.8 到 +6.9

SNR 机理：PPO/GRPO 中 KL 散度与熵正则项 input-agnostic，任务梯度 gtask 由 reward 方差驱动。低 RV → gtask≈0 但 greg 恒定 → 更新被正则噪声主导 → 抹除跨输入差异。Cauchy-Schwarz 上界：‖gtask(x)‖ ≤ √Var(R|X=x) · √E[‖s(z;x)‖²|X=x]。

RouteDev 的 [execution-orchestrator](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 并行派发 worker 时不看 reward 方差分布——低 RV 的 worker 仍被派发，稀释信号。

### 2.2 设计

新增 `SNRAwareFilter` 类，接入 execution-orchestrator 的 worker 派发前阶段：

```ts
// src/agent/snr-aware-filter.ts
import { logger } from '../utils/logger.js';

/** Worker 任务候选（带预估 reward 方差） */
export interface WorkerTaskWithRV {
  /** 原始 worker 任务 */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 预估 reward 方差（基于历史或采样） */
  estimatedRewardVariance: number;
  /** 是否被保留（top-p 过滤后） */
  retained: boolean;
}

/** Top-p 过滤结果 */
export interface TopPFilterResult {
  /** 保留的任务（按 RV 降序） */
  retainedTasks: WorkerTaskWithRV[];
  /** 过滤掉的任务 */
  filteredOutTasks: WorkerTaskWithRV[];
  /** 是否整个 batch 被拒绝（top-p 的天然保护） */
  batchRejected: boolean;
  /** 拒绝原因（batchRejected=true 时非空） */
  rejectReason?: string;
  /** 实际保留比例（retained / total） */
  actualRetainRatio: number;
}

/**
 * SNR-Aware Top-p 过滤器
 *
 * 借鉴 RAGEN-2 的 SNR-Aware Filtering：
 *   1. 对每个候选 worker 任务预估 reward 方差（基于历史或采样）
 *   2. 按 RV 降序排序
 *   3. top-p=0.9 保留高信号子集
 *   4. 多数任务 RV 近零时拒绝整个 batch（天然保护退化更新）
 *
 * Top-p 优于 Top-k 的关键：
 *   - top-k 强制保留 k 个，即使多数 RV=0 也会稀释信号
 *   - top-p 按 RV 比例过滤，RV 普遍低时拒绝整个 batch
 */
export class SNRAwareFilter {
  constructor(private readonly config: {
    /** 是否启用 */
    enabled: boolean;
    /** top-p 比例（论文值 0.9） */
    topP: number; // 默认 0.9
    /** 最小 RV 阈值（RV < 此值的任务视为零信号） */
    minRVThreshold: number; // 默认 0.01
    /** batch 拒绝阈值（零信号任务占比 > 此值时拒绝整个 batch） */
    batchRejectRatio: number; // 默认 0.7
  }) {}

  /**
   * Top-p 过滤 worker 任务
   *
   * @param tasks 候选任务（带预估 RV）
   * @returns 过滤结果
   */
  filter(tasks: WorkerTaskWithRV[]): TopPFilterResult {
    if (!this.config.enabled || tasks.length === 0) {
      // 关闭或空 batch：全部保留
      return {
        retainedTasks: tasks.map(t => ({ ...t, retained: true })),
        filteredOutTasks: [],
        batchRejected: false,
        actualRetainRatio: tasks.length > 0 ? 1 : 0,
      };
    }

    // 统计零信号任务占比
    const zeroSignalCount = tasks.filter(t => t.estimatedRewardVariance < this.config.minRVThreshold).length;
    const zeroSignalRatio = zeroSignalCount / tasks.length;

    // batch 拒绝：多数任务零信号时拒绝整个 batch（top-p 的天然保护）
    if (zeroSignalRatio > this.config.batchRejectRatio) {
      logger.warn('SNRAwareFilter: batch rejected (majority zero-signal)', {
        total: tasks.length,
        zeroSignalCount,
        zeroSignalRatio,
        threshold: this.config.batchRejectRatio,
      });
      return {
        retainedTasks: [],
        filteredOutTasks: tasks.map(t => ({ ...t, retained: false })),
        batchRejected: true,
        rejectReason: `Majority zero-signal (ratio=${zeroSignalRatio.toFixed(2)} > threshold=${this.config.batchRejectRatio})`,
        actualRetainRatio: 0,
      };
    }

    // 按 RV 降序排序
    const sorted = [...tasks].sort((a, b) => b.estimatedRewardVariance - a.estimatedRewardVariance);

    // top-p 保留：按比例取前 p% 的任务
    const retainCount = Math.max(1, Math.ceil(sorted.length * this.config.topP));
    const retained = sorted.slice(0, retainCount).map(t => ({ ...t, retained: true }));
    const filteredOut = sorted.slice(retainCount).map(t => ({ ...t, retained: false }));

    logger.info('SNRAwareFilter: top-p filter applied', {
      total: tasks.length,
      retained: retained.length,
      filteredOut: filteredOut.length,
      actualRetainRatio: retained.length / tasks.length,
    });

    return {
      retainedTasks: retained,
      filteredOutTasks: filteredOut,
      batchRejected: false,
      actualRetainRatio: retained.length / tasks.length,
    };
  }

  /**
   * 预估 worker 任务的 reward 方差
   *
   * 策略：
   *   1. 历史模式：从 AuditChain 查询同类任务的 reward 历史，计算方差
   *   2. 采样模式：派发 G=4 次轻量预演，计算 reward 方差
   *   3. 降级模式：无历史无采样能力时返回默认 RV=0.5（中等信号）
   *
   * @param taskDescription 任务描述
   * @param queryHistory 历史查询回调（由 AuditChain 提供）
   * @param sampleRun 采样预演回调（由 execution-orchestrator 提供）
   */
  async estimateRewardVariance(
    taskDescription: string,
    queryHistory?: (desc: string) => Promise<number[]>,
    sampleRun?: (desc: string) => Promise<number[]>,
  ): Promise<number> {
    // 优先用历史模式
    if (queryHistory) {
      const history = await queryHistory(taskDescription);
      if (history.length >= 2) {
        return this.computeVariance(history);
      }
    }

    // 采样模式：派发 G=4 次轻量预演
    if (sampleRun) {
      const samples = await sampleRun(taskDescription);
      if (samples.length >= 2) {
        return this.computeVariance(samples);
      }
    }

    // 降级：返回默认 RV=0.5
    return 0.5;
  }

  /** 计算方差 */
  private computeVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    return variance;
  }
}
```

### 2.3 接线点

- 新增：`src/agent/snr-aware-filter.ts`
- 修改：`src/agent/execution-orchestrator.ts` — worker 派发前调用 `snrFilter.filter(tasks)`，仅派发 retainedTasks
- 修改：`src/harness/audit-logger.ts` — 新增 `queryRewardHistory(taskDescription)` 方法，供 estimateRewardVariance 查询历史
- 修改：`src/cli/app-init.ts` — 装配 SNRAwareFilter 单例

### 2.4 Step 分解

- [ ] **Step 1: 定义 WorkerTaskWithRV 与 TopPFilterResult**

新建 `src/agent/snr-aware-filter.ts`，按 2.2 定义 WorkerTaskWithRV（含 estimatedRewardVariance、retained）与 TopPFilterResult（含 batchRejected、actualRetainRatio）。

- [ ] **Step 2: 实现 filter 主流程**

按 2.2 实现：统计零信号占比 → batch 拒绝判断 → 按 RV 降序排序 → top-p 保留前 p% → 返回 TopPFilterResult。

- [ ] **Step 3: 实现 batch 拒绝逻辑**

零信号任务占比 > batchRejectRatio（默认 0.7）时拒绝整个 batch，retainedTasks 为空。

- [ ] **Step 4: 实现 estimateRewardVariance**

按 2.2 实现：优先历史模式 → 采样模式（G=4）→ 降级默认 RV=0.5。

- [ ] **Step 5: AuditLogger 新增 queryRewardHistory**

在 [audit-logger.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 新增：

```ts
async queryRewardHistory(taskDescription: string): Promise<number[]> {
  // 从 audit-chain.jsonl 查询 action='worker_complete' 且 details.description 匹配的记录
  // 返回 reward 数组
  // 简化实现：返回空数组，实际接线时由 AuditLogger 提供
  return [];
}
```

- [ ] **Step 6: 接入 execution-orchestrator**

在 [execution-orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 的多 Agent 模式派发前：
- 对每个候选 worker 任务调用 `snrFilter.estimateRewardVariance` 预估 RV
- 调用 `snrFilter.filter(tasksWithRV)`
- 仅派发 retainedTasks，filteredOutTasks 记录到 audit log
- batchRejected=true 时跳过整个 batch，记录退化预警

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 SNRAwareFilterConfig：

```ts
snrAwareFilter: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 SNR-Aware 过滤（默认 false） */
  enabled: z.boolean().default(false),
  /** top-p 比例（论文值 0.9） */
  topP: z.number().min(0.1).max(1).default(0.9),
  /** 最小 RV 阈值（RV < 此值视为零信号） */
  minRVThreshold: z.number().min(0).default(0.01),
  /** batch 拒绝阈值（零信号占比 > 此值时拒绝整个 batch） */
  batchRejectRatio: z.number().min(0.5).max(1).default(0.7),
})).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/snr-aware-filter.test.ts`，覆盖：
- top-p 0.9 保留前 90% 高 RV 任务
- batch 拒绝：零信号占比 > 0.7 时拒绝整个 batch
- 不拒绝：零信号占比 ≤ 0.7 时正常过滤
- 空任务列表降级
- estimateRewardVariance 历史模式
- estimateRewardVariance 采样模式
- estimateRewardVariance 降级默认 RV=0.5
- 配置关闭时全部保留

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-67): SNR-Aware Top-p 过滤接入 execution-orchestrator

新增 SNRAwareFilter，worker 派发前预估 RV + top-p=0.9 过滤
论文借鉴：RAGEN-2 的 SNR-Aware Top-p Filtering
关键：Top-p 优于 Top-k（多数零信号时拒绝整个 batch 保护退化更新）"
```

---

## Task 3：Epistemic Token 邻域保护接入 context-compaction L2（≥ 6 测试）

### 3.1 论文借鉴

Self-Distillation 论文的 Epistemic Verbalization——模型推理中显式表达不确定的 token（"Wait"、"Hmm" 等 10 个标记）。论文核心论断：**不是风格冗余，而是 self-Bayesian reasoning 中保留备选假设、渐进降不确定性的关键信号**。关键实验数据：

- DeepSeek-R1-Distill-Qwen-7B：unguided epistemic token 182.5 → solution-guided 8.8；AIME24 暴跌 40%
- 跨 Qwen3-1.7B/8B、DeepSeek-Distill-Qwen-7B、Olmo3-7B-Instruct 均观察最高 40% 下降

RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) L2 Snipping 当前是"保留最近 10 条 + system，删除中间"——删除旧消息时不检查内容里是否有 epistemic token，"Wait, let me reconsider" 这类不确定性信号被无脑裁掉。

### 3.2 设计

在 context-compaction L2 Snipping 阶段增加 epistemic token 邻域保护：

```ts
// src/agent/epistemic-token-protector.ts
import { logger } from '../utils/logger.js';

/**
 * 论文 2 定义的 10 个 epistemic token
 * 这些 token 表达不确定性、保留备选假设、渐进降不确定性
 */
export const EPISTEMIC_TOKENS = [
  'wait',
  'hmm',
  'actually',
  'let me reconsider',
  'on second thought',
  'but',
  'however',
  'perhaps',
  'maybe',
  'not sure',
] as const;

/** Epistemic token 出现位置 */
export interface EpistemicTokenHit {
  /** token 内容 */
  token: string;
  /** 在文本中的起始位置 */
  startIndex: number;
  /** 在文本中的结束位置 */
  endIndex: number;
}

/**
 * Epistemic Token 邻域保护器
 *
 * 借鉴 Self-Distillation 论文：
 *   - epistemic token 不是风格冗余，而是 self-Bayesian reasoning 的关键信号
 *   - 压缩时必须保护 epistemic token 前后 N 行，避免裁掉不确定性表达
 */
export class EpistemicTokenProtector {
  constructor(private readonly config: {
    /** 是否启用 */
    enabled: boolean;
    /** 邻域保护行数（前后各 N 行） */
    neighborhoodLines: number; // 默认 3
    /** 自定义 epistemic token 列表（覆盖默认 10 个） */
    customTokens?: string[];
  }) {}

  /**
   * 扫描文本中的 epistemic token
   */
  scanTokens(text: string): EpistemicTokenHit[] {
    const tokens = this.config.customTokens ?? EPISTEMIC_TOKENS;
    const hits: EpistemicTokenHit[] = [];
    const lowerText = text.toLowerCase();

    for (const token of tokens) {
      let searchStart = 0;
      const lowerToken = token.toLowerCase();
      while (true) {
        const idx = lowerText.indexOf(lowerToken, searchStart);
        if (idx === -1) break;
        hits.push({ token, startIndex: idx, endIndex: idx + token.length });
        searchStart = idx + token.length;
      }
    }

    return hits.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * 判断消息是否包含 epistemic token
   */
  hasEpistemicToken(text: string): boolean {
    return this.scanTokens(text).length > 0;
  }

  /**
   * 计算消息中应受保护的行范围
   *
   * @param lines 消息按行拆分后的数组
   * @returns 受保护的行索引集合（epistemic token 所在行 ± neighborhoodLines）
   */
  computeProtectedLineRanges(lines: string[]): Set<number> {
    if (!this.config.enabled) return new Set();

    const protectedLines = new Set<number>();
    const N = this.config.neighborhoodLines;

    for (let i = 0; i < lines.length; i++) {
      const hits = this.scanTokens(lines[i]);
      if (hits.length > 0) {
        // 保护 [i-N, i+N] 范围
        for (let j = Math.max(0, i - N); j <= Math.min(lines.length - 1, i + N); j++) {
          protectedLines.add(j);
        }
      }
    }

    return protectedLines;
  }

  /**
   * 过滤消息行：保留受保护的行 + 其他行
   * 用于 L2 Snipping 时，对包含 epistemic token 的消息不完全删除，而是保留邻域行
   *
   * @param messageContent 消息内容
   * @param shouldKeep 是否本应保留（最近 10 条或 system）
   * @returns 处理后的消息内容（shouldKeep=false 时仅保留 epistemic 邻域行）
   */
  protectMessage(messageContent: string, shouldKeep: boolean): string {
    if (!this.config.enabled || shouldKeep) return messageContent;

    const lines = messageContent.split('\n');
    const protectedLines = this.computeProtectedLineRanges(lines);

    if (protectedLines.size === 0) {
      // 无 epistemic token：返回空（按原 L2 逻辑删除）
      return '';
    }

    // 仅保留受保护的行 + 占位标记
    const retainedLines: string[] = [];
    let lastProtectedIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (protectedLines.has(i)) {
        if (lastProtectedIdx >= 0 && i > lastProtectedIdx + 1) {
          retainedLines.push('[...epistemic-protected snippet...]');
        }
        retainedLines.push(lines[i]);
        lastProtectedIdx = i;
      }
    }

    logger.debug('EpistemicTokenProtector: protected message lines', {
      totalLines: lines.length,
      protectedCount: protectedLines.size,
      retainedCount: retainedLines.length,
    });

    return retainedLines.join('\n');
  }

  /**
   * 统计文本中 epistemic token 频率
   * 用于 Task 4 的完整性审查
   */
  countEpistemicTokens(text: string): number {
    return this.scanTokens(text).length;
  }
}
```

### 3.3 接线点

- 新增：`src/agent/epistemic-token-protector.ts`
- 修改：`src/agent/context-compaction.ts` — L2 stage2SnipOldMessages 调用 `protector.protectMessage`，对包含 epistemic token 的消息保留邻域行而非完全删除
- 修改：`src/cli/app-init.ts` — 装配 EpistemicTokenProtector 单例，注入 ContextCompactor

### 3.4 Step 分解

- [ ] **Step 1: 定义 EPISTEMIC_TOKENS 常量**

新建 `src/agent/epistemic-token-protector.ts`，按论文 2 定义 10 个 epistemic token：wait/hmm/actually/let me reconsider/on second thought/but/however/perhaps/maybe/not sure。

- [ ] **Step 2: 实现 scanTokens 与 hasEpistemicToken**

scanTokens 扫描文本中所有 epistemic token 出现位置；hasEpistemicToken 返回布尔。

- [ ] **Step 3: 实现 computeProtectedLineRanges**

对每行扫描 epistemic token，命中则保护 [i-N, i+N] 范围，返回受保护行索引集合。

- [ ] **Step 4: 实现 protectMessage**

按 3.2 实现：shouldKeep=true 时原样返回；shouldKeep=false 时仅保留 epistemic 邻域行 + 占位标记。

- [ ] **Step 5: 接入 context-compaction L2**

在 [context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 的 `stage2SnipOldMessages` 方法：
- 对每条消息判断 shouldKeep（最近 10 条或 system）
- shouldKeep=false 时调用 `protector.protectMessage(content, false)`
- 若返回非空字符串，保留为压缩后消息（标注 `[epistemic-protected]`）；若返回空，按原逻辑删除

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 EpistemicTokenProtectorConfig：

```ts
epistemicTokenProtector: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 epistemic token 邻域保护（默认 false） */
  enabled: z.boolean().default(false),
  /** 邻域保护行数（前后各 N 行，默认 3） */
  neighborhoodLines: z.number().int().min(1).max(10).default(3),
  /** 自定义 epistemic token 列表（覆盖默认 10 个） */
  customTokens: z.array(z.string()).optional(),
})).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/epistemic-token-protector.test.ts`，覆盖：
- scanTokens 命中所有 10 个 epistemic token
- scanTokens 大小写不敏感
- hasEpistemicToken 正确性
- computeProtectedLineRanges 保护 [i-N, i+N] 范围
- protectMessage shouldKeep=true 时原样返回
- protectMessage shouldKeep=false 且无 epistemic token 时返回空
- protectMessage shouldKeep=false 且有 epistemic token 时保留邻域行

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-67): Epistemic Token 邻域保护接入 context-compaction L2

新增 EpistemicTokenProtector，L2 Snipping 保护 epistemic token 前后 N 行
论文借鉴：Self-Distillation 的 Epistemic Verbalization
10 token：wait/hmm/actually/let me reconsider/on second thought/but/however/perhaps/maybe/not sure"
```

---

## Task 4：Epistemic Token 完整性审查接入 CrossModelReviewer（≥ 6 测试）

### 4.1 论文借鉴

Self-Distillation 论文的关键实验数据——DeepSeek-R1-Distill-Qwen-7B 上 unguided epistemic token 182.5 → solution-guided 8.8，AIME24 暴跌 40%。论文结论：**仅强化正确答案 trace 不够，post-training 目标必须显式保留不确定性感知的推理行为**。信息丰富度形式化 I(y*;c|x) = H(y*|x) − H(y*|x,c)，四种生成设置不等式链 (1)<(3)≤(4)≤(2)。

RouteDev 的 [CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 当前审查代码时不检查推理过程的 epistemic token 频率变化——如果审查或压缩过程把 epistemic token 频率从 182.5 降到 8.8，这种"过度压缩风险"完全不可见。

### 4.2 设计

在 CrossModelReviewer 上增加 epistemic token 完整性审查：

```ts
// src/agent/epistemic-integrity-checker.ts
import { EpistemicTokenProtector } from './epistemic-token-protector.js';
import { logger } from '../utils/logger.js';

/** Epistemic token 完整性审查结果 */
export interface EpistemicIntegrityResult {
  /** 原始推理的 epistemic token 频率（每千字） */
  originalFrequency: number;
  /** 审查/压缩后推理的 epistemic token 频率（每千字） */
  reviewedFrequency: number;
  /** 频率下降比例（>0 表示下降，<0 表示上升） */
  frequencyDropRatio: number;
  /** 是否标记"过度压缩风险" */
  overCompressionWarning: boolean;
  /** 原始 token 计数 */
  originalTokenCount: number;
  /** 审查后 token 计数 */
  reviewedTokenCount: number;
  /** 原始文本长度 */
  originalLength: number;
  /** 审查后文本长度 */
  reviewedLength: number;
}

/**
 * Epistemic Token 完整性审查器
 *
 * 借鉴 Self-Distillation 论文：
 *   - 对比原始与审查后 epistemic token 频率变化
 *   - 下降超阈值标记"过度压缩风险"
 *   - 论文数据：unguided 182.5 → solution-guided 8.8，AIME24 暴跌 40%
 */
export class EpistemicIntegrityChecker {
  constructor(
    private readonly protector: EpistemicTokenProtector,
    private readonly config: {
      /** 是否启用 */
      enabled: boolean;
      /** 频率下降阈值（下降比例 > 此值时标记过度压缩风险） */
      overCompressionThreshold: number; // 默认 0.5（下降 50%）
      /** 最小原始 token 计数（< 此值时不审查，避免小样本噪声） */
      minTokenCount: number; // 默认 5
    },
  ) {}

  /**
   * 审查 epistemic token 完整性
   *
   * @param originalReasoning 原始推理文本
   * @param reviewedReasoning 审查/压缩后推理文本
   */
  check(originalReasoning: string, reviewedReasoning: string): EpistemicIntegrityResult {
    if (!this.config.enabled) {
      return {
        originalFrequency: 0,
        reviewedFrequency: 0,
        frequencyDropRatio: 0,
        overCompressionWarning: false,
        originalTokenCount: 0,
        reviewedTokenCount: 0,
        originalLength: originalReasoning.length,
        reviewedLength: reviewedReasoning.length,
      };
    }

    const originalTokenCount = this.protector.countEpistemicTokens(originalReasoning);
    const reviewedTokenCount = this.protector.countEpistemicTokens(reviewedReasoning);

    // 频率 = token 计数 / 文本长度 × 1000（每千字）
    const originalFrequency = originalReasoning.length > 0
      ? (originalTokenCount / originalReasoning.length) * 1000
      : 0;
    const reviewedFrequency = reviewedReasoning.length > 0
      ? (reviewedTokenCount / reviewedReasoning.length) * 1000
      : 0;

    // 频率下降比例
    let frequencyDropRatio = 0;
    if (originalFrequency > 0) {
      frequencyDropRatio = (originalFrequency - reviewedFrequency) / originalFrequency;
    }

    // 过度压缩风险：频率下降 > 阈值 且 原始 token 计数 >= 最小值
    const overCompressionWarning = frequencyDropRatio > this.config.overCompressionThreshold
      && originalTokenCount >= this.config.minTokenCount;

    if (overCompressionWarning) {
      logger.warn('EpistemicIntegrityChecker: over-compression risk detected', {
        originalFrequency: originalFrequency.toFixed(2),
        reviewedFrequency: reviewedFrequency.toFixed(2),
        frequencyDropRatio: (frequencyDropRatio * 100).toFixed(1) + '%',
        threshold: (this.config.overCompressionThreshold * 100).toFixed(1) + '%',
        originalTokenCount,
        reviewedTokenCount,
      });
    }

    return {
      originalFrequency,
      reviewedFrequency,
      frequencyDropRatio,
      overCompressionWarning,
      originalTokenCount,
      reviewedTokenCount,
      originalLength: originalReasoning.length,
      reviewedLength: reviewedReasoning.length,
    };
  }
}
```

### 4.3 接线点

- 新增：`src/agent/epistemic-integrity-checker.ts`
- 修改：`src/agent/cross-model-reviewer.ts` — `review()` 方法在生成审查结论后，调用 `checker.check(originalReasoning, reviewedReasoning)`，overCompressionWarning=true 时在 CodeReviewResult 中追加 issue（severity='warning'）
- 修改：`src/cli/app-init.ts` — 装配 EpistemicIntegrityChecker 单例，注入 CrossModelReviewer

### 4.4 Step 分解

- [ ] **Step 1: 定义 EpistemicIntegrityResult 接口**

新建 `src/agent/epistemic-integrity-checker.ts`，按 4.2 定义 EpistemicIntegrityResult（含 originalFrequency、reviewedFrequency、frequencyDropRatio、overCompressionWarning）。

- [ ] **Step 2: 实现 check 主流程**

按 4.2 实现：用 protector.countEpistemicTokens 统计原始与审查后 token 计数 → 计算每千字频率 → 计算下降比例 → 判断过度压缩风险。

- [ ] **Step 3: 实现过度压缩风险判断**

frequencyDropRatio > overCompressionThreshold（默认 0.5）且 originalTokenCount >= minTokenCount（默认 5）时触发。

- [ ] **Step 4: 接入 CrossModelReviewer**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 的 `review()` 方法：
- 保存原始推理文本（userMessage 中的 executionSummary + modifiedFiles 推理过程）
- 审查完成后，调用 `checker.check(originalReasoning, reviewedReasoning)`
- overCompressionWarning=true 时在 CodeReviewResult.issues 中追加：

```ts
{
  severity: 'warning',
  file: null,
  line: null,
  description: `Epistemic token 过度压缩风险：原始频率 ${result.originalFrequency.toFixed(2)}/千字 → 审查后 ${result.reviewedFrequency.toFixed(2)}/千字（下降 ${(result.frequencyDropRatio * 100).toFixed(1)}%）`,
}
```

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 EpistemicIntegrityCheckerConfig：

```ts
epistemicIntegrityChecker: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 epistemic token 完整性审查（默认 false） */
  enabled: z.boolean().default(false),
  /** 频率下降阈值（下降比例 > 此值时标记过度压缩风险） */
  overCompressionThreshold: z.number().min(0).max(1).default(0.5),
  /** 最小原始 token 计数（< 此值时不审查） */
  minTokenCount: z.number().int().min(1).default(5),
})).default({}),
```

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/epistemic-integrity-checker.test.ts`，覆盖：
- 原始与审查后频率一致 → frequencyDropRatio=0，无预警
- 频率下降 60% → overCompressionWarning=true
- 频率下降 30% → overCompressionWarning=false（未超阈值）
- 原始 token 计数 < minTokenCount → 不触发预警
- 频率上升 → frequencyDropRatio<0，无预警
- 配置关闭时返回占位结果

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-67): Epistemic Token 完整性审查接入 CrossModelReviewer

新增 EpistemicIntegrityChecker，对比原始与审查后 epistemic token 频率
论文借鉴：Self-Distillation 的 epistemic token 频率下降 40% 性能暴跌
阈值：频率下降 > 50% 且原始计数 >= 5 时标记过度压缩风险"
```

---

## Task 5：L5 摘要 prompt 保留不确定性表达（≥ 5 测试）

### 5.1 论文借鉴

Self-Distillation 论文结论——**仅强化正确答案 trace 不够，post-training 目标必须显式保留不确定性感知的推理行为**。信息丰富度形式化 I(y*;c|x) = H(y*|x) − H(y*|x,c)，四种生成设置不等式链 (1)<(3)≤(4)≤(2)。任务覆盖度：低覆盖度 SDPO 压缩优势明显；高覆盖度 GRPO 保留 epistemic verbalization 胜出。

RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) L5 LLM Summary 当前的 summarize 函数由调用方提供，prompt 不要求保留 epistemic token 与备选假设分支——摘要往往只摘"最终结论"，丢掉"Wait, let me reconsider" 这类不确定性表达。

### 5.2 设计

新增 `EpistemicPreservingSummarizer`，提供默认的 L5 summarize 函数，prompt 显式要求保留 epistemic token 与备选假设分支：

```ts
// src/agent/epistemic-preserving-summarizer.ts
import type { LLMMessage } from '../router/types.js';
import { EpistemicTokenProtector } from './epistemic-token-protector.js';
import { logger } from '../utils/logger.js';

/**
 * Epistemic Token 保留摘要器
 *
 * 借鉴 Self-Distillation 论文：
 *   - post-training 目标必须显式保留不确定性感知的推理行为
 *   - L5 摘要 prompt 显式要求保留 epistemic token 与备选假设分支
 *   - 不只摘"最终结论"，还要摘"Wait, let me reconsider" 这类不确定性表达
 */
export class EpistemicPreservingSummarizer {
  constructor(
    private readonly llmClient: { chat: (messages: LLMMessage[]) => Promise<string> },
    private readonly protector: EpistemicTokenProtector,
    private readonly config: {
      /** 是否启用 */
      enabled: boolean;
      /** 摘要最大 token 数 */
      maxTokens: number; // 默认 500
    },
  ) {}

  /**
   * 生成保留 epistemic token 的摘要
   *
   * @param messages 待摘要的消息列表
   * @returns 摘要文本
   */
  async summarize(messages: LLMMessage[]): Promise<string> {
    if (!this.config.enabled) {
      // 关闭时降级为简单拼接（最近 3 条消息）
      const recent = messages.slice(-3);
      return recent.map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
    }

    // 统计原始消息中的 epistemic token
    const originalText = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    const originalTokenCount = this.protector.countEpistemicTokens(originalText);

    // 构造 prompt：显式要求保留 epistemic token 与备选假设分支
    const systemPrompt = `你是一个推理过程摘要器。请把以下对话历史压缩为简洁摘要。

【关键要求】
1. 必须保留所有 epistemic token（wait / hmm / actually / let me reconsider / but / however / perhaps / maybe / not sure 等）
2. 必须保留备选假设分支（"原本以为 X，但 reconsider 后发现 Y"）
3. 必须保留不确定性表达的渐进降不确定性过程
4. 不要只摘"最终结论"，要摘"推理过程中的不确定性信号"
5. 摘要长度不超过 ${this.config.maxTokens} token

【输出格式】
- 主结论：<最终结论>
- 关键推理分支：<备选假设与推翻过程，保留 epistemic token>
- 未解决不确定性：<仍存疑的点>

【待摘要对话】
${originalText.slice(0, 8000)}`;

    try {
      const summary = await this.llmClient.chat([
        { role: 'user', content: systemPrompt },
      ]);

      // 验证摘要中是否保留了 epistemic token
      const summaryTokenCount = this.protector.countEpistemicTokens(summary);
      const retentionRatio = originalTokenCount > 0 ? summaryTokenCount / originalTokenCount : 1;

      logger.info('EpistemicPreservingSummarizer: summary generated', {
        originalTokenCount,
        summaryTokenCount,
        retentionRatio: (retentionRatio * 100).toFixed(1) + '%',
        originalLength: originalText.length,
        summaryLength: summary.length,
      });

      if (retentionRatio < 0.3 && originalTokenCount >= 5) {
        // 保留率 < 30% 且原始有 >= 5 个 token：警告但返回摘要
        logger.warn('EpistemicPreservingSummarizer: low retention ratio', {
          retentionRatio: (retentionRatio * 100).toFixed(1) + '%',
          originalTokenCount,
          summaryTokenCount,
        });
      }

      return summary;
    } catch (err) {
      logger.warn('EpistemicPreservingSummarizer: summarize failed, fallback to concatenation', {
        error: String(err),
      });
      // 降级：简单拼接最近 3 条
      const recent = messages.slice(-3);
      return recent.map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
    }
  }
}
```

### 5.3 接线点

- 新增：`src/agent/epistemic-preserving-summarizer.ts`
- 修改：`src/agent/context-compaction.ts` — CompactionConfig.summarize 函数可由 EpistemicPreservingSummarizer 提供
- 修改：`src/cli/app-init.ts` — 装配 EpistemicPreservingSummarizer，注入 ContextCompactor 的 summarize 配置

### 5.4 Step 分解

- [ ] **Step 1: 定义 EpistemicPreservingSummarizer 类**

新建 `src/agent/epistemic-preserving-summarizer.ts`，按 5.2 实现：构造函数接收 llmClient + protector + config。

- [ ] **Step 2: 构造保留 epistemic token 的 prompt**

按 5.2 的 systemPrompt 模板：5 条关键要求（保留 epistemic token / 保留备选假设 / 保留不确定性渐进过程 / 不只摘最终结论 / 长度限制）+ 输出格式（主结论 / 关键推理分支 / 未解决不确定性）。

- [ ] **Step 3: 实现 summarize 主流程**

按 5.2 实现：统计原始 token → 调用 LLM → 验证保留率 → 低保留率警告 → 失败降级为简单拼接。

- [ ] **Step 4: 接入 context-compaction L5**

在 [context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/context-compaction.ts) 的 CompactionConfig.summarize：
- 若配置开启，用 `epistemicPreservingSummarizer.summarize` 作为 summarize 函数
- 关闭时回退到调用方提供的原有 summarize

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 EpistemicPreservingSummarizerConfig：

```ts
epistemicPreservingSummarizer: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 epistemic 保留摘要（默认 false） */
  enabled: z.boolean().default(false),
  /** 摘要最大 token 数 */
  maxTokens: z.number().int().min(100).max(2000).default(500),
})).default({}),
```

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/epistemic-preserving-summarizer.test.ts`，覆盖：
- summarize 调用 LLM 生成摘要
- prompt 包含"保留 epistemic token"要求
- 原始 token 计数与摘要 token 计数统计正确
- 低保留率警告（< 30%）
- LLM 调用失败时降级为简单拼接

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-67): L5 摘要 prompt 保留不确定性表达

新增 EpistemicPreservingSummarizer，L5 摘要 prompt 显式要求保留 epistemic token
论文借鉴：Self-Distillation 的 post-training 目标必须保留不确定性感知推理行为
prompt：5 条关键要求 + 输出格式（主结论/关键推理分支/未解决不确定性）"
```

---

## Task 6：AuditChain 记录 RV 与 MI 指标（≥ 6 测试）

### 6.1 论文借鉴

RAGEN-2 论文强调 MI 代理与 RV 指标的可观测性——Retrieval-Acc、MI-ZScore-EMA、reward variance 是诊断推理质量的核心指标。论文实验中每次迭代都记录这些指标，用于分析退化趋势。

RouteDev 的 [AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts)（Phase 53 Task 4 + Phase 66 Task 4）已实现 SHA-256 哈希链 + 状态承诺快照链，但**每个 audit entry 不附加 RV/MI 指标**——事后无法分析"哪次迭代开始退化""哪个 worker RV 过低被过滤"。

### 6.2 设计

在 AuditLogger 的 audit entry 上附加 RV/MI 指标三字段：

```ts
// src/harness/audit-logger.ts（扩展）
import type { MIProxySnapshot } from '../evaluation/mi-cross-scorer.js';

/**
 * Phase 67 Task 6：RV/MI 指标元数据（附加到审计记录）
 * 借鉴 RAGEN-2：每次迭代记录 reward variance + MI proxy
 */
export interface QualityMetricsMetadata {
  /** Reward 方差（per-prompt 或 per-batch） */
  rewardVariance?: number;
  /** MI 代理快照（Retrieval-Acc / MI-ZScore-EMA / conditional entropy） */
  miProxy?: {
    retrievalAcc: number;
    randomBaseline: number;
    miZScore: number;
    miZScoreEma: number;
    conditionalEntropy: number;
    collapseWarning: boolean;
  };
  /** Epistemic token 统计（原始/审查后/保留率） */
  epistemicStats?: {
    originalCount: number;
    reviewedCount: number;
    retentionRatio: number;
    overCompressionWarning: boolean;
  };
}

/** 扩展的审计记录（带 QualityMetricsMetadata） */
export interface MetricsAuditRecord extends AuditRecord {
  qualityMetrics?: QualityMetricsMetadata;
}

export class AuditLogger {
  // ... 现有代码 ...

  /**
   * Phase 67 Task 6：记录带 RV/MI 指标的审计事件
   */
  logWithMetrics(
    action: AuditAction,
    target: string,
    details: Record<string, unknown>,
    metrics: QualityMetricsMetadata,
    result: AuditRecord['result'] = 'success',
    agentId = 'main',
  ): void {
    if (!this.config.enabled) return;

    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      action,
      agentId,
      target,
      details,
      result,
    };

    (record as MetricsAuditRecord).qualityMetrics = metrics;
    this.writeRecord(record);
  }

  /** 快捷方法：记录 worker 派发与 RV 指标 */
  logWorkerDispatchWithRV(
    taskId: string,
    description: string,
    rewardVariance: number,
    retained: boolean,
    agentId = 'main',
  ): void {
    this.logWithMetrics(
      'worker_dispatch',
      taskId,
      { description, retained },
      { rewardVariance },
      'success',
      agentId,
    );
  }

  /** 快捷方法：记录 MI 代理快照 */
  logMIProxySnapshot(
    snapshot: MIProxySnapshot,
    agentId = 'main',
  ): void {
    this.logWithMetrics(
      'mi_proxy_snapshot',
      `batch_${snapshot.timestamp}`,
      { retrievalAcc: snapshot.retrievalAcc },
      {
        miProxy: {
          retrievalAcc: snapshot.retrievalAcc,
          randomBaseline: snapshot.randomBaseline,
          miZScore: snapshot.miZScore,
          miZScoreEma: snapshot.miZScoreEma,
          conditionalEntropy: snapshot.conditionalEntropy,
          collapseWarning: snapshot.collapseWarning,
        },
      },
      'success',
      agentId,
    );
  }

  /** 快捷方法：记录 epistemic token 完整性审查 */
  logEpistemicIntegrity(
    reviewId: string,
    result: {
      originalTokenCount: number;
      reviewedTokenCount: number;
      frequencyDropRatio: number;
      overCompressionWarning: boolean;
    },
    agentId = 'main',
  ): void {
    const retentionRatio = result.originalTokenCount > 0
      ? result.reviewedTokenCount / result.originalTokenCount
      : 1;
    this.logWithMetrics(
      'epistemic_integrity',
      reviewId,
      { frequencyDropRatio: result.frequencyDropRatio },
      {
        epistemicStats: {
          originalCount: result.originalTokenCount,
          reviewedCount: result.reviewedTokenCount,
          retentionRatio,
          overCompressionWarning: result.overCompressionWarning,
        },
      },
      result.overCompressionWarning ? 'warning' : 'success',
      agentId,
    );
  }
}
```

### 6.3 接线点

- 修改：`src/harness/audit-logger.ts` — 新增 QualityMetricsMetadata 接口、logWithMetrics 方法、3 个快捷方法
- 修改：`src/agent/execution-orchestrator.ts` — worker 派发时调用 `logWorkerDispatchWithRV`
- 修改：`src/evaluation/mi-cross-scorer.ts` — computeMIProxy 完成后调用 `logMIProxySnapshot`
- 修改：`src/agent/epistemic-integrity-checker.ts` — check 完成后调用 `logEpistemicIntegrity`

### 6.4 Step 分解

- [ ] **Step 1: 定义 QualityMetricsMetadata 接口**

在 [audit-logger.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 新增 QualityMetricsMetadata（含 rewardVariance、miProxy、epistemicStats 三字段）与 MetricsAuditRecord。

- [ ] **Step 2: 实现 logWithMetrics 通用方法**

按 6.2 实现：构造 record → 附加 qualityMetrics → writeRecord。

- [ ] **Step 3: 实现 logWorkerDispatchWithRV 快捷方法**

记录 worker 派发事件 + rewardVariance + retained 标志。

- [ ] **Step 4: 实现 logMIProxySnapshot 快捷方法**

记录 MI 代理快照（retrievalAcc / miZScore / miZScoreEma / conditionalEntropy / collapseWarning）。

- [ ] **Step 5: 实现 logEpistemicIntegrity 快捷方法**

记录 epistemic token 完整性审查（originalCount / reviewedCount / retentionRatio / overCompressionWarning）。

- [ ] **Step 6: 接入 execution-orchestrator**

在 [execution-orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) worker 派发时：
- 调用 `auditLogger.logWorkerDispatchWithRV(taskId, description, estimatedRV, retained)`
- retained=false 时 result 标记为 'filtered'

- [ ] **Step 7: 接入 MICrossScorer 与 EpistemicIntegrityChecker**

在 [mi-cross-scorer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/evaluation/mi-cross-scorer.ts) computeMIProxy 完成后调用 `logMIProxySnapshot`。
在 [epistemic-integrity-checker.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/epistemic-integrity-checker.ts) check 完成后调用 `logEpistemicIntegrity`。

- [ ] **Step 8: 配置开关**

AuditChain 的 RV/MI 指标记录复用现有 `auditChain.enabled` 开关，无需新增配置。但增加一个独立开关控制是否记录 epistemic 统计：

```ts
// 在 AuditChainConfigSchema 增加
logEpistemicStats: z.boolean().default(false),
```

- [ ] **Step 9: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/harness/audit-logger-metrics.test.ts`，覆盖：
- logWithMetrics 附加 qualityMetrics 字段
- logWorkerDispatchWithRV 记录 rewardVariance + retained
- logMIProxySnapshot 记录完整 MI 快照
- logEpistemicIntegrity 记录 epistemic 统计
- qualityMetrics 字段持久化到 jsonl
- 哈希链包含 qualityMetrics 字段（防篡改）

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "feat(phase-67): AuditChain 记录 RV 与 MI 指标

AuditLogger 新增 QualityMetricsMetadata + logWithMetrics + 3 个快捷方法
论文借鉴：RAGEN-2 每次迭代记录 reward variance + MI proxy
指标：rewardVariance / miProxy / epistemicStats 三字段附加到 audit entry"
```

---

## Task 7：配置收口、设置页与全量验证（≥ 6 测试）

### 7.1 目标

收口 Phase 67 所有配置项，确保设置页可调，全量验证通过。

### 7.2 Step 分解

- [ ] **Step 1: 配置 schema 收口**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 AppConfigSchema 增加顶层 `reasoningQualityDiagnostics` 字段，聚合 Task 1-6 的所有子配置：

```ts
reasoningQualityDiagnostics: z.preprocess((v) => v ?? {}, z.object({
  /** 总开关（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** Task 1：MI 代理 Template Collapse 预警 */
  miCrossScorer: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    collapseThreshold: z.number().min(1).max(5).default(1.5),
    minPrompts: z.number().int().min(2).default(2),
    samplesPerPrompt: z.number().int().min(1).max(16).default(4),
  })).default({}),
  /** Task 2：SNR-Aware Top-p 过滤 */
  snrAwareFilter: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    topP: z.number().min(0.1).max(1).default(0.9),
    minRVThreshold: z.number().min(0).default(0.01),
    batchRejectRatio: z.number().min(0.5).max(1).default(0.7),
  })).default({}),
  /** Task 3：Epistemic Token 邻域保护 */
  epistemicTokenProtector: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    neighborhoodLines: z.number().int().min(1).max(10).default(3),
    customTokens: z.array(z.string()).optional(),
  })).default({}),
  /** Task 4：Epistemic Token 完整性审查 */
  epistemicIntegrityChecker: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    overCompressionThreshold: z.number().min(0).max(1).default(0.5),
    minTokenCount: z.number().int().min(1).default(5),
  })).default({}),
  /** Task 5：L5 摘要保留不确定性表达 */
  epistemicPreservingSummarizer: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    maxTokens: z.number().int().min(100).max(2000).default(500),
  })).default({}),
  /** Task 6：AuditChain RV/MI 指标记录（复用 auditChain.enabled） */
  auditMetricsLogging: z.preprocess((v) => v ?? {}, z.object({
    logEpistemicStats: z.boolean().default(false),
  })).default({}),
})).default({}),
```

- [ ] **Step 2: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加对应默认值。

- [ ] **Step 3: 设置页 UI**

在 desktop renderer 设置页新增"推理质量诊断"分区：
- 总开关
- 子开关（MICrossScorer / SNRAwareFilter / EpistemicTokenProtector / EpistemicIntegrityChecker / EpistemicPreservingSummarizer / AuditMetricsLogging）
- 参数配置（collapseThreshold / topP / neighborhoodLines / overCompressionThreshold / maxTokens）
- MI 代理仪表盘（显示 Retrieval-Acc / MI-ZScore-EMA 曲线 / collapseWarning 状态）
- SNR 过滤统计（显示最近 N 次 batch 的 retained/filteredOut 比例）
- Epistemic token 频率仪表盘（显示原始/审查后/保留率）

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 4: 仪表盘可视化**

在设置页增加 MI 代理仪表盘：
- Retrieval-Acc 曲线（横轴时间，纵轴 0-1，标注 1/P 基线）
- MI-ZScore-EMA 曲线（横轴时间，纵轴 z-score，标注 -1.5 预警线）
- collapseWarning 红色标记

SNR 过滤统计：
- 最近 N 次 batch 的 retained/filteredOut 堆叠柱状图
- batchRejected 事件红色标记

- [ ] **Step 5: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 45 个测试通过。

- [ ] **Step 6: 文档同步**

更新 README.md 与 ARCHITECTURE.md，说明推理质量诊断架构（MI 代理 + SNR 过滤 + Epistemic 保护）。

- [ ] **Step 7: 配置测试**

新建 `tests/config/reasoning-quality-config.test.ts`，覆盖：
- 默认配置加载（总开关 false）
- 子配置默认值正确
- collapseThreshold 范围校验（1-5）
- topP 范围校验（0.1-1）
- neighborhoodLines 范围校验（1-10）
- overCompressionThreshold 范围校验（0-1）
- 配置热加载（watcher 触发后重新装配）

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-67): 配置收口、设置页与全量验证

推理质量诊断总开关 + 6 个子开关 + 参数配置 + MI/SNR/Epistemic 仪表盘
论文借鉴：RAGEN-2 + Self-Distillation 完整落地
版本：v4.6.6"
```

---

## 风险与回滚

### 风险 1：MI Cross-Scoring 拖慢 worker 派发
- **缓解**：MI 诊断异步执行，不阻塞 worker 派发主流程；P < minPrompts 时降级不诊断
- **回滚**：关闭 `reasoningQualityDiagnostics.miCrossScorer.enabled`

### 风险 2：SNR Top-p 过滤误拒合法 batch
- **缓解**：batchRejectRatio 默认 0.7（70% 零信号才拒绝），保守阈值；filteredOut 任务记录到 audit log 可追溯
- **回滚**：关闭 `reasoningQualityDiagnostics.snrAwareFilter.enabled`，全部 worker 派发

### 风险 3：Epistemic Token 邻域保护导致 L2 压缩失效
- **缓解**：仅保护 epistemic token 前后 N 行（默认 3 行），不保护整条消息；无 epistemic token 的消息按原逻辑删除
- **回滚**：关闭 `reasoningQualityDiagnostics.epistemicTokenProtector.enabled`

### 风险 4：Epistemic 完整性审查误报过度压缩
- **缓解**：minTokenCount 默认 5（原始 < 5 个 token 不审查），overCompressionThreshold 默认 0.5（下降 50% 才预警）
- **回滚**：关闭 `reasoningQualityDiagnostics.epistemicIntegrityChecker.enabled`

### 风险 5：L5 摘要 prompt 改造导致摘要质量下降
- **缓解**：prompt 显式要求保留主结论 + 关键推理分支 + 未解决不确定性三段式，不只是保留 epistemic token；LLM 失败时降级为简单拼接
- **回滚**：关闭 `reasoningQualityDiagnostics.epistemicPreservingSummarizer.enabled`，回退到原有 summarize

### 风险 6：AuditChain 指标记录导致 jsonl 膨胀
- **缓解**：qualityMetrics 字段仅记录数值（rewardVariance / miProxy / epistemicStats），不记录原始文本；定期归档
- **回滚**：关闭 `reasoningQualityDiagnostics.auditMetricsLogging.logEpistemicStats`，仅记录 rewardVariance + miProxy

### 风险 7：MI 代理指标方向与论文不一致
- **缓解**：MI-ZScore-EMA 与性能 Spearman +0.39（论文值），若实测发现 Spearman 为负，说明 z-score 归一化或 EMA 平滑实现有误，需校准
- **回滚**：关闭 MI 诊断，仅保留 SNR 过滤（SNR 不依赖 MI 指标）

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 45 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] 推理质量诊断总开关默认关闭，设置页可开启
- [ ] MICrossScorer 计算 Retrieval-Acc + MI-ZScore-EMA，坍缩时触发预警
- [ ] SNRAwareFilter top-p=0.9 过滤，多数零信号时拒绝整个 batch
- [ ] EpistemicTokenProtector L2 邻域保护 10 个 epistemic token
- [ ] EpistemicIntegrityChecker 对比原始与审查后频率，下降 > 50% 标记过度压缩
- [ ] EpistemicPreservingSummarizer L5 prompt 保留 epistemic token 与备选假设
- [ ] AuditChain 每个 audit entry 附加 (rewardVariance, miProxy, epistemicStats) 三字段
- [ ] MI/SNR/Epistemic 仪表盘可查看（Retrieval-Acc 曲线 / SNR 过滤统计 / epistemic 频率）
- [ ] fail-open：任一子模块失败时降级为现有逻辑，不阻塞主流程
- [ ] 设置页推理质量诊断分区可调（总开关 + 6 个子开关 + 参数）
- [ ] README.md 与 ARCHITECTURE.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中

# Phase 62 — 动态工作流模式与隔离治理

> **版本目标：** v4.6.1
> **前置依赖：** Phase 61（ACRouter 闭环模型路由）完成
> **后继依赖：** Phase 63（上下文状态外部化重构）依赖本 Phase 的 Quarantine 隔离与对抗验证常规化
> **新增测试要求：** ≥ 35 个
> **研究依据：** 精读 Anthropic 官方博客《A harness for every task: dynamic workflows in Claude Code》（2026-06-02）全文。博客核心论断：长任务在单上下文窗口触发三种失败——**agentic laziness**（部分进度就宣布完成，如安全审查 50 项只做 35 项就宣布完成）、**self-preferential bias**（自我验证偏袒，同模型既写又评必然漏判自身缺陷）、**goal drift**（压缩后约束丢失，每步摘要都是有损的，"不要做 X"这类否定约束会丢失）。博客提出六大可复用模式（Classify-and-act / Fan-out-and-synthesize / Adversarial verification / Generate-and-filter / Tournament / Loop until done）与一个安全关键的 **Quarantine 模式**（读不可信公开内容的 agent 禁止高权限动作，由独立"动作 agent"执行基于信息的高权限操作）。博客主张**动态工作流优于静态工作流**——静态工作流需为所有边缘情况设计故通常泛化，动态工作流让 Claude 自己写定制 harness（JS 文件 + 特殊函数 spawn/协调 subagent），用 `ultracode` 触发词确保创建 workflow，并与 `/goal`（硬完成要求）、`/loop`（定期重复）配合。
> **核心命题：** RouteDev 的 [execution-orchestrator](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 当前 worker 并行**无显式 synthesize 屏障**——并行 worker 各自返回结果后直接拼装，没有"等所有 fan-out 完成后合并结构化输出"的屏障语义。[cross-model-reviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 仅在高风险事后触发，对抗验证非常规化。[security.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/security.ts) 有 PolicyEngine 但**无 Quarantine 隔离**——读公开 web 内容的 agent 与能写文件/执行 shell 的 agent 共享同一权限边界，这是当前最大安全缺口。Phase 62 把六大模式中的四种（Fan-out-and-synthesize / Adversarial verification / Loop-until-done / Tournament）与 Quarantine 隔离落地到 RouteDev 既有模块。

---

## 项目现状审计与可行性结论

### 1. 博客模式与 RouteDev 缺口的映射

| Claude Code 模式 | 核心 Contribution | RouteDev 现状缺口 | Phase 62 Task |
|------------------|-------------------|-------------------|---------------|
| Fan-out-and-synthesize | 拆分→并行子 agent→**屏障合并**（synthesize 是屏障，等所有 fan-out 完成后合并结构化输出） | [execution-orchestrator](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 并行 worker 各自返回，无显式 synthesize 屏障语义 | Task 1（SynthesizeBarrier） |
| Adversarial verification | 每个子 agent 配对抗验证 agent，按 rubric 检查 | [cross-model-reviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 仅高风险事后审查，未常规化、未配 rubric | Task 2（对抗验证常规化） |
| Loop until done | 停止条件驱动（无新发现/无新错误）而非固定轮数 | [completion-gate](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 用固定 gateRetry，无"无新发现"停止判定 | Task 3（LoopUntilDoneGate） |
| Quarantine 模式 | 读不可信公开内容的 agent 禁止高权限动作，由独立"动作 agent"执行 | [security.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/security.ts) 无 agent 降权机制，读 web 与写文件共享权限 | Task 4（Quarantine 隔离治理） |
| Tournament | N 个 agent 同任务竞争→pairwise judging→淘汰至冠军 | [compose-pipeline](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/compose-pipeline.ts) requirements 阶段单一方案，无多方案竞争 | Task 5（Tournament 选型） |
| Generate-and-filter | 生成多方案→按 rubric 过滤→去重 | compose-pipeline coding 阶段单路径，无 generate-and-filter | 本 Phase 暂不落地（Phase 64 接 SkillWeaver 多方案生成时合并） |
| Classify-and-act | 分类器 agent 决定路由 | Phase 61 ACRouter 已落地 | 不重复 |
| agentic laziness 诊断 | 部分进度就宣布完成 | completion-gate 用 spawnSync 验证但无"完成度百分比" | Task 3（停止条件含完成度检查） |
| self-preferential bias 诊断 | 同模型既写又评必然漏判 | CrossModelReviewer 已支持跨模型但非常规化 | Task 2 |
| goal drift 诊断 | 压缩后约束丢失 | [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) L5 摘要不保留约束清单 | Phase 63 Task 1 解决 |

### 2. 可行性总评

- **Task 1（Fan-out-and-synthesize 屏障）：** 高度可行。现有 [Orchestrator](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) 已生成 ExecutionPlan，[WorkerExecutor](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/worker-executor.ts) 已并行执行，只需在并行组完成回调点插入 synthesize 屏障。
- **Task 2（对抗验证常规化）：** 可行。[CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 已具备跨模型审查能力，扩展为"每步可配 verifier agent"需增加 rubric 注入与触发频率配置。
- **Task 3（Loop-until-done）：** 可行。[completion-gate](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 已有 GateResult.checks，扩展为"无新发现/无新错误"停止判定需对比前后两轮 check 结果。
- **Task 4（Quarantine 隔离）：** 中等可行。[security.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/security.ts) 已有 PermissionProfile，新增"不可信源 agent 降权机制"需扩展 profile 维度（agent 来源标签 + 工具黑名单），并接入 [spawn-agent](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/spawn-agent.ts) 的子 agent 创建路径。
- **Task 5（Tournament 选型）：** 可行。compose-pipeline requirements 阶段已有 systemPromptOverride 注入点，新增"多方案竞争 + pairwise judging"需在阶段配置中增加 tournament 模式开关。
- **Task 6（配置收口）：** 高度可行。遵循 Phase 51 反写死原则。

---

## 核心设计原则

### 原则 1：屏障优先于拼接

博客核心模式——Fan-out-and-synthesize 的 synthesize 是**屏障**，必须等所有 fan-out 完成（含失败/超时）后才能合并。Phase 62 的每个并行执行点都要回答："这里需要屏障语义吗？如果 fan-out 中途有失败，synthesize 还能合并吗？" 答案总是"需要屏障且必须处理失败"。

### 原则 2：对抗验证常规化，而非仅高风险触发

博客诊断——self-preferential bias 是同模型既写又评的必然结果。Phase 62 的对抗验证不再"高风险才触发"，而是每步可配 verifier agent，默认频率可调（每步/每 N 步/仅末尾）。fail-open：verifier 不可用时降级为同模型自评但显式标注"未对抗"。

### 原则 3：停止条件驱动，而非固定轮数

博客 Loop-until-done 模式——用"无新发现/无新错误"做停止判定，比固定轮数更接近真实完成。Phase 62 的 LoopUntilDoneGate 必须对比连续两轮的 check 结果集，仅在两轮集合差为空时才允许停止。

### 原则 4：Quarantine 是安全底线，不可协商

博客安全关键模式——读不可信公开内容的 agent 禁止 file_write/shell_exec。Phase 62 的 Quarantine 是**强制性 deny**，不走 PolicyEngine 的 deny-overrides 协商路径（避免被高优先级 allow 策略覆盖）。读 web 的 agent 产生的"基于信息的高权限操作意图"必须由独立"动作 agent"代为执行。

### 原则 5：反写死原则（延续 Phase 51）

所有新增模式必须有配置开关、设置页面入口、明确代码接线点。默认关闭，用户在设置页开启。Tournament 与对抗验证因 LLM 成本较高，默认关闭。

### 原则 6：Fail-open，不阻塞主流程

synthesize 屏障超时、verifier 调用失败、Tournament judging 异常时，降级为现有行为（直接拼接/同模型自评/选首个方案），不阻塞主流程，但显式标注降级原因。

### 原则 7：死代码防护与执行人自审（延续 Phase 51/53）

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

## Task 1：Fan-out-and-synthesize 屏障模式落地（≥ 6 测试）

### 1.1 论文借鉴

博客 Fan-out-and-synthesize 模式：拆分→并行子 agent→**屏障合并**（synthesize 是屏障，等所有 fan-out 完成后合并结构化输出）。关键在于 synthesize 是**屏障语义**——必须等所有 fan-out（含失败/超时）完成才能合并，且合并输出是结构化的（不是简单字符串拼接）。RouteDev 的 [execution-orchestrator](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 当前并行组用 Promise.allSettled 后直接拼装 WorkerResult.result 字符串，无结构化合并、无屏障超时、无失败占位。

### 1.2 设计

新增 `SynthesizeBarrier` 类，包装现有并行组执行后的合并环节：

```ts
// src/agent/multi/synthesize-barrier.ts
/**
 * Fan-out-and-synthesize 屏障
 * 博客借鉴：synthesize 是屏障，等所有 fan-out 完成后合并结构化输出
 *
 * 与 Promise.allSettled 的区别：
 *   1. 屏障超时（独立于 worker 超时）
 *   2. 失败 worker 占位（不丢弃，标注 failedReason）
 *   3. 结构化合并（按字段聚合，而非字符串拼接）
 */
export interface FanOutResult<T = unknown> {
  /** worker ID */
  workerId: string;
  /** 是否成功 */
  success: boolean;
  /** 成功时的结构化结果 */
  data?: T;
  /** 失败时的错误摘要 */
  failedReason?: string;
  /** worker 执行耗时（ms） */
  durationMs: number;
}

export interface SynthesizeOptions {
  /** 屏障超时（ms，独立于 worker 超时），默认 60000 */
  barrierTimeoutMs: number;
  /** 合并策略 */
  strategy: 'merge-fields' | 'concat-dedup' | 'judging';
  /** 失败 worker 是否参与合并（默认 true，以 failedReason 占位） */
  includeFailed: boolean;
}

export interface SynthesizeOutput<T = unknown> {
  /** 合并后的结构化输出 */
  merged: T;
  /** 参与合并的 worker 列表（含失败占位） */
  participants: FanOutResult[];
  /** 屏障是否超时 */
  barrierTimedOut: boolean;
  /** 合并耗时（ms） */
  synthesizeMs: number;
}

export class SynthesizeBarrier<T = unknown> {
  /**
   * 屏障合并
   * @param fanOutResults 所有 fan-out worker 的结果（含失败）
   * @param options 合并选项
   * @returns 结构化合并输出
   */
  async synthesize(
    fanOutResults: FanOutResult<T>[],
    options: SynthesizeOptions,
  ): Promise<SynthesizeOutput<T>>;

  /** merge-fields 策略：按字段名聚合，同名字段取首个非空 */
  private mergeByFields(results: FanOutResult<T>[]): T;

  /** concat-dedup 策略：数组合并后按 hash 去重 */
  private concatDedup(results: FanOutResult<T>[]): T;

  /** judging 策略：调用 LLM 做裁判合并（fail-open 时降级为 concat-dedup） */
  private judgeMerge(results: FanOutResult<T>[]): Promise<T>;
}
```

### 1.3 接线点

- 新增：`src/agent/multi/synthesize-barrier.ts`
- 修改：`src/agent/execution-orchestrator.ts` — 并行组执行后调用 `synthesizeBarrier.synthesize` 替代直接拼装
- 修改：`src/agent/multi/worker-executor.ts` — WorkerResult 转 FanOutResult 适配器
- 复用：[CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的内容哈希（concat-dedup 策略去重）

### 1.4 Step 分解

- [ ] **Step 1: 定义 SynthesizeBarrier 类与 FanOutResult 类型**

新建 `src/agent/multi/synthesize-barrier.ts`，实现上述接口。`barrierTimeoutMs` 默认 60000，`includeFailed` 默认 true。

- [ ] **Step 2: 实现 merge-fields 策略**

按字段名聚合对象数组，同名字段取首个非空值（适用于多 worker 各自填一部分结构化字段的场景）。

- [ ] **Step 3: 实现 concat-dedup 策略**

数组合并后按内容哈希去重，复用 [CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 `createHash('sha256')` 模式（避免引入新依赖）。

- [ ] **Step 4: 实现 judging 策略与 fail-open**

调用 LLM 做裁判合并（注入 rubric prompt）；LLM 调用失败时降级为 concat-dedup，标注 `synthesizeMs` 与降级原因。

- [ ] **Step 5: 屏障超时实现**

用 Promise.race 包装 synthesize 内部逻辑，超时返回当前已合并的部分结果，标注 `barrierTimedOut: true`。

- [ ] **Step 6: 接入 execution-orchestrator**

在 [execution-orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts) 并行组执行后，构造 FanOutResult 数组（成功填 data，失败填 failedReason），调用 synthesizeBarrier.synthesize，结果写入 ExecutionOrchestrationResult.blackboardSnapshot。

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 OrchestrationIntegrationSchema（或新增 DynamicWorkflowConfigSchema）增加：

```ts
synthesizeBarrier: z.object({
  enabled: z.boolean().default(false),
  barrierTimeoutMs: z.number().int().default(60000),
  defaultStrategy: z.enum(['merge-fields', 'concat-dedup', 'judging']).default('concat-dedup'),
  includeFailed: z.boolean().default(true),
}).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/multi/synthesize-barrier.test.ts`，覆盖：
- merge-fields 同名字段取首个非空
- concat-dedup 按 hash 去重
- judging 调用 LLM 合并
- judging fail-open 降级为 concat-dedup
- 屏障超时返回部分结果
- 失败 worker 占位（includeFailed=true）

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-62): Fan-out-and-synthesize 屏障模式落地

新增 SynthesizeBarrier，屏障语义替代直接拼装
博客借鉴：synthesize 是屏障，等所有 fan-out 完成后合并结构化输出
策略：merge-fields / concat-dedup / judging，judging fail-open 降级"
```

---

## Task 2：Adversarial verification 常规化（≥ 6 测试）

### 2.1 论文借鉴

博客 Adversarial verification 模式：每个子 agent 配对抗验证 agent，按 **rubric** 检查。博客诊断——self-preferential bias 是同模型既写又评的必然结果，对抗验证用"不同模型 + 显式 rubric"打破偏袒。RouteDev 的 [CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 已支持跨模型审查，但仅在高风险事后触发，且无 rubric 注入——审查 prompt 是固定 5 维度（安全/性能/可读性/边界/错误处理），无法按任务类型定制。

### 2.2 设计

扩展 `CrossModelReviewer` 为常规化对抗验证，新增 `AdversarialVerifier` 包装类：

```ts
// src/agent/adversarial-verifier.ts
/**
 * 对抗验证常规化
 * 博客借鉴：每个子 agent 配对抗验证 agent，按 rubric 检查
 *
 * 与 CrossModelReviewer 的区别：
 *   1. 触发频率可配（每步/每 N 步/仅末尾），不再仅高风险
 *   2. rubric 可注入（按任务类型定制检查清单）
 *   3. fail-open：verifier 不可用时降级为同模型自评，显式标注"未对抗"
 */
export interface VerifierRubric {
  /** rubric ID（用于追踪） */
  id: string;
  /** 任务类型匹配（如 'security-audit' / 'refactor' / 'new-feature'） */
  taskType: string;
  /** 检查项清单（每项含描述 + 严重度） */
  checks: Array<{
    description: string;
    severity: 'critical' | 'major' | 'minor';
  }>;
}

export interface AdversarialVerifierConfig {
  /** 触发频率：every-step / every-n-steps / end-only */
  frequency: 'every-step' | 'every-n-steps' | 'end-only';
  /** every-n-steps 时的 N 值 */
  n?: number;
  /** 默认 rubric（任务类型无匹配时使用） */
  defaultRubric: VerifierRubric;
  /** verifier 模型 ID（不填则复用 CrossModelReviewer 的选模型逻辑） */
  verifierModelId?: string;
  /** 是否强制跨模型（true 时单模型可用也拒绝自评） */
  forceCrossModel: boolean;
}

export interface VerificationOutcome {
  /** 是否通过（无 critical 问题） */
  passed: boolean;
  /** 检查项结果（按 rubric 顺序） */
  checkResults: Array<{
    description: string;
    severity: 'critical' | 'major' | 'minor';
    passed: boolean;
    note?: string;
  }>;
  /** 是否真正跨模型（false 表示 fail-open 降级为同模型自评） */
  isCrossModel: boolean;
  /** 未对抗原因（isCrossModel=false 时填充） */
  downgradeReason?: string;
}

export class AdversarialVerifier {
  constructor(
    private readonly crossModelReviewer: CrossModelReviewer,
    private readonly rubricRegistry: Map<string, VerifierRubric>,
    private readonly config: AdversarialVerifierConfig,
  ) {}

  /** 判断当前步骤是否应触发验证 */
  shouldVerify(stepIndex: number, totalSteps: number): boolean;

  /** 按任务类型选择 rubric */
  selectRubric(taskType: string): VerifierRubric;

  /** 执行对抗验证 */
  async verify(params: {
    modifiedFiles: string[];
    executionSummary: string;
    taskType: string;
    stepIndex: number;
  }): Promise<VerificationOutcome>;
}
```

### 2.3 接线点

- 新增：`src/agent/adversarial-verifier.ts`
- 新增：`src/agent/rubric-registry.ts` — 内置 rubric 库（security-audit / refactor / new-feature / bug-fix 四类）
- 修改：`src/agent/cross-model-reviewer.ts` — review 方法增加可选 rubric 参数，注入到 user message
- 修改：`src/cli/goal-runner.ts` — 步骤执行后调用 adversarialVerifier.shouldVerify，命中则 verify
- 修改：`src/cli/app-init.ts` — 装配 AdversarialVerifier 单例

### 2.4 Step 分解

- [ ] **Step 1: 定义 VerifierRubric 与 AdversarialVerifierConfig 类型**

新建 `src/agent/adversarial-verifier.ts`，实现上述接口。`frequency` 默认 `end-only`（成本敏感），`forceCrossModel` 默认 false。

- [ ] **Step 2: 内置 rubric 库**

新建 `src/agent/rubric-registry.ts`，预置四类 rubric：
- `security-audit`：硬编码密钥/注入/SSRF/权限提升（critical 4 项）
- `refactor`：行为不变/无新增 API/测试通过/命名清晰（major 2 + minor 2）
- `new-feature`：覆盖验收标准/边界处理/错误处理/测试覆盖（major 4）
- `bug-fix`：复现路径/根因/回归测试/副作用（major 4）

- [ ] **Step 3: 实现 shouldVerify**

按 frequency 配置返回：every-step 总是 true；every-n-steps 当 stepIndex % n === 0；end-only 当 stepIndex === totalSteps - 1。

- [ ] **Step 4: 实现 verify 与 fail-open**

调用 crossModelReviewer.review，注入 rubric 到 user message。verifier 不可用（LLM 调用失败/单模型可用且 forceCrossModel=true）时降级为同模型自评，标注 `isCrossModel: false` 与 `downgradeReason`。

- [ ] **Step 5: 修改 CrossModelReviewer 接受 rubric**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 的 review 方法增加可选 `rubric?: VerifierRubric` 参数，存在时拼接到 userMessage 末尾（替换默认 5 维度 prompt）。

- [ ] **Step 6: 接入 goal-runner**

在 [goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts) 每步执行后调用 `adversarialVerifier.shouldVerify(stepIndex, totalSteps)`，命中则调用 verify，结果写入步骤 trace 与 ExecutionOrchestrationResult。

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
adversarialVerification: z.object({
  enabled: z.boolean().default(false),
  frequency: z.enum(['every-step', 'every-n-steps', 'end-only']).default('end-only'),
  n: z.number().int().min(1).default(3),
  forceCrossModel: z.boolean().default(false),
  verifierModelId: z.string().optional(),
}).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/adversarial-verifier.test.ts`，覆盖：
- shouldVerify 三种频率
- selectRubric 任务类型匹配
- verify 跨模型成功
- verify fail-open 降级（forceCrossModel=true 且单模型）
- rubric 注入到 review 调用
- 配置关闭时跳过

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-62): Adversarial verification 常规化

新增 AdversarialVerifier，从仅高风险扩展为每步可配对抗验证
博客借鉴：每个子 agent 配对抗验证 agent，按 rubric 检查
fail-open：verifier 不可用时降级为同模型自评，显式标注未对抗"
```

---

## Task 3：Loop-until-done 停止条件驱动（≥ 6 测试）

### 3.1 论文借鉴

博客 Loop-until-done 模式：**停止条件驱动**（无新发现/无新错误）而非固定轮数。博客诊断——agentic laziness 让 agent 在固定轮数内"凑数完成"，停止条件驱动要求连续两轮 check 结果集差为空才允许停止。RouteDev 的 [completion-gate](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 用固定 `gateRetry: 1`，验证失败后仅重试一次，无"无新发现"停止判定——复杂任务可能一轮重试不够，简单任务又浪费一轮。

### 3.2 设计

新增 `LoopUntilDoneGate` 类，包装现有 CompletionGate：

```ts
// src/agent/loop-until-done-gate.ts
/**
 * Loop-until-done 停止条件驱动
 * 博客借鉴：停止条件是"无新发现/无新错误"，而非固定轮数
 *
 * 与 CompletionGate.gateRetry 的区别：
 *   1. 最大轮数是上限保护（默认 5），实际停止由停止条件决定
 *   2. 对比连续两轮 check 结果集，差为空才允许停止
 *   3. 完成度百分比（agentic laziness 诊断）：低于阈值时拒绝停止
 */
export interface LoopUntilDoneConfig {
  /** 最大轮数上限（保护，默认 5） */
  maxRounds: number;
  /** 停止条件：连续 N 轮无新发现 */
  stableRoundsRequired: number; // 默认 2
  /** 完成度阈值（0-1，低于此值拒绝停止，agentic laziness 诊断） */
  minCompletionRatio: number; // 默认 0.85
  /** 单轮 gate 超时（沿用 CompletionGate.gateTimeout） */
  gateTimeoutMs: number;
}

export interface LoopCheckSnapshot {
  /** 轮次 */
  round: number;
  /** 本轮 check 名称集合（如 'typecheck' / 'lint' / 'tests'） */
  checkNames: Set<string>;
  /** 本轮失败的 check 集合 */
  failedChecks: Set<string>;
  /** 本轮 check 输出指纹（SHA-256，用于对比"是否有新错误内容"） */
  failureFingerprints: Map<string, string>;
  /** 完成度估算（基于检查项通过比例） */
  completionRatio: number;
}

export interface LoopUntilDoneResult {
  /** 是否允许停止 */
  canStop: boolean;
  /** 实际执行的轮数 */
  roundsExecuted: number;
  /** 停止原因 */
  stopReason: 'stable' | 'max-rounds' | 'completion-threshold-met' | 'manual-abort';
  /** 各轮快照 */
  snapshots: LoopCheckSnapshot[];
  /** 最终完成度 */
  finalCompletionRatio: number;
}

export class LoopUntilDoneGate {
  constructor(
    private readonly completionGate: CompletionGate,
    private readonly config: LoopUntilDoneConfig,
  ) {}

  /**
   * 执行 loop-until-done 循环
   * 每轮调用 completionGate.run，对比连续两轮快照
   */
  async run(params: {
    projectPath: string;
    modifiedFiles: string[];
  }): Promise<LoopUntilDoneResult>;

  /** 计算两轮快照的差异（新增失败 check + 已有失败内容变化） */
  private diffSnapshots(prev: LoopCheckSnapshot, curr: LoopCheckSnapshot): {
    newFailedChecks: string[];
    changedFailureContents: string[];
  };

  /** 估算完成度（agentic laziness 诊断） */
  private estimateCompletion(gateResult: GateResult): number;
}
```

### 3.3 接线点

- 新增：`src/agent/loop-until-done-gate.ts`
- 修改：`src/cli/goal-runner.ts` — 验证环节用 LoopUntilDoneGate 替代直接调用 CompletionGate（开关开启时）
- 复用：[completion-gate.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 的 spawnSync 验证逻辑（不重写）
- 复用：[ccr-cache.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 createHash 模式生成 failureFingerprints

### 3.4 Step 分解

- [ ] **Step 1: 定义 LoopUntilDoneConfig 与 LoopCheckSnapshot 类型**

新建 `src/agent/loop-until-done-gate.ts`，实现上述接口。`maxRounds` 默认 5，`stableRoundsRequired` 默认 2，`minCompletionRatio` 默认 0.85。

- [ ] **Step 2: 实现 diffSnapshots**

对比两轮快照：新增失败 check（curr.failedChecks - prev.failedChecks）+ 已有失败内容变化（failureFingerprints 中同 check 不同 hash）。差为空时返回空数组。

- [ ] **Step 3: 实现 estimateCompletion**

基于 GateResult.checks 中 ok=true 的比例。skipped 不计入分母（避免超时误判为未完成）。返回 0-1。

- [ ] **Step 4: 实现 run 循环**

每轮调用 completionGate.run，构造快照，与上一轮 diffSnapshots。停止条件：
1. 连续 stableRoundsRequired 轮 diff 为空 → stopReason: 'stable'
2. completionRatio >= minCompletionRatio 且无 critical 失败 → stopReason: 'completion-threshold-met'
3. 达到 maxRounds → stopReason: 'max-rounds'

- [ ] **Step 5: 接入 goal-runner**

在 [goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts) 验证环节，若 config 启用 loopUntilDone，用 LoopUntilDoneGate.run 替代直接 completionGate.run，结果写入 trace。

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
loopUntilDone: z.object({
  enabled: z.boolean().default(false),
  maxRounds: z.number().int().min(1).max(20).default(5),
  stableRoundsRequired: z.number().int().min(1).default(2),
  minCompletionRatio: z.number().min(0).max(1).default(0.85),
}).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/loop-until-done-gate.test.ts`，覆盖：
- 连续两轮无新发现 → stable 停止
- 达到 maxRounds → max-rounds 停止
- 完成度不足拒绝停止
- 完成度达标且无 critical → completion-threshold-met 停止
- diffSnapshots 新增失败 check 检测
- diffSnapshots 失败内容变化检测

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-62): Loop-until-done 停止条件驱动

新增 LoopUntilDoneGate，无新发现/无新错误停止判定替代固定轮数
博客借鉴：Loop until done 模式 + agentic laziness 诊断
复用：CompletionGate 的 spawnSync 验证逻辑"
```

---

## Task 4：Quarantine 隔离治理（≥ 8 测试）

### 4.1 论文借鉴

博客 Quarantine 模式（安全关键）：读不可信公开内容的 agent 禁止高权限动作，由"动作 agent"执行基于信息的高权限操作。博客诊断——这是当前安全缺口，agent 读 web 内容后可能被 prompt injection 诱导执行危险命令。RouteDev 的 [security.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/security.ts) 有 PolicyEngine 与 PermissionProfile，但**无 agent 降权机制**——读 web 的 agent 与能写文件/执行 shell 的 agent 共享同一权限边界。读 web 内容的 agent 产生的"基于信息的高权限操作意图"必须由独立"动作 agent"代为执行。

### 4.2 设计

新增 `QuarantineProfileManager` 与 `ActionAgentDispatcher`：

```ts
// src/tools/quarantine-profile.ts
/**
 * Quarantine 隔离治理
 * 博客借鉴：读不可信公开内容的 agent 禁止高权限动作，由独立动作 agent 执行
 *
 * 设计：
 *   1. agent 来源标签（untrusted-web / trusted-local / privileged）
 *   2. untrusted-web agent 强制 deny file_write/shell_exec（不走 PolicyEngine 协商）
 *   3. untrusted-web agent 产生的高权限意图通过 ActionAgentDispatcher 转交
 *   4. ActionAgentDispatcher 是独立 agent 实例，使用 trusted-local 权限
 */
export type AgentTrustLevel = 'untrusted-web' | 'trusted-local' | 'privileged';

export interface QuarantineProfile {
  /** agent 信任级别 */
  trustLevel: AgentTrustLevel;
  /** 来源标记（如 'web-fetch:https://example.com'） */
  source: string;
  /** 强制 deny 的工具列表（untrusted-web 默认含 file_write/shell_exec） */
  deniedTools: string[];
  /** 是否允许产生高权限意图（false 时直接拒绝，true 时转发到 ActionAgentDispatcher） */
  allowIntentForwarding: boolean;
}

export class QuarantineProfileManager {
  /** 为 agent 创建隔离 profile */
  createProfile(params: {
    trustLevel: AgentTrustLevel;
    source: string;
    customDeniedTools?: string[];
  }): QuarantineProfile;

  /** 检查工具调用是否被 quarantine 拒绝（强制 deny，不走协商） */
  isDenied(profile: QuarantineProfile, toolName: string): boolean;

  /** 标记 agent 已访问不可信源（用于追踪污染链） */
  markContactWithUntrusted(agentId: string, source: string): void;

  /** 查询 agent 是否被污染（曾访问不可信源） */
  isContaminated(agentId: string): boolean;
}

// src/agent/action-agent-dispatcher.ts
/**
 * 动作 agent 调度器
 * 博客借鉴：读不可信内容的 agent 禁止高权限动作，由独立动作 agent 执行
 *
 * 工作流：
 *   1. untrusted-web agent 产生"基于信息的高权限操作意图"
 *   2. 意图序列化为 ActionIntent 结构
 *   3. ActionAgentDispatcher 用 trusted-local 权限的独立 agent 执行
 *   4. 执行结果回传给原 agent（仅回传结构化结果，不回传执行细节）
 */
export interface ActionIntent {
  /** 意图 ID */
  id: string;
  /** 来源 agent ID（untrusted-web） */
  sourceAgentId: string;
  /** 意图类型（file-write / shell-exec / config-change） */
  type: 'file-write' | 'shell-exec' | 'config-change';
  /** 操作描述（自然语言） */
  description: string;
  /** 操作参数（结构化） */
  params: Record<string, unknown>;
  /** 不可信源 URL（追溯用） */
  untrustedSource: string;
}

export class ActionAgentDispatcher {
  /**
   * 调度独立动作 agent 执行高权限操作
   * @returns 结构化结果（不含执行细节，避免 prompt injection 反向注入）
   */
  async dispatch(intent: ActionIntent): Promise<{
    success: boolean;
    result: unknown;
    /** 拒绝原因（被 PolicyEngine 拒绝时填充） */
    rejectedReason?: string;
  }>;
}
```

### 4.3 接线点

- 新增：`src/tools/quarantine-profile.ts`
- 新增：`src/agent/action-agent-dispatcher.ts`
- 修改：`src/tools/security.ts` — SecurityChecker 增加 `quarantineProfile?: QuarantineProfile` 字段，checkToolCall 前先调用 `QuarantineProfileManager.isDenied`（强制 deny，不走 PolicyEngine）
- 修改：`src/tools/builtin/spawn-agent.ts` — 子 agent 创建时根据父 agent 的 trustLevel 与是否曾访问 web 决定子 agent 的 trustLevel
- 修改：`src/tools/builtin/web-fetch.ts` 与 `src/tools/builtin/web-search.ts` — 调用后调用 `markContactWithUntrusted`
- 修改：`src/policies/policy-engine.ts` — evaluateAction 前调用 QuarantineProfileManager.isDenied（短路，不走 deny-overrides）

### 4.4 Step 分解

- [ ] **Step 1: 定义 AgentTrustLevel 与 QuarantineProfile 类型**

新建 `src/tools/quarantine-profile.ts`，实现上述接口。`untrusted-web` 默认 deniedTools 含 `['file_write', 'file_edit', 'shell_exec', 'git_op']`，`allowIntentForwarding` 默认 true。

- [ ] **Step 2: 实现 QuarantineProfileManager**

`createProfile` 按 trustLevel 生成默认 deniedTools；`isDenied` 检查 toolName 是否在 deniedTools 中（精确匹配，不用 includes）；`markContactWithUntrusted` 与 `isContaminated` 用 Map<agentId, string[]> 追踪污染链。

- [ ] **Step 3: 实现 ActionAgentDispatcher**

`dispatch` 创建独立 agent 实例（trusted-local 权限），执行 ActionIntent。PolicyEngine 仍对动作 agent 生效（quarantine 不绕过 PolicyEngine，只绕过 untrusted-web 的 deny）。结果回传时仅保留结构化字段（success/result/rejectedReason），剥离执行细节（避免 prompt injection 反向注入）。

- [ ] **Step 4: 修改 SecurityChecker 接入 quarantine**

在 [security.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/security.ts) 的 SecurityChecker 增加 `quarantineProfile?: QuarantineProfile` 字段。checkToolCall 入口处先调用 `quarantineProfileManager.isDenied(profile, toolName)`，命中则直接返回 `{ safe: false, reason: 'quarantine-denied' }`，**不走 PolicyEngine 协商**。

- [ ] **Step 5: 修改 spawn-agent 接入污染链**

在 [spawn-agent.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/spawn-agent.ts) 子 agent 创建时：
- 父 agent 是 untrusted-web → 子 agent 强制 untrusted-web
- 父 agent 是 trusted-local 但 isContaminated → 子 agent 降级为 untrusted-web
- 父 agent 是 privileged 且未污染 → 子 agent trusted-local

- [ ] **Step 6: 修改 web-fetch / web-search 标记污染**

在 [web-fetch.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/web-fetch.ts) 与 [web-search.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/web-search.ts) 调用完成后，调用 `quarantineProfileManager.markContactWithUntrusted(currentAgentId, url)`。

- [ ] **Step 7: 修改 PolicyEngine 短路**

在 [policy-engine.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 的 evaluateAction 入口处先调用 `isDenied`，命中则直接返回 `{ denied: true, reason: 'quarantine-denied', matchedPolicies: 0 }`，不走 deny-overrides 协商。

- [ ] **Step 8: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 SecurityConfigSchema 增加：

```ts
quarantine: z.object({
  enabled: z.boolean().default(false),
  /** 默认 deny 工具列表（untrusted-web agent） */
  untrustedDeniedTools: z.array(z.string()).default(['file_write', 'file_edit', 'shell_exec', 'git_op']),
  /** 是否允许意图转发到 ActionAgentDispatcher */
  allowIntentForwarding: z.boolean().default(true),
  /** 污染链追踪深度（默认 10，超过则强制降级） */
  contaminationTraceDepth: z.number().int().default(10),
}).default({}),
```

- [ ] **Step 9: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/tools/quarantine-profile.test.ts`，覆盖：
- untrusted-web agent 调用 file_write 被强制 deny
- untrusted-web agent 调用 file_read 允许
- trusted-local agent 不受 quarantine 影响
- markContactWithUntrusted + isContaminated 污染链追踪
- spawn-agent 子 agent trustLevel 继承规则
- ActionAgentDispatcher 执行高权限意图
- PolicyEngine 短路（不走 deny-overrides）
- 配置关闭时跳过 quarantine 检查

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "feat(phase-62): Quarantine 隔离治理

新增 QuarantineProfileManager + ActionAgentDispatcher
博客借鉴：读不可信公开内容的 agent 禁止高权限动作，由独立动作 agent 执行
安全：强制 deny 不走 PolicyEngine 协商；污染链追踪；结果剥离执行细节"
```

---

## Task 5：Tournament 方案选型（≥ 5 测试）

### 5.1 论文借鉴

博客 Tournament 模式：N 个 agent 同任务竞争→**pairwise judging**→淘汰至冠军。关键在于 pairwise judging——两两对比选优，比绝对打分更稳定（消除 judge 的绝对分偏移）。RouteDev 的 [compose-pipeline](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/compose-pipeline.ts) requirements 阶段当前单一方案输出，无多方案竞争——复杂需求可能有多条实现路径，单一方案容易陷入局部最优。

### 5.2 设计

新增 `TournamentSelector` 类，在 compose-pipeline requirements 阶段可选启用：

```ts
// src/agent/tournament-selector.ts
/**
 * Tournament 方案选型
 * 博客借鉴：N 个 agent 同任务竞争 + pairwise judging + 淘汰至冠军
 *
 * 设计：
 *   1. requirements 阶段生成 N 个候选方案（独立 LLM 调用，不同 seed/温度）
 *   2. pairwise judging：两两对比，judge 选优
 *   3. 单败淘汰至冠军
 *   4. fail-open：judge 异常时降级为"选首个方案"
 */
export interface TournamentCandidate {
  /** 候选 ID */
  id: string;
  /** 方案描述（结构化） */
  proposal: {
    goal: string;
    steps: string[];
    risks: string[];
    estimatedComplexity: 'low' | 'medium' | 'high';
  };
  /** 生成该候选的 seed（用于复现） */
  seed: number;
}

export interface PairwiseJudgeResult {
  /** 胜者 ID */
  winnerId: string;
  /** 败者 ID */
  loserId: string;
  /** 判定理由 */
  rationale: string;
  /** judge 模型 ID */
  judgeModelId: string;
}

export interface TournamentConfig {
  /** 候选数量（默认 3） */
  candidateCount: number;
  /** 生成温度（默认 0.7，提高多样性） */
  temperature: number;
  /** judge 模型 ID（不填则复用 CrossModelReviewer 选模型逻辑） */
  judgeModelId?: string;
  /** 是否单败淘汰（true）vs 循环积分（false），默认 true */
  singleElimination: boolean;
}

export interface TournamentResult {
  /** 冠军候选 */
  champion: TournamentCandidate;
  /** 所有候选 */
  candidates: TournamentCandidate[];
  /** judging 历史 */
  judgeHistory: PairwiseJudgeResult[];
  /** 是否降级（judge 异常时选首个） */
  downgraded: boolean;
  /** 降级原因 */
  downgradeReason?: string;
}

export class TournamentSelector {
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly config: TournamentConfig,
  ) {}

  /** 生成 N 个候选方案（独立 LLM 调用，不同 seed） */
  async generateCandidates(requirement: string): Promise<TournamentCandidate[]>;

  /** 单败淘汰赛 */
  async singleElimination(candidates: TournamentCandidate[]): Promise<PairwiseJudgeResult[]>;

  /** 两两 judging */
  private async pairwiseJudge(
    a: TournamentCandidate,
    b: TournamentCandidate,
    requirement: string,
  ): Promise<PairwiseJudgeResult>;

  /** 运行完整 tournament */
  async run(requirement: string): Promise<TournamentResult>;
}
```

### 5.3 接线点

- 新增：`src/agent/tournament-selector.ts`
- 修改：`src/agent/compose-pipeline.ts` — requirements 阶段配置增加 tournament 开关，开启时调用 TournamentSelector.run 替代单一方案生成
- 修改：`src/agent/work-modes.ts` — ComposePhaseConfig 类型扩展（可选 tournament 配置）
- 复用：[cross-model-reviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 的 selectReviewerModel 选 judge 模型

### 5.4 Step 分解

- [ ] **Step 1: 定义 TournamentCandidate 与 TournamentConfig 类型**

新建 `src/agent/tournament-selector.ts`，实现上述接口。`candidateCount` 默认 3，`temperature` 默认 0.7，`singleElimination` 默认 true。

- [ ] **Step 2: 实现 generateCandidates**

N 次独立 LLM 调用，每次 seed 不同（影响 temperature 抖动）。prompt 注入"请独立思考，输出结构化方案（goal/steps/risks/estimatedComplexity）"。失败候选（LLM 调用失败或返回非结构化）跳过，至少保留 2 个候选才进入 judging，否则降级。

- [ ] **Step 3: 实现 pairwiseJudge**

构造对比 prompt：给定 requirement + 候选 A + 候选 B，judge 输出胜者 ID + rationale。LLM 调用失败时降级为"选首个"。

- [ ] **Step 4: 实现 singleElimination**

按候选顺序两两对比，胜者进入下一轮，直到冠军。judgeHistory 记录所有对比结果。

- [ ] **Step 5: 实现 run 入口**

generateCandidates → singleElimination → 返回 TournamentResult。候选不足 2 个时 downgraded=true，downgradeReason='insufficient-candidates'。

- [ ] **Step 6: 接入 compose-pipeline requirements 阶段**

在 [compose-pipeline.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/compose-pipeline.ts) 的 requirements 阶段配置中增加 `tournament?: TournamentConfig`，存在时调用 TournamentSelector.run，champion.proposal 作为需求文档输出。

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
tournament: z.object({
  enabled: z.boolean().default(false),
  candidateCount: z.number().int().min(2).max(5).default(3),
  temperature: z.number().min(0).max(2).default(0.7),
  singleElimination: z.boolean().default(true),
  judgeModelId: z.string().optional(),
}).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/tournament-selector.test.ts`，覆盖：
- generateCandidates 返回 N 个候选
- pairwiseJudge 选优
- singleElimination 淘汰至冠军
- 候选不足 2 个降级
- judge 异常降级为选首个
- 配置关闭时跳过

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-62): Tournament 方案选型

新增 TournamentSelector，requirements 阶段多方案竞争 + pairwise judging
博客借鉴：Tournament 模式（N 个 agent 同任务竞争 + 单败淘汰）
fail-open：候选不足或 judge 异常时降级为选首个方案"
```

---

## Task 6：配置收口、设置页与全量验证（≥ 4 测试）

### 6.1 目标

收口 Phase 62 所有配置项，确保设置页可调，全量验证通过。

### 6.2 Step 分解

- [ ] **Step 1: 配置 schema 收口**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加顶层 `dynamicWorkflow` 字段，聚合 Task 1-5 的所有子配置：

```ts
dynamicWorkflow: z.object({
  enabled: z.boolean().default(false), // 总开关
  synthesizeBarrier: z.object({
    enabled: z.boolean().default(false),
    barrierTimeoutMs: z.number().int().default(60000),
    defaultStrategy: z.enum(['merge-fields', 'concat-dedup', 'judging']).default('concat-dedup'),
    includeFailed: z.boolean().default(true),
  }).default({}),
  adversarialVerification: z.object({
    enabled: z.boolean().default(false),
    frequency: z.enum(['every-step', 'every-n-steps', 'end-only']).default('end-only'),
    n: z.number().int().min(1).default(3),
    forceCrossModel: z.boolean().default(false),
    verifierModelId: z.string().optional(),
  }).default({}),
  loopUntilDone: z.object({
    enabled: z.boolean().default(false),
    maxRounds: z.number().int().min(1).max(20).default(5),
    stableRoundsRequired: z.number().int().min(1).default(2),
    minCompletionRatio: z.number().min(0).max(1).default(0.85),
  }).default({}),
  quarantine: z.object({
    enabled: z.boolean().default(false),
    untrustedDeniedTools: z.array(z.string()).default(['file_write', 'file_edit', 'shell_exec', 'git_op']),
    allowIntentForwarding: z.boolean().default(true),
    contaminationTraceDepth: z.number().int().default(10),
  }).default({}),
  tournament: z.object({
    enabled: z.boolean().default(false),
    candidateCount: z.number().int().min(2).max(5).default(3),
    temperature: z.number().min(0).max(2).default(0.7),
    singleElimination: z.boolean().default(true),
    judgeModelId: z.string().optional(),
  }).default({}),
}).default({}),
```

- [ ] **Step 2: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加 dynamicWorkflow 默认值，所有子开关默认 false。

- [ ] **Step 3: 设置页 UI**

在 desktop renderer 设置页新增"动态工作流"分区：
- 总开关
- 子开关（SynthesizeBarrier / AdversarialVerification / LoopUntilDone / Quarantine / Tournament）
- Quarantine 子开关默认**显眼警示**（开启后影响 web-fetch agent 权限）
- 参数滑块（barrierTimeoutMs / candidateCount / maxRounds / minCompletionRatio）
- "查看污染链"按钮（展示当前被标记为 contaminated 的 agent 列表）
- Tournament 候选数量建议说明（增加 LLM 成本）

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 4: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 35 个测试通过。

- [ ] **Step 5: 文档同步**

更新 README.md 与 ARCHITECTURE.md，说明动态工作流模式与 Quarantine 隔离架构。在 SECURITY_AUDIT_v2.0.md 增加 Quarantine 章节。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/config/dynamic-workflow-schema.test.ts`，覆盖：
- dynamicWorkflow 默认值正确
- 子开关独立启用
- quarantine.untrustedDeniedTools 默认值
- tournament 参数边界（candidateCount 2-5）

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-62): 配置收口、设置页与全量验证

动态工作流总开关 + 5 个子开关 + 参数滑块 + 污染链查看
博客借鉴：六大可复用模式中四种（Fan-out/Adversarial/Loop/Tournament）+ Quarantine 隔离
版本：v4.6.1"
```

---

## 风险与回滚

### 风险 1：synthesizeBarrier judging 策略拖慢并行组合并
- **缓解**：judging 策略默认不启用（默认 concat-dedup）；启用时设 60s 屏障超时，超时降级为 concat-dedup
- **回滚**：关闭 `dynamicWorkflow.synthesizeBarrier.enabled`，或把 defaultStrategy 改为 'concat-dedup'

### 风险 2：AdversarialVerification 每步触发大幅增加 LLM 成本
- **缓解**：默认频率 `end-only`（仅末尾触发）；every-step 模式在设置页显眼警示成本
- **回滚**：关闭 `dynamicWorkflow.adversarialVerification.enabled`，或频率改回 end-only

### 风险 3：LoopUntilDoneGate 在复杂任务上达到 maxRounds 仍未稳定
- **缓解**：maxRounds 默认 5 是上限保护，达到后强制停止并标注 stopReason: 'max-rounds'；设置页可调
- **回滚**：关闭 `dynamicWorkflow.loopUntilDone.enabled`，回退到固定 gateRetry=1

### 风险 4：Quarantine 误伤合法 web-fetch 工作流
- **缓解**：默认 disabled，用户在设置页显式开启；开启后 web-fetch 仍可读，仅 file_write/shell_exec 被禁；allowIntentForwarding=true 时通过 ActionAgentDispatcher 转发意图
- **回滚**：关闭 `dynamicWorkflow.quarantine.enabled`，所有 agent 恢复 trusted-local 权限

### 风险 5：Tournament 候选生成失败导致 requirements 阶段卡死
- **缓解**：候选不足 2 个时降级为"选首个方案"，downgraded=true 标注；至少 1 个候选即可进入下游阶段
- **回滚**：关闭 `dynamicWorkflow.tournament.enabled`，requirements 阶段恢复单一方案

### 风险 6：Quarantine 污染链追踪内存泄漏
- **缓解**：contaminationTraceDepth 默认 10，超过则强制降级（旧条目 LRU 淘汰）；提供"清除污染链"按钮
- **回滚**：关闭 quarantine.enabled，污染链 Map 自动清空

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 35 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] 动态工作流总开关默认关闭，设置页可开启
- [ ] SynthesizeBarrier 屏障语义正确（等所有 fan-out 完成后合并，失败占位）
- [ ] AdversarialVerification 三种频率可配，fail-open 降级标注"未对抗"
- [ ] LoopUntilDoneGate 停止条件驱动（连续两轮无新发现），maxRounds 上限保护
- [ ] Quarantine 强制 deny 不走 PolicyEngine 协商，污染链追踪正常
- [ ] ActionAgentDispatcher 执行高权限意图，结果剥离执行细节
- [ ] Tournament 单败淘汰至冠军，候选不足降级为选首个
- [ ] 设置页"动态工作流"分区可调，Quarantine 子开关有显眼警示
- [ ] "查看污染链"按钮可展示当前 contaminated agent 列表
- [ ] fail-open：所有模式异常时降级为现有行为，不阻塞主流程
- [ ] README.md、ARCHITECTURE.md、SECURITY_AUDIT_v2.0.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中

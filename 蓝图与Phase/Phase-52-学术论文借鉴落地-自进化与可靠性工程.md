# Phase 52 — 学术论文借鉴落地：自进化与可靠性工程

> **版本目标：** v4.1.0
> **前置依赖：** Phase 51（外部开源借鉴落地与配置化接入收尾）完成
> **新增测试要求：** ≥ 60 个
> **研究依据：** 精读 10 篇 arXiv 论文，覆盖自进化 Agent、Skill 生命周期、过程级评估、长程工作流可靠性、组合技能路由、架构感知评估、基准饱和、递归自改进、Harness 自优化、MCP 安全。每篇论文都针对 RouteDev 的具体工程缺口。论文清单：
> 1. MUSE-Autoskill (arXiv 2605.27366, 字节跳动, 2026-05) — Skill 生命周期管理
> 2. ProcBench (arXiv 2605.20251, 阿里高德, 2026-05) — 过程级缺陷评估
> 3. BCER Agent (arXiv 2605.29163, UCLA+Cedars-Sinai, 2026-05) — 长程工作流可靠执行
> 4. SKILLWEAVER (arXiv 2606.18051, 阿里云, 2026-06) — 组合技能路由
> 5. Self-Evolving AI Agents Survey (arXiv 2508.07407, Glasgow+Sheffield, 2025-08) — 自进化综述
> 6. Architecture-Aware Evaluation Metrics (arXiv 2601.19583, UFCG Brazil, CAIN'26) — 架构感知评估
> 7. Benchmark Saturation (arXiv 2602.16763, EvalEval Coalition, 2026-02) — 基准饱和研究
> 8. Gödel Agent (arXiv 2410.04444, 北大+UCSB, ACL 2025) — 递归自改进
> 9. Self-Harness (arXiv 2606.09498, 上海 AI Lab, 2026-06) — Harness 自优化
> 10. MCPSHIELD (arXiv 2604.05969, 2026-04) — MCP 安全形式化框架
> **核心命题：** RouteDev 的 Phase 49 实现了 SkillFlow 引擎和双循环验证层，Phase 50 接入了散落模块，Phase 51 落地了外部开源借鉴。但这三步都停留在"人工设计 Harness"的范式——Skill 定义由人写、评估集由人建、失败模式由人总结。10 篇论文共同指向一个新范式：**Harness 自演化**。论文 1/4/8/9 证明 Skill 和 Harness 可以由 Agent 自己创建和优化；论文 2/6/7 证明评估必须从结果级升级到过程级且绑定架构组件；论文 3 证明长程工作流需要"有界局部恢复"而非全局重跑；论文 5 给出自进化的统一框架；论文 10 证明 MCP 生态安全需要形式化防御而非零散补丁。Phase 52 把这 10 篇论文的借鉴点落地为 10 个 Task，核心是把 RouteDev 从"人工维护的 Harness"升级为"自演化的 Harness"。

---

## 项目现状审计与可行性结论

### 1. 论文与 RouteDev 缺口的映射

| 论文 | 核心 Contribution | RouteDev 现状缺口 | Phase 52 Task |
|------|-------------------|-------------------|---------------|
| MUSE-Autoskill | Skill 生命周期（创建/记忆/管理/评估/优化） | Skill 无跨任务记忆、无按需创建 | Task 1 |
| ProcBench | 过程级缺陷本体 + 校准风险评分卡 | 评估只看结果（pass/fail），不看过程 | Task 2 |
| BCER Agent | 规划执行解耦 + 有界局部恢复 + 工件绑定 | 双循环失败后全局重跑，无局部恢复 | Task 3 |
| SKILLWEAVER | 组合技能路由（分解/检索/组合）+ SAD 迭代 | Skill 选择是单选，无组合编排 | Task 4 |
| Self-Evolving Survey | 统一反馈循环（输入/Agent/环境/优化器） | 无统一自进化框架 | Task 5 |
| Architecture-Aware Metrics | 指标绑定架构组件（planner/memory/router） | 评估指标笼统，不区分组件 | Task 6 |
| Benchmark Saturation | 14 属性预测饱和 + 专家策划抗饱和 | 评估集无饱和监测 | Task 7 |
| Gödel Agent | 自指递归自改进（无固定优化算法） | Agent 逻辑由人写死，不自修改 | Task 8 |
| Self-Harness | 三阶段循环（弱点挖掘/提案/验证） | Harness 修改由人做，无自动优化 | Task 9 |
| MCPSHIELD | 7 类威胁 23 向量 + 深度防御架构 | MCP 安全零散（沙箱+权限），无形式化 | Task 10 |

### 2. 可行性总评

- **Task 1（Skill 生命周期）：** 高度可行。Phase 49 的 SkillFlow 引擎已落地，扩展 SkillMemory 字段即可。
- **Task 2（过程级评估）：** 可行。ScoreCard 已记录过程指标，需扩展缺陷分类和校准评分。
- **Task 3（有界局部恢复）：** 中等可行。需要改造 DualLoopOrchestrator，从"全局重跑"改为"局部恢复"。
- **Task 4（组合技能路由）：** 可行。SkillFlow 已支持 branch 节点，扩展为 DAG 组合。
- **Task 5（自进化框架）：** 可行。本质是整合 Task 1/8/9 的元框架。
- **Task 6（架构感知指标）：** 高度可行。ScoreCard 已有组件级数据，只需绑定指标。
- **Task 7（饱和监测）：** 可行。评估集运行后统计区分度即可。
- **Task 8（Gödel 自修改）：** 高风险。Agent 自修改逻辑可能引入不可控行为。建议限制为"建议修改"而非"自动应用"。
- **Task 9（Self-Harness 循环）：** 中等可行。需要弱点挖掘（失败聚类）+ Harness 提案 + 回归测试。
- **Task 10（MCP 安全框架）：** 可行。Phase 48 已有 MCP 桥接，扩展安全层即可。

---

## 核心设计原则

### 原则 1：自演化优先于人工维护

10 篇论文的共同方向——Harness 不应只由人工维护，而应支持自演化。Phase 52 的每个 Task 都要回答："这个能力能否由 Agent 自己执行/优化？" 如果能，设计为自演化流程；如果不能，说明原因。

### 原则 2：过程级评估优先于结果级评估

ProcBench 和 Architecture-Aware Metrics 共同指出——只看 pass/fail 会遗漏过程缺陷。Phase 52 的评估相关 Task 必须记录执行轨迹的过程级信号（工具调用错误率、步骤跳过率、恢复次数等）。

### 原则 3：有界恢复优先于全局重跑

BCER Agent 证明长程工作流中全局重跑成本过高且可能引入新错误。Phase 52 的恢复机制必须支持"有界局部恢复"——只回退到最近的 checkpoint 重跑失败步骤，而非从头开始。

### 原则 4：安全形式化优先于零散补丁

MCPSHIELD 证明单一防御覆盖不超过 34% 威胁。Phase 52 的 MCP 安全必须用形式化框架（威胁分类 + 信任边界 + 深度防御），而非零散的沙箱和权限检查。

### 原则 5：反写死原则（延续 Phase 51）

所有新增能力必须有配置开关、设置页面入口、明确代码接线点。

---

## Task 1：Skill 生命周期管理——Skill 级记忆与按需创建（≥ 8 测试）

### 1.1 论文借鉴

**MUSE-Autoskill (arXiv 2605.27366, 字节跳动)** 提出 Skill 的五阶段统一生命周期：创建（Creation）→ 记忆（Memory）→ 管理（Management）→ 评估（Evaluation）→ 优化（Refinement）。核心创新是 **Skill-level memory**——每个 Skill 积累跨任务的经验，使 Skill 越用越好。实验显示生命周期管理的 Skill 比静态 Skill 准确率高 15.2pp。

### 1.2 RouteDev 缺口

Phase 49 的 SkillFlow 引擎把 Skill 从"说明书"升级为"可执行流水线"，但：
- Skill 无跨任务记忆——每次执行都是干净的，不记得上次在哪里失败过
- Skill 创建完全由人触发——Agent 不能按需自己创建 Skill
- Skill 无持续优化——SKILL.md 写好后就不变了

### 1.3 落地设计

```typescript
// src/skills/skill-lifecycle.ts（新建文件）

/**
 * Skill 生命周期管理器
 *
 * 来自 MUSE-Autoskill 的五阶段生命周期：
 *   1. Creation — Agent 按需创建 Skill（当重复执行相似任务 N 次时自动触发）
 *   2. Memory — Skill 级记忆，积累跨任务经验
 *   3. Management — Skill 组织、选择、淘汰
 *   4. Evaluation — 单元测试 + 运行时反馈
 *   5. Refinement — 基于评估结果优化 Skill 定义
 */
export interface SkillMemory {
  skillId: string;
  /** 执行历史：每次执行的摘要 + 失败模式 + 用户反馈 */
  executions: SkillExecutionRecord[];
  /** 常见失败模式聚类（自动从 executions 提取） */
  failurePatterns: SkillFailurePattern[];
  /** 成功路径摘要（高频成功步骤序列） */
  successPaths: string[][];
  /** 最后优化时间 */
  lastRefinedAt: number;
}

export interface SkillExecutionRecord {
  timestamp: number;
  taskDescription: string;
  stepsTaken: string[];
  outcome: 'success' | 'partial' | 'failure';
  failurePoint?: string;
  userFeedback?: 'accepted' | 'rejected' | 'edited';
  durationMs: number;
}

export class SkillLifecycleManager {
  /**
   * 按需创建触发器
   * 当检测到 Agent 重复执行相似任务模式 ≥ 阈值次时，自动建议创建 Skill
   */
  checkCreationTrigger(taskHistory: TaskRecord[]): SkillCreationSuggestion | null;

  /**
   * 记录 Skill 执行到 SkillMemory
   */
  recordExecution(skillId: string, record: SkillExecutionRecord): void;

  /**
   * 从执行历史提取失败模式聚类
   */
  extractFailurePatterns(skillId: string): SkillFailurePattern[];

  /**
   * 基于记忆构建优化建议
   * 不自动修改 Skill，而是产出建议供用户/Agent 决策
   */
  proposeRefinement(skillId: string): SkillRefinementProposal | null;
}
```

### 1.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const SkillLifecycleSchema = z.object({
  /** 是否启用 Skill 生命周期管理（默认 false） */
  enabled: z.boolean().default(false),
  /** 按需创建触发阈值：相似任务重复执行多少次后建议创建 Skill（默认 3） */
  creationTriggerThreshold: z.number().int().min(2).max(10).default(3),
  /** Skill 记忆保留时长（天，默认 30） */
  memoryRetentionDays: z.number().int().min(1).max(365).default(30),
  /** 是否自动应用优化建议（默认 false，需用户确认） */
  autoApplyRefinement: z.boolean().default(false),
});
```

### 1.5 设置页面接入

在 `skills` tab 中增加"Skill 生命周期"子区域：
- Switch: "启用 Skill 生命周期管理"
- Input[type=number]: "按需创建触发阈值"（2-10）
- Input[type=number]: "记忆保留时长(天)"（1-365）
- Switch: "自动应用优化建议"（默认关）

### 1.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/skills/skill-lifecycle.ts` | 新建 | 生命周期管理器 |
| `src/skills/skill-flow-engine.ts` | 修改 | 执行后调用 `recordExecution` |
| `src/skills/skill-generator.ts` | 修改 | 接入按需创建触发器 |
| `src/config/schema.ts` | 修改 | 增加 `SkillLifecycleSchema` |
| `desktop/renderer/src/components/settings/SettingsSkillsTab.tsx` | 修改 | 增加生命周期控件 |

### 1.7 测试要求

- 重复执行相似任务 ≥ 阈值时触发创建建议。
- Skill 执行后记录到 SkillMemory。
- 失败模式从执行历史中正确聚类。
- 优化建议基于失败模式生成。
- autoApplyRefinement=false 时不自动修改 Skill。
- 记忆超过保留时长后自动清理。
- 配置开关默认 false 时回退到原行为。

---

## Task 2：过程级缺陷评估——缺陷本体与校准风险评分卡（≥ 6 测试）

### 2.1 论文借鉴

**ProcBench (arXiv 2605.20251, 阿里高德)** 提出过程级缺陷评估框架：① 把执行失败组织成可复用的缺陷本体（ontology）② 把异构日志标准化为统一轨迹表示 ③ 报告校准的风险评分卡而非仅最终结果。在 AndroidBench/TerminalBench/SWE-bench-Verified 上验证，过程感知评分卡比结果评估提供更多诊断信息。

### 2.2 RouteDev 缺口

Phase 49 的评估集框架只记录 pass/fail 和 ScoreCard（token/耗时/工具调用数），但：
- 无缺陷分类——失败原因散落在日志中，无结构化分类
- 无校准评分——pass/fail 是二值的，不区分"差一点"和"完全失败"
- 无过程感知——只看最终结果，不知道执行过程中有多少次恢复/跳过/降级

### 2.3 落地设计

```typescript
// src/evaluation/process-defect-ontology.ts（新建文件）

/**
 * 过程级缺陷本体
 * 来自 ProcBench 的缺陷分类法
 */
export type DefectCategory =
  | 'tool_misuse'          // 工具误用（参数错误/选错工具）
  | 'context_loss'         // 上下文丢失（忘记前序信息）
  | 'step_skip'            // 步骤跳过（跳过必要步骤）
  | 'infinite_loop'        // 死循环
  | 'premature_termination' // 过早终止（声称完成但未完成）
  | 'scope_creep'          // 范围蔓延（做了不该做的）
  | 'recovery_failure'     // 恢复失败（出错后未能恢复）
  | 'hallucination'        // 幻觉（虚构工具结果/文件内容）
  | 'permission_violation' // 权限违反
  | 'resource_exhaustion'; // 资源耗尽（token/时间超限）

export interface ProcessDefect {
  category: DefectCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 校准后的风险分（0-1，考虑频率和影响） */
  calibratedRisk: number;
  stepIndex: number;
  description: string;
  evidence: string;        // 日志片段
  recoveredFrom?: boolean; // 是否成功恢复
}

export interface CalibratedScorecard {
  /** 过程缺陷列表 */
  defects: ProcessDefect[];
  /** 校准后的综合风险分（0-1） */
  overallRisk: number;
  /** 控制保持度（执行过程中有多少比例的步骤保持了预期控制流） */
  controlPreservation: number;
  /** 最终结果 pass/fail */
  outcomePassed: boolean;
  /** 过程质量分级（A/B/C/D/F） */
  processGrade: 'A' | 'B' | 'C' | 'D' | 'F';
}
```

### 2.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const ProcessEvaluationSchema = z.object({
  enabled: z.boolean().default(false),
  /** 缺陷检测灵敏度：low/medium/high（high 检测更多潜在缺陷） */
  sensitivity: z.enum(['low', 'medium', 'high']).default('medium'),
  /** 是否在 UI 中显示过程质量分级 */
  showProcessGrade: z.boolean().default(true),
  /** 控制保持度阈值（低于此值标记为过程异常） */
  controlPreservationThreshold: z.number().min(0).max(1).default(0.7),
});
```

### 2.5 设置页面接入

在 `goal` tab 或新建 `evaluation` tab 中增加"过程级评估"子区域。

### 2.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/evaluation/process-defect-ontology.ts` | 新建 | 缺陷本体 + 校准评分卡 |
| `src/evaluation/evaluation-framework.ts` | 修改 | 评估时产出 CalibratedScorecard |
| `src/agent/multi/score-card.ts` | 修改 | 增加过程缺陷字段 |
| `src/config/schema.ts` | 修改 | 增加 `ProcessEvaluationSchema` |

### 2.7 测试要求

- 10 类缺陷正确分类。
- 校准风险分考虑频率和影响。
- 控制保持度正确计算。
- 过程质量分级 A-F 正确映射。
- sensitivity=high 时检测更多缺陷。
- 配置开关默认 false 时回退到原行为。

---

## Task 3：长程工作流有界局部恢复（≥ 6 测试）

### 3.1 论文借鉴

**BCER Agent (arXiv 2605.29163, UCLA+Cedars-Sinai)** 提出"有界局部恢复"（Bounded Local Recovery）——长程工作流失败时不全局重跑，而是回退到最近的 checkpoint 只重跑失败步骤。核心三机制：① 高层规划与执行解耦 ② 工件绑定（Artifact Binding）维护中间产物链接 ③ 有界局部恢复。在长链工作流上提升最显著。

### 3.2 RouteDev 缺口

Phase 49 的双循环编排器失败后全局重跑——把整个任务重新交给内循环。问题：
- 全局重跑成本高（token/时间）
- 可能引入新错误（第二次执行的路径可能与第一次不同）
- 已成功的步骤被浪费

### 3.3 落地设计

```typescript
// src/agent/bounded-recovery.ts（新建文件）

/**
 * 有界局部恢复
 * 来自 BCER Agent 的 Bounded Local Recovery
 *
 * 核心机制：
 *   1. 每个步骤执行后产出 Artifact（工件），绑定到步骤
 *   2. 失败时找到最近的 checkpoint，只重跑失败步骤及其依赖
 *   3. 恢复范围有界——最多回退 N 步，超过则全局重跑
 */
export interface StepArtifact {
  stepId: string;
  /** 工件类型：代码修改/文件创建/测试结果/分析报告 */
  type: 'code_change' | 'file_create' | 'test_result' | 'analysis';
  /** 工件内容摘要 */
  summary: string;
  /** 工件位置（文件路径/测试报告路径） */
  location: string;
  /** 依赖的上游工件 */
  dependsOn: string[];
  /** 产出时间 */
  producedAt: number;
}

export class BoundedRecoveryManager {
  /** 工件注册表 */
  private artifacts = new Map<string, StepArtifact>();

  /** 注册步骤工件 */
  registerArtifact(artifact: StepArtifact): void;

  /**
   * 计算恢复范围
   * 给定失败步骤，返回需要重跑的步骤列表
   *   - 默认最多回退 maxBacktrack 步
   *   - 超过则返回 null，表示需要全局重跑
   */
  computeRecoveryScope(
    failedStepId: string,
    maxBacktrack: number,
  ): string[] | null;

  /** 验证恢复后工件一致性（上游工件是否仍然有效） */
  validateArtifactConsistency(recoveryScope: string[]): boolean;

  /** 清理被恢复步骤影响的下游工件 */
  invalidateDownstreamArtifacts(recoveryScope: string[]): void;
}
```

### 3.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema.arbitration 中增加
const BoundedRecoverySchema = z.object({
  enabled: z.boolean().default(false),
  /** 最大回退步数（默认 3，超过则全局重跑） */
  maxBacktrack: z.number().int().min(1).max(10).default(3),
  /** 是否启用工件绑定 */
  artifactBinding: z.boolean().default(true),
  /** 恢复后是否验证工件一致性 */
  validateConsistency: z.boolean().default(true),
});
```

### 3.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/bounded-recovery.ts` | 新建 | 有界恢复管理器 |
| `src/agent/dual-loop-orchestrator.ts` | 修改 | 失败时优先尝试局部恢复，超过阈值才全局重跑 |
| `src/skills/skill-flow-checkpoint-store.ts` | 修改 | 接入工件注册 |
| `src/config/schema.ts` | 修改 | 增加 `BoundedRecoverySchema` |

### 3.6 测试要求

- 步骤失败时计算恢复范围正确（包含失败步骤及其依赖）。
- 恢复范围超过 maxBacktrack 时返回 null（触发全局重跑）。
- 恢复后验证工件一致性。
- 下游工件在恢复后正确失效。
- artifactBinding=true 时工件被注册。
- 配置开关默认 false 时回退到全局重跑。

---

## Task 4：组合技能路由——分解/检索/组合 DAG（≥ 7 测试）

### 4.1 论文借鉴

**SKILLWEAVER (arXiv 2606.18051, 阿里云)** 提出组合技能路由问题：复杂任务需要组合多个 Skill，而非只选一个。核心发现：**任务分解是主要瓶颈**——标准 LLM 分解只有 34.2% 类别召回。提出的 SAD（迭代技能感知分解）反馈循环把分解准确率从 51% 提升到 67.7%。bi-encoder 检索器 + FAISS 索引 + 依赖感知 DAG 规划器，上下文消耗降低 99%。

### 4.2 RouteDev 缺口

Phase 49 的 SkillFlow 是单 Skill 内部的流水线，但：
- 复杂任务需要组合多个 Skill（如先 code-reviewer 再 refactor 再 test-generator）
- Skill 选择是单选，无组合编排
- 无任务分解→Skill 映射的机制
- 无 Skill 检索索引（当前靠名称匹配）

### 4.3 落地设计

```typescript
// src/skills/compositional-router.ts（新建文件）

/**
 * 组合技能路由
 * 来自 SKILLWEAVER 的 decompose-retrieve-compose 框架
 *
 * 三阶段：
 *   1. Decompose — 把复杂任务分解为原子子任务
 *   2. Retrieve — 为每个子任务检索最匹配的 Skill
 *   3. Compose — 按依赖关系组合为 DAG 执行计划
 */
export interface AtomicSubTask {
  id: string;
  description: string;
  /** 预期需要的 Skill 类别 */
  expectedSkillCategory: string;
}

export interface SkillDAGPlan {
  /** DAG 节点（每个节点 = 一个 Skill 执行） */
  nodes: SkillDAGNode[];
  /** 依赖边 */
  edges: Array<{ from: string; to: string }>;
  /** 可并行的节点组 */
  parallelGroups: SkillDAGNode[][];
}

export class CompositionalSkillRouter {
  /**
   * 迭代技能感知分解（SAD）
   * 来自 SKILLWEAVER 的核心创新
   *
   * 不一次性分解，而是：
   *   1. 初步分解
   *   2. 为每个子任务检索 Skill
   *   3. 检查检索结果是否覆盖所有子任务
   *   4. 未覆盖的子任务重新分解（调整粒度）
   *   5. 迭代直到覆盖或达到最大迭代次数
   */
  async decomposeWithSkillAwareness(
    task: string,
    maxIterations: number,
  ): Promise<AtomicSubTask[]>;

  /** 为子任务检索最匹配的 Skill */
  async retrieveSkill(subTask: AtomicSubTask): Promise<SkillMatch | null>;

  /** 组合为 DAG 执行计划 */
  composeDAG(matches: SkillMatch[]): SkillDAGPlan;
}
```

### 4.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const CompositionalRoutingSchema = z.object({
  enabled: z.boolean().default(false),
  /** SAD 最大迭代次数（默认 2） */
  maxDecompositionIterations: z.number().int().min(1).max(5).default(2),
  /** 是否启用 Skill 语义检索（FAISS 索引） */
  semanticRetrieval: z.boolean().default(true),
  /** DAG 并行度上限 */
  maxParallelSkills: z.number().int().min(1).max(4).default(2),
});
```

### 4.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/skills/compositional-router.ts` | 新建 | 组合路由器 |
| `src/skills/skill-executor.ts` | 修改 | 执行前调用组合路由 |
| `src/skills/skill-flow-engine.ts` | 修改 | 支持 DAG 并行执行 |
| `src/config/schema.ts` | 修改 | 增加 `CompositionalRoutingSchema` |

### 4.6 测试要求

- 复杂任务被正确分解为原子子任务。
- SAD 迭代后分解准确率提升（未覆盖子任务重新分解）。
- Skill 检索返回最匹配的 Skill。
- DAG 依赖关系正确（无环）。
- 并行组正确识别（无依赖冲突）。
- 上下文消耗降低（不加载所有 Skill 描述）。
- 配置开关默认 false 时回退到单 Skill 选择。

---

## Task 5：自进化统一框架——反馈循环架构（≥ 5 测试）

### 5.1 论文借鉴

**Self-Evolving AI Agents Survey (arXiv 2508.07407)** 提出自进化 Agent 的统一概念框架，包含四个关键组件：① System inputs（任务/反馈/环境信号）② Agent System（基础模型/Prompt/Memory/工具/工作流/通信）③ Environment（执行环境/反馈源）④ Optimisers（优化各组件的机制）。核心观点：自进化不只是模型微调，而是 Agent 系统各层的持续适应。

### 5.2 RouteDev 缺口

RouteDev 有零散的自进化能力（SkillGenerator 创建 Skill、LoopMemory 沉淀失败、ScoreCard 统计质量），但：
- 无统一框架——各能力散落，无协调
- 无反馈循环——数据收集了但不自动反馈到优化
- 无优化目标分层——不知道该优化哪一层（Prompt? Memory? 工具?）

### 5.3 落地设计

```typescript
// src/agent/self-evolution/framework.ts（新建文件）

/**
 * 自进化统一框架
 * 来自 Self-Evolving AI Agents Survey 的四组件模型
 *
 *   System Inputs → Agent System → Environment → Optimisers → (反馈到 Agent System)
 *
 * RouteDev 映射：
 *   System Inputs = 用户任务 + 执行反馈 + 环境信号（token/耗时/错误）
 *   Agent System = 基础模型(路由) + Prompt(system prompt) + Memory(LoopMemory/SkillMemory) + 工具(工具注册) + 工作流(SkillFlow) + 通信(子Agent)
 *   Environment = 执行环境(沙箱/文件系统/终端)
 *   Optimisers = SkillOptimizer + PromptOptimizer + MemoryOptimizer
 */
export interface SelfEvolutionConfig {
  /** 优化目标分层 */
  targets: {
    prompt: boolean;      // 优化 system prompt
    memory: boolean;      // 优化记忆策略
    tools: boolean;       // 优化工具配置
    workflow: boolean;    // 优化 SkillFlow 定义
    communication: boolean; // 优化子 Agent 配置
  };
  /** 反馈循环触发条件 */
  trigger: {
    /** 失败模式积累到多少次触发优化 */
    failureThreshold: number;
    /** 质量下降到多少触发优化 */
    qualityDropThreshold: number;
    /** 多少次执行后触发优化评估 */
    evaluationInterval: number;
  };
}

export class SelfEvolutionFramework {
  /**
   * 收集反馈信号
   * 从 LoopMemory/SkillMemory/ScoreCard/ProcessDefect 汇总
   */
  collectSignals(): EvolutionSignal[];

  /**
   * 决定优化哪一层
   * 根据信号类型和频率，选择最需要优化的组件层
   */
  selectOptimizationTarget(signals: EvolutionSignal[]): OptimizationTarget;

  /**
   * 执行优化（产出建议，不自动应用）
   */
  optimize(target: OptimizationTarget): OptimizationProposal;
}
```

### 5.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const SelfEvolutionSchema = z.object({
  enabled: z.boolean().default(false),
  targets: z.object({
    prompt: z.boolean().default(true),
    memory: z.boolean().default(true),
    tools: z.boolean().default(false),
    workflow: z.boolean().default(true),
    communication: z.boolean().default(false),
  }),
  trigger: z.object({
    failureThreshold: z.number().int().min(2).max(20).default(5),
    qualityDropThreshold: z.number().min(0).max(1).default(0.3),
    evaluationInterval: z.number().int().min(5).max(100).default(20),
  }),
});
```

### 5.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/self-evolution/framework.ts` | 新建 | 统一框架 |
| `src/agent/self-evolution/types.ts` | 新建 | 类型定义 |
| `src/cli/app-init.ts` | 修改 | 初始化框架并注入信号源 |
| `src/config/schema.ts` | 修改 | 增加 `SelfEvolutionSchema` |

### 5.6 测试要求

- 信号从多个源（LoopMemory/SkillMemory/ScoreCard）正确收集。
- 优化目标根据信号类型正确选择。
- 优化产出建议而非自动应用。
- 触发条件正确判断（失败次数/质量下降/执行间隔）。
- 配置开关默认 false 时不执行自进化。

---

## Task 6：架构感知评估指标（≥ 5 测试）

### 6.1 论文借鉴

**Architecture-Aware Evaluation Metrics (arXiv 2601.19583, UFCG, CAIN'26)** 提出：评估指标应绑定到 Agent 的架构组件（planner/memory/tool router），而非笼统评分。核心方法：把 Agent 行为分解为组件级行为，每个组件绑定可观测指标，实现"什么该测量和为什么"的明确映射。

### 6.2 RouteDev 缺口

Phase 49 的 ScoreCard 记录了 token/耗时/工具调用数等聚合指标，但：
- 不区分哪个组件导致的耗时（是规划慢还是工具调用慢？）
- 不区分哪个组件导致的错误（是路由选错模型还是工具参数错？）
- 无组件级诊断能力

### 6.3 落地设计

```typescript
// src/evaluation/architecture-aware-metrics.ts（新建文件）

/**
 * 架构感知评估指标
 * 来自 Architecture-Aware Evaluation Metrics
 *
 * RouteDev 的架构组件：
 *   1. Router（模型路由）— 指标：路由准确率/路由延迟/模型选择成本比
 *   2. Planner（任务规划）— 指标：规划质量/规划耗时/步骤覆盖率
 *   3. Memory（记忆系统）— 指标：记忆命中率/记忆膨胀率/过期记忆比例
 *   4. ToolExecutor（工具执行）— 指标：工具成功率/工具误用率/工具延迟
 *   5. SkillFlowEngine（Skill 执行）— 指标：节点跳过率/循环节点次数/用户介入率
 *   6. DualLoopOrchestrator（双循环）— 指标：重跑率/申诉率/审查阻断率
 */
export interface ComponentMetrics {
  component: 'router' | 'planner' | 'memory' | 'tool_executor' | 'skill_flow' | 'dual_loop';
  metrics: MetricEntry[];
}

export interface MetricEntry {
  name: string;
  value: number;
  unit: string;
  /** 预期范围（超出则标记异常） */
  expectedRange: { min: number; max: number };
  isAnomaly: boolean;
}

export class ArchitectureAwareMetricsCollector {
  /** 从执行轨迹提取组件级指标 */
  extractFromTrajectory(trajectory: ExecutionTrajectory): ComponentMetrics[];

  /** 生成组件级诊断报告 */
  generateDiagnosticReport(metrics: ComponentMetrics[]): string;

  /** 识别异常组件 */
  identifyAnomalies(metrics: ComponentMetrics[]): ComponentMetrics[];
}
```

### 6.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const ArchAwareMetricsSchema = z.object({
  enabled: z.boolean().default(false),
  /** 异常检测灵敏度 */
  anomalySensitivity: z.enum(['low', 'medium', 'high']).default('medium'),
  /** 是否在 /quality 命令中显示组件级报告 */
  showInQualityCommand: z.boolean().default(true),
});
```

### 6.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/evaluation/architecture-aware-metrics.ts` | 新建 | 组件级指标收集器 |
| `src/agent/multi/score-card.ts` | 修改 | 增加组件级字段 |
| `src/config/schema.ts` | 修改 | 增加 `ArchAwareMetricsSchema` |

### 6.6 测试要求

- 6 个组件的指标正确提取。
- 异常组件正确识别（超出预期范围）。
- 诊断报告包含组件级信息。
-灵敏度=high 时检测更多异常。

---

## Task 7：评估集饱和监测（≥ 4 测试）

### 7.1 论文借鉴

**Benchmark Saturation (arXiv 2602.16763, EvalEval Coalition)** 研究 60 个 LLM 基准的饱和情况，发现：① 近一半基准已饱和（无法区分顶级模型）② 隐藏测试数据无保护效果 ③ 专家策划的基准抗饱和更好 ④ 14 个属性可预测饱和率。核心建议：持续监测评估集的区分度，饱和时及时更新。

### 7.2 RouteDev 缺口

Phase 49 的评估集（Smoke 10条/Regression 30条）无饱和监测——如果所有测试用例都 pass，不知道是"真的都合格"还是"评估集太简单"。

### 7.3 落地设计

```typescript
// src/evaluation/saturation-monitor.ts（新建文件）

/**
 * 评估集饱和监测
 * 来自 Benchmark Saturation 的 14 属性分析
 *
 * 核心指标：
 *   1. 区分度（discrimination）— 不同模型/配置的得分差异
 *   2. 通过率趋势 — 通过率是否趋近 100%
 *   3. 方差 — 得分方差是否趋近 0
 *
 * 饱和信号：
 *   - 通过率 > 95% 且方差 < 0.05 → 饱和
 *   - 连续 N 次运行无区分度 → 饱和
 */
export interface SaturationReport {
  /** 总体饱和状态 */
  status: 'healthy' | 'aging' | 'saturated';
  /** 区分度（0-1，越高越好） */
  discrimination: number;
  /** 通过率（0-1） */
  passRate: number;
  /** 得分方差 */
  scoreVariance: number;
  /** 建议动作 */
  recommendation: 'none' | 'add_difficult_cases' | 'retire_easy_cases' | 'replace_evaluation';
  /** 饱和属性分析 */
  saturationFactors: string[];
}

export class SaturationMonitor {
  /** 评估评估集的饱和状态 */
  evaluate(evaluationResults: EvaluationRunResult[]): SaturationReport;

  /** 建议新增的困难用例类型 */
  suggestDifficultCases(report: SaturationReport): string[];

  /** 建议淘汰的过简用例 */
  suggestRetireEasyCases(report: SaturationReport): string[];
}
```

### 7.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const SaturationMonitorSchema = z.object({
  enabled: z.boolean().default(false),
  /** 饱和阈值：通过率超过此值且方差低于阈值 → 饱和 */
  passRateThreshold: z.number().min(0.5).max(1).default(0.95),
  varianceThreshold: z.number().min(0).max(0.5).default(0.05),
  /** 评估间隔（多少次运行后检查饱和） */
  checkInterval: z.number().int().min(5).max(100).default(10),
});
```

### 7.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/evaluation/saturation-monitor.ts` | 新建 | 饱和监测器 |
| `src/evaluation/evaluation-framework.ts` | 修改 | 运行后调用饱和监测 |
| `src/config/schema.ts` | 修改 | 增加 `SaturationMonitorSchema` |

### 7.6 测试要求

- 通过率 > 95% 且方差 < 0.05 时标记为 saturated。
- 区分度正确计算。
- 建议新增困难用例类型合理。
- 建议淘汰过简用例合理。

---

## Task 8：Gödel 式自修改建议（≥ 5 测试）

### 8.1 论文借鉴

**Gödel Agent (arXiv 2410.04444, 北大+UCSB, ACL 2025)** 提出自指递归自改进框架——Agent 不依赖预定义例程，而是通过 Prompt 引导的高层目标动态修改自己的逻辑和行为。实验显示持续自改进超越人工设计。

### 8.2 RouteDev 缺口与风险

RouteDev 的 Agent 逻辑（ReAct 循环/SkillFlow/双循环）完全由人工设计，不自修改。Gödel 式自修改的风险很高——Agent 可能修改出不可控行为。

**落地策略：** 不让 Agent 自动修改逻辑，而是让 Agent **产出修改建议**供用户审核。这是 Gödel 思想的"安全版"。

### 8.3 落地设计

```typescript
// src/agent/self-evolution/godel-proposer.ts（新建文件）

/**
 * Gödel 式自修改建议器
 * 来自 Gödel Agent 的自指递归自改进
 *
 * 安全版：只产出建议，不自动应用
 *
 * Agent 分析自己的执行轨迹，识别可改进的逻辑模式，
 * 产出修改建议（如"SkillFlow 的 user-gate 节点应增加超时"）
 */
export interface SelfModificationProposal {
  /** 建议修改的组件 */
  target: 'react_loop' | 'skill_flow' | 'dual_loop' | 'router' | 'memory';
  /** 当前行为描述 */
  currentBehavior: string;
  /** 建议的新行为 */
  proposedBehavior: string;
  /** 理由（基于哪些失败模式） */
  rationale: string;
  /** 预期改进 */
  expectedImprovement: string;
  /** 风险评估 */
  riskAssessment: 'low' | 'medium' | 'high';
  /** 是否需要用户确认（默认 true） */
  requiresUserApproval: boolean;
}

export class GodelProposer {
  /**
   * 分析执行轨迹，产出自修改建议
   */
  proposeModifications(trajectories: ExecutionTrajectory[]): SelfModificationProposal[];
}
```

### 8.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const GodelProposerSchema = z.object({
  enabled: z.boolean().default(false),
  /** 建议产出间隔（多少次执行后分析） */
  proposalInterval: z.number().int().min(10).max(200).default(50),
  /** 是否允许高风险建议（默认 false） */
  allowHighRiskProposals: z.boolean().default(false),
  /** 建议保留时长（天） */
  proposalRetentionDays: z.number().int().min(1).max(90).default(14),
});
```

### 8.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/self-evolution/godel-proposer.ts` | 新建 | 自修改建议器 |
| `src/agent/self-evolution/framework.ts` | 修改 | 接入 GodelProposer |
| `src/config/schema.ts` | 修改 | 增加 `GodelProposerSchema` |

### 8.6 测试要求

- 建议产出基于执行轨迹的失败模式。
- 高风险建议在 allowHighRiskProposals=false 时不产出。
- 所有建议 requiresUserApproval=true（不自动应用）。
- 建议保留超过时长后清理。
- 建议包含风险评估。

---

## Task 9：Self-Harness 三阶段循环（≥ 6 测试）

### 9.1 论文借鉴

**Self-Harness (arXiv 2606.09498, 上海 AI Lab)** 提出 Harness 自优化范式：① Weakness Mining（弱点挖掘）— 分析执行轨迹识别模型特定的重复失败模式 ② Harness Proposal（Harness 提案）— 生成最小修改 ③ Proposal Validation（提案验证）— 回归测试后才接受。三模型平均提升 15-20pp。核心：修改是模型特定的——不同模型需要不同的 Harness 优化。

### 9.2 RouteDev 缺口

RouteDev 的 Harness（SkillFlow/双循环/路由策略）由人工维护，无自动优化。Self-Harness 的三阶段循环可让 RouteDev 自动识别弱点并优化。

### 9.3 落地设计

```typescript
// src/agent/self-evolution/self-harness-loop.ts（新建文件）

/**
 * Self-Harness 三阶段循环
 * 来自 Self-Harness 论文
 *
 *   1. Weakness Mining — 聚类失败轨迹，识别重复失败模式
 *   2. Harness Proposal — 针对失败模式生成最小 Harness 修改
 *   3. Proposal Validation — 回归测试通过后才接受修改
 *
 * 安全约束：
 *   - 修改必须是最小的（不重写整个 Harness）
 *   - 修改必须通过回归测试
 *   - 修改是模型特定的（不同模型不同优化）
 *   - 用户可审查和回滚
 */
export interface WeaknessPattern {
  /** 失败模式描述 */
  pattern: string;
  /** 出现频率 */
  frequency: number;
  /** 涉及的步骤类型 */
  stepTypes: string[];
  /** 示例轨迹 ID */
  exampleTrajectoryIds: string[];
}

export interface HarnessModification {
  /** 修改的 Harness 组件 */
  component: 'skill_flow' | 'system_prompt' | 'router_config' | 'tool_config';
  /** 修改类型：add/remove/modify */
  action: 'add' | 'remove' | 'modify';
  /** 修改前 */
  before: string;
  /** 修改后 */
  after: string;
  /** 针对的弱点模式 */
  targetsWeakness: string;
  /** 回归测试结果 */
  validationStatus: 'pending' | 'passed' | 'failed';
}

export class SelfHarnessLoop {
  /** 阶段 1：弱点挖掘 */
  mineWeaknesses(trajectories: ExecutionTrajectory[]): WeaknessPattern[];

  /** 阶段 2：Harness 提案 */
  proposeModifications(weaknesses: WeaknessPattern[]): HarnessModification[];

  /** 阶段 3：提案验证（回归测试） */
  async validateProposal(modification: HarnessModification): Promise<boolean>;

  /** 应用已验证的修改（需用户确认） */
  async applyModification(modification: HarnessModification): Promise<void>;
}
```

### 9.4 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const SelfHarnessSchema = z.object({
  enabled: z.boolean().default(false),
  /** 弱点挖掘的轨迹样本量（默认 50） */
  miningSampleSize: z.number().int().min(10).max(500).default(50),
  /** 失败频率阈值（出现多少次才算模式） */
  patternFrequencyThreshold: z.number().int().min(2).max(20).default(3),
  /** 是否自动应用已验证的修改（默认 false） */
  autoApplyValidated: z.boolean().default(false),
  /** 回归测试集路径 */
  regressionTestPath: z.string().default('.routedev/regression-tests/'),
});
```

### 9.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/self-evolution/self-harness-loop.ts` | 新建 | Self-Harness 循环 |
| `src/agent/self-evolution/framework.ts` | 修改 | 接入 SelfHarnessLoop |
| `src/config/schema.ts` | 修改 | 增加 `SelfHarnessSchema` |

### 9.6 测试要求

- 弱点模式从失败轨迹中正确聚类。
- 修改提案针对弱点模式。
- 回归测试通过才标记 validationStatus=passed。
- autoApplyValidated=false 时不自动应用。
- 修改是最小的（不重写整个组件）。
- 不同模型的弱点模式不同（模型特定）。

---

## Task 10：MCP 安全形式化框架（≥ 8 测试）

### 10.1 论文借鉴

**MCPSHIELD (arXiv 2604.05969)** 提出 MCP 安全形式化框架：① 7 类威胁 23 种攻击向量 ② 形式化验证模型（标记转移系统+信任边界标注）③ 12 种防御机制评估（单一防御覆盖不超 34%）④ 深度防御参考架构（能力访问控制/加密工具证明/信息流追踪/运行时策略）集成覆盖 91%。

### 10.2 RouteDev 缺口

Phase 48 的 MCP 桥接有基础安全（沙箱+权限引擎），但：
- 无威胁分类——不知道有哪些攻击向量
- 无形式化验证——安全检查是零散的 if-else
- 无深度防御——单一防御机制覆盖不足

### 10.3 落地设计

```typescript
// src/mcp/security-framework.ts（新建文件）

/**
 * MCP 安全形式化框架
 * 来自 MCPSHIELD
 *
 * 7 类威胁：
 *   1. Tool Poisoning — 工具描述中注入恶意指令
 *   2. Tool Confusion — 工具名/参数混淆
 *   3. Data Exfiltration — 数据外泄
 *   4. Privilege Escalation — 权限提升
 *   5. Supply Chain — 供应链攻击（恶意 MCP server）
 *   6. Session Hijacking — 会话劫持
 *   7. Resource Exhaustion — 资源耗尽攻击
 *
 * 深度防御架构（四层）：
 *   L1: 能力访问控制（Capability-based Access Control）
 *   L2: 工具证明验证（Cryptographic Tool Attestation）
 *   L3: 信息流追踪（Information Flow Tracking）
 *   L4: 运行时策略执行（Runtime Policy Enforcement）
 */
export type MCPThreatCategory =
  | 'tool_poisoning' | 'tool_confusion' | 'data_exfiltration'
  | 'privilege_escalation' | 'supply_chain' | 'session_hijacking'
  | 'resource_exhaustion';

export interface ThreatDetectionResult {
  category: MCPThreatCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 检测到的攻击向量 */
  attackVector: string;
  /** 信任边界违规详情 */
  trustBoundaryViolation: string;
  /** 建议的防御动作 */
  defenseAction: 'block' | 'sanitize' | 'warn' | 'log';
}

export class MCPSecurityFramework {
  /** L1: 能力访问控制 — 工具只能访问声明的能力 */
  checkCapability(toolCall: ToolCall, declaredCapabilities: string[]): boolean;

  /** L2: 工具证明验证 — 验证 MCP server 来源可信 */
  verifyAttestation(serverId: string, attestation: string): boolean;

  /** L3: 信息流追踪 — 追踪敏感数据是否流向未授权工具 */
  trackInformationFlow(dataFlow: DataFlowRecord[]): ThreatDetectionResult[];

  /** L4: 运行时策略执行 — 实时拦截违规调用 */
  enforcePolicy(toolCall: ToolCall, policy: MCPSecurityPolicy): ThreatDetectionResult | null;

  /** 综合安全评估 */
  assessSecurity(serverConfig: MCPServerConfig): SecurityAssessment;
}
```

### 10.4 配置接入

```typescript
// src/config/schema.ts — 在 MCPConfig 或 SecurityConfig 中增加
const MCPSecuritySchema = z.object({
  /** 是否启用 MCP 安全框架（默认 true） */
  enabled: z.boolean().default(true),
  /** 深度防御层级 */
  defenseLayers: z.object({
    capabilityControl: z.boolean().default(true),
    toolAttestation: z.boolean().default(false),  // 需要密钥基础设施
    informationFlowTracking: z.boolean().default(true),
    runtimePolicyEnforcement: z.boolean().default(true),
  }),
  /** 安全策略严格度 */
  strictness: z.enum(['permissive', 'standard', 'strict']).default('standard'),
  /** 是否在 UI 中显示安全评估报告 */
  showSecurityReport: z.boolean().default(true),
});
```

### 10.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/mcp/security-framework.ts` | 新建 | 安全形式化框架 |
| `src/mcp/bridge.ts` | 修改 | MCP 调用前经过安全框架检查 |
| `src/tools/permission-engine.ts` | 修改 | 接入能力访问控制 |
| `src/config/schema.ts` | 修改 | 增加 `MCPSecuritySchema` |

### 10.6 测试要求

- 7 类威胁正确检测。
- L1 能力访问控制拦截越权工具调用。
- L3 信息流追踪检测敏感数据外泄。
- L4 运行时策略执行实时拦截。
- strictness=strict 时所有防御层启用。
- 安全评估报告正确生成。
- 深度防御集成覆盖 > 90% 威胁。
- 配置开关可独立控制各防御层。

---

## Task 11：集成测试与文档同步（≥ 4 测试）

### 11.1 集成测试

```typescript
// tests/integration/phase52-integration.test.ts

// 1. Skill 生命周期端到端：执行→记忆→失败模式→优化建议
// 2. 过程级评估端到端：执行轨迹→缺陷分类→校准评分卡
// 3. 有界局部恢复端到端：步骤失败→计算恢复范围→局部重跑→验证一致性
// 4. 组合技能路由端到端：复杂任务→SAD分解→检索→DAG组合→并行执行
// 5. 自进化框架端到端：信号收集→目标选择→优化建议→用户确认
// 6. Self-Harness 循环端到端：弱点挖掘→提案→回归测试→应用
// 7. MCP 安全端到端：恶意工具调用→检测→拦截→报告
```

### 11.2 文档同步

- 更新 `docs/architecture.md`：增加自进化框架、安全框架
- 更新 `docs/configuration.md`：增加 Phase 52 所有配置项
- 更新 `docs/paper-references.md`：记录 10 篇论文的借鉴映射

### 11.3 测试要求

- 7 个端到端测试通过。
- 文档同步完成。

---

## 陷阱警告（#171-#180）

**171. Skill 级记忆可能导致 Skill 定义膨胀：** Task 1 的 SkillMemory 积累跨任务经验，如果不限制大小，记忆会无限增长。memoryRetentionDays 必须严格执行，且 SkillMemory 的 failurePatterns 和 successPaths 应有数量上限（如各最多 20 条），超出时按频率淘汰低频项。

**172. 过程级缺陷检测可能产生过多噪声：** Task 2 的 10 类缺陷在 sensitivity=high 时可能把正常行为误判为缺陷（如把"工具重试"误判为"infinite_loop"）。缺陷检测必须有上下文窗口——连续 N 步出现才判定，单次出现只记录不判定。sensitivity 应可配置且默认 medium。

**173. 有界局部恢复可能引入工件不一致：** Task 3 的局部恢复回退到 checkpoint 重跑，但已成功的下游步骤可能依赖被重跑步骤的工件。validateArtifactConsistency 必须检查所有下游工件的 dependsOn 链，发现不一致时必须失效下游工件并扩大恢复范围。

**174. SAD 迭代分解可能死循环：** Task 4 的迭代技能感知分解在 Skill 库不完整时可能无限迭代——子任务始终无法匹配到 Skill。maxDecompositionIterations 是硬上限，达到后应回退到"人工分解建议"而非继续迭代。

**175. 自进化框架可能优化错误的目标层：** Task 5 的 selectOptimizationTarget 根据信号选择优化层，但信号可能误导——如"工具调用失败率高"可能是工具配置问题（tools 层），也可能是路由选错模型（prompt 层）。优化目标选择必须有人工确认环节，不自动执行优化。

**176. Gödel 式自修改建议可能产出危险修改：** Task 8 的自修改建议即使不自动应用，也可能误导用户。riskAssessment 必须保守——涉及安全/认证/数据完整性的修改自动标记为 high risk，allowHighRiskProposals=false 时不产出。建议必须包含"回滚方法"说明。

**177. Self-Harness 回归测试集可能过时：** Task 9 的 Proposal Validation 依赖回归测试集，如果测试集本身过时或覆盖不足，验证通过不等于修改安全。回归测试集必须有饱和监测（Task 7）和定期更新机制。autoApplyValidated=false 是安全默认。

**178. MCP 安全框架的信任边界标注可能不一致：** Task 10 的形式化验证依赖信任边界标注，如果不同 MCP server 的信任边界标注不一致，可能导致检测遗漏。信任边界必须有统一标准——所有第三方 MCP server 默认为"不可信"边界，只有用户显式标记为"可信"的才放宽。

**179. 自演化能力的配置开关默认必须为 false：** Phase 52 的所有自演化能力（Task 1/5/8/9）默认 enabled=false。自演化是高级能力，可能改变 Agent 行为，用户必须显式启用。且自演化的产出（建议/修改）必须有审计日志，记录何时产出、是否应用、由谁确认。

**180. 10 篇论文的借鉴点之间有依赖关系：** Task 5（自进化框架）依赖 Task 1（Skill 记忆）和 Task 9（Self-Harness）的信号源。Task 8（Gödel 建议）依赖 Task 5 的框架协调。Task 9（Self-Harness）依赖 Task 7（饱和监测）保证回归测试集有效。落地顺序必须遵循依赖：先 Task 1/2/7（基础能力）→ 再 Task 5/9（自进化框架）→ 最后 Task 8（Gödel 自修改）。

---

## 思考引导总结

1. **10 篇论文的共同方向——Harness 自演化：** 论文 1/4/5/8/9 都指向"Agent 自己创建和优化 Harness"。RouteDev 当前停留在"人工维护 Harness"的范式，Phase 52 把它升级为"自演化 Harness"。但安全版——只产出建议，不自动应用。

2. **过程级评估是结果级评估的必要补充：** 论文 2/6/7 共同指出——只看 pass/fail 会遗漏过程缺陷和饱和。Phase 52 的评估相关 Task 把 RouteDev 的评估从"结果级"升级为"过程级+架构感知+饱和监测"。

3. **有界局部恢复优于全局重跑：** 论文 3 证明长程工作流中全局重跑成本过高。Phase 52 的 Task 3 把双循环从"失败就全局重跑"改为"优先局部恢复，超过阈值才全局重跑"。

4. **组合技能路由解决复杂任务的 Skill 选择问题：** 论文 4 证明复杂任务需要组合多个 Skill，且任务分解是瓶颈。Phase 52 的 Task 4 用 SAD 迭代分解解决"标准 LLM 分解只有 34% 召回"的问题。

5. **自进化框架是元能力：** 论文 5 的统一框架把 RouteDev 的零散自进化能力（SkillGenerator/LoopMemory/ScoreCard）整合为协调的反馈循环。这是 Phase 52 的"骨架"，其他 Task 是"血肉"。

6. **架构感知指标让诊断从"笼统"变"精准"：** 论文 6 的指标绑定架构组件，让 RouteDev 的 /quality 命令从"总 token/总耗时"升级为"哪个组件慢/哪个组件错"。

7. **基准饱和监测让评估集保持有效：** 论文 7 的饱和研究提醒——评估集不是一劳永逸的。Phase 52 的 Task 7 持续监测评估集区分度，饱和时及时更新。

8. **Gödel 自修改的安全版——建议而非应用：** 论文 8 的自指递归自改进很激进，直接应用风险高。Phase 52 的 Task 8 保守落地——只产出修改建议，所有建议需用户确认。

9. **Self-Harness 三阶段循环是 Harness 自优化的工程化方案：** 论文 9 的弱点挖掘→提案→验证三阶段循环，是自演化的工程化实现。Phase 52 的 Task 9 把它落地为可配置的循环。

10. **MCP 安全需要形式化而非零散补丁：** 论文 10 证明单一防御覆盖不超 34% 威胁。Phase 52 的 Task 10 用四层深度防御架构（能力控制/工具证明/信息流追踪/运行时策略）实现 91% 覆盖。

11. **Phase 52 是 v4.1.0 的核心——从"人工 Harness"到"自演化 Harness"：** Phase 49/50/51 把 RouteDev 的 Harness 做完整了，Phase 52 让 Harness 开始自己进化。这是 RouteDev 从"工具"升级为"会进化的工具"的转折点。

12. **论文选择的针对性——每篇解决一个具体缺口：** 这 10 篇不是随便挑的——论文 1 解决 Skill 记忆缺口、论文 3 解决恢复机制缺口、论文 4 解决组合路由缺口、论文 10 解决安全形式化缺口。每篇都对应 RouteDev 的一个真实工程问题。

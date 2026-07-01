# Phase 54 — 多 Agent 协作剧场与参赛演示闭环（实践化修正版）

> **版本目标：** v4.3.0
> **前置依赖：** Phase 50（死代码接入收尾与模块集成）已完成
> **后继依赖：** 无（参赛演示 Phase，独立交付）
> **新增测试要求：** ≥ 60 个
> **研究依据：**
> 1. **TRAE AI 创造力大赛初赛参赛指南**（forum.trae.cn/t/topic/22549）——评审 4 维度（创新性/完整性/价值/可体验性），要求"实质性版本迭代"+ ≥3 张关键步骤截图 + ≥3 个 Session ID + 可体验地址
> 2. **RouteDev 现状深度审计**（基于 codegraph 索引 419 文件/5117 节点 + 逐文件源码阅读）——揭示**两条互不通用的流水线**：`/goal` 路径（GoalRunner 单 Agent 串行，有 GoalAuditor + 迭代闭环，不调用 Orchestrator/WorkerExecutor/ContextPacker）与 `development` 路径（TaskOrchestrator → ExecutionOrchestrator → Orchestrator + WorkerExecutor + UnifiedReviewer，不调用 GoalAuditor，无迭代闭环）
> 3. **用户核心诉求明确**——目标流程：用户输入需求 + /goal → Agent 自动追问明确需求 → 分解子任务 + 制定验收标准 → 用户确认 → 自动多 Agent 协作开发 → 多层验收循环 → 人工最终确认 → 产出。突出四个核心点：**独立上下文** + **多角色任务** + **选择性传递** + **强制提问和严苛验收**
> **核心命题：** Phase 54 原设计假设 `/goal` 已接入多 Agent 编排链路，但源码审计证明这是**架构性错误假设**——`/goal` 走 GoalRunner 单 Agent 串行路径，完全不调用 Orchestrator/WorkerExecutor/ContextPacker。实践化修正后的 Phase 54 分两层推进：**架构统一层**（Task 1-5）让 `/goal` 走完整多 Agent 链路 + 修复 GoalAuditor 接入缺陷 + 新增 acceptanceCriteria 字段 + 自主度枚举 + ContextPacker 扩展；**剧场展示层**（Task 6-15）在统一的架构上实现两轮提问（整合 gatherer 的提问机制 + clarifier 的模糊度评分 + 对抗性建议）、事件埋点、IPC 桥接、角色看板、提问对话流、Blackboard 信息流、执行计划预览、演示模式。最终让 `/goal` 命令触发完整流程：输入模糊需求 → 模糊度评分判定是否提问 → 两轮提问（第一轮可跳过 + 第二轮对抗性建议+自动选推荐）→ 生成执行计划（含验收标准）→ 用户确认 → 多 Agent 协作开发（独立上下文+选择性传递可见）→ 三层验收循环 → 人工最终确认 → 产出。

---

## 项目现状审计（基于源码逐文件阅读）

### 1. 两条流水线互不通用（最关键发现）

| 维度 | `/goal` 路径 | `development` 路径 |
|------|-------------|-------------------|
| 驱动 | `GoalRunner.executeGoalPlan`（`goal-runner.ts:427`）串行 for 循环 | `TaskOrchestrator.handle` → `ExecutionOrchestrator.executeMultiAgent`（`execution-orchestrator.ts:377`） |
| 提问 | ❌ 不调用 RequirementsGatherer | ✅ `App.tsx:503` `runRequirementsGathererRef` |
| 编排 | ❌ 不调用 Orchestrator/WorkerExecutor | ✅ Orchestrator.plan + WorkerExecutor.execute |
| 上下文打包 | ❌ 不调用 ContextPacker | ❌ WorkerExecutor 用自己的 filterContext（**也不调用 ContextPacker**） |
| 验收 | ✅ GoalAuditor（可选，`goalIntegration.auditEnabled`）+ GoalVerifier + CompletionGate + 迭代闭环 | ❌ 不调用 GoalAuditor；UnifiedReviewer 只返回结果不重试 |
| 迭代闭环 | ✅ `config.goalVerifier.iterative`（默认未启用） | ❌ 无回退 |

**结论：Phase 54 必须先做架构统一，让 `/goal` 接入多 Agent 编排，否则"多 Agent 协作剧场"无落脚点。**

### 2. 六大模块现状（逐项审计）

#### 2.1 GoalRunner（`src/cli/goal-runner.ts`，809 行）
- **已存在**：`handleGoalCommand`（L96）→ `GoalParser.parse` → `requestPlanEdit`（用户确认，`config.goal.requireConfirmation`）→ `gateManager.freeze` → `executeGoalPlan`（L427）→ `verifyPlan`（L197）→ `runCompletionGate`（L287）→ 迭代闭环（L657-732）
- **已存在**：用户确认计划环节（StepEditor）
- **已存在**：迭代闭环（`config.goalVerifier.iterative`，最大 `maxRounds`）
- **完全缺失**：不调用 Orchestrator/WorkerExecutor/ContextPacker/RequirementsGatherer
- **完全缺失**：auto/semi/manual 自主度枚举（只有 `requireConfirmation` 布尔 + `onConfirmTool` 回调）

#### 2.2 RequirementsGatherer（`src/agent/requirements-gatherer.ts`，Phase 31）
- **已存在**：单轮提问（AsyncGenerator + 事件流），LLM 生成问题，降级到 skipped
- **已存在**：事件发射（`yield RequirementsEvent`）
- **完全缺失**：`/goal` 不调用它
- **完全缺失**：对抗性建议、两轮提问
- **重复模块**：`requirements-clarifier.ts`（Phase 37）有模糊度评分（0~1）+ `enrichGoal`，功能重叠

#### 2.3 Orchestrator（`src/agent/multi/orchestrator.ts`）
- **已存在**：`plan()` 返回 `ExecutionPlan { dependencies: StepDependency[], parallelGroups, executionOrder, analysisNotes }`
- **已存在**：依赖图（LLM + Kahn 拓扑排序）、并行组、角色分配（coder/searcher/tester/reviewer）、`executeWorkerIsolated`（异常隔离 + 自动重试）
- **完全缺失**：`StepDependency` 无 `acceptanceCriteria` 字段（只有 stepId/dependsOn/assignedRole/likelyFiles）
- **完全缺失**：事件发射（仅 logger）
- **完全缺失**：`/goal` 不调用它

#### 2.4 WorkerExecutor（`src/agent/multi/worker-executor.ts`）
- **已存在**：`execute(task, llmClient, routeDecision, conversationHistory, baseSystemPrompt, signal, onConfirmTool)` 完整实现（熔断器 + 异常隔离 + 自动重试 + rollback + filterContext 三策略 + 三分类 classifyAndPrune + declareFocus）
- **完全缺失**：**不调用 ContextPacker**——用自己的 filterContext 注入 Blackboard 快照
- **完全缺失**：事件发射

#### 2.5 ContextPacker（`src/agents/context-packer.ts`）
- **已存在**：`pack({role, taskId, sources, budgetTokens})` 返回 `ContextPackage { role, taskId, tokenBudget, sections: ContextSection[], metadata: { totalFiles, totalSymbols, estimatedTokens, truncated, sourceSnapshot } }`
- **完全缺失**：`fragments` / `filteredOutCount` / `filteredOutSummary` 字段——只有 `sections` + `metadata.truncated`（布尔）
- **完全缺失**：WorkerExecutor 不调用它（只被 `spawn-agent.ts:434` 调用）

#### 2.6 GoalAuditor（`src/agent/goal-audit.ts`）
- **已存在**：三层审计（CompletionGate + VerifierLLM + ReviewerAgent）+ 三种仲裁规则（completion_gate_first / reviewer_first / all_must_pass）
- **接入缺陷**：`goal-runner.ts:254-272` 调用 `audit` 时**未传** `typecheckPassed`/`lintPassed`/`testsPassed`/`reviewerResult`，导致 completion_gate 层永远 missing，三层实际退化为单层 verifier_llm
- **完全缺失**：循环重试（靠外层 iterative 闭环）、人工最终确认、事件发射

---

## 核心设计原则

### 原则 1：架构统一优先于展示层

原 Phase 54 跳过架构直接做展示层是错误的。实践化修正后，Task 1-5 先让 `/goal` 接入多 Agent 编排、修复 GoalAuditor、新增 acceptanceCriteria、扩展 ContextPacker、新增自主度枚举；Task 6-15 才做提问/事件/埋点/UI/演示。**没有统一架构，剧场无落脚点。**

### 原则 2：最小侵入接入 /goal

不重写 goal-runner.ts，而是在 `executeGoalPlan` 内增加分支：当 `orchestrationIntegration` 开启时，调用 `ExecutionOrchestrator.executeMultiAgent` 替代串行 for 循环；关闭时保留原串行路径作为 fallback。这样：
- 现有 `/goal` 测试零回归（开关默认 false）
- 演示模式一键开启即走多 Agent 路径

### 原则 3：四大核心价值必须可见

- **强制提问**——模糊度评分判定是否提问 + 两轮提问（第一轮可跳过 + 第二轮对抗性建议+自动选推荐）
- **独立上下文**——每个子 Agent 的上下文大小、来源可见
- **选择性传递**——ContextPacker 扩展后传递片段+过滤摘要可见
- **严苛验收**——GoalAuditor 三层门禁（修复接入缺陷）+ 循环重试 + 人工最终确认

### 原则 4：模糊度评分决定是否提问

整合 clarifier 的模糊度评分（0~1）：用户输入详细（评分<0.3）则跳过提问直接规划；输入模糊（评分≥0.3）则触发两轮提问。这尊重用户自主权——详细输入不被打扰，模糊输入强制澄清。

### 原则 5：不删除旧模块避免破坏测试

`requirements-gatherer.ts` 和 `requirements-clarifier.ts` 都保留，新建 `two-round-questioner.ts` 整合两者优点。旧模块继续服务于 development 流水线，新模块服务于 `/goal`。

---

## Task 1：/goal 接入多 Agent 编排（≥ 6 测试）

### 1.1 背景

`/goal` 当前走 GoalRunner 单 Agent 串行路径，不调用 Orchestrator/WorkerExecutor。需在 `executeGoalPlan` 内增加分支，开启编排时走多 Agent 路径。

### 1.2 接入点

```typescript
// src/cli/goal-runner.ts（修改 executeGoalPlan，L427-743）

private async executeGoalPlan(plan: GoalPlan): Promise<void> {
  // ... 原有 checkpointManager.saveGoalPlan + tracker.startTask

  const orchestrationEnabled = config.orchestrationIntegration?.strategyEnabled
    || config.orchestrationIntegration?.stateGraphEnabled
    || config.orchestrationIntegration?.branchOrchestrationEnabled;

  if (orchestrationEnabled) {
    // 新增：多 Agent 路径
    await this.executePlanWithMultiAgent(plan);
  } else {
    // 原有：串行 for 循环路径（保留，零回归）
    await this.executePlanSequential(plan);
  }

  // ... 原有 verifyPlan + runCompletionGate + 迭代闭环
}

/** 多 Agent 路径：委托 ExecutionOrchestrator */
private async executePlanWithMultiAgent(plan: GoalPlan): Promise<void> {
  const executionPlan = await this.orchestrator.plan(plan);
  for (const group of executionPlan.parallelGroups) {
    // 并行组内 Worker 并行执行
    const results = await Promise.all(
      group.map(stepId => this.executeWorkerStep(plan, executionPlan, stepId))
    );
    // 结果写入 Blackboard
    for (const result of results) {
      if (result.success) {
        this.blackboard.addCompletedStep(result.stepId, result.role, result.conclusion);
      }
    }
  }
}

/** 执行单个 Worker 步骤 */
private async executeWorkerStep(plan: GoalPlan, executionPlan: ExecutionPlan, stepId: number): Promise<WorkerResult> {
  const dep = executionPlan.dependencies.find(d => d.stepId === stepId)!;
  const task: WorkerTask = {
    stepId,
    description: plan.steps.find(s => s.id === stepId)?.description ?? '',
    role: dep.assignedRole,
    rolePrompt: this.getRolePrompt(dep.assignedRole),
    blackboardSnapshot: this.blackboard.formatForPrompt(),
  };
  const llmClient = await this.clientManager.get(...);
  const routeDecision = this.modelRouter.route(...);
  return await this.workerExecutor.execute(
    task, llmClient, routeDecision,
    this.conversationHistory, this.baseSystemPrompt,
    this.abortControllerRef.current?.signal,
    this.onConfirmTool,
  );
}
```

### 1.3 依赖注入

```typescript
// src/cli/app-init.ts（修改）

// GoalRunner 构造增加 orchestrator/workerExecutor/blackboard 注入
goalRunner = new GoalRunner({
  // ... 原有参数
  orchestrator: executionOrchestrator.orchestrator,      // 新增
  workerExecutor: executionOrchestrator.workerExecutor,  // 新增
  blackboard: executionOrchestrator.blackboard,          // 新增
});
```

### 1.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/cli/goal-runner.ts` | 修改 | executeGoalPlan 增加分支 + 新增 executePlanWithMultiAgent/executeWorkerStep |
| `src/cli/app-init.ts` | 修改 | GoalRunner 注入 orchestrator/workerExecutor/blackboard |

### 1.5 测试要求

- orchestrationEnabled=true 时走 executePlanWithMultiAgent 路径。
- orchestrationEnabled=false 时走原串行路径（零回归）。
- parallelGroups 内 Worker 并行执行。
- Worker 结果写入 Blackboard。
- 现有 `/goal` 测试全部通过（开关默认 false）。
- 中断信号（abortController）在多 Agent 路径也生效。

---

## Task 2：ContextPacker 扩展 + WorkerExecutor 接线（≥ 5 测试）

### 2.1 背景

ContextPacker 现有返回结构只有 `sections` + `metadata.truncated`，无 `fragments`/`filteredOutCount`/`filteredOutSummary`。WorkerExecutor 不调用 ContextPacker。需扩展字段并接线。

### 2.2 ContextPacker 扩展

```typescript
// src/agents/context-packer.ts（修改 ContextPackage 接口）

export interface ContextPackage {
  role: AgentRole;
  taskId: string;
  tokenBudget: number;
  sections: ContextSection[];
  metadata: {
    totalFiles: number;
    totalSymbols: number;
    estimatedTokens: number;
    truncated: boolean;
    sourceSnapshot: string;
  };
  // ===== Phase 54 新增字段（用于选择性传递可视化） =====
  /** 传递的片段摘要列表（从 sections 映射） */
  passedFragments: Array<{
    source: string;      // section.title
    summary: string;     // section.content 前 80 字符
    weight: number;      // section.priority
  }>;
  /** 被过滤的片段数（候选数 - 入选数） */
  filteredOutCount: number;
  /** 被过滤内容摘要（被截断或超预算的 section 标题列表） */
  filteredOutSummary: string;
}

// pack() 末尾填充新字段
async pack(options): Promise<ContextPackage> {
  // ... 原有逻辑生成 sections
  const candidates = this.buildCandidates(sources, weights);
  const passedFragments = sections.map(s => ({
    source: s.title,
    summary: s.content.slice(0, 80),
    weight: s.priority,
  }));
  const filteredOutCount = candidates.length - sections.length;
  const filteredOutSummary = candidates
    .slice(sections.length)
    .map(c => c.title)
    .join(', ');
  return { role, taskId, tokenBudget, sections, metadata: {...}, passedFragments, filteredOutCount, filteredOutSummary };
}
```

### 2.3 WorkerExecutor 接线 ContextPacker

```typescript
// src/agent/multi/worker-executor.ts（修改 execute）

export class WorkerExecutor {
  constructor(
    private agentLoop: ReActAgentLoop,
    private options: WorkerExecutorOptions,
    private contextPacker?: ContextPacker,  // 新增可选注入
  ) {}

  async execute(task, llmClient, routeDecision, conversationHistory, baseSystemPrompt, signal?, onConfirmTool?): Promise<WorkerResult> {
    // 原有：熔断器检查
    // 新增：调用 ContextPacker 打包上下文（若注入了 contextPacker）
    let packedContext: ContextPackage | null = null;
    if (this.contextPacker) {
      packedContext = await this.contextPacker.pack({
        role: this.mapRoleToAgentRole(task.role),
        taskId: String(task.stepId),
        sources: this.buildContextSources(task, conversationHistory),
        budgetTokens: routeDecision.tokenBudget ?? 8000,
      });
    }
    // 原有：filterContext（保留作为 fallback，contextPacker 未注入时用）
    const filteredHistory = packedContext
      ? this.applyPackedContext(conversationHistory, packedContext)
      : this.filterContext(task, conversationHistory);
    // ... 原有执行逻辑
  }
}
```

### 2.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agents/context-packer.ts` | 修改 | ContextPackage 新增 passedFragments/filteredOutCount/filteredOutSummary + pack() 填充 |
| `src/agent/multi/worker-executor.ts` | 修改 | 构造函数注入 contextPacker + execute() 调用 pack |
| `src/cli/app-init.ts` | 修改 | WorkerExecutor 注入 ContextPacker |

### 2.5 测试要求

- pack() 返回的 passedFragments 与 sections 一一对应。
- filteredOutCount = 候选数 - 入选数。
- filteredOutSummary 包含被过滤的 section 标题。
- WorkerExecutor 注入 contextPacker 后调用 pack。
- 未注入 contextPacker 时回退到 filterContext（零回归）。

---

## Task 3：acceptanceCriteria 字段贯通（≥ 4 测试）

### 3.1 背景

`GoalPlan`（`goal-types.ts:39`）和 `ExecutionPlan`（`multi/types.ts:21`）都无 `acceptanceCriteria` 字段。需新增并贯通 GoalParser/Orchestrator。

### 3.2 类型扩展

```typescript
// src/agent/goal-types.ts（修改 GoalStep）
export interface GoalStep {
  id: number;
  description: string;
  // ... 原有字段
  acceptanceCriteria?: string;  // 新增
}

// src/agent/multi/types.ts（修改 StepDependency）
export interface StepDependency {
  stepId: number;
  dependsOn: number[];
  assignedRole: WorkerRole;
  likelyFiles: string[];
  acceptanceCriteria?: string;  // 新增
}
```

### 3.3 GoalParser 填充

```typescript
// src/agent/goal-parser.ts（修改 parse）

async parse(description, options): Promise<GoalPlan> {
  // 原有 LLM 调用生成 steps
  const plan = await this.llmParse(description, options);
  // 新增：为每个 step 生成验收标准（若 LLM 未生成）
  for (const step of plan.steps) {
    if (!step.acceptanceCriteria) {
      step.acceptanceCriteria = await this.generateAcceptanceCriteria(step, plan);
    }
  }
  return plan;
}

/** 生成具体化验收标准（防止空泛） */
private async generateAcceptanceCriteria(step: GoalStep, plan: GoalPlan): Promise<string> {
  const prompt = `为以下步骤生成具体可验证的验收标准（禁止"功能正常工作"这种空泛表述）：
步骤：${step.description}
目标：${plan.description}
要求：必须包含可检查的具体条件（如"命令能执行并输出 X"、"测试覆盖 Y"、"文件存在于 Z 路径"）。`;
  return await this.llmClient.complete(prompt);
}
```

### 3.4 Orchestrator 传递

```typescript
// src/agent/multi/orchestrator.ts（修改 plan）

async plan(goalPlan: GoalPlan): Promise<ExecutionPlan> {
  // 原有 analyzeWithLLM
  const analysis = await this.analyzeWithLLM(goalPlan);
  // 新增：从 goalPlan.steps 填充 acceptanceCriteria 到 dependencies
  for (const dep of analysis) {
    const step = goalPlan.steps.find(s => s.id === dep.stepId);
    if (step?.acceptanceCriteria) {
      dep.acceptanceCriteria = step.acceptanceCriteria;
    }
  }
  // ... 原有拓扑排序/并行组
}
```

### 3.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/goal-types.ts` | 修改 | GoalStep 新增 acceptanceCriteria |
| `src/agent/multi/types.ts` | 修改 | StepDependency 新增 acceptanceCriteria |
| `src/agent/goal-parser.ts` | 修改 | parse() 填充 acceptanceCriteria + generateAcceptanceCriteria |
| `src/agent/multi/orchestrator.ts` | 修改 | plan() 从 goalPlan 传递 acceptanceCriteria 到 dependencies |

### 3.6 测试要求

- GoalStep/StepDependency 类型扩展不破坏现有测试。
- GoalParser.parse 为每个 step 生成 acceptanceCriteria。
- acceptanceCriteria 非空且具体（非"功能正常工作"）。
- Orchestrator.plan 把 acceptanceCriteria 从 goalPlan 传递到 dependencies。

---

## Task 4：GoalAuditor 接入缺陷修复（≥ 4 测试）

### 4.1 背景

`goal-runner.ts:254-272` 调用 `goalAuditor.audit` 时未传 `typecheckPassed`/`lintPassed`/`testsPassed`/`reviewerResult`，导致 completion_gate 层永远 missing，三层退化为单层。

### 4.2 修复

```typescript
// src/cli/goal-runner.ts（修改 verifyPlan，L197-281）

private async verifyPlan(plan: GoalPlan): Promise<void> {
  // 原有：GoalVerifier.verify
  const verifierResult = await this.goalVerifier.verify(plan, options, this.gateManager.getGates());

  // 原有：runCompletionGate（已有结果，但没传给 GoalAuditor）
  const completionResult = await this.runCompletionGate(plan);

  // 修复：GoalAuditor.audit 传入完整参数
  if (this.config.goalIntegration?.auditEnabled && this.goalAuditor) {
    const auditOutcome = await this.goalAuditor.audit({
      spec: { doneWhen: plan.verificationCriteria },
      verifierResult: {
        passed: verifierResult.passed,
        evidence: verifierResult.reasoning,
        missing: verifierResult.missingItems,
      },
      // 修复：传入 completion gate 的客观结果
      typecheckPassed: completionResult?.typecheck?.ok,
      lintPassed: completionResult?.lint?.ok,
      testsPassed: completionResult?.tests?.ok,
      // 修复：调用 UnifiedReviewer 获取 reviewerResult
      reviewerResult: await this.getReviewerResult(plan),
    });
    if (!auditOutcome.overallPassed) {
      plan.status = 'failed';
    }
  }
}

/** 新增：获取 reviewer 结果 */
private async getReviewerResult(plan: GoalPlan): Promise<ReviewResult | undefined> {
  if (!this.unifiedReviewer) return undefined;
  return await this.unifiedReviewer.review({ plan, modifiedFiles: plan.modifiedFiles ?? [] });
}
```

### 4.3 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/cli/goal-runner.ts` | 修改 | verifyPlan 传入 typecheck/lint/tests/reviewer 结果 + getReviewerResult |
| `src/cli/app-init.ts` | 修改 | GoalRunner 注入 unifiedReviewer |

### 4.4 测试要求

- audit 调用时 typecheckPassed/lintPassed/testsPassed 非空。
- completion_gate 层正常工作（不再永远 missing）。
- reviewerResult 传入后 reviewer_agent 层生效。
- 三层仲裁按配置规则正确仲裁。

---

## Task 5：自主度模式枚举（≥ 3 测试）

### 5.1 背景

当前只有 `requireConfirmation` 布尔 + `onConfirmTool` 回调，无 auto/semi/manual 枚举。

### 5.2 枚举定义

```typescript
// src/config/schema.ts（修改）

const AutonomyModeSchema = z.enum(['auto', 'semi', 'manual']).default('semi');

const GoalConfigSchema = z.object({
  // ... 原有字段
  autonomyMode: AutonomyModeSchema,  // 新增
});

/** 自主度模式行为定义 */
export const AUTONOMY_BEHAVIOR: Record<AutonomyMode, {
  requirePlanConfirmation: boolean;   // 是否需要用户确认计划
  requireToolConfirmation: boolean;   // 是否需要用户确认工具调用
  requireHumanAcceptance: boolean;    // 是否需要人工最终确认验收
}> = {
  auto:   { requirePlanConfirmation: false, requireToolConfirmation: false, requireHumanAcceptance: true },  // 自动但需人工验收
  semi:   { requirePlanConfirmation: true,  requireToolConfirmation: false, requireHumanAcceptance: true },  // 半自动
  manual: { requirePlanConfirmation: true,  requireToolConfirmation: true,  requireHumanAcceptance: true },  // 全手动
};
```

### 5.3 GoalRunner 应用

```typescript
// src/cli/goal-runner.ts（修改 handleGoalCommand）

const autonomy = AUTONOMY_BEHAVIOR[config.goal.autonomyMode];
// 计划确认
if (autonomy.requirePlanConfirmation && config.goal.requireConfirmation !== false) {
  const confirmed = await this.requestPlanEdit(plan);
  if (!confirmed) return;
}
// 工具确认
const onConfirmTool = autonomy.requireToolConfirmation ? this.onConfirmTool : undefined;
// 人工验收确认（Task 8 的 acceptance_awaiting_human 由 UI 触发）
```

### 5.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/config/schema.ts` | 修改 | 新增 AutonomyModeSchema + AUTONOMY_BEHAVIOR |
| `src/cli/goal-runner.ts` | 修改 | handleGoalCommand 应用自主度行为 |

### 5.5 测试要求

- auto 模式跳过计划确认。
- semi 模式需要计划确认。
- manual 模式需要计划确认 + 工具确认。
- 所有模式都需要人工验收确认。

---

## Task 6：两轮提问模块（整合 gatherer + clarifier）（≥ 10 测试）

### 6.1 背景

整合 `requirements-gatherer.ts`（提问机制）+ `requirements-clarifier.ts`（模糊度评分）优点，新建 `two-round-questioner.ts`。模糊度评分决定是否提问；两轮提问（第一轮可跳过 + 第二轮对抗性建议+自动选推荐）。

### 6.2 模糊度评分（复用 clarifier）

```typescript
// src/agent/two-round-questioner.ts（新建）

import { RequirementsClarifier } from './requirements-clarifier.js';

export class TwoRoundQuestioner {
  constructor(
    private llmClient: ILLMClient,
    private clarifier: RequirementsClarifier,  // 复用模糊度评分
    private config: QuestionEnhancementConfig,
  ) {}

  async question(input: string, planId: string): Promise<QuestionResult> {
    // 1. 模糊度评分（复用 clarifier）
    const ambiguityScore = await this.clarifier.clarify(input).score;
    if (ambiguityScore < 0.3) {
      // 输入详细，跳过提问
      return { skipped: true, reason: '输入清晰度高，跳过提问', ambiguityScore };
    }

    // 2. 第一轮：事无巨细提问（复用 gatherer 的 generateQuestions 逻辑）
    const round1Questions = await this.generateExhaustiveQuestions(input);
    const round1Answers = await this.askRound1(round1Questions, planId);

    // 3. 第二轮：针对跳过的问题，对抗性建议
    const skippedQuestions = round1Answers.filter(a => a.skipped);
    if (skippedQuestions.length > 0 && this.config.adversarialAdviceEnabled) {
      const round2Results = await this.askRound2WithAdversarialAdvice(skippedQuestions, planId);
      return this.mergeAnswers(round1Answers, round2Results, ambiguityScore);
    }
    return this.consolidate(round1Answers, ambiguityScore);
  }

  // ... askRound1 / askRound2WithAdversarialAdvice / generateAdversarialAdvice 实现
  // （埋点在 Task 8 添加）
}
```

### 6.3 接入 /goal

```typescript
// src/cli/goal-runner.ts（修改 handleGoalCommand，在 GoalParser.parse 之前）

private async handleGoalCommand(command: string): Promise<void> {
  // ... 原有解析
  if (this.config.questionEnhancement?.twoRoundEnabled && this.twoRoundQuestioner) {
    const questionResult = await this.twoRoundQuestioner.question(description, planId);
    if (!questionResult.skipped) {
      description = this.enrichDescription(description, questionResult);
    }
  }
  const plan = await this.parser.parse(enrichedDescription, ...);
  // ... 原有流程
}
```

### 6.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/two-round-questioner.ts` | 新建 | 两轮提问 + 对抗性建议 + 模糊度评分 |
| `src/config/schema.ts` | 修改 | 新增 QuestionEnhancementSchema |
| `src/cli/goal-runner.ts` | 修改 | handleGoalCommand 接入 TwoRoundQuestioner |
| `src/cli/app-init.ts` | 修改 | 注入 TwoRoundQuestioner |

### 6.5 测试要求

- 模糊度评分 < 0.3 时跳过提问。
- 模糊度评分 ≥ 0.3 时触发第一轮提问。
- 第一轮生成的问题覆盖各维度。
- 用户跳过的问题进入第二轮。
- 第二轮生成两个对抗性建议（不同 system prompt 确保对抗性）。
- 第二轮未选时自动选推荐。
- 第二轮用户选择时不自动选。
- 两个 Agent 的对抗性建议确实不同（不同 system prompt）。
- config.twoRoundEnabled=false 时跳过提问。
- /goal 接入后正常触发提问。

---

## Task 7：协作事件层（≥ 6 测试）

（与原 Phase 54 Task 1 相同，事件类型覆盖提问/计划/执行/上下文/验收/Blackboard 全生命周期。详见事件类型定义。）

### 7.1 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/multi/collaboration-events.ts` | 新建 | 事件类型 + EventBus + Tracker |

### 7.2 测试要求

- EventBus emitSafe 失败时不抛出。
- Tracker 收到事件后 listeners 被通知。
- Tracker 超过 maxEvents 时 FIFO 丢弃。
- getEventsByPlan 正确过滤。
- onEvent 取消订阅生效。
- 事件类型字段完整性。

---

## Task 8：数据层埋点（≥ 10 测试）

### 8.1 背景

在 TwoRoundQuestioner/Orchestrator/WorkerExecutor/ContextPacker/GoalAuditor/Blackboard 六个模块插入埋点。**不修改业务逻辑**。

### 8.2 埋点清单

| 模块 | 埋点事件 |
|------|----------|
| TwoRoundQuestioner | question_round_1_started/asked/answered/skipped/completed + question_round_2_started/advice_a/advice_b/answered/auto_selected/completed |
| Orchestrator | plan_created（含 acceptanceCriteria）+ plan_confirmed |
| WorkerExecutor | worker_assigned/started/completed/failed |
| ContextPacker | context_passed（passedFragments + filteredOutCount + filteredOutSummary） |
| GoalAuditor | acceptance_started/gate_checking/gate_rejected/verifier_checking/verifier_rejected/reviewer_checking/reviewer_rejected/loop_retry/passed/awaiting_human/human_confirmed/human_rejected |
| Blackboard | blackboard_goal_set/step_added/fact_added |

### 8.3 ContextPacker 埋点（在 WorkerExecutor.execute 内）

```typescript
// src/agent/multi/worker-executor.ts（修改 execute）

// 调用 contextPacker.pack 后埋点
if (packedContext) {
  this.eventBus.emitSafe({
    id: randomUUID(), type: 'context_passed', timestamp: Date.now(),
    planId: this.currentPlanId ?? randomUUID(),
    role: task.role, stepId: task.stepId,
    contextTransfer: {
      targetRole: task.role,
      totalContextSize: packedContext.metadata.estimatedTokens,
      passedFragmentCount: packedContext.passedFragments.length,
      passedFragments: packedContext.passedFragments,
      filteredOutCount: packedContext.filteredOutCount,
      filteredOutSummary: packedContext.filteredOutSummary,
    },
  });
}
```

### 8.4 GoalAuditor 埋点 + 人工确认

```typescript
// src/agent/goal-audit.ts（修改 audit）

async audit(params): Promise<AuditOutcome> {
  // 每层检查前后都埋点 acceptance_*_checking / _rejected
  // 三层全通过后埋点 acceptance_passed + acceptance_awaiting_human
  // emitHumanConfirmation 方法由 UI 触发（Task 9 IPC）
}

emitHumanConfirmation(stepId, role, confirmed, retryCount): void {
  this.emitAcceptance(confirmed ? 'acceptance_human_confirmed' : 'acceptance_human_rejected', ...);
}
```

### 8.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/two-round-questioner.ts` | 修改 | 各阶段埋点 |
| `src/agent/multi/orchestrator.ts` | 修改 | plan_created + plan_confirmed 埋点 |
| `src/agent/multi/worker-executor.ts` | 修改 | worker_* + context_passed 埋点 |
| `src/agent/multi/blackboard.ts` | 修改 | blackboard_* 埋点 |
| `src/agent/goal-audit.ts` | 修改 | acceptance_* 全流程埋点 + emitHumanConfirmation |

### 8.6 测试要求

- TwoRoundQuestioner 两轮提问事件正确发射。
- Orchestrator.plan() 后收到 plan_created（含 acceptanceCriteria）。
- WorkerExecutor.execute() 后收到 worker_* + context_passed。
- context_passed 事件含 passedFragments 和 filteredOutSummary（来自 Task 2 扩展）。
- GoalAuditor 三层验收每层都有 _checking 和 _rejected。
- 验收不通过收到 acceptance_loop_retry。
- 三层全通过后收到 acceptance_awaiting_human。
- 人工确认触发 acceptance_human_confirmed/rejected。
- 埋点失败不影响原业务逻辑。
- Blackboard 写入触发对应事件。

---

## Task 9：IPC 通道与主进程桥接（≥ 4 测试）

（与原 Phase 54 Task 4 相同，新增 collaboration:event 通道 + confirmAcceptance/confirmPlan 回传指令。）

### 9.1 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/shared/ipc-types.ts` | 修改 | 新增 collaboration 命名空间 |
| `desktop/preload/index.ts` | 修改 | 新增 collaboration API |
| `desktop/main/engine-bridge.ts` | 修改 | setCollaborationTracker + registerCollaborationHandlers |
| `desktop/main/index.ts` | 修改 | 调用 registerCollaborationHandlers |

### 9.2 测试要求

- onEvent 注册后收到事件。
- getEvents 返回指定 planId 事件。
- confirmAcceptance 触发 emitHumanConfirmation。
- confirmPlan 触发 emitPlanConfirmed。

---

## Task 10：角色看板组件 + 验收循环状态（≥ 8 测试）

（与原 Phase 54 Task 5 相同，8 种卡片状态 + 验收循环计数 + 上下文展开。）

### 10.1 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/renderer/src/components/CollaborationPanel.tsx` | 新建 | RoleBoard + TaskCard + aggregateTaskCards |

### 10.2 测试要求

- aggregateTaskCards 正确聚合全流程。
- 验收不通过 status='acceptance_failed'。
- retryCount 正确累加。
- context_passed 填充到 card.contextTransfer。
- acceptanceCriteria 填充到卡片。
- 角色列按 role 分组。
- 空事件返回空数组。
- awaiting_human 时有确认按钮。

---

## Task 11：两轮提问对话流组件（≥ 5 测试）

（与原 Phase 54 Task 6 相同，第一轮问题列表 + 第二轮对抗性建议 + 自动选择标记。）

### 11.1 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/renderer/src/components/CollaborationPanel.tsx` | 修改 | QuestionFlow + QuestionItem |

### 11.2 测试要求

- 第一轮问题列表正确渲染。
- 第二轮对抗性建议显示 Agent A/B。
- 自动选择时显示"自动选择推荐"。
- 推荐选项有 ✓ 标记。
- 空事件时不渲染。

---

## Task 12：Blackboard 信息流 + 执行计划预览（≥ 6 测试）

（与原 Phase 54 Task 7 相同，Blackboard 信息流 + 执行计划预览含验收标准 + 用户确认按钮。）

### 12.1 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/renderer/src/components/CollaborationPanel.tsx` | 修改 | BlackboardFlow + PlanPreview |

### 12.2 测试要求

- BlackboardFlow 过滤三类事件，超过 20 条只显示最近 20 条。
- PlanPreview 无 plan_created 时不渲染。
- 显示步骤数 + 并行组数 + 依赖 + 验收标准。
- 未确认时显示确认按钮。
- 已确认时显示"用户已确认"。
- 确认按钮触发 confirmPlan()。

---

## Task 13：CollaborationPanel 主组件与 ChatPage 集成（≥ 5 测试）

（与原 Phase 54 Task 8 相同，面板主组件 + ChatPage Tab 切换。）

### 13.1 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/renderer/src/components/CollaborationPanel.tsx` | 修改 | CollaborationPanel 主组件 |
| `desktop/renderer/src/pages/ChatPage.tsx` | 修改 | 右侧面板 Tab 布局 |
| `desktop/renderer/src/components/CheckpointTimeline.tsx` | 修改 | 新增 showHeader prop |

### 13.2 测试要求

- 空事件显示占位。
- 有事件时四个子组件都渲染。
- 有提问事件时 QuestionFlow 渲染。
- Tab 切换正确。
- 卡片点击展开/收起。

---

## Task 14：演示模式与配置预设（≥ 4 测试）

### 14.1 演示模式配置（正确版本——开启所有核心能力）

```typescript
// src/config/defaults.ts（修改）

export const DEMO_MODE_CONFIG_OVERRIDE = {
  orchestrationIntegration: {
    strategyEnabled: true,
    stateGraphEnabled: true,
    branchOrchestrationEnabled: true,
  },
  questionEnhancement: {
    twoRoundEnabled: true,
    exhaustiveFirstRound: true,
    adversarialAdviceEnabled: true,
    autoSelectRecommended: true,
    maxQuestions: 15,
  },
  goalAudit: { auditEnabled: true, /* 三层全开 */ },
  goal: {
    autonomyMode: 'semi',        // 半自动：需确认计划 + 人工验收
    requireConfirmation: true,
  },
};
```

### 14.2 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/config/schema.ts` | 修改 | 新增 CollaborationPanelSchema |
| `src/config/defaults.ts` | 修改 | DEMO_MODE_CONFIG_OVERRIDE + applyDemoMode |
| `src/config/loader.ts` | 修改 | 加载后调用 applyDemoMode |
| `desktop/renderer/src/components/settings/SettingsAdvancedTab.tsx` | 修改 | 演示模式开关 |

### 14.3 测试要求

- demoMode=true 时配置正确覆盖。
- demoMode=false 时不改变原配置。
- applyDemoMode 叠加而非替换。
- 配置加载后 applyDemoMode 被调用。

---

## Task 15：演示任务素材与集成测试（≥ 5 测试）

### 15.1 演示任务需求文档（刻意模糊）

新建 `docs/demo-tasks/markdown-notes-cli.md`：

```markdown
# 演示任务：Markdown 笔记 CLI

## 需求（刻意模糊，用于触发两轮提问）
做一个命令行笔记工具，能记笔记、看笔记、删笔记。

## 技术约束
（未明确——留给 Agent 追问）

## 验收标准
（未明确——留给 Agent 追问）
```

### 15.2 集成测试

```typescript
// tests/integration/phase54-collaboration-e2e.test.ts（新建）

describe('Phase 54: 多 Agent 协作剧场 E2E', () => {
  // 1. /goal 输入模糊需求 → 模糊度评分≥0.3 → 触发两轮提问
  // 2. 第一轮提问≥5 问题，用户跳过部分
  // 3. 跳过的问题触发第二轮对抗性建议
  // 4. 第二轮未选时自动选推荐
  // 5. 生成执行计划（含 acceptanceCriteria）
  // 6. 用户确认计划
  // 7. 多 Agent 协作开发（context_passed 事件含传递片段）
  // 8. 验收不通过触发循环重试
  // 9. 三层全通过后等待人工确认
  // 10. 人工确认通过后任务完成
  // 11. 演示模式配置正确应用
  // 12. 面板组件正确渲染完整事件流
});
```

### 15.3 参赛素材收集清单

| 素材 | 数量 | 收集方式 |
|------|------|----------|
| Session ID | ≥3 | 开发过程中双击 TRAE 对话复制 |
| 关键步骤截图 | ≥3 | 两轮提问/上下文传递/验收循环/人工确认 |
| 演示视频 | 1 | OBS 录屏 |
| CHANGELOG | 1 | v4.3.0 变更记录 |

### 15.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `docs/demo-tasks/markdown-notes-cli.md` | 新建 | 演示任务需求 |
| `tests/integration/phase54-collaboration-e2e.test.ts` | 新建 | 端到端测试 |
| `docs/ARCHITECTURE.md` | 修改 | Phase 54 总览 |
| `docs/CONFIGURATION.md` | 修改 | 新增配置项 |
| `docs/COLLABORATION_THEATER.md` | 新建 | 使用指南 |
| `CHANGELOG.md` | 修改 | v4.3.0 |

### 15.5 测试要求

- 端到端测试覆盖完整流程。
- 演示模式配置应用正确。
- 文档同步完整。

---

## 陷阱警告（#171-#185）

**171. EventBus 单例在测试间污染：** 每个测试必须 `CollaborationEventBus.resetInstance()`。

**172. 埋点异常静默降级掩盖 Bug：** emitSafe 的 try/catch 吞异常。开发时打开 verbose。

**173. IPC 事件转发内存膨胀：** 限制面板最近 1000 条事件。

**174. 角色看板列宽在窄面板下挤压：** 最小列宽 80px，不足时横向滚动。

**175. 演示模式覆盖配置冲突：** applyDemoMode 叠加非替换。

**176. 对抗性建议雷同：** 两个 Agent 必须用不同 system prompt（A 偏简洁，B 偏健壮）。

**177. 第二轮自动选推荐选错：** 记录"考虑 A/B 后选 A 因为..."可追溯。

**178. 验收循环无限重试：** 最大重试 5 次，超限交回用户决策。

**179. passedFragments 过多 UI 拥挤：** 展开只显示前 3 个 + "更多 N 个"。

**180. 人工确认入口超时：** awaiting_human 脉冲动画 + 10 分钟超时转交用户。

**181. acceptanceCriteria 空泛：** generateAcceptanceCriteria 强制具体化。

**182. Tab 切换丢失事件订阅：** 切回时通过 getEvents(getActivePlanId()) 加载历史。

**183. /goal 接入多 Agent 后迭代闭环冲突：** Task 1 的多 Agent 路径与原 iterative 闭环（L657-732）可能叠加执行。需在多 Agent 路径内自行处理验收循环，跳过原 iterative 闭环。

**184. ContextPacker 扩展字段破坏 spawn-agent 调用方：** ContextPackage 新增字段是可选的，但 spawn-agent.ts:434 的调用方需确认不依赖严格结构。测试 spawn-agent 零回归。

**185. GoalRunner 注入新依赖可能未定义：** Task 1 注入 orchestrator/workerExecutor/blackboard，Task 4 注入 unifiedReviewer，Task 6 注入 twoRoundQuestioner。需确保 app-init.ts 实例化顺序正确（这些依赖必须在 GoalRunner 之前实例化）。

---

## 思考引导总结

1. **架构统一是 Phase 54 的前提：** 原 Phase 54 跳过架构直接做展示层是错的。源码审计证明 `/goal` 不调用编排模块。Task 1-5 先统一架构，Task 6-15 才做展示。没有统一架构，剧场无落脚点。

2. **最小侵入接入 /goal：** 不重写 goal-runner，在 executeGoalPlan 增加分支。开关默认 false，现有测试零回归。

3. **ContextPacker 扩展而非新建：** 在现有 sections + metadata.truncated 基础上新增 passedFragments/filteredOutCount/filteredOutSummary，保留向后兼容。

4. **GoalAuditor 接入缺陷必须修复：** 现有三层审计因未传 typecheck/lint/tests 退化为单层。Task 4 修复后三层才真正生效。

5. **模糊度评分尊重用户自主权：** 输入详细（评分<0.3）跳过提问；输入模糊（≥0.3）触发两轮提问。这比强制提问更优雅。

6. **两轮提问整合两个模块优点：** gatherer 的提问机制 + clarifier 的模糊度评分 + 对抗性建议。新建 TwoRoundQuestioner，不删除旧模块。

7. **acceptanceCriteria 字段贯通三层：** GoalStep → GoalParser 生成 → StepDependency → Orchestrator 传递 → 面板展示。这是验收标准可见化的基础。

8. **自主度枚举替代布尔：** auto/semi/manual 三档，每档明确行为（计划确认/工具确认/人工验收）。

9. **工期风险：** 架构统一层（Task 1-5）是大工程，预估 7 天；提问层（Task 6）2 天；事件+埋点+IPC（Task 7-9）3 天；UI 层（Task 10-13）4 天；演示层（Task 14-15）2 天。共 18 天，贴满截止日。建议 Task 1-5 优先执行，若超期则削减 Task 11/12 的细节展示。

10. **参赛素材同步收集：** Session ID、截图、视频、CHANGELOG 开发过程中收集，不可事后补。

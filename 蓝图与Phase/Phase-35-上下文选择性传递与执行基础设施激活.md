# Phase 35 — 上下文选择性传递与执行基础设施激活

> **版本目标：** v2.7.0
> **前置依赖：** Phase 32 完成（v2.4.0）—— **不依赖 Phase 33 或 34**
> **新增测试要求：** ≥ 18 个
> **研究依据：** 《实用型 Coding Agent 功能体系解构与自研项目构建指南》§3 选择性上下文传递、§4 Agent Harness 理论、§5 自验证体系
> **核心命题：** RouteDev 的基础设施已经接近"完整"，但有三个关键断层：多 Agent 的 Worker 收到未经过滤的完整对话历史（浪费 token）；HookRunner 系统写好了但从未通电（8 个事件类型零注册）；DurableExecutor 的 StepExecutor 是一个假桩（永远返回 success）。本 Phase 的目标不是写新功能，而是**让已写好的基础设施真正跑起来**。

---

## 并行执行分析：为什么 33/34/35 可以同时进行

三个 Phase 共享同一个前置（Phase 32），各自修改不同文件，无硬依赖：

| Phase | 核心修改面 | 与 35 的交叉 |
|-------|-----------|:---:|
| 33（设置补全） | desktop/renderer/、SettingsPage.tsx | 无 |
| 34（交互+检索） | CLI 渲染组件、search 工具、AuditLogger 追加 | 见下方"条件接入" |
| 35（执行基础设施） | worker-executor.ts、hooks.ts 接线、app-init.ts、durable-executor.ts | 自身 |

**共享文件 app-init.ts：** 三个 Phase 都会修改 `createAppDependencies()`，但各自改不同段落：
- Phase 33：添加新配置服务注入（goalVerifier/adversarial/updates/prompts 的 SettingsPage 绑定）
- Phase 34：添加 RepoMap 服务、TrajectoryCollector 实例化
- Phase 35：HookRunner 实例化 + 钩子注册 + StepExecutor 替换为真实实现

**合并策略：** 三者改 app-init.ts 的不同行区间，属于纯加法（新增依赖注入），git merge 时不会冲突。执行人在合并时按 Phase 编号顺序 merge 即可。

**条件接入（Phase 34 Task 5 ↔ Phase 35 Task 4）：** Phase 34 的"过程评测指标"在 AuditLogger 中追加 trajectory 级字段（totalTokens、toolCallCount 等），Phase 35 的"执行轨迹导出"读取 AuditLogger 的 JSONL 记录做聚合分析。两者可并行开发，但合并时需要验证：Phase 34 写入的字段名和 Phase 35 读取的字段名一致。建议在 Phase 35 Task 4 的 `TrajectoryExporter` 中定义明确的输入 schema（`interface TrajectoryRecord { ... }`），只要 Phase 34 的输出符合这个 schema，两边就能对接。

---

## 研究背景：从研究报告中提取的三个核心洞察

> 以下内容来自《实用型 Coding Agent 功能体系解构》的研究结论。不是标准答案，是思考素材。

### 洞察一：选择性上下文传递是 Token 节省的最大杠杆

报告引用了学术论文的实测数据：在多 Agent 场景下，给每个 Worker 只传递与其角色相关的上下文（而非完整对话历史），可以节省高达 97% 的 token 消耗。RouteDev 当前的问题是 `WorkerExecutor.execute()` 把完整的 `conversationHistory`（最多 20 条消息）原封不动传给每个 Worker——不管是写代码的 Worker、跑测试的 Worker、还是做代码审查的 Worker，收到的上下文完全一样。

这就好比一个项目经理给所有组员发了同一份 200 页的会议纪要，但实际上每个人只需要跟自己任务相关的 5 页。

### 洞察二：Agent Harness 理论——代码即 Agent

UIUC/Meta/Stanford 的研究提出了"Agent Harness"概念：Agent 的代码本身就是可执行、可检视、有状态的载体。RouteDev 已经具备了 Harness 的三大支柱（DurableExecutor 断点恢复、TraceCollector 全链路追踪、AuditLogger 操作审计），但有两根柱子是"空心"的：DurableExecutor 的执行器是假桩，HookRunner 从未通电。

### 洞察三：自验证应该是逐步的，不是最终一次

报告指出成熟的 Agent 系统采用"per-file-change verification"——每次文件变更后立即做轻量验证（语法检查、类型推断），而不是等所有步骤完成后才跑一次完整的 typecheck。RouteDev 的 CompletionGate 只在 `/goal` 完成后运行一次，中间步骤的文件变更没有任何即时验证。HookRunner 的 `post-tool-call` 事件天然适合这个用途，但目前零注册。

---

## Task 1：Worker 上下文选择性传递

### 现状问题

`worker-executor.ts:74-82` 的 `conversationHistory` 直接透传给 `agentLoop.run()`，无过滤。`chat-runner.ts:215` 和 `goal-runner.ts:252` 的硬上限是 20 条消息。多 Agent 路径下，每个 Worker 都收到完整的 20 条消息。

假设一个 goal 有 5 个步骤，其中 3 个 Worker 并行执行：
- 3 个 Worker × 20 条消息 = 60 条消息被 LLM 处理
- 但每个 Worker 实际上只需要跟自己的任务描述相关的上下文
- 如果能把每个 Worker 的上下文压缩到 3-5 条消息，token 节省可达 75-90%

### 设计方向

在 `WorkerExecutor` 中增加一个 `filterContext()` 方法，在传给 `agentLoop.run()` 之前对 `conversationHistory` 做角色感知过滤。

**三种过滤策略供选择（可以只用一种，也可以组合）：**

**策略 A：Tail + Blackboard 注入**
- 只保留最近 N 条消息（如 5 条）
- 把 Blackboard 中已完成步骤的结论作为额外上下文注入
- 优点：简单、可预测
- 缺点：可能丢失早期的重要上下文

**策略 B：关键词相关性过滤**
- 从 `task.description` 中提取关键词（文件名、函数名、概念）
- 保留包含这些关键词的消息，丢弃无关消息
- 优点：精准
- 缺点：关键词提取本身可能不准确，过滤太激进会丢失必要背景

**策略 C：Token 预算裁剪**
- 给每个 Worker 设置 token 上限（如 4000 tokens）
- 从最新消息开始向前累积，超出预算则停止
- 优点：token 消耗可控
- 缺点：不考虑内容相关性

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| WorkerExecutor.execute() | `(task: WorkerTask, llmClient: ILLMClient, routeDecision: RoutingResult, conversationHistory: LLMMessage[], baseSystemPrompt: string, signal?: AbortSignal, onConfirmTool?: ConfirmToolCallback) => Promise<WorkerResult>` | worker-executor.ts:39-47 | ✅ 已验证 |
| WorkerTask 类型 | `{ stepId: string, description: string, role: string, rolePrompt?: string, blackboardSnapshot: BlackboardSnapshot }` | execution-orchestrator.ts 定义 | ✅ 已验证 |
| formatBlackboard() | 私有方法，line 148-170，输出 goal + completedSteps + projectFacts | worker-executor.ts:148 | ✅ 已验证 |
| conversationHistory 传递 | `conversationHistory` 直接传入 `agentLoop.run()`，无任何过滤 | worker-executor.ts:74-82 | ✅ 已验证 |
| Blackboard.getSnapshot() | 返回深拷贝，Worker 修改不影响主 Blackboard | blackboard.ts:70 | ✅ 已验证 |

### 需要你决定的

1. **策略选择：** 三种策略各有利弊。策略 A 最简单、策略 B 最精准、策略 C 最可控。你的实际项目场景中，Worker 最需要什么上下文？建议读一下 `src/agent/multi/worker-executor.ts` 和 `src/agent/multi/blackboard.ts`，看看 Blackboard 中已有哪些结构化数据——如果 Blackboard 的 `completedSteps` 已经包含了足够的"前序工作总结"，策略 A（Tail + Blackboard）可能是投入产出比最高的。

2. **配置开关：** 是否需要在 schema.ts 中加一个 `optimization.workerContext` 配置块？比如 `strategy: 'tail' | 'keyword' | 'budget'`、`maxMessages: 5`、`maxTokens: 4000`。还是先用最简单的方式硬编码，等实际使用后再接配置？

3. **向后兼容：** 如果过滤后的上下文不够用，Worker 的执行质量会下降。是否需要一个"完整上下文回退"机制——比如过滤后 Worker 执行失败时，自动用完整历史重试？还是接受偶尔的质量下降作为 token 节省的代价？

4. **测试验证：** 如何证明过滤后的上下文没有降低 Worker 的执行质量？一个思路是写两组对比测试：同一个 goal plan，分别用完整上下文和过滤后上下文执行，比较 Worker 输出。但这种测试依赖 LLM 调用，不稳定。另一个思路是单元测试过滤逻辑本身——验证过滤结果包含必要消息、不包含噪声消息。

### 验收标准

- [ ] `WorkerExecutor` 有 `filterContext()` 方法，在 `execute()` 内部被调用
- [ ] 过滤策略可配置（至少在 schema.ts 中有对应的配置字段）
- [ ] 过滤后的消息数组仍然包含当前 userMessage（task.description 不受影响）
- [ ] Blackboard 的 `completedSteps` 信息在过滤后仍然可访问（通过 systemPrompt 注入）
- [ ] ≥ 6 个单元测试

---

## Task 2：HookRunner 生产激活与文件变更验证

### 现状问题

`src/agent/hooks.ts` 定义了 8 个事件类型和完整的 `HookRunner` 类（优先级排序、错误隔离、结果合并），但：
- `app-init.ts` 中没有创建 `HookRunner` 实例
- `DurableExecutor` 构造时没有传入 `hookRunner`
- 全代码库零个 `HookDefinition` 被注册
- `fireHook()` 在无 hookRunner 时静默返回 `{ action: 'continue' }`（hooks.ts:766-794）

这意味着 hooks.ts 的全部代码——包括 Phase 31 设计的 `pre-tool-call`、`post-tool-call`、`on-session-start`、`on-session-end` 四个事件——都是死代码。

### 设计方向

**第一步：激活 HookRunner**

在 `app-init.ts` 的 `createAppDependencies()` 中：
1. 创建 `HookRunner` 实例
2. 传入 `DurableExecutor` 的构造参数
3. 传入 `TraceCollector`（用于记录 hook 执行的 span）

**第二步：注册内置验证钩子**

创建 `src/hooks/built-in.ts`，注册以下内置钩子：

**钩子 1：Post-File-Change Syntax Check（post-tool-call）**
- 触发条件：`toolName` 为 `file_write` 或 `file_edit`
- 行为：对修改的文件运行轻量语法检查（不是完整的 CompletionGate——那个太重了）
- 检查方式选择：
  - 方案 A：`node -e "require('fs').readFileSync(path, 'utf8')"` + 简单正则检查（如 JSON 文件验证 JSON.parse）
  - 方案 B：TypeScript 项目用 `tsc --noEmit <file>` 做单文件类型检查
  - 方案 C：只检查文件是否可读（`fs.access`）+ 文件大小是否合理
- 如果检查失败：返回 `{ action: 'continue', message: '⚠️ 文件语法可能有错误: ...' }`，让 Agent 在下一次推理时看到警告
- 注意：**不返回 abort**——文件语法错误不严重到要中止任务，只是一个提醒

**钩子 2：Session Lifecycle Logger（on-session-start / on-session-end）**
- on-session-start：记录 `AuditLogger` 条目（action: `session_start`），包含 `sessionId`、`cwd`、`modelId`
- on-session-end：记录 `AuditLogger` 条目（action: `session_end`），包含 `durationMs`、`totalTokens`（如果有的话）
- 这是最轻量的钩子，目的是让审计日志有会话级生命周期事件

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| HookRunner 构造函数 | `constructor(trace?: TraceCollector)` | hooks.ts:135 | ✅ 已验证 |
| HookRunner.register() | `(hook: HookDefinition) => void` | hooks.ts 约 line 150 | ✅ 已验证 |
| HookRunner.fire() | `(event: HookEvent, context: HookContext) => Promise<HookResult>` | hooks.ts:197 | ✅ 已验证 |
| HookEvent 类型 | `'pre-step' \| 'post-step' \| 'on-error' \| 'on-complete' \| 'pre-tool-call' \| 'post-tool-call' \| 'on-session-start' \| 'on-session-end'` | hooks.ts:35-43 | ✅ 已验证 |
| HookContext 接口 | `{ stepId, agentId, stepResult?, error?, projectPath, toolName?, toolArgs?, toolResult?, toolDuration? }` | hooks.ts:46-65 | ✅ 已验证 |
| HookResult 接口 | `{ action: 'continue'\|'abort'\|'retry'\|'skip', message?, modifiedResult?, modifiedToolResult? }` | hooks.ts:90-103 | ✅ 已验证 |
| DurableExecutorOptions.hookRunner | `hookRunner?: HookRunner`（可选字段） | durable-executor.ts:74-87 | ✅ 已验证 |
| fireHook() 降级 | 无 hookRunner 时返回 `{ action: 'continue' }` | durable-executor.ts:766-794 | ✅ 已验证 |

### 需要你决定的

1. **语法检查的深度：** 三种方案从轻到重。方案 C（fs.access + 大小检查）几乎零成本但价值有限；方案 B（tsc --noEmit 单文件）最有用但可能很慢（TypeScript 编译器启动就要 1-2 秒）。你在实际使用中，Agent 写出的文件有多大概率有语法错误？如果 Agent 主要做结构化编辑（file_edit 的 oldString/newString 替换），语法错误其实很少见——这种情况下方案 C 就够了。

2. **是否需要更多内置钩子：** 除了文件变更验证和会话生命周期，还有什么场景适合用钩子？比如：
   - `pre-tool-call` 做工具调用频率限制（防止 Agent 在短时间内调用同一个工具几十次）
   - `post-step` 做步骤级 token 审计（单步消耗超过预算时发出警告）
   - 但每多一个钩子就多一份运行时开销和代码复杂度。先做最小必要集合，后续按需添加是否更合理？

3. **钩子注册的扩展性：** 内置钩子硬编码在 `src/hooks/built-in.ts` 中，但未来用户可能想通过 `HookPlugin` 注册自定义钩子。内置钩子的优先级应该设多少？（HookRunner 按 priority 升序执行，默认 100）建议内置钩子用较低优先级（如 50），让插件钩子可以排在后面。

### 验收标准

- [ ] `app-init.ts` 中创建 `HookRunner` 实例并传入 `DurableExecutor`
- [ ] `src/hooks/built-in.ts` 至少注册 2 个内置钩子（post-tool-call 文件验证 + session 生命周期）
- [ ] 内置钩子的 `post-tool-call` 钩子在 `file_write`/`file_edit` 后执行轻量验证
- [ ] 验证失败时返回 `continue` + 警告消息，不中止任务
- [ ] session 生命周期钩子写入 AuditLogger
- [ ] ≥ 5 个单元测试

---

## Task 3：DurableExecutor 真实接线与会话恢复

### 现状问题

`app-init.ts:379-389` 的 `StepExecutor` 是一个假桩：

```
// 当前代码（假桩）
const durableStepExecutor: StepExecutor = {
  async execute(step: PlanStep, _goal: string): Promise<StepResult> {
    return { success: true, output: `步骤 ${step.id} 已执行: ${step.description}`, durationMs: 0 };
  },
};
```

这意味着：
- `/resume` 命令可以列出可恢复的执行，但"恢复执行"实际上不会真的运行 Agent Loop
- `DurableExecutor` 的快照保存、断点恢复、并行组执行等全部能力都是空中楼阁
- 同时，`DurableExecutor` 没有接收 `hookRunner`，所以即使假桩替换了，钩子系统也不会生效

### 设计方向

**第一步：实现真实的 StepExecutor**

创建一个 `AgentLoopStepExecutor`，把 `DurableExecutor` 的 `PlanStep` 转化为 Agent Loop 的一次执行：

- 从 `app-init.ts` 的依赖中获取 `agentLoop`、`llmClientManager`、`modelRouter`、`classifier`、`toolExecutor` 等
- `execute(step, goal)` 的逻辑：
  1. 用 `classifier.classify()` 对 `step.description` 分类，得到 tier
  2. 用 `modelRouter.route()` 选择模型
  3. 构建 systemPrompt（可以复用 main.system 模板，注入 step 上下文）
  4. 调用 `agentLoop.run()` 执行
  5. 收集输出、提取 modifiedFiles、返回 StepResult

**需要注意的边界问题：**
- Agent Loop 是 AsyncGenerator（流式事件），StepExecutor 需要同步收集所有事件后返回结果
- 单次 step 执行应该有独立的 AbortSignal（不跟随全局 abort）
- step 执行的 conversationHistory 应该是空数组或只包含 goal 描述（不复用主对话历史）——这与 Task 1 的 Worker 上下文过滤是独立的逻辑

**第二步：传入 HookRunner**

在 `DurableExecutor` 构造时传入 Task 2 创建的 `HookRunner`，使 `runStepWithHooks()` 真正生效。

**第三步：会话启动时检查可恢复执行**

在 `App.tsx` 或 `app-init.ts` 的初始化流程中：
1. 调用 `durableExecutor.listRecoverable()`
2. 如果有 `paused` 或 `failed` 状态的快照：
   - CLI 模式：打印提示 "发现未完成执行：{goal}，输入 /resume 恢复"
   - Desktop 模式：弹出提示框（如果 Desktop 有通知系统的话）
3. **不自动恢复**——只提示，让用户决定

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| StepExecutor 接口 | `{ execute(step: PlanStep, goal: string): Promise<StepResult> }` | durable-executor.ts:68-71 | ✅ 已验证 |
| PlanStep 类型 | 需确认——从 goal-parser 或 goal-types 获取 | goal-types.ts | ⚠️ 需执行人确认 |
| DurableExecutor.start() | `(plan: PlanStep[], goal: string, parallelGroups?: number[][]) => Promise<ExecutionResult>` | durable-executor.ts:149 | ✅ 已验证 |
| DurableExecutor.resumeFrom() | `(planId: string) => Promise<ExecutionResult>` | durable-executor.ts:184 | ✅ 已验证 |
| DurableExecutor.listRecoverable() | `() => ExecutionSnapshot[]`（同步版）+ `async () => ExecutionSnapshot[]`（异步版 line 291） | durable-executor.ts:252,291 | ✅ 已验证 |
| ExecutionSnapshot 接口 | `{ planId, goal, startedAt, lastStepCompleted, totalSteps, status, completedResults, nextStep, remainingSteps?, updatedAt }` | durable-executor.ts:29-50 | ✅ 已验证 |
| runStepWithHooks() | 私有方法，line 672-761，pre-step → execute → on-error → post-step | durable-executor.ts:672 | ✅ 已验证 |
| makeHookContext() | 私有方法，line 799-812 | durable-executor.ts:799 | ✅ 已验证 |

### 需要你决定的

1. **StepExecutor 的复杂度：** 真实的 StepExecutor 需要注入至少 5 个依赖（agentLoop、llmClientManager、modelRouter、classifier、toolExecutor）。这会让 `createAppDependencies()` 的装配逻辑更复杂。一个替代方案是让 StepExecutor 只做"薄代理"——调用一个已有的函数（如 `goal-runner.ts` 中的 step 执行逻辑），避免重复实现 Agent Loop 调用链。你看一下 `goal-runner.ts` 中执行单个 step 的代码（大约在 line 170-240 之间），是否可以提取成一个可复用的函数？

2. **conversationHistory 隔离：** StepExecutor 每次执行 step 时，conversationHistory 应该是空数组（每个 step 从零开始）还是包含前序 step 的摘要？前者简单但 Agent 不知道前序发生了什么；后者需要某种 step 间信息传递机制（Blackboard？CheckpointWriter 的摘要？）。这个决策和 Task 1 的 Worker 上下文过滤是平行的问题，但解法可以不同。

3. **是否启用自动恢复：** 启动时只提示 vs 自动恢复最近一次 paused 执行。自动恢复的风险在于：如果上次执行是因为某个环境问题（如网络不通）而 paused，恢复后可能立即再次失败。但如果用户明确知道自己想恢复，`/resume` 命令已经够用了。你觉得"只提示"是否足够？

### 验收标准

- [ ] `app-init.ts` 中 `StepExecutor` 替换为真实实现（不再是假桩）
- [ ] 真实 StepExecutor 通过 `agentLoop.run()` 执行 step，能实际修改文件
- [ ] `DurableExecutor` 构造时接收 `HookRunner`（Task 2 创建的实例）
- [ ] 应用启动时调用 `listRecoverable()` 并在有可恢复执行时显示提示
- [ ] `/resume` 命令的恢复执行能真正运行 Agent Loop
- [ ] ≥ 4 个单元测试

---

## Task 4：执行轨迹导出与聚合分析

### 现状问题

RouteDev 的审计和追踪数据分散在三个独立系统中：
- `AuditLogger`：JSONL 格式的操作记录（17 种 AuditAction）
- `TraceCollector`：7 种 Span 类型的执行追踪
- `TokenTracker`：多维度 token 归因（byModel/byAgent/byStep）

这三者通过 `sessionId` 关联，但没有统一的"导出一条完整执行轨迹"的 API。想做跨会话分析（比如"本周所有 goal 任务的平均 token 消耗"）需要手动解析 JSONL 文件。

### 与 Phase 34 Task 5 的边界

Phase 34 Task 5 做的是**单任务级**的过程指标——一次 goal 执行中的 token/工具调用/LLM 调用/重试次数，写入 AuditLogger。

本 Task 做的是**跨任务级**的聚合分析——从已有的 AuditLogger + TraceCollector 数据中，提取和分析多条轨迹。

打个比方：Phase 34 是给每场比赛写一份详细的技术统计；本 Task 是做赛季数据分析。

### 设计方向

**TrajectoryExporter**（`src/observability/trajectory-exporter.ts`）：

- 输入：`sessionId`（可选，不传则导出最近的 N 个会话）
- 输出：`TrajectoryBundle` 对象，包含：
  - `auditRecords: AuditRecord[]` — 该会话的所有审计记录
  - `spans: TraceSpan[]` — 该会话的所有 span
  - `tokenSummary: TokenStats` — token 使用汇总
  - `goalSummary?: { goal, status, durationMs, stepCount }` — 如果有的话

**TrajectoryAggregator**（`src/observability/trajectory-aggregator.ts`）：

- 输入：`TrajectoryBundle[]`（多条轨迹）
- 输出：`AggregatedMetrics`，包含：
  - `totalSessions: number`
  - `avgTokensPerSession: number`
  - `avgDurationPerGoal: number`
  - `successRate: number`（completed / total）
  - `topToolsByUsage: Array<{ toolName, callCount }>`
  - `modelUsageBreakdown: Record<string, number>`（按模型的 token 分布）

**用户入口：** `/trajectory` 命令（或扩展现有的 `/trace` 命令）
- `/trajectory export [sessionId]` — 导出单条轨迹为 JSON
- `/trajectory summary` — 显示最近 10 个会话的聚合指标

### 接口对齐表

| 接口 | 签名 | 文件:行 | 验证状态 |
|------|------|---------|:---:|
| AuditLogger.listToday() | `(limit?: number) => AuditRecord[]` | audit-logger.ts:150 | ✅ 已验证 |
| AuditLogger.listByAction() | `(action: AuditAction) => AuditRecord[]` | audit-logger.ts:181 | ✅ 已验证 |
| TraceSession 接口 | `{ id, startTime, endTime, goalId, userInput, routeDecision, totalUsage, spanCount, completed }` | trace-types.ts:7 | ✅ 已验证 |
| TokenTracker.getStats() | `() => TokenStats`，含 total/byModel/byAgent/byStep 分层 | tracker.ts:146 | ✅ 已验证 |
| TraceCollector 存储 | `<APPDATA>/traces/<YYYY-MM-DD>/<sessionId>.trace.jsonl` | trace-collector.ts | ✅ 已验证 |
| AuditLogger 存储 | `<APPDATA>/audit/<YYYY-MM-DD>/<sessionId>.audit.jsonl` | audit-logger.ts | ✅ 已验证 |

### 需要你决定的

1. **数据读取方式：** AuditLogger 和 TraceCollector 各自写入独立的 JSONL 文件。TrajectoryExporter 需要读取这些文件。问题是：
   - 直接读文件（简单但需要知道文件路径模式）
   - 通过已有的 `listToday()` / `listByAction()` 方法（已有但不支持按 sessionId 过滤）
   - 给 AuditLogger 和 TraceCollector 各加一个 `listBySession(sessionId)` 方法（更干净但改动更大）
   建议看看 `audit-logger.ts` 的 `listByAction()` 实现，判断加一个 `listBySession()` 是否简单。

2. **聚合粒度：** "赛季数据"应该覆盖多大范围？最近 7 天？30 天？全部历史？如果用户的审计日志超过 30 天会被 `cleanup()` 删除（`retentionDays: 30`），那聚合数据的有效期也是 30 天。这是否够用？

3. **是否有实际用户需要这个功能：** `/trace` 命令已经有 `sessions` / `view` / `audit` 三个子命令。`/trajectory` 是否真的有用，还是只是在"看起来很厉害"？如果目前的目标用户（CLI 开发者）更关心单次任务的质量而非长期趋势，这个 Task 的优先级可以降低。

### 验收标准

- [ ] `TrajectoryExporter` 能导出单个会话的完整轨迹（审计 + 追踪 + token）
- [ ] `TrajectoryAggregator` 能计算跨会话的聚合指标
- [ ] 至少一个 CLI 入口（`/trajectory` 或扩展 `/trace`）
- [ ] 导出格式为 JSON，可被外部工具解析
- [ ] ≥ 3 个单元测试

---

## Task 5：集成测试与文档同步

### 测试矩阵

| 测试文件 | 测试内容 | 数量 |
|----------|---------|:---:|
| `tests/phase35/worker-context-filter.test.ts` | Worker 上下文过滤逻辑：tail/keyword/budget 策略、边界条件（空历史、超长历史）、Blackboard 注入 | ≥ 6 |
| `tests/phase35/hook-activation.test.ts` | HookRunner 接线验证：内置钩子注册、post-tool-call 文件验证触发、session 生命周期记录、钩子错误隔离 | ≥ 5 |
| `tests/phase35/durable-wiring.test.ts` | StepExecutor 真实实现、DurableExecutor + HookRunner 集成、listRecoverable 启动提示 | ≥ 4 |
| `tests/phase35/trajectory.test.ts` | TrajectoryExporter 导出完整性、TrajectoryAggregator 计算正确性 | ≥ 3 |

### 文档同步

- **AGENTS.md 陷阱更新：** 新增 #45-48（见下方"陷阱预告"）
- **CODEMAP.md：** 新增 `src/hooks/built-in.ts`、`src/observability/trajectory-exporter.ts`、`src/observability/trajectory-aggregator.ts`
- **CHANGELOG.md：** v2.7.0 条目
- **package.json：** 版本号升级到 v2.7.0

### 验收标准

- [ ] 全部测试通过（≥ 18 个）
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] AGENTS.md 新增陷阱 #45-48
- [ ] CODEMAP.md / CHANGELOG.md 已更新

---

## 陷阱预告（写入 AGENTS.md）

**#45 HookRunner 在 app-init.ts 中必须传入 TraceCollector：** `new HookRunner(trace)` 构造函数接受可选的 `TraceCollector` 参数。如果不传，钩子执行不会产生 span 记录。`DurableExecutor` 构造时也必须传入同一个 `hookRunner` 实例，否则 `runStepWithHooks()` 会走降级路径（`fireHook` 返回 continue）。禁止创建不带 trace 的 HookRunner。

**#46 DurableExecutor 的 StepExecutor 不再是假桩：** Phase 35 之前的 `durableStepExecutor` 永远返回 `{ success: true }`。Phase 35 替换为 `AgentLoopStepExecutor`，真正调用 `agentLoop.run()`。如果有人在做 Phase 35 之前的代码回退，需要知道旧桩的行为（永远成功、零耗时、空输出）和新的真实执行器的行为完全不同。

**#47 Worker 上下文过滤发生在 execute() 内部，不在调用方：** `WorkerExecutor.execute()` 内部调用 `filterContext()` 过滤 `conversationHistory`，调用方（`ExecutionOrchestrator`）不需要也不应该预先过滤。如果调用方也过滤了一次，会导致双重过滤，Worker 收到的上下文可能过少。

**#48 TrajectoryExporter 读取的是已持久化的 JSONL，不是内存数据：** `AuditLogger` 和 `TraceCollector` 都有内存缓冲和异步写入（TraceCollector 100ms flush、AuditLogger 同步写入）。`TrajectoryExporter` 从磁盘读取 JSONL 文件时，最近的记录可能还没 flush。如果导出的是"刚刚结束的会话"，需要先等 flush 完成或从内存缓冲中补充。

---

## 思考引导汇总

以下是需要执行人读代码后做出判断的问题清单（不强制答案）：

| # | 问题 | 关联 Task | 建议阅读的代码 |
|---|------|:---:|------|
| 1 | Worker 上下文用哪种过滤策略？Tail+Blackboard 是否足够？ | Task 1 | worker-executor.ts + blackboard.ts |
| 2 | 过滤后 Worker 失败时是否用完整上下文重试？ | Task 1 | execution-orchestrator.ts 多 Agent 路径 |
| 3 | 文件变更验证的深度：fs.access 够用还是需要 tsc？ | Task 2 | file-write.ts + file-edit.ts 的修改模式 |
| 4 | 内置钩子的优先级应该设多少？ | Task 2 | hooks.ts 的 priority 机制 |
| 5 | StepExecutor 是薄代理（调用 goal-runner 逻辑）还是独立实现？ | Task 3 | goal-runner.ts step 执行段 vs durable-executor.ts |
| 6 | step 间 conversationHistory 是隔离还是继承？ | Task 3 | goal-runner.ts 的 conversationHistoryRef 管理 |
| 7 | 轨迹导出是独立命令还是扩展 /trace？ | Task 4 | commands/trace.ts 的现有子命令结构 |

# RouteDev 全量审查报告

> **审查日期：** 2026-06-19
> **审查范围：** 整个代码库（v2.3.0）+ Phase 31 设计文档真实性核验 + 必要性权衡
> **审查方法：** 4 个并行 Explore Agent 深度审查 + 接口对齐表逐项核实 + Phase 31 实现状态验证

---

## 审查总结

RouteDev 是一个架构成熟、测试覆盖良好的 TypeScript CLI Agent 项目（~1735 测试 / 143 文件）。代码质量整体中上，无硬编码凭据、无数据丢失风险。**核心问题不在代码质量，而在"设计文档与实际代码的脱节"**——Phase 31 描述的 8 个模块全部被实现并测试，但零个被接入生产路径，是 100% 的死代码。Phase 31 接口对齐表中约 1/3 的声明已过时或不准确。安全防护层（ReadTracker、ToolResultSanitizer、CompletionGate）同样已实现但未通电。

**一句话判断：** 代码可以正常运行，但 Phase 31 描述的统一工作流编排功能实际不存在。需要先解决"接线"问题，再讨论后续迭代。

---

## Critical（立即修复）

### C1. Phase 31 全部 8 个模块是死代码——未接入任何生产路径

| Phase 31 模块 | 文件存在 | 测试存在 | 生产路径导入 | 实际状态 |
|---|:---:|:---:|:---:|---|
| TaskOrchestrator | ✅ | ✅ (27 tests) | ❌ | 死代码 |
| RequirementsGatherer | ✅ | ✅ | ❌ | 死代码 |
| TaskComplexityAnalyzer | ✅ | ✅ | ❌ | 死代码 |
| ExecutionOrchestrator | ✅ | ✅ | ❌ | 死代码 |
| UnifiedReviewer | ✅ | ✅ | ❌ | 死代码 |
| ReadTracker | ✅ | ✅ | ❌ | 死代码 |
| ToolResultSanitizer | ✅ | ✅ | ❌ | 死代码 |
| CompletionGate | ✅ | ✅ | ❌ | 死代码 |

**影响：** `unifiedPipeline` 配置项已在 schema.ts 和 defaults.ts 中定义（默认 `true`），但没有任何代码读取它。用户无论怎么配置都不会触发统一流水线。`App.tsx` 的 `handleSubmit`（line 382-383）将所有非命令输入直接送到 `chatRunnerRef.current.runChat(text)`，完全绕过 TaskOrchestrator。

**结论：** Phase 31 的"执行"只完成了代码编写和单元测试，缺少最关键的"接线"步骤——把新模块接入 App.tsx 分发路径、chat-runner/goal-runner 调用链、以及 loop.ts 的工具执行管道。

### C2. 安全防护层全部未通电

以下安全机制已实现但从未在生产路径中调用：

| 安全模块 | 用途 | 实际调用情况 |
|---|---|---|
| `ReadTracker`（src/tools/read-tracker.ts） | 先读后写强制 | 未被 file_write/file_edit/file_read 导入 |
| `ToolResultSanitizer`（src/tools/result-sanitizer.ts） | Prompt Injection 检测 + 智能截断 | 未被 loop.ts 导入 |
| `filterSensitiveFields()`（security-enhanced.ts:373） | API Key 脱敏 | 全代码库零导入 |
| `CompletionGate`（src/agent/completion-gate.ts） | 独立代码验证（typecheck/lint/tests） | 未被任何审查流程调用 |

**影响：** 工具返回的内容（file_read、shell_exec）直接注入 LLM 上下文，无任何内容过滤。恶意文件中的 Prompt Injection 模式会不受阻碍地到达 LLM。agents.md 陷阱 #27-30 描述的安全机制在运行时不存在。

---

## Important（继续前建议修）

### I1. Token 任务预算双计数 Bug

`TokenTracker` 中 `record()`（line 97-99）和 `recordTaskUsage()`（line 241）**各自独立累加** `this.taskSpent`。如果调用方对同一 LLM 调用同时触发两者（这是自然用法），任务预算会被双计数。line 239 的注释声称"decoupled from record()"，但 `record()` 仍保留了 taskSpent 累加逻辑。

**文件：** `src/router/tracker.ts:97-99` + `:241`

### I2. goal-runner 不调用 checkBudget()

`chat-runner.ts` 在 line 161 调用 `tracker.checkBudget()` 进行预算检查，但 `goal-runner.ts` 完全不调用此方法。长时间运行的 goal 计划可以无限消耗 token 而不触发任何预算警告或中止。

**文件：** `src/cli/goal-runner.ts`（全文无 `checkBudget` 引用）

### I3. ClassificationInput.context 是死代码

`ClassificationInput` 定义了 `context?: { projectType?, recentTools?, hasGitChanges? }` 三个字段，但 `ScenarioClassifier.classify()` 从不读取这些字段。调用方可以传入任意 context 值，分类结果不受影响。

**文件：** `src/router/types.ts:114-121` + `src/router/classifier.ts:40`

### I4. GuardedToolExecutorAdapter 缺少 executeToolStructured()

`GuardedToolExecutorAdapter`（work-modes.ts:206）实现了 `ToolExecutorAdapter` 接口，但没有实现可选方法 `executeToolStructured()`。当 Agent Loop 的并行执行路径检查 `typeof this.toolExecutor.executeToolStructured === 'function'`（loop.ts:289）时，结果为 `false`，退化为基于正则的 `isError` 检测。这意味着启用 WorkMode 守卫后，并行工具执行的错误检测精度下降。

**文件：** `src/agent/work-modes.ts:206-240`

### I5. 核心运行时模块零测试覆盖

以下模块是核心运行时组件，但没有直接的单元测试：

| 模块 | 文件 | 角色 |
|---|---|---|
| App.tsx | `src/cli/App.tsx` | 主 UI 组件和输入分发 |
| chat-runner.ts | `src/cli/chat-runner.ts` | 聊天处理核心路径 |
| goal-runner.ts | `src/cli/goal-runner.ts` | goal 执行核心路径 |
| app-init.ts | `src/cli/app-init.ts` | 依赖装配工厂 |

这些模块只能通过集成测试间接覆盖。一旦重构（如接入 Phase 31 模块），缺少直接测试会导致回归风险。

### I6. DreamConsolidator 的 compactor 选项未传入

`app-init.ts` line 181 创建 `DreamConsolidator` 时未传入 `compactor` 选项，导致 DreamConsolidator 内部的增强压缩路径在生产中从不执行。ContextCompactor 本身在 app-init.ts:153 被实例化并传给 ContextManager，但 DreamConsolidator 拿不到它。

**文件：** `src/cli/app-init.ts:181`

---

## Minor（记录后续处理）

### M1. App.tsx 命令数注释过时

line 94 注释写 "26 commands" 但实际注册了 29 个（Phase 31 Task 7.3 已添加 memoryCommand、permissionsCommand、configCommand）。

### M2. GoalParser token 使用量被丢弃

`GoalParser.parseAndBuildPlan()`（line 96）的 `_usage` 参数标记为未使用，LLM 调用的 token 消耗不会被任何 tracker 记录。

### M3. perRequestLimit 检查的时序依赖

`checkBudget()` 检查 perRequestLimit 时只看 `records` 数组的最后一条（tracker.ts:206-215）。如果在违规请求和 checkBudget() 调用之间又添加了新记录，检查可能会漏掉。

---

## Phase 31 接口对齐表核验结果

对 Phase 31 文档中的 24 项接口声明逐项核实：

| 结果 | 数量 | 占比 |
|------|:---:|:---:|
| PASS（完全准确） | 15 | 63% |
| PARTIAL（大体正确但细节有误） | 5 | 21% |
| FAIL（关键声明错误） | 4 | 17% |

### FAIL 项（必须修正文档）

| # | 声明 | 实际情况 |
|---|------|---------|
| 11 | CommandRegistry "26 个已注册命令，3 个未注册" | **实际 29 个已注册**，3 个已在 Phase 31 Task 7.3 注册。声明已过时 |
| 12 | HookRunner.fire() 在 hooks.ts:150，4 个事件 | fire() 实际在 **line 197**，line 150 是 `register()`。事件数已扩展到 **8 个**（Phase 31 Task 6.7 新增了 pre/post-tool-call、on-session-start/end） |
| 15 | GoalParser.parse() 在 goal-parser.ts:37 | parse() 实际在 **line 54**。line 37 是 REQUIREMENTS_CONTEXT_TEMPLATE 常量 |
| 21 | checkBudget() 在 tracker.ts:133-158，只检查 dailyLimit | checkBudget() 实际在 **lines 179-218**。已同时检查 dailyLimit **和** perRequestLimit（Phase 31 Task 6.3 已修复） |

### PARTIAL 项

| # | 声明 | 差异 |
|---|------|------|
| 4 | createChatRunner deps 含 19 个字段 | 实际 20 个字段（含 profiler?） |
| 7 | Blackboard "8 个方法" | 8 个方法 + 1 个 getter (entryCount) |
| 16 | GoalVerifier.verify() 签名 `(plan, gates, stepResults)` | 实际签名 `(plan, options: GoalVerifierOptions, gates?)` — 第二参数类型和第三参数位置都不同 |
| 22 | 工具注入路径 loop.ts:301-321 | 实际并行路径 lines 307-329，"无内容过滤"声明准确 |
| 23 | 错误处理 loop.ts:460-478 | catch 块起始 line 468，行为描述准确 |

### 不一致项核验

| 不一致声明 | 判定 | 说明 |
|---|---|---|
| Orchestrator 未接入 goal-runner | **仍为真** | goal-runner 全文无 Orchestrator 引用 |
| chat-runner 不传 context 给 classifier | **仍为真** | line 73: `classify({ query: text })` 无 context |
| 3 个命令未注册 | **已修复** | Phase 31 Task 7.3 已注册全部 3 个 |
| ComposePipeline requirements 无用户交互 | **仍为真** | LLM 读代码后自动推进，无确认步骤 |
| perRequestLimit 从未检查 | **已修复** | checkBudget() lines 204-215 已检查 |
| filterSensitiveFields 未在工具路径调用 | **仍为真** | 全代码库零导入 |
| goal-runner 不调用 checkBudget | **仍为真** | 零引用 |

---

## Phase 31 各 Task 必要性权衡

### Task 1：TaskOrchestrator 核心状态机 — 必要但需要接线

**判定：必要。** 当前 App.tsx 的 `handleSubmit` 是硬编码的 5 级优先级链，没有意图分类能力。TaskOrchestrator 的四类 intent 分发（quick_answer/development/explicit_goal/planning）是合理的架构改进。Steering Queue 解决了 Agent 执行时用户无法介入的体验问题。

**但现状是：** 代码写好了、测试有了，就是没接进 App.tsx。Phase 31 文档声称"TaskOrchestrator 是 App.tsx 的新调度层"，但实际代码中 App.tsx 完全不知道它的存在。**这不是设计问题，是执行遗漏。**

### Task 2：需求确认 — 必要但可简化

**判定：必要。** 当前 `/goal` 命令直接执行、不跟用户确认需求理解是否一致，这是一个真实的体验缺口。但自动确认/主动追问的双策略可能过度设计——先只做自动确认（LLM 生成摘要 → 用户 y/n）就够了，主动追问可以后续迭代。

### Task 3：任务分解与复杂度评估 — 必要

**判定：必要。** GoalParser 已有 3-8 步分解能力，TaskComplexityAnalyzer 的"规则层 + LLM 层"混合评估是务实的设计。needsSubAgent 决策逻辑合理（complex 或 medium+多文件时才用子 Agent）。

### Task 4：执行编排 — 必要且设计优秀

**判定：必要。** 这是激活 Orchestrator/WorkerExecutor/Blackboard 这三个已有但未用基础设施的关键 Task。单 Agent 串行 vs 多 Agent 并行的自适应切换是项目最有价值的架构升级。有序发射（4.6）是对 LLM 理解友好的正确设计。

### Task 5：统一审查与验收 — 必要

**判定：必要。** GoalVerifier + reviewer Worker 的双层验证是合理的。CompletionGate（独立运行 typecheck/lint/tests）是 Claude 建议中最有价值的部分——不信任 LLM 自评，用硬性验证门兜底。

### Task 6：生产安全防护 — 最必要但最没接入

**判定：最必要。** ReadTracker、ToolResultSanitizer、CompletionGate、Token 熔断、FailureReport 都是真实需要。但讽刺的是，这些是离"接线"最远的模块——零个被导入到生产路径。其中：

- ReadTracker 的 fs.access() 例外检查合理
- ToolResultSanitizer 的"不删内容只加警告"策略正确
- 智能截断的错误优先保留（6.6）优于简单头+尾
- 扩展钩子（6.7）的 retry 无限递归风险已在文档中警告

### Task 7：集成测试与文档同步 — 部分完成

**判定：测试已写，但接线测试缺失。** 12 个集成测试场景在文档中列出，phase31-workflow.test.ts 已存在。但所有测试都是在隔离环境中测试模块本身，没有测试"App.tsx 收到用户输入 → TaskOrchestrator 分发 → 各模块协作"的端到端路径。文档同步（AGENTS.md 陷阱）已完成。

---

## 死代码清单

按严重程度排序：

| 模块 | 文件 | 行数 | 测试数 | 死代码原因 |
|---|---|:---:|:---:|---|
| TaskOrchestrator | task-orchestrator.ts | ~300 | 27 | 未接入 App.tsx |
| ExecutionOrchestrator | execution-orchestrator.ts | ~350 | 多 | 未被 TaskOrchestrator 调用 |
| RequirementsGatherer | requirements-gatherer.ts | ~200 | 多 | 未被 TaskOrchestrator 调用 |
| TaskComplexityAnalyzer | complexity-analyzer.ts | ~200 | 多 | 未被 TaskOrchestrator 调用 |
| UnifiedReviewer | unified-reviewer.ts | ~200 | 多 | 未被任何流程调用 |
| CompletionGate | completion-gate.ts | ~150 | 多 | 未被审查流程调用 |
| ReadTracker | read-tracker.ts | ~130 | 多 | 未被任何工具导入 |
| ToolResultSanitizer | result-sanitizer.ts | ~210 | 多 | 未被 loop.ts 导入 |
| Task 级 Token 预算 | tracker.ts startTask/recordTaskUsage/endTask | ~60 | 有 | 从未被生产代码调用 |
| filterSensitiveFields | security-enhanced.ts:373-398 | ~25 | 有 | 从未被导入 |
| ClassificationInput.context | types.ts:114-121 | ~8 | — | 从未被 classifier 读取 |
| DreamConsolidator.compactor | dream-consolidator.ts 的可选参数 | — | — | app-init 未传入 |

**估算死代码总量：** ~1800+ 行实现代码 + ~500+ 行测试代码，全部未被生产路径调用。

---

## 测试覆盖概况

| 指标 | 数值 |
|------|------|
| 测试文件数 | 143 |
| 测试用例数 (it/it.each) | ~1735 |
| E2E 测试 | 1 文件 (10 场景) |
| 集成测试 | 5 文件 |
| 零直接测试的核心模块 | App.tsx, chat-runner.ts, goal-runner.ts, app-init.ts |
| Phase 31 测试文件 | 9 个（8 单元 + 1 集成） |
| Phase 31 测试用例 | ~100+ |

---

## 安全评估

| 方面 | 评级 | 说明 |
|---|:---:|---|
| 凭据管理 | ✅ 良好 | 无硬编码密钥，环境变量 fail-fast，配置 `${VAR}` 替换 |
| 路径遍历 | ⚠️ 分层但不一致 | file_write/edit/read 自身不检查边界，依赖 ToolExecutor 层；code_search/file_search 内部有检查 |
| Shell 安全 | ✅ 良好 | 7 层 Bash 安全检查、环境变量白名单、Circuit Breaker、超时 SIGKILL |
| Prompt Injection | ❌ 无防御 | ToolResultSanitizer 已实现但未接入，工具返回直接注入 LLM |
| API Key 脱敏 | ❌ 无防御 | filterSensitiveFields() 已实现但未接入 |
| 先读后写 | ❌ 无防御 | ReadTracker 已实现但未接入 |

---

## 架构评估

### 做得好的地方

1. **ReAct Agent Loop 设计扎实**（loop.ts 633 行）：AsyncGenerator 流式事件、Promise.allSettled 隔离工具失败、连续错误自动中止、可配置的迭代上限。并行工具执行保留声明顺序（for 循环按索引），对缓存友好。

2. **配置系统成熟**（schema.ts 409 行）：Zod 校验、17 个顶级 section、环境变量 fail-fast、deep merge、备份恢复、热重载。

3. **多 Agent 基础设施完整**：Orchestrator 拓扑排序 + 冲突检测、WorkerExecutor 角色提示 + 隔离执行、Blackboard 乐观锁 + 深拷贝。这些在 Phase 14 设计，Phase 31 终于通过 ExecutionOrchestrator 串联。

4. **测试文化深厚**：143 个测试文件，从单元测试到 E2E 覆盖。Phase 31 的 8 个新模块各有独立测试文件。

### 需要改进的地方

1. **"写了就完了"的执行模式**：Phase 31 的 8 个模块实现了完整功能但没有接入生产路径。这不是 Phase 31 独有的问题——ContextCompactor 的 DreamConsolidator 集成也有类似遗漏。建议在 Phase 文档中加入"接线验收"环节：不只是模块本身通过测试，还要验证至少一条端到端路径。

2. **App.tsx 的分发逻辑与文档脱节**：agents.md 声称 TaskOrchestrator 是新调度层，但 App.tsx 仍用旧逻辑。文档更新应作为接线的最后一步，而不是提前写。

3. **安全模块的"存在但不用"模式**：ReadTracker、ToolResultSanitizer、filterSensitiveFields 三个安全模块全部是死代码。这意味着 agents.md 中的安全陷阱描述给用户一种"已防护"的错觉，实际运行时完全暴露。

---

## 建议修复优先级

| 优先级 | 修复项 | 工作量 |
|:---:|---|:---:|
| P0 | 将 Phase 31 的 8 个模块接入生产路径（修改 App.tsx handleSubmit、chat-runner/goal-runner、loop.ts 工具注入路径） | 大 |
| P0 | 在 agents.md 中标注 Phase 31 功能"已实现但未接线"，移除误导性陷阱描述 | 小 |
| P1 | 修复 TokenTracker 双计数 bug（record() 和 recordTaskUsage() 的 taskSpent 累加） | 小 |
| P1 | goal-runner 添加 checkBudget() 调用 | 小 |
| P1 | chat-runner 传 context 给 classifier | 小 |
| P2 | 为 chat-runner.ts、goal-runner.ts、app-init.ts 补充直接单元测试 | 中 |
| P2 | GuardedToolExecutorAdapter 添加 executeToolStructured() | 小 |
| P2 | 更新 Phase 31 接口对齐表中的 4 个 FAIL 项 | 小 |
| P3 | 统一 file_write/edit/read 的内部路径遍历检查（或确认 ToolExecutor 层覆盖足够） | 中 |
| P3 | DreamConsolidator 传入 compactor 选项 | 小 |

---

## 附录：项目规模统计

| 指标 | 数值 |
|------|------|
| 语言 | TypeScript 6.0.3 (strict, ESM) |
| 运行时 | Node.js 20+ |
| UI 框架 | Ink 7.0.6 + React 19.2.7 |
| 测试框架 | Vitest 4.1.9 |
| 构建工具 | tsup 8.x |
| 版本号 | v2.3.0 |
| 许可证 | AGPL-3.0 |
| src/ 源文件 | ~150 |
| 测试文件 | 143 |
| 测试用例 | ~1735 |
| 注册命令 | 29 |
| 内置工具 | 13 个工具类 |
| 配置 section | 17 顶级 + 6 优化子项 |
| Phase 数 | 01-31 + 0c + 17b + 17c |

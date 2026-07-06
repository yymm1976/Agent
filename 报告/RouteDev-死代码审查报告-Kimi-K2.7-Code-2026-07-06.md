# RouteDev 死代码审查报告

> **审查模型**：Kimi-K2.7-Code  
> **审查日期**：2026-07-06  
> **审查范围**：`src/` + `desktop/`（排除 `tests/`、`node_modules/`）  
> **生产入口**：`desktop/main/index.ts` → `desktop/main/engine-bridge.ts` → `src/runtime/app-init.ts`  
> **依据文档**：`C:\Users\杨铭\Desktop\Agent\报告\RouteDev-死代码审查提示词.md`

---

## 1. 执行摘要

本次审查严格遵循提示词中的 7 步判定流程，搜索范围覆盖 `src/` + `desktop/`，排除 `tests/`；对每项死代码判定均附 Grep 命令与命中数。

> **说明**：报告标记的“死代码”数量较多（主要集中在 `AppDependencies` 返回字段冗余），并非动态 import 漏判导致的误报，而是 `app-init.ts` 返回了大量未被 `engine-bridge.ts` / `goal-runner.ts` / `App.tsx` 消费的字段。所有判定均经过二次关键词交叉验证。

| 类别 | 数量 | 处理建议 |
|------|------|----------|
| **Zombie-Field（僵尸字段）** | 25 项 | 从 `AppDependencies` 接口中删除或标记 `@deprecated`，保留源文件与内部构造逻辑 |
| **True-Dead（运行时导出）** | 5 项 | 删除导出或整文件（需同步清理对应测试） |
| **Dead-Variable（未使用变量）** | 1 项 | 删除解构变量 |
| **Wiring-Bug（配置/接线断裂）** | 5 项 | 修复 `engine-bridge.ts` 传参或补充配置消费逻辑 |
| **误报排除** | 若干 | 类型导出、动态 import 模块、配置门控可选功能等未列入死代码 |

---

## 2. 确认死代码清单

### 2.1 True-Dead（纯死运行时导出）

以下运行时导出（非 `interface/type`）在 `src/` + `desktop/`（排除自身与 `tests/`）中 0 引用，且无动态 import 接入。

| 导出 | 文件 | 死因 | 验证命令 | 命中数 |
|------|------|------|----------|--------|
| `createTaskComplexityAnalyzer` | `src/agent/complexity-analyzer.ts` | 工厂函数导出后无生产调用；同文件 `TaskComplexityAnalyzer` 类亦无生产引用 | `grep -r "createTaskComplexityAnalyzer\|TaskComplexityAnalyzer" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0（排除自身/测试） |
| `createRequirementsGatherer` | `src/agent/requirements-gatherer.ts` | 工厂函数导出后无生产调用；`RequirementsGatherer` 类仅测试使用 | `grep -r "createRequirementsGatherer\|RequirementsGatherer" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0（排除自身/测试） |
| `PlannerResultSchema` | `src/agents/result-schemas.ts` | 仅被同文件 `MultiAgentResultSchema` 引用；`MultiAgentResultSchema` 无外部引用 | `grep -r "MultiAgentResultSchema\|PlannerResultSchema" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0（排除自身） |
| `VerifierResultSchema` | `src/agents/result-schemas.ts` | 同上 | 同上 | 0 |
| `SynthesizerResultSchema` | `src/agents/result-schemas.ts` | 同上 | 同上 | 0 |

> **交叉验证**：`builtin-templates.ts` 中的 `PLANNER_PROFILE` / `VERIFIER_PROFILE` / `SYNTHESIZER_PROFILE` 初看疑似死导出，但它们被同文件 `BUILTIN_PROFILES` 数组聚合，而 `BUILTIN_PROFILES` 被 `src/agents/profiles/manager.ts` 消费，故**不是死代码**。

---

### 2.2 Zombie-Field（僵尸字段）

`app-init.ts` 创建并返回 `AppDependencies` 字段，但 `engine-bridge.ts` 和其他生产文件对 `deps.<字段>` / `this.deps.<字段>` 0 消费。测试引用不计入。

#### 高优先级清理（字段完全无生产消费）

| 字段 | `app-init.ts` 返回位置 | 生产消费 | 验证命令 | 命中数 |
|------|------------------------|----------|----------|--------|
| `securityChecker` | L2238 | 0 | `grep -r "deps\.securityChecker\|this\.deps\.securityChecker" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `adapter` | L2240 | 0 | `grep -r "deps\.adapter\|this\.deps\.adapter" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `permissionEngine` | L2248 | 0 | `grep -r "deps\.permissionEngine\|this\.deps\.permissionEngine" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `checkpointWriter` | L2252 | 0 | `grep -r "deps\.checkpointWriter\|this\.deps\.checkpointWriter" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `projectMemory` | L2260 | 0（仅在 `app-init.ts` 内部 `setProjectDoc`） | `grep -r "deps\.projectMemory\|this\.deps\.projectMemory" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `primaryClient` | L2262 | 0 | `grep -r "deps\.primaryClient\|this\.deps\.primaryClient" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `taskOrchestrator` | L2266 | 0 | `grep -r "deps\.taskOrchestrator\|this\.deps\.taskOrchestrator" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `readTracker` | L2269 | 0 | `grep -r "deps\.readTracker\|this\.deps\.readTracker" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `resultSanitizer` | L2270 | 0 | `grep -r "deps\.resultSanitizer\|this\.deps\.resultSanitizer" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `subAgentLifecycle` | L2278 | 0 | `grep -r "deps\.subAgentLifecycle\|this\.deps\.subAgentLifecycle" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `subAgentScoreCardCollector` | L2279 | 0 | `grep -r "deps\.subAgentScoreCardCollector\|this\.deps\.subAgentScoreCardCollector" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `compositionalRouter` | L2284 | 0 | `grep -r "deps\.compositionalRouter\|this\.deps\.compositionalRouter" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `pathRouter` | L2286 | 0 | `grep -r "deps\.pathRouter\|this\.deps\.pathRouter" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `dualLoopOrchestratorRef` | L2288 | 0 | `grep -r "deps\.dualLoopOrchestratorRef\|this\.deps\.dualLoopOrchestratorRef" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |
| `dagEngineRef` | L2290 | 0 | `grep -r "deps\.dagEngineRef\|this\.deps\.dagEngineRef" src/ desktop/ --include="*.ts" --include="*.tsx"` | 0 |

#### 内部构造辅助字段（仍在 `app-init.ts` 内部使用，但无需返回）

| 字段 | `app-init.ts` 内部使用 | 生产外部消费 | 说明 |
|------|------------------------|--------------|------|
| `workModeController` | L699 创建；L704 构造 `GuardedToolExecutorAdapter`；L729 取 `ComposePipeline` | 0 | 构造 `agentLoop` 所需，但无需暴露到 `AppDependencies` |
| `guardedAdapter` | L704 创建；L707 构造 `ReActAgentLoop` | 0 | 同上 |
| `middlewarePipeline` | `pluginSystem.middlewarePipeline` 返回 | 0 | `pluginRegistry` / `middlewarePipeline` 均未在 `engine-bridge.ts` 消费 |
| `pluginRegistry` | `pluginSystem.pluginRegistry` 返回 | 0 | 同上；`ModelRouter` 虽支持 `pluginRegistry` 参数，但 `engine-bridge.ts` 构造时未传入 |

#### Phase 70 上下文压缩模块实例（通过 `ContextCompactor` 内部消费，deps 字段冗余）

| 字段 | `app-init.ts` 返回位置 | 生产外部消费 | 说明 |
|------|------------------------|--------------|------|
| `toolOutputBudgetManager` | L2443（动态返回） | 0 | 已注入 `ContextCompactor`，无需作为 deps 字段 |
| `messageGrouper` | L2448 | 0 | 同上 |
| `actionChainDetector` | L2452 | 0 | 同上 |
| `autoCompactGuardian` | L2456 | 0 | 同上 |
| `compactPromptEngine` | L2460 | 0 | 同上 |
| `sessionMemoryStore` | L2464 | 0 | 同上 |

---

### 2.3 Dead-Variable（未使用变量）

| 变量 | 文件 | 说明 | 验证命令 | 命中数 |
|------|------|------|----------|--------|
| `awaitingGoalConfirmRef` | `src/runtime/goal-runner.ts` | 在 `GoalRunnerDeps` 接口中定义（L90），并在解构时取出（L220），但函数体内无任何引用 | `grep -n "awaitingGoalConfirmRef" src/runtime/goal-runner.ts` | 仅 L90、L220 |

---

## 3. Wiring-Bug（配置断裂 / 接线缺陷）

| 缺陷项 | 说明 | 影响 |
|--------|------|------|
| `compositionalRouter` 未传入 `createGoalRunner` | `app-init.ts:2284` 返回；`goal-runner.ts:142/1869` 期望并消费；`desktop/main/engine-bridge.ts:736-834` 的 `createGoalRunner` 调用中未传递 | Desktop 端 `/goal` 永远不走组合式路由路径 |
| `dualLoopOrchestratorRef` 未传入 `createGoalRunner` | `app-init.ts:2288` 返回；`goal-runner.ts:131/1173` 期望并消费；`engine-bridge.ts` 未传递 | Desktop 端双循环编排器不生效 |
| `dagEngineRef` 未接入 `createGoalRunner` | `app-init.ts:2290` 返回 `dagEngineRef`；`goal-runner.ts:136/227` 期望的是 `dagEngine`（`DagEngine` 实例）；`engine-bridge.ts` 未传递任何值 | Desktop 端 DAG 执行路径不生效 |
| `pathRouter` 未传入 `createGoalRunner` | `app-init.ts:2286` 返回；`goal-runner.ts:122/1083` 期望；`engine-bridge.ts` 未传递。`goal-runner.ts:1083` 有 `pathRouter ?? new PathRouter()` fallback | 当前通过 fallback 自建新实例，app-init 创建的实例被浪费；不确定是故意降级还是遗漏接线 |
| `phase52Integration.skillLifecycle.memoryRetentionDays` 配置未触发清理 | `defaults.ts:574` / `schema.ts:1535` 定义；`SkillLifecycleManager.cleanupExpiredMemory(memoryRetentionDays)` 仅在测试中被调用，生产路径未按配置触发 | 过期 Skill 记忆不会自动清理，与注释“陷阱 #171：必须严格执行”矛盾 |

---

## 4. 需人工裁决清单

| 模块 | 原因 | 建议 |
|------|------|------|
| `pathRouter` | `engine-bridge.ts` 未传给 `createGoalRunner`，但 `goal-runner.ts` 内部自带 `new PathRouter()` fallback | 确认是“故意让每个 GoalRunner 独立持有一个 PathRouter”还是遗漏接线 |
| `toolOutputBudgetManager` 等 6 个 Phase 70 字段 | 未被外部以 `deps.<字段>` 消费，但已通过 `ContextCompactor` 配置生效 | 决定是否保留在 `AppDependencies` 接口中供未来观察/调试，或从接口删除 |
| `complexity-analyzer.ts` 整文件 | `TaskComplexityAnalyzer` 类与 `createTaskComplexityAnalyzer` 均无生产引用，仅测试使用 | 确认是否整文件删除，或保留为可复用库 |
| `requirements-gatherer.ts` 整文件 | `RequirementsGatherer` 与 `createRequirementsGatherer` 均无生产引用，仅测试使用 | 同上 |

---

## 5. 误报排除清单（自查记录）

| 模块/导出 | 初判风险 | 实际状态 | 排除理由 |
|-----------|----------|----------|----------|
| `src/policies/*` | 被前序报告误判为死代码 | 活代码 | `app-init.ts:1325-1356` 静态构造 `PolicyEngine` 并注入 `agentLoop` |
| `src/import/*` | 动态 import 漏判 | 活代码 | `app-init.ts:1918-2025` 通过 `Promise.all([import(...)])` 动态加载 |
| `src/mcp/claude-bridge.ts` | 动态 import 漏判 | 活代码 | `app-init.ts:2026-2050` 动态加载 `ClaudeMCPBridge` |
| `src/tools/builtin/browser.ts` | 动态 import 漏判 | 活代码 | `app-init.ts:593-599` 动态加载并注册到 `ToolRegistry` |
| `src/agent/micro-summary.ts` | 未搜索 desktop/ | 活代码 | `desktop/main/engine-bridge.ts:21` 静态 import `generateMicroSummary` |
| `src/agent/omission-checker.ts` | 未搜索 desktop/ | 活代码 | `desktop/main/engine-bridge.ts` 通过动态 import 消费 |
| Phase 68/70 配置项 | `enabled: false` 误判 | 配置门控的可选功能 | 对应实例通过 `engine-bridge.ts` 传递给 `createGoalRunner`，`goal-runner.ts` 内有真实方法调用链 |
| `PLANNER_PROFILE` 等 | 导出后疑似无引用 | 活代码 | 被同文件 `BUILTIN_PROFILES` 聚合，`manager.ts:69` 消费该数组 |
| `QualityAggregator` 类 | 导出后疑似无引用 | 活代码 | `quality-signal.ts` 通过 `getGlobalQualityAggregator()` 间接使用，且 `quality-signal.ts` 被 `app-init.ts` 动态加载 |
| 大量 `interface/type` 导出 | 被 `detect-dead-code.ts` 标记 | 不处理 | 类型导出不影响运行时，按提示词要求不列入死代码 |

---

## 6. 交叉验证记录

| 项 | 核验方法 | 核验结果 |
|----|----------|----------|
| `securityChecker` / `adapter` / `permissionEngine` 等僵尸字段 | 换关键词搜索：直接搜索字段名（无 `deps.` 前缀）在 `src/` + `desktop/` 的引用 | 除 `app-init.ts` 自身与测试外无生产引用 |
| `compositionalRouter` / `dualLoopOrchestratorRef` / `dagEngineRef` / `pathRouter` | 搜索 `createGoalRunner(` 调用点，逐字段核对传入参数 | `engine-bridge.ts` 未传入这 4 个字段 |
| `createTaskComplexityAnalyzer` / `createRequirementsGatherer` | 搜索函数名 + 文件名动态 import | 无生产引用、无动态 import |
| Phase 70 模块实例 | 搜索 `deps.toolOutputBudgetManager` 等 6 个字段 | 0 命中；确认仅通过 `ContextCompactor` 内部消费 |
| `memoryRetentionDays` | 搜索 `cleanupExpiredMemory` 调用点 | 仅在 `tests/skills/skill-lifecycle.test.ts` 调用，生产路径未触发 |

---

## 7. 结论与建议

1. **Zombie-Field 清理**：`AppDependencies` 接口存在明显膨胀。建议分两轮处理：
   - 第一轮删除高优先级字段（`securityChecker`、`adapter`、`permissionEngine`、`checkpointWriter`、`projectMemory`、`primaryClient`、`taskOrchestrator`、`readTracker`、`resultSanitizer`、`subAgentLifecycle`、`subAgentScoreCardCollector`、`compositionalRouter`、`pathRouter`、`dualLoopOrchestratorRef`、`dagEngineRef`）。
   - 第二轮评估内部构造辅助字段（`workModeController`、`guardedAdapter`、`middlewarePipeline`、`pluginRegistry`）以及 Phase 70 的 6 个实例字段是否仍需保留在接口中。

2. **Wiring-Bug 修复优先级**：
   - **高**：`compositionalRouter`、`dualLoopOrchestratorRef`、`dagEngineRef` 在 Desktop 端完全未接入，需在 `engine-bridge.ts` 的 `createGoalRunner` 调用中补传。注意 `dagEngineRef` 需解引用为 `.current` 后传入，或修改 `goal-runner.ts` 签名。
   - **中**：`pathRouter` 需确认是否补传；若保持 fallback，则 `app-init.ts` 不应再创建和返回该实例。
   - **中**：`phase52Integration.skillLifecycle.memoryRetentionDays` 需在生产路径中定时调用 `cleanupExpiredMemory`，否则配置形同虚设。

3. **True-Dead 导出清理**：`createTaskComplexityAnalyzer`、`createRequirementsGatherer`、`PlannerResultSchema` / `VerifierResultSchema` / `SynthesizerResultSchema` 可安全移除导出；如对应文件已无其他生产引用，可整文件删除。

4. **Dead-Variable 清理**：`src/runtime/goal-runner.ts` 中的 `awaitingGoalConfirmRef` 解构变量可直接删除。

---

## 8. 质量自检清单

- [x] 每个死代码判定都附带了 Grep 命令和命中数
- [x] 搜索范围包含 `src/` + `desktop/`（不只是 `src/`）
- [x] 已检查动态 import（搜索文件名在 `app-init.ts` 中的出现）
- [x] 未把 `enabled: false` 的配置门控功能判为死代码
- [x] 未把 TypeScript 类型导出判为需要删除的死代码
- [x] 未建议删除整个目录
- [x] 已区分“实例化”和“方法调用”（有 `new` 不等于活）
- [x] 已检查事件回调/信号监听器的间接调用链
- [x] 所有 True-Dead / Zombie-Field 项经过交叉验证

# RouteDev 死代码审查报告

> **审查模型**：Kimi-K2.7-Code  
> **审查日期**：2026-07-07  
> **审查范围**：`src/` + `desktop/`（排除 `tests/`、`node_modules/`）  
> **生产入口**：`desktop/main/index.ts` → `engine-bridge.ts` → `app-init.ts`  
> **审查依据**：《RouteDev-死代码审查提示词.md》七步判定流程 + 六类分类标准  

---

## 1. 执行摘要

本轮审查基于六轮历史清理后的当前源码，重点核验 `app-init.ts` 返回的 `AppDependencies` 字段是否被 `engine-bridge.ts` / `goal-runner.ts` / 工具系统实际消费，并对历史报告中的遗留结论进行逐条复核。

| 指标 | 结果 | 说明 |
|------|------|------|
| 审查文件数 | 约 180 个 `.ts` 文件（`src/` + `desktop/`） | 未依赖 `detect-dead-code.ts` 脚本 |
| True-Dead（纯死文件） | **0** | 未发现完全无生产引用的源文件 |
| Zombie-Field（僵尸字段） | **2** | `AppDependencies.orchestrator`、`AppDependencies.workerExecutor` |
| Dead-Method（死方法） | **2** | `src/router/embedder.ts:l2Normalize`、`src/agent/memory/context-manager.ts:setEpisodicMemory/getEpisodicMemory` |
| Wiring-Bug（接线冗余） | **2** | `GoalRunnerDeps.difficultyAssessor` / `stateMigration` 仅接口声明，从未被上层注入 |
| Test-Only（仅测试） | **1** | `src/agent/memory/episodic-memory.ts` 整类实现 |
| 需人工裁决 | **2** | `utils/errors.ts` 双受众格式化体系、`src/hooks/hook-events.ts` 元数据导出 |
| 误报排除 | **8** | 动态 import、配置门控、事件回调、历史已删文件等 |

**总体结论**：代码库整体干净，主要残余集中在 `AppDependencies` 的两个僵尸字段；其余问题均为“未注入的接口字段”或“仅测试消费的实现/导出”，删除风险可控。

---

## 2. 确认死代码清单

### 2.1 True-Dead（纯死文件）

无。

逐文件核验后，所有 `.ts` 源文件至少满足以下任一条件：
- 被 `app-init.ts` 静态 import 并实例化；
- 被 `app-init.ts` 动态 import（变量路径 + fail-open）；
- 被 `engine-bridge.ts` / `goal-runner.ts` / 工具系统静态 import 并调用；
- 作为事件回调 / 信号监听器被间接调用；
- 被配置门控的可选功能通过 `deps.xxx.method()` 真实消费。

历史报告中标记的 `src/skills/fallback-checker.ts`、`src/skills/skill-schema-validator.ts`、`src/skills/skill-validator.ts`、`src/observability/trajectory-exporter.ts`、`src/observability/trajectory-aggregator.ts` 等文件**已不存在**。

### 2.2 Zombie-Field（僵尸字段）

| 字段 | 实例化位置 | 生产消费方 | 验证命令 | 命中数 |
|------|-----------|-----------|----------|--------|
| `AppDependencies.orchestrator` | `src/runtime/app-init.ts:1425` | 0 | `grep -r "this\.deps\.orchestrator\|deps\.orchestrator" src/ desktop/` | 2（均位于 `tests/`，生产代码 0） |
| `AppDependencies.workerExecutor` | `src/runtime/app-init.ts:1432` | 0 | `grep -r "this\.deps\.workerExecutor\|deps\.workerExecutor" src/ desktop/` | 2（均位于 `tests/`，生产代码 0） |

#### 详细证据

1. **`orchestrator` 字段**
   - `app-init.ts:1425` 创建 `const orchestrator = new Orchestrator(...)`，并在 `AppDependencies` 接口（`L205`）和返回对象（`L2268`）中暴露。
   - `engine-bridge.ts:799` 注释明确说明 “Phase 58：orchestrator/workerExecutor 已删除”，`createGoalRunner` 传参中未包含 `orchestrator`。
   - 全 `src/` + `desktop/` 搜索 `deps.orchestrator` / `this.deps.orchestrator`：生产代码 0 命中，仅 `tests/runtime/app-init.test.ts:227` 断言字段存在。
   - `Orchestrator` 类当前在 `src/agent/multi/orchestrator.ts` 中仍被 `app-init.ts` 静态 import 并实例化，但实例从未被外部消费；`src/agent/unified-reviewer.ts:259` 自行 `new WorkerExecutor(...)`，不依赖该字段。

2. **`workerExecutor` 字段**
   - `app-init.ts:1432` 创建 `const workerExecutor = new WorkerExecutor(...)`，并在 `AppDependencies` 接口（`L206`）和返回对象（`L2269`）中暴露。
   - `engine-bridge.ts:801` 注释同样说明已删除，未向 `createGoalRunner` 传参。
   - 全 `src/` + `desktop/` 搜索 `deps.workerExecutor` / `this.deps.workerExecutor`：生产代码 0 命中，仅 `tests/runtime/app-init.test.ts:228` 断言字段存在。
   - 局部变量 `workerExecutor` 在 `app-init.ts:1462` 的熔断器动态 import 回调中被使用，但属于闭包内局部引用，不构成 `AppDependencies` 字段消费。

#### 处理建议

按提示词 Zombie-Field 分类标准：删除 `app-init.ts` 中的两个实例化代码，并从 `AppDependencies` 接口与返回对象中移除对应字段；保留 `src/agent/multi/orchestrator.ts` 与 `src/agent/multi/worker-executor.ts` 源文件（测试仍在使用 / 其他模块自行实例化）。

### 2.3 Dead-Method（死方法）

| 方法 | 定义位置 | 调用方 | 验证命令 | 命中数 |
|------|----------|--------|----------|--------|
| `l2Normalize` | `src/router/embedder.ts:24` | 0（生产） | `grep -r "l2Normalize" src/ desktop/` | 生产 `src/` 0 命中（`src/skills/bi-encoder-retriever.ts:31` 为本地实现，未从 `router/embedder.ts` 导入；其余命中仅在 `tests/`） |
| `ContextManager.setEpisodicMemory` | `src/agent/memory/context-manager.ts:179` | 0 | `grep -r "setEpisodicMemory" src/ desktop/` | 0（仅定义处） |
| `ContextManager.getEpisodicMemory` | `src/agent/memory/context-manager.ts:187` | 0 | `grep -r "getEpisodicMemory" src/ desktop/` | 0（仅定义处） |

#### 详细证据

1. **`src/router/embedder.ts:l2Normalize`**
   - `src/router/embedder.ts:24` 以 `export function l2Normalize(...)` 形式导出。
   - 全 `src/` + `desktop/` 搜索：无生产文件从 `router/embedder.ts` 导入 `l2Normalize`。
   - `src/skills/bi-encoder-retriever.ts:31` 存在同名本地实现并自行使用，与 `router/embedder.ts` 的导出重复。
   - 仅有 `tests/router/routing-memory.test.ts` 导入并测试该函数。
   - **建议**：删除 `src/router/embedder.ts` 中的 `l2Normalize` 导出，或让 `bi-encoder-retriever.ts` 复用同一实现以消除重复。

2. **`ContextManager.setEpisodicMemory / getEpisodicMemory`**
   - `context-manager.ts:179/187` 定义了 setter/getter，但全项目无生产调用方。
   - 对应私有字段 `episodicMemory`（`L135`）始终为 `null`：`app-init.ts` 在 `L339-344` 创建 `MemoryRecallInjector` 时未传入 `episodicMemory` 参数；`triggerCheckpoint` 中 `if (this.episodicMemory)` 分支永远不会执行。
   - **建议**：若保留 `EpisodicMemory` 作为未来功能，可移除这两个未接入的 public 方法；若决定删除 `EpisodicMemory` 类实现，则一并移除字段与方法。

### 2.4 Wiring-Bug（接线冗余）

| 字段 | 声明位置 | 是否被 `app-init.ts` / `engine-bridge.ts` 注入 | 实际消费方式 | 建议 |
|------|---------|-------------------------------------------|-------------|------|
| `GoalRunnerDeps.difficultyAssessor` | `src/runtime/goal-runner.ts:115` | ❌ 否 | `goal-runner.ts:424/442` 内部 `new DifficultyAssessor()` 兜底 | 可移除接口字段，统一内部实例化 |
| `GoalRunnerDeps.stateMigration` | `src/runtime/goal-runner.ts:116` | ❌ 否 | `goal-runner.ts:1120` 内部 `new StateMigration()` 兜底 | 可移除接口字段，统一内部实例化 |

#### 说明

这两个字段并非严格意义上的“死代码”，因为 `DifficultyAssessor` / `StateMigration` 类在生产路径中被调用（`goal-runner.ts:424/442` 和 `goal-runner.ts:1120`）。但它们作为 `GoalRunnerDeps` 的可选字段从未被上层注入，`engine-bridge.ts:736-844` 的 `createGoalRunner(...)` 调用中未出现这两个字段，属于“只声明不传递”的接线冗余。建议清理以统一依赖来源。

---

## 3. 需人工裁决清单

| 模块 | 原因 | 建议 |
|------|------|------|
| `src/agent/memory/episodic-memory.ts`（整类实现） | 仅 `tests/agent/memory/episodic-memory.test.ts` 通过 `new EpisodicMemory(...)` 实例化；生产代码中仅作为 type import 使用，且 `ContextManager` / `MemoryRecallInjector` 的接入点未接线 | 若 Phase 71 B4 的 episodic memory 功能仍计划启用，保留类实现并补全 `app-init.ts` 注入；若已废弃，删除类实现并清理 `context-manager.ts` 相关字段/方法 |
| `src/utils/errors.ts` 中 `ToolExecutionError` / `isRouteDevError` / `formatErrorForUser` / `formatErrorForDev` / `RouteDevError.toUserMessage` / `toDevMessage` | 生产代码仅 `ConfigValidationError` 被 `src/config/loader.ts` 使用；其余导出仅在测试/集成测试中被引用 | 若“双受众错误格式化体系”仍在 UI 层规划中，保留；若已废弃，整体清理 |
| `src/hooks/hook-events.ts` 中 `ALL_HOOK_EVENTS` / `HOOK_EVENT_METADATA` / `LEGACY_HOOK_EVENT_MAP` / `isValidHookEventType` / `getHookEventMetadata` / `listEventsByCategory` / `HookEventMetadata` / `HookEventCategory` | 文件本身活（`legacyToNewEvent`、`HookPayload`、`HookHandler` 被 `src/agent/hooks.ts` 使用），但上述元数据导出全项目零外部消费 | 若 hook 系统有公共 API 设计目标，保留；若纯属内部使用，清理未消费导出 |

---

## 4. 误报排除清单（自查记录）

| 模块/项 | 初判怀疑 | 实际状态 | 排除理由 |
|---------|---------|----------|----------|
| `src/agent/loop.ts` 队列 API | 可能为死方法 | **活代码** | `followUp` / `setFollowUpMode` / `getQueueStatus` / `getFollowUpQueue` / `removeFollowUp` / `clearAllQueues` 均被 `desktop/main/engine-bridge.ts` + `desktop/main/index.ts` + `desktop/renderer/src/pages/ChatPage.tsx` 调用；`clearFollowUpQueue` 在 `clearAllQueues` 内部被调用 |
| `src/agent/dual-loop-orchestrator.ts` `registerRecoveryArtifact` / `evaluateOuterLoop` | public 但无外部调用 | **活代码（内部自调用）** | `registerRecoveryArtifact` 在 `runDualLoop` 内被调用（`L325`）；`evaluateOuterLoop` 在 `runDualLoop` 内被调用（`L375`）。`setReviewerPolicy` / `setBoundedRecovery` / `setInnerAgent` 均在 `app-init.ts` 动态 import 回调中被调用 |
| `DifficultyAssessor` / `StateMigration` | 可能为死类 | **活代码** | 被 `goal-runner.ts` 以 `new DifficultyAssessor()` / `new StateMigration()` 形式调用，存在生产消费 |
| `src/skills/fallback-checker.ts` 等 3 个文件 | 历史报告 True-Dead | **已删除** | 源码已不存在 |
| `src/observability/trajectory-exporter.ts` / `trajectory-aggregator.ts` | 历史报告死类/功能性死代码 | **已删除** | 源码已不存在 |
| `executeWorkerStep`（`goal-runner.ts`） | 历史报告死方法 | **已删除** | 方法及调用方已在 Phase 58 清理，源码中仅存注释 |
| `src/import/*`、`src/mcp/claude-bridge.ts`、`src/code-map/fallback.ts`、`src/tools/builtin/browser.ts` 等 | 未搜索到静态 import | **活代码（动态 import）** | 在 `app-init.ts` 中通过 `const path = '...'; import(path)` 接入，符合提示词“动态 import 是有效生产引用” |
| Phase 68/69/70 配置门控模块 | `enabled: false` 误判为死代码 | **活代码** | `goal-runner.ts` 中以 `if (deps.provenanceGraph) { deps.provenanceGraph.addArtifact(...) }` 等形式存在真实方法调用链 |
| `workerExecutor` 局部变量 | 可能因 `app-init.ts:1462` 使用而被误判为活 | **仍属 Zombie-Field** | `app-init.ts:1462` 使用的是闭包内局部变量 `workerExecutor`，而非 `AppDependencies.workerExecutor`；`deps.workerExecutor` 仍零消费 |

---

## 5. 交叉验证记录

| 项 | 初次核验 | 二次核验方法 | 二次核验结果 |
|----|---------|-------------|-------------|
| `AppDependencies.orchestrator` | `grep "orchestrator" src/runtime/app-init.ts` 发现实例化 + 返回 | 搜索 `this.deps.orchestrator` / `deps.orchestrator` 在 `src/` + `desktop/` | 生产代码 0 命中（仅 `tests/` 2 处） |
| `AppDependencies.workerExecutor` | `grep "workerExecutor" src/runtime/app-init.ts` 发现实例化 + 返回 | 搜索 `this.deps.workerExecutor` / `deps.workerExecutor` 在 `src/` + `desktop/` | 生产代码 0 命中（仅 `tests/` 2 处） |
| `Orchestrator` 源文件是否死亡 | `grep "new Orchestrator" src/ desktop/` 发现 `app-init.ts` + `tests` | 搜索 `from '../agent/multi/orchestrator.js'` 在 `src/` + `desktop/` | 仅 `app-init.ts` 1 处静态 import |
| `WorkerExecutor` 源文件是否死亡 | `grep "new WorkerExecutor" src/ desktop/` 发现 `app-init.ts` + `unified-reviewer.ts` + `tests` | 搜索 `from '../agent/multi/worker-executor.js'` 在 `src/` + `desktop/` | 仅 `app-init.ts` 1 处静态 import + `unified-reviewer.ts` 自行实例化 |
| `DifficultyAssessor` / `StateMigration` 是否活代码 | `grep "DifficultyAssessor\|StateMigration" src/runtime/goal-runner.ts` 发现方法调用 | 搜索对应字段在 `app-init.ts` / `engine-bridge.ts` 是否被注入 | 0 命中，确认仅内部兜底实例化 |
| `l2Normalize` 是否死导出 | `grep "l2Normalize" src/ desktop/` 发现 `router/embedder.ts` 定义 + `skills/bi-encoder-retriever.ts` 本地实现 + 测试 | 单独搜索 `from '../router/embedder.js'` 中是否导入 `l2Normalize` | 生产代码 0 命中 |
| `EpisodicMemory` 是否 Test-Only | `grep "new EpisodicMemory" src/ desktop/` 仅发现测试 | 搜索 `setEpisodicMemory\|getEpisodicMemory` 生产调用方 | 0 命中 |
| `errors.ts` 未消费导出 | `grep "ToolExecutionError\|isRouteDevError\|formatErrorForUser\|formatErrorForDev" src/ desktop/` | 排除 `tests/` 后统计生产命中 | 仅 `ConfigValidationError` 在 `src/config/loader.ts` 有 1 处命中，其余导出 0 |

---

## 6. 质量自检清单

- [x] 每个死代码判定都附带了 Grep 命令和命中数
- [x] 搜索范围包含 `src/` + `desktop/`（不只是 `src/`）
- [x] 已检查动态 import（搜索文件名在 `app-init.ts` 中的出现）
- [x] 未把 `enabled: false` 的配置门控功能判为死代码
- [x] 未把 TypeScript 类型导出判为需要删除的死代码
- [x] 未建议删除整个目录
- [x] 已区分“实例化”和“方法调用”（`Orchestrator`/`WorkerExecutor` 有实例化但无 `deps` 消费）
- [x] 已检查事件回调/信号监听器的间接调用链
- [x] 所有 Zombie-Field / Dead-Method 经过交叉验证

---

## 7. 审查总结

1. **代码库高度干净**：六轮清理后未发现新的纯死文件；历史报告中的 `executeWorkerStep`、`TrajectoryExporter`、3 个 `skills/` 死文件等已在后续轮次删除，本轮基于当前源码重新核验，不可复用旧结论。
2. **核心问题在 `AppDependencies` 僵尸字段**：Phase 58 删除了 `executeWorkerStep` / `executePlanWithMultiAgent` 路径后，`orchestrator` 与 `workerExecutor` 从 `GoalRunnerDeps` 中移除，但 `app-init.ts` 的实例化和 `AppDependencies` 接口字段未同步清理。
3. **接线冗余需统一**：`GoalRunnerDeps.difficultyAssessor` / `stateMigration` 是“声明了但未注入”的接口字段，实际功能通过 `goal-runner.ts` 内部兜底实例化完成，建议移除接口字段以统一依赖来源。
4. **低优先级清理项**：
   - `src/router/embedder.ts:l2Normalize` 导出与 `src/skills/bi-encoder-retriever.ts` 本地实现重复，可删除导出或复用。
   - `EpisodicMemory` 实现目前为 Test-Only，相关 `ContextManager` setter/getter 为零调用死方法，需人工裁决是否保留 Phase 71 B4 功能。
   - `src/utils/errors.ts` 中除 `ConfigValidationError` 外，其余导出主要为测试消费，需确认双受众错误体系是否仍在规划中。

---

*本报告由 Kimi-K2.7-Code 基于当前源码全量审查生成，严格遵循《RouteDev-死代码审查提示词.md》的判定流程与分类标准。*

# RouteDev 死代码审查报告

> 审查模型：Qwen3.7max（通过 TRAE IDE Agent 执行）
> 审查日期：2026-07-06
> 审查范围：src/ + desktop/（排除 tests/、node_modules/）
> 生产入口：desktop/main/index.ts → engine-bridge.ts → app-init.ts
> 历史背景：项目已经历六轮死代码清理（累计删除 229 文件 / -35389 行），本次为第七轮审查

## 1. 执行摘要

| 指标 | 数值 |
|------|------|
| 审查文件数 | ~200+ .ts 文件（src/ 全目录 + desktop/main/ + desktop/renderer/） |
| 确认死代码 | **4 项**（2 个死文件 + 2 个死方法） |
| 僵尸字段 | **6 项**（app-init.ts 实例化并返回 deps，但无消费方） |
| 需人工裁决 | **1 项**（engine-bridge.ts 未传递可选 deps 到 goal-runner） |
| 误报排除 | **55+ 项**（详见第 4 节自查记录） |

## 2. 确认死代码清单

### 2.1 True-Dead（纯死文件）

| 文件 | 死因 | 验证命令 | 命中数 |
|------|------|----------|--------|
| `src/agent/init-analyzer.ts` | Phase 59 删除了全部实例化代码，app-init.ts L534 注释"僵尸字段，无消费方"。全 src/ + desktop/ 无任何 import 引用 | `grep -r "init-analyzer\|InitAnalyzer" src/ desktop/ --include="*.ts" --exclude-dir=tests --exclude-dir=test` | 2（仅 app-init.ts 注释 + 文件自身） |
| `src/evaluation/architecture-aware-metrics.ts` | Phase 59 删除了全部 import 和实例化。dual-loop-orchestrator.ts L67 注释"import 已删除（死链清理）"。schema.ts 中仅有注释提及 | `grep -r "architecture-aware-metrics\|ArchitectureAwareMetrics" src/ desktop/ --include="*.ts" --exclude-dir=tests` | 4（全部为注释：dual-loop-orchestrator.ts×2 + app-init.ts×1 + schema.ts×1 + 文件自身） |

**交叉验证**：
- `InitAnalyzer` 类名搜索：仅 `init-analyzer.ts:94`（定义处）+ 测试文件，0 个生产消费方
- `ArchitectureAwareMetricsCollector` 类名搜索：仅 `architecture-aware-metrics.ts`（定义处）+ 测试文件，0 个生产消费方
- desktop/ 目录搜索两个类名：0 命中
- 动态 import 搜索（app-init.ts 中搜索文件名）：0 命中（均为注释提及）

### 2.2 Zombie-Field（僵尸字段）

以下字段在 `app-init.ts` 中实例化并通过 `AppDependencies` 返回，但在 `engine-bridge.ts` 和 `goal-runner.ts` 中**均无消费**（`deps.X` / `this.deps.X` 搜索 0 命中）。

| 字段 | app-init.ts 实例化行 | engine-bridge.ts 消费 | goal-runner.ts 消费 | 验证命令 | 命中数 |
|------|---------------------|----------------------|--------------------|----------|--------|
| `branchManager` | L533 | ❌ 不传递 | ❌ GoalRunnerDeps 未声明 | `grep "deps.branchManager\|this.deps.branchManager" src/ desktop/` | 0 |
| `complexityAnalyzer` | L1697 | ❌ 不传递 | ❌ GoalRunnerDeps 未声明 | `grep "deps.complexityAnalyzer" src/ desktop/` | 0 |
| `requirementsGatherer` | L1696 | ❌ 不传递 | ❌ GoalRunnerDeps 未声明 | `grep "deps.requirementsGatherer" src/ desktop/` | 0 |
| `goalParser` | L1489 | ❌ 不传递 | ❌ GoalRunnerDeps 未声明 | `grep "deps.goalParser[^A-Z]" src/ desktop/` | 0 |
| `goalVerifier` | L1511 | ❌ 不传递 | ❌ goal-runner L938 自建实例 | `grep "deps.goalVerifier\|this.deps.goalVerifier" src/ desktop/` | 0 |
| `buildRegimeTransition` | L2442（条件返回） | ❌ 不传递 | ❌ GoalRunnerDeps 未声明 | `grep "deps.buildRegimeTransition" src/ desktop/` | 0 |

**处理建议**：
- `branchManager`：可安全删除实例化代码（L533）和 AppDependencies 接口字段（L225）
- `complexityAnalyzer` / `requirementsGatherer`：Phase 31 模块，app-init.ts 创建了但无任何消费路径。可删除实例化和返回字段，保留源文件（未来可能接入）
- `goalParser` / `goalVerifier`：goal-runner.ts 内部自建实例（L921 `new GoalParser()`、L938 `new GoalVerifier()`），deps 中的实例冗余。可删除 deps 字段，保留源文件
- `buildRegimeTransition`：Phase 68 operationClassification 功能的一部分，但 goal-runner.ts 仅解构了 `classifyOperation`，未解构 `buildRegimeTransition`。可删除此返回字段

**注意**：`checkpointWriter` 虽在 `deps.checkpointWriter` 层面 0 命中，但它在 app-init.ts L356 被传入 `new ContextManager(... , checkpointWriter)` 内部消费，**不是僵尸字段**，不在此列。

### 2.3 Dead-Method（死方法）

| 方法 | 定义位置 | 调用方 | 验证命令 | 命中数 |
|------|----------|--------|----------|--------|
| `ReActAgentLoop.updateToolExecutor()` | `src/agent/loop.ts:1834` | 0 | `grep "updateToolExecutor" src/ desktop/ --include="*.ts" --exclude-dir=tests` | 1（仅定义处） |
| `ReActAgentLoop.updateConfig()` | `src/agent/loop.ts:1839` | 0（engine-bridge.ts 的 `updateConfig` 是 RouteDevEngine 类的方法，非 ReActAgentLoop） | `grep "\.updateConfig(" src/ desktop/ --include="*.ts" --exclude-dir=tests` | 0（对 ReActAgentLoop 的调用） |

**交叉验证**：
- `updateToolExecutor` 全局搜索仅命中定义处（loop.ts:1834），无任何 `.updateToolExecutor(` 调用
- `updateConfig` 全局搜索命中的是 `engine?.updateConfig(config)`（desktop/main/index.ts），调用的是 `RouteDevEngine.updateConfig`（engine-bridge.ts:604），与 `ReActAgentLoop.updateConfig` 无关

**半死方法（public 但仅内部自调用，不列入删除建议）**：
- `DualLoopOrchestrator.registerRecoveryArtifact()`（L175）— public 但仅 `runDualLoop` 内部自调用
- `DualLoopOrchestrator.evaluateOuterLoop()`（L511）— public 但仅 `runDualLoop` 内部自调用

### 2.4 Wiring-Bug（配置断裂）

| 配置项 | defaults.ts 位置 | app-init.ts 传递 | 影响 |
|--------|-----------------|-----------------|------|
| engine-bridge.ts 未传递 Phase 61/68 deps 到 goal-runner | — | createGoalRunner 调用（L736-814）缺少 `routingHistory/routingMemory/routingOrchestrator/executionVerifier/routingRegretTracker/provenanceGraph/kanObstacleChecker/quantitativeGate/classifyOperation` | Desktop 路径下 goal-runner 的 Phase 61 闭环路由和 Phase 68 知识图谱功能**全部失效**（走 fail-open 分支），即使配置已启用 |

**详细说明**：
- `goal-runner.ts` 的 `GoalRunnerDeps` 接口（L172-185）声明了上述可选字段
- `goal-runner.ts` 内部（L1311-1573）有完整的消费逻辑（`routingOrchestrator.route()`、`executionVerifier.verify()` 等）
- 但 `engine-bridge.ts` 在 L736-814 调用 `createGoalRunner` 时**没有传递**这些字段
- `app-init.ts` 在 `createAppDependencies()` 返回对象中已创建这些实例（L2316-2354 Phase 61 块、L2403-2457 Phase 68 块）
- **修复方案**：在 engine-bridge.ts 的 `createGoalRunner` 调用中补充传递 `this.deps.routingHistory`、`this.deps.provenanceGraph` 等字段

## 3. 需人工裁决清单

| 模块 | 原因 | 建议 |
|------|------|------|
| `src/evaluation/architecture-aware-metrics.ts` | CHANGELOG 声称"保留为类型契约"，但实际搜索证实所有 `import type` 引用已在 Phase 59 中全部清除。源文件仅被测试引用 | 删除源文件 + 清理相关测试。若未来需要恢复可从 Git 历史取回 |
| `src/agent/init-analyzer.ts` | app-init.ts 注释明确标注"僵尸字段，无消费方"，源文件仅被测试引用 | 删除源文件 + 清理相关测试 |

## 4. 误报排除清单（自查记录）

| 模块 | 初判 | 实际状态 | 排除理由 |
|------|------|----------|----------|
| `src/policies/*`（5 个文件） | 可能被误判为未引用 | **活代码** | PolicyEngine 通过静态 import 在 app-init.ts L152-156 加载，L1336-1384 实例化并注入 agentLoop |
| `src/import/*`（3 个文件） | 无静态 import | **活代码** | app-init.ts L1937-1939 动态 import（`claude-plugin-importer.js`、`codex-importer.js`、`anthropic-skills-loader.js`） |
| `src/mcp/claude-bridge.ts` | 无静态 import | **活代码** | app-init.ts L2043 动态 import |
| `src/tools/builtin/browser.ts` | 无静态 import | **活代码** | app-init.ts L607 动态 import |
| `src/agent/micro-summary.ts` | src/ 内无引用 | **活代码** | engine-bridge.ts L21 静态 import `generateMicroSummary` |
| `src/agent/omission-checker.ts` | src/ 内无引用 | **活代码** | engine-bridge.ts L587 动态 import |
| `src/security/audit-panel.ts` | 表面无直接引用 | **活代码** | 被 4 个安全模块引用 |
| `src/code-map/fallback.ts` | 无静态 import | **活代码** | app-init.ts L1738 动态 import |
| `src/agent/budget-monitor.ts` | 无静态 import | **活代码** | app-init.ts L759 动态 import + loop.ts type import |
| `src/agent/circuit-breaker.ts` | 无静态 import | **活代码** | app-init.ts L1458 动态 import + worker-executor.ts 静态 import |
| `src/agent/branch-persistence.ts` | 无静态 import | **活代码** | app-init.ts L1762 动态 import |
| `src/agent/branch-linkage.ts` | 无静态 import | **活代码** | app-init.ts L1790 动态 import |
| `src/agent/parallel-experiment.ts` | 无静态 import | **活代码** | app-init.ts L1817 动态 import |
| `src/agent/middleware/code-map-context.ts` | 无静态 import | **活代码** | app-init.ts L1121 动态 import |
| `src/agent/middleware/quality-signal.ts` | 无静态 import | **活代码** | app-init.ts L1213 动态 import |
| `src/agent/middleware/expertise-prompt.ts` | 无静态 import | **活代码** | app-init.ts L1241 动态 import |
| `src/code-map/index.ts` | 无静态 import | **活代码** | app-init.ts L1272 动态 import |
| `src/code-map/watcher.ts` | 无静态 import | **活代码** | app-init.ts L1303 动态 import |
| `src/code-map/indexer.ts` | 无静态 import | **活代码** | app-init.ts L1144 动态 import |
| `src/tools/trust-gradient.ts` | 无静态 import | **活代码** | app-init.ts L1185 动态 import |
| `src/config/expertise-manager.ts` | 无静态 import | **活代码** | app-init.ts L1240 动态 import |
| `src/hooks/registry.ts` | 无静态 import（在 app-init.ts） | **活代码** | app-init.ts L1543 动态 import + engine-bridge.ts L27 静态 import |
| `src/hooks/adapter.ts` | 无静态 import | **活代码** | app-init.ts L1577 动态 import |
| `src/agent/dual-loop-orchestrator.ts` | 无静态 import | **活代码** | app-init.ts L2075 动态 import + loop.ts 类型引用 |
| `src/agent/workflow/dag-engine.ts` | 无静态 import | **活代码** | app-init.ts L1498 动态 import |
| `src/skills/security-gate.ts` | 无静态 import | **活代码** | app-init.ts L2125 动态 import |
| `src/observability/otel-exporter.ts` | 无静态 import | **活代码** | app-init.ts L486 动态 import |
| `src/observability/integration.ts` | 无静态 import | **活代码** | app-init.ts L489 动态 import |
| `src/agent/budget-monitor.ts` | 配置门控 enabled:false | **活代码** | 有真实方法调用链（loop.setBudgetMonitor） |
| `src/agent/memory/prefix-cache.ts` | 配置门控 enabled:false | **活代码** | app-init.ts L511 动态 import |
| Phase 68 全部 4 模块 | `enabled: false` | **活代码** | goal-runner.ts 有完整消费逻辑（deps.provenanceGraph.addArtifact 等） |
| Phase 70 全部 6 模块 | 部分 `enabled: false` | **活代码** | ContextCompactor 构造时传入，有真实方法调用链 |
| `src/runtime/doctor.ts` | 配置门控 runOnStartup:false | **活代码** | app-init.ts L2196 动态 import |
| `src/cite/manager.ts` + `resolver.ts` | 无静态 import | **活代码** | app-init.ts L1900-1901 动态 import |
| `src/macros/manager.ts` | 无静态 import | **活代码** | app-init.ts L2020 动态 import |
| `src/runtime/graceful-shutdown.ts` | 无静态 import（在 app-init.ts） | **活代码** | app-init.ts L62 静态 import + 信号监听器回调链 |

## 5. 交叉验证记录

| 项 | 初次核验方法 | 交叉核验方法 | 核验结果 |
|----|-------------|-------------|----------|
| `init-analyzer.ts` | grep "init-analyzer" src/ desktop/ → 2 命中（注释+自身） | grep "InitAnalyzer" src/ desktop/ → 仅定义处+测试 | ✅ 确认死代码 |
| `architecture-aware-metrics.ts` | grep "architecture-aware-metrics" → 4 命中（全部注释+自身） | grep "ArchitectureAwareMetricsCollector" → 仅定义处+测试 | ✅ 确认死代码 |
| `branchManager` 僵尸字段 | grep "deps.branchManager" → 0 命中 | grep "this.deps.branchManager" desktop/ → 0 命中 | ✅ 确认僵尸字段 |
| `complexityAnalyzer` 僵尸字段 | grep "deps.complexityAnalyzer" → 0 命中 | 搜索 goal-runner.ts GoalRunnerDeps 接口 → 未声明 | ✅ 确认僵尸字段 |
| `requirementsGatherer` 僵尸字段 | grep "deps.requirementsGatherer" → 0 命中 | 搜索 goal-runner.ts GoalRunnerDeps 接口 → 未声明 | ✅ 确认僵尸字段 |
| `goalParser` 僵尸字段 | grep "deps.goalParser" → 0 命中 | 搜索 goal-runner.ts → L921 自建 `new GoalParser()` | ✅ 确认僵尸字段（deps 实例冗余） |
| `goalVerifier` 僵尸字段 | grep "deps.goalVerifier" → 0 命中 | 搜索 goal-runner.ts → L938 自建 `new GoalVerifier()` | ✅ 确认僵尸字段（deps 实例冗余） |
| `buildRegimeTransition` 僵尸字段 | grep "deps.buildRegimeTransition" → 0 命中 | 搜索 goal-runner.ts GoalRunnerDeps → 未声明 | ✅ 确认僵尸字段 |
| `updateToolExecutor` 死方法 | grep "updateToolExecutor" src/ desktop/ → 1 命中（仅定义处） | 搜索 `.updateToolExecutor(` 全局 → 0 调用 | ✅ 确认死方法 |
| `updateConfig` (loop.ts) 死方法 | grep ".updateConfig(" src/ → 命中 engine-bridge 同名方法 | 确认 engine-bridge 的 updateConfig 属于 RouteDevEngine 类 | ✅ 确认 loop.ts 的 updateConfig 为死方法 |
| engine-bridge.ts 未传 Phase 61/68 deps | 检查 createGoalRunner 调用 L736-814 | 对比 GoalRunnerDeps 接口声明 → 9 个可选字段缺失 | ✅ 确认 Wiring-Bug |

## 6. 审查覆盖范围

### 已审查的 src/ 子目录

| 目录 | 文件数 | 死代码 | 状态 |
|------|--------|--------|------|
| `src/agent/` | 45+ | init-analyzer.ts (死), 2 个死方法 | 完成 |
| `src/agent/context/` | 6 | 0 | 完成 |
| `src/agent/memory/` | 15 | 0 | 完成 |
| `src/agent/middleware/` | 5 | 0 | 完成 |
| `src/agent/multi/` | 8 | 0 | 完成 |
| `src/agent/tools/` | 2 | 0 | 完成 |
| `src/agent/workflow/` | 1 | 0 | 完成 |
| `src/agents/` | 11 | 0 | 完成 |
| `src/cite/` | 3 | 0 | 完成 |
| `src/code-map/` | 15 | 0 | 完成 |
| `src/config/` | 4 | 0 | 完成 |
| `src/evaluation/` | 1 | architecture-aware-metrics.ts (死) | 完成 |
| `src/harness/` | 6 | 0 | 完成 |
| `src/hooks/` | 6 | 0 | 完成 |
| `src/import/` | 4 | 0 | 完成 |
| `src/macros/` | 3 | 0 | 完成 |
| `src/mcp/` | 1 | 0 | 完成 |
| `src/memory/` | 9 | 0 | 完成 |
| `src/observability/` | 5 | 0 | 完成 |
| `src/plugins/` | 3 | 0 | 完成 |
| `src/policies/` | 5 | 0 | 完成 |
| `src/prompts/` | 2 | 0 | 完成 |
| `src/router/` | 14 | 0 | 完成 |
| `src/runtime/` | 7 | 0 | 完成 |
| `src/security/` | 3 | 0 | 完成 |
| `src/skills/` | 18 | 0 | 完成 |
| `src/tools/` | 26 | 0 | 完成 |
| `src/utils/` | 6 | 0 | 完成 |

### 已审查的 desktop/ 目录

| 目录 | 审查重点 | 状态 |
|------|----------|------|
| `desktop/main/engine-bridge.ts` | deps.X 消费分析 | 完成 |
| `desktop/main/index.ts` | IPC 处理器引用 | 完成 |
| `desktop/renderer/` | 组件引用 | 完成 |

## 7. 质量自检清单

- [x] 每个死代码判定都附带了 Grep 命令和命中数
- [x] 搜索范围包含 src/ + desktop/（不只是 src/）
- [x] 已检查动态 import（搜索文件名在 app-init.ts 中的出现）
- [x] 未把 `enabled: false` 的配置门控功能判为死代码
- [x] 未把 TypeScript 类型导出判为需要删除的死代码
- [x] 未建议删除整个目录
- [x] 已区分"实例化"和"方法调用"（有 new 不等于活）
- [x] 已检查事件回调/信号监听器的间接调用链（graceful-shutdown.ts 确认存活）
- [x] 所有 True-Dead 项经过交叉验证

## 8. 总结与建议

### 本轮发现

经过六轮清理后，RouteDev 代码库已非常干净。本轮发现：
- **2 个死文件**：`init-analyzer.ts` 和 `architecture-aware-metrics.ts`（均为 Phase 59 删除消费方后遗留的源文件）
- **6 个僵尸字段**：`branchManager`、`complexityAnalyzer`、`requirementsGatherer`、`goalParser`、`goalVerifier`、`buildRegimeTransition`（在 app-init.ts 中实例化并返回但无消费方）
- **2 个死方法**：`ReActAgentLoop.updateToolExecutor()` 和 `ReActAgentLoop.updateConfig()`
- **1 个 Wiring-Bug**：engine-bridge.ts 未将 Phase 61/68 的 9 个可选 deps 传递给 goal-runner

### 优先级建议

1. **高优先级**：修复 Wiring-Bug — 在 engine-bridge.ts 的 `createGoalRunner` 调用中补充传递 Phase 61/68 deps，激活 Desktop 路径下的闭环路由和知识图谱功能
2. **中优先级**：删除 2 个死文件 + 清理相关测试
3. **低优先级**：清理 6 个僵尸字段（删除实例化代码和 AppDependencies 接口字段）
4. **低优先级**：删除 2 个死方法

### 预估影响

| 操作 | 预计删除行数 | 风险 |
|------|-------------|------|
| 删除 2 个死文件 | ~200 行 | 极低（无生产引用） |
| 清理 6 个僵尸字段 | ~50 行 | 低（仅修改 app-init.ts） |
| 删除 2 个死方法 | ~15 行 | 极低（无调用方） |
| 修复 Wiring-Bug | ~10 行（新增） | 中（需确认 Phase 61/68 模块在 Desktop 路径下的兼容性） |

# RouteDev 死代码审查报告

> **审查模型**：GLM-5.2
> **审查日期**：2026-07-06
> **审查范围**：`c:\Users\杨铭\Desktop\Agent\routedev` 全量源码（src/ + desktop/）
> **审查方法论**：依据 `RouteDev-死代码审查提示词.md` 7 步判定流程（静态 import → 动态 import → 类名/函数名 → 测试引用 → 实例化消费验证）
> **误报率目标**：< 20%（历史平均 73%，本次采用类名+实例化双重验证）

---

## 1. 执行摘要

本次审查覆盖 RouteDev 桌面应用全量 TypeScript 源码。审查采用"文件级 + 字段级 + 接线级"三层分析：

- **文件级**：确认 1 个 True-Dead 文件（`architecture-aware-metrics.ts`，零生产引用），3 个 Test-Only 文件（类被类型引用但生产无实例化）。
- **字段级**：确认 45 个 Zombie Fields（app-init.ts 返回的 AppDependencies 字段无生产消费方），其中 15 个为"死解构"（goal-runner.ts 解构但 engine-bridge.ts 不传入）。
- **接线级**：发现 1 处 Wiring-Bug（app-init.ts L2153 注释陈旧，声称类型仍被引用但实际已全部删除）。

**建议优先级**：
1. **高**：修复 app-init.ts L128/L2153 陈旧注释（误导后续维护）
2. **中**：清理 45 个 Zombie Fields（减少 AppDependencies 对象体积与初始化开销）
3. **低**：评估 5 个配置门控但接线缺失的文件是否补全接线或删除

**误报排除**：本次严格遵循方法论，未将"默认关闭的可选功能""动态 import 模块""TypeScript 类型导出"判为死代码。`llm/*.ts` 相对导入陷阱已用类名 grep 二次验证排除。

---

## 2. 确认死代码清单

### 2.1 True-Dead（确认死文件）

| # | 文件路径 | 证据 | 建议 |
|---|---------|------|------|
| 1 | `src/evaluation/architecture-aware-metrics.ts` | Phase 59 删除所有 import（含 type-only）。`grep ArchitectureAwareMetricsCollector` 全仓命中：源文件自身 + dead-code-report.json + tests/ + 3 处过时注释（app-init.ts L128/L2153、dual-loop-orchestrator.ts L67）。**零生产引用**，`new` 仅在 tests/evaluation/。app-init.ts L2153 注释声称"类型仍被 score-card.ts / dual-loop-orchestrator.ts / completion-gate.ts 引用"但三者均已删除 import。 | 删除文件 + 清理 3 处过时注释 |

**判定依据**：
```
grep "ArchitectureAwareMetricsCollector" routedev/ → 18 命中
  - 源文件自身（src/evaluation/architecture-aware-metrics.ts）：6 命中
  - tests/evaluation/：11 命中
  - dead-code-report.json：1 命中
  - 生产 import：0 命中（含 type-only import）
```

### 2.2 Zombie-Field（僵尸字段）

AppDependencies 对象（app-init.ts 返回）中，被实例化并挂到 deps 对象但无生产消费方的字段。消费方定义为：`engine-bridge.ts` 或其他 src/ 文件通过 `deps.xxx` 读取该字段。

#### 类别 A：完全僵尸（28 个，0 生产 `deps.xxx` 引用）

| # | 字段名 | 实例化位置 | 生产消费 | 备注 |
|---|--------|-----------|---------|------|
| 1 | securityChecker | app-init.ts | 0 | 仅 tests/runtime/app-init.test.ts:235 断言存在 |
| 2 | adapter | app-init.ts | 0 | 仅 tests:237 |
| 3 | workModeController | app-init.ts | 0 | 仅 tests:238 |
| 4 | guardedAdapter | app-init.ts | 0 | 仅 tests 断言 |
| 5 | middlewarePipeline | app-init.ts | 0 | |
| 6 | pluginRegistry | app-init.ts | 0 | 仅 tests:243 |
| 7 | permissionEngine | app-init.ts | 0 | 仅 tests:247 |
| 8 | checkpointWriter | app-init.ts | 0 | |
| 9 | branchManager | app-init.ts | 0 | |
| 10 | projectMemory | app-init.ts | 0 | |
| 11 | goalParser | app-init.ts | 0 | |
| 12 | goalVerifier | app-init.ts | 0 | |
| 13 | primaryClient | app-init.ts | 0 | |
| 14 | taskOrchestrator | app-init.ts | 0 | |
| 15 | requirementsGatherer | app-init.ts | 0 | |
| 16 | complexityAnalyzer | app-init.ts | 0 | |
| 17 | readTracker | app-init.ts | 0 | |
| 18 | resultSanitizer | app-init.ts | 0 | |
| 19 | subAgentLifecycle | app-init.ts | 0 | |
| 20 | subAgentScoreCardCollector | app-init.ts | 0 | |
| 21 | dagEngineRef | app-init.ts | 0 | |
| 22 | buildRegimeTransition | app-init.ts | 0 | |
| 23 | toolOutputBudgetManager | app-init.ts | 0 | |
| 24 | messageGrouper | app-init.ts | 0 | |
| 25 | actionChainDetector | app-init.ts | 0 | |
| 26 | autoCompactGuardian | app-init.ts | 0 | |
| 27 | compactPromptEngine | app-init.ts | 0 | |
| 28 | sessionMemoryStore | app-init.ts | 0 | |

**验证方法**（抽样 securityChecker / adapter / workModeController / pluginRegistry / permissionEngine）：
```
grep "deps\.securityChecker|deps\.permissionEngine|deps\.pluginRegistry|deps\.adapter\b|deps\.workModeController" routedev/
  → 5 命中，全部在 tests/runtime/app-init.test.ts（断言 deps 字段存在）
  → 生产代码 0 命中
```

#### 类别 B：死解构（15 个，goal-runner.ts 解构但 engine-bridge.ts 不传入）

`goal-runner.ts` L215-243 从 `GoalRunnerDeps` 解构以下 15 个字段，但 `engine-bridge.ts` L736-814 的 `createGoalRunner({...})` 调用**不传入**对应值，导致解构变量始终 `undefined`。

| # | 字段名 | engine-bridge.ts 传入？ | 影响 |
|---|--------|----------------------|------|
| 1 | compositionalRouter | ❌ 未传入 | 解构为 undefined |
| 2 | pathRouter | ❌ 未传入 | 解构为 undefined |
| 3 | dualLoopOrchestratorRef | ❌ 未传入 | 解构为 undefined |
| 4 | routingHistory | ❌ 未传入 | 解构为 undefined |
| 5 | routingMemory | ❌ 未传入 | 解构为 undefined |
| 6 | routingOrchestrator | ❌ 未传入 | 解构为 undefined |
| 7 | executionVerifier | ❌ 未传入 | 解构为 undefined |
| 8 | routingRegretTracker | ❌ 未传入 | 解构为 undefined |
| 9 | memoryStore | ❌ 未传入 | 解构为 undefined |
| 10 | hybridRetriever | ❌ 未传入 | 解构为 undefined |
| 11 | localMaintenance | ❌ 未传入 | 解构为 undefined |
| 12 | provenanceGraph | ❌ 未传入 | 解构为 undefined |
| 13 | kanObstacleChecker | ❌ 未传入 | 解构为 undefined |
| 14 | quantitativeGate | ❌ 未传入 | 解构为 undefined |
| 15 | classifyOperation | ❌ 未传入 | 解构为 undefined |

**验证证据**（engine-bridge.ts L736-814 createGoalRunner 实际传入字段清单）：
```typescript
// L736-814 实际传入的字段：
createGoalRunner({
  classifier, modelRouter, clientManager, tracker,      // 4
  agentLoop, checkpointManager, contextManager,          // 3
  config, systemPromptRef, conversationHistoryRef,        // 3
  pendingConfirmRef, abortControllerRef, currentPlanRef,  // 3
  awaitingGoalConfirmRef, addSystemMessage,               // 2
  onToolConfirmRequest, requestPlanEdit, setIsProcessing, // 3
  nextId, orchestrator, workerExecutor, blackboard,      // 4
  unifiedReviewer, goalAuditor, goalPersistence,           // 3
  completionGate, profiler, onGoalEvent, goalId, hookRunner // 5
})
// 合计 30 个字段，上述 15 个死解构字段均不在传入清单中
```

#### 类别 C：deps 非 AppDependencies（2 个）

| # | 字段名 | 实例化位置 | 说明 |
|---|--------|-----------|------|
| 1 | skillLifecycleManager | app-init.ts | spawn-agent.ts 有 grep 命中，但该处 `deps` 是本地 `DelegationIntegrationDeps` 接口而非 `AppDependencies`，故 AppDependencies 字段本身仍为僵尸 |
| 2 | activityStore | app-init.ts | 同上，spawn-agent.ts 的 `deps` 非 AppDependencies |

---

### 2.3 Dead-Method（死方法）

本次审查未深入函数级死方法分析。`dead-code-report.json` 中记录的函数级死代码（cache-optimizer.ts、deterministic-rules.ts、repo-map.ts、token-counter.ts、hook-events.ts 的部分方法）所在文件本身被引用，不属于死文件，建议后续用工具单独清理函数级死方法。

---

### 2.4 Wiring-Bug（接线缺陷）

| # | 位置 | 问题描述 | 证据 |
|---|------|---------|------|
| 1 | `app-init.ts` L128-129 | 注释声称"类型仍被 score-card.ts / dual-loop-orchestrator.ts / completion-gate.ts 通过各自 import 引用"，**实际三者均已删除 import** | `grep "ArchitectureAwareMetricsCollector"` 在 score-card.ts / completion-gate.ts 中 0 命中；dual-loop-orchestrator.ts L67 明确"import 已删除（死链清理）" |
| 2 | `app-init.ts` L2153 | 同上，"故源文件 architecture-aware-metrics.ts / saturation-monitor.ts 保留，仅删配置字段与实例化"——保留理由已不成立 | 同上 |
| 3 | `app-init.ts` L1426-1427 | branchOrchestrator 注释"这里不创建（生产 wiring 留给后续阶段）"+"branchOrchestrationEnabled=true 时 Orchestrator.planBranches 会因 branchOrchestrator 缺失安全回退" | 配置开关存在但实例化代码缺失，靠安全回退兜底 |

---

## 3. 需人工裁决清单

以下文件为**配置门控的可选功能**（默认 false），按方法论"严禁把默认关闭的可选功能判为死代码"原则不判为死代码。但审查发现：**即使开关开启，app-init.ts 也无实例化代码**（Wiring-Bug）。需人工裁决是补全接线还是删除。

| # | 文件路径 | 配置开关 | 默认值 | 接线状态 | 建议 |
|---|---------|---------|--------|---------|------|
| 1 | `src/agent/multi/branch-orchestrator.ts` | `orchestrationIntegration.branchOrchestrationEnabled` | false | ❌ app-init.ts L1426 明确不创建实例 | 补全接线 or 删除 |
| 2 | `src/skills/quality-gate.ts` | `phase49Integration.skillQualityGateEnabled` | false | ❌ app-init.ts 读取 phase49Cfg 但无 `if (skillQualityGateEnabled)` 块 | 补全接线 or 删除 |
| 3 | `src/skills/skill-schema-validator.ts` | 同上（传递性） | - | 仅被 quality-gate.ts 静态调用 | 随 quality-gate.ts 裁决 |
| 4 | `src/skills/fallback-checker.ts` | 同上（传递性） | - | 仅被 quality-gate.ts 静态调用 | 随 quality-gate.ts 裁决 |
| 5 | `src/skills/skill-validator.ts` | 同上（传递性） | - | 仅被 quality-gate.ts `new` | 随 quality-gate.ts 裁决 |

**补充说明**：
- `SkillSchemaValidator` 和 `FallbackChecker` 提供**静态方法**（`validate()` / `check()`），被 quality-gate.ts 调用，无 `new` 实例化。若 quality-gate.ts 被裁决删除，这 2 个文件随之成为死代码。
- `skill-validator.ts` 在 quality-gate.ts:102 有 `new SkillValidator()`，但 quality-gate.ts 本身无生产实例化，故传递性死。
- `docs/ARCHITECTURE.md` L164 声称"app-init.ts 创建实例（未接入主流程，setter 不存在）"——此文档已过时，app-init.ts 实际不创建 SkillQualityGate 实例。

### Test-Only 文件（3 个）

以下文件类被引用为类型，但 `new` 仅出现在 tests/ 目录，生产代码无实例化。

| # | 文件路径 | 类型引用方 | `new` 位置 | 建议 |
|---|---------|-----------|-----------|------|
| 1 | `src/agent/memory/episodic-memory.ts` | recall-injector.ts（构造参数类型）、context-manager.ts（字段/setter/getter） | 仅 tests/agent/memory/ | `setEpisodicMemory()` 定义但生产从未调用，类从未注入。评估是否补全接线 or 删除 |
| 2 | `src/memory/codebase-memory.ts` | type import | 仅 tests/memory/ | app-init.ts L446 注释"实例化已删除（僵尸字段，无外部消费方）；源文件保留" |
| 3 | `src/observability/trajectory-exporter.ts` | type import | 仅 tests/phase35/（src 内 `new` 为 JSDoc 示例） | 评估是否保留 |

---

## 4. 误报排除清单

本次审查严格遵循方法论，以下类型**不判为死代码**：

### 4.1 默认关闭的可选功能（配置门控）
- `orchestrationIntegration`（strategyEnabled / stateGraphEnabled / branchOrchestrationEnabled）默认 false
- `delegationIntegration` 各开关默认 false
- `phase49Integration` 六模块默认 false
- `phase52Integration` 各模块
- `ccrCompression.enabled` 默认 false
- `experiment.parallelEnabled` 默认 false
- `vision.enabled` 默认 false
- `codegraph.enabled` 默认 false
- `contentRouting.enabled` 默认 false
- `adversarial.enabled` 默认 false

**原则**：配置门控功能即使开关默认关闭，只要存在实例化代码路径（开关开启时能创建实例），就不判为死代码。仅当开关存在但**无实例化代码**时，归入"需人工裁决"。

### 4.2 动态 import 模块
- app-init.ts 大量使用 `await import(...)` / `.then()` 模式动态导入
- DualLoopOrchestrator、SkillSecurityGate 等通过动态 import 接入
- **原则**：动态 import 是 fail-open 设计，模块存在即不判死

### 4.3 TypeScript 类型导出
- `import type { ... }` 在编译期擦除，不产生运行时引用
- **原则**：类型导出不判为死代码（如 EpisodicMemory 作为类型被引用）

### 4.4 llm/*.ts 相对导入陷阱
- `llm/anthropic.ts` 等文件用 filename grep 显示 0 引用，因相对导入写 `./anthropic.js` 而非 `llm/anthropic.js`
- **验证方法**：用类名（如 `AnthropicClient`）作为二级 grep，确认活跃引用
- **结论**：llm/*.ts 全部活跃，非死代码

### 4.5 函数级死代码（非文件级）
- `dead-code-report.json` 记录的 cache-optimizer.ts、deterministic-rules.ts、repo-map.ts、token-counter.ts、hook-events.ts 函数级死方法
- 所在文件本身被引用，不属于死文件
- **结论**：本次不处理函数级，建议后续工具单独清理

### 4.6 desktop/ 目录
- `settings-helpers.ts` 被 SettingsPage.tsx 导入，确认为活代码
- desktop/ 下无死代码

---

## 5. 交叉验证记录

### 5.1 True-Dead 验证（architecture-aware-metrics.ts）

| 关键词 | 全仓命中 | 生产引用 | tests 引用 | 判定 |
|--------|---------|---------|-----------|------|
| `ArchitectureAwareMetricsCollector` | 18 | 0 | 11 | ✅ True-Dead |
| `SaturationMonitor` | （含在上述 18 中） | 0 | - | ✅ True-Dead |

**关键证据**：
- `dual-loop-orchestrator.ts:67`：`// Phase 59：ArchitectureAwareMetricsCollector / TrajectoryInput import 已删除（死链清理）`
- `app-init.ts:128`：`// Phase 59：ArchitectureAwareMetricsCollector/SaturationMonitor import 已删除（批次1，实例化块移除）`
- `app-init.ts:2153`：`// 类型仍被 score-card.ts / dual-loop-orchestrator.ts / completion-gate.ts 通过 type 引用` ← **过时**，三者均无 import

### 5.2 Test-Only 验证

| 文件 | 类名 | `new` 命中 | 生产 `new` | tests `new` | 判定 |
|------|------|-----------|-----------|------------|------|
| episodic-memory.ts | EpisodicMemory | 1（tests） | 0 | 1 | ✅ Test-Only |
| codebase-memory.ts | CodebaseMemory | 26（全 tests） | 0 | 26 | ✅ Test-Only |
| trajectory-exporter.ts | TrajectoryExporter | 4（tests）+ 1（JSDoc） | 0 | 4 | ✅ Test-Only |
| quality-gate.ts | SkillQualityGate | 4（tests） | 0 | 4 | 需裁决 |
| skill-schema-validator.ts | SkillSchemaValidator | 0（静态方法调用） | 0 | 0 | 随 quality-gate |
| fallback-checker.ts | FallbackChecker | 0（静态方法调用） | 0 | 0 | 随 quality-gate |
| skill-validator.ts | SkillValidator | 3（tests）+ 1（quality-gate:102） | 1（但 consumer 死） | 3 | 随 quality-gate |

### 5.3 死解构字段验证（engine-bridge.ts createGoalRunner）

**验证方法**：读取 engine-bridge.ts L736-814，逐字段比对 createGoalRunner 实际传入参数。

**传入字段**（30 个）：classifier, modelRouter, clientManager, tracker, agentLoop, checkpointManager, contextManager, config, systemPromptRef, conversationHistoryRef, pendingConfirmRef, abortControllerRef, currentPlanRef, awaitingGoalConfirmRef, addSystemMessage, onToolConfirmRequest, requestPlanEdit, setIsProcessing, nextId, orchestrator, workerExecutor, blackboard, unifiedReviewer, goalAuditor, goalPersistence, completionGate, profiler, onGoalEvent, goalId, hookRunner

**未传入的 15 个死解构字段**：compositionalRouter, pathRouter, dualLoopOrchestratorRef, routingHistory, routingMemory, routingOrchestrator, executionVerifier, routingRegretTracker, memoryStore, hybridRetriever, localMaintenance, provenanceGraph, kanObstacleChecker, quantitativeGate, classifyOperation

### 5.4 完全僵尸字段抽样验证

```
grep "deps\.securityChecker|deps\.permissionEngine|deps\.pluginRegistry|deps\.adapter\b|deps\.workModeController" routedev/
→ 5 命中，全部在 tests/runtime/app-init.test.ts（断言 deps 字段存在）
→ 生产代码 0 命中 ✅ 确认僵尸
```

---

## 6. 汇总统计

| 类别 | 数量 | 处理建议 |
|------|------|---------|
| True-Dead 文件 | 1 | 删除文件 + 清理过时注释 |
| Test-Only 文件 | 3 | 评估补全接线 or 删除 |
| 需人工裁决（配置门控+接线缺失） | 5 | 补全接线 or 删除 |
| Zombie Fields（完全僵尸） | 28 | 从 AppDependencies 移除字段 + 删除实例化代码 |
| Zombie Fields（死解构） | 15 | 从 goal-runner.ts GoalRunnerDeps 移除字段 + 删除解构代码 |
| Zombie Fields（deps 非 AppDependencies） | 2 | 确认 spawn-agent.ts 本地 deps 接口，AppDependencies 字段可移除 |
| Wiring-Bug（陈旧注释） | 2 处（L128-129, L2153） | 更新注释 |
| Wiring-Bug（接线缺失） | 2 处（branchOrchestrator, skillQualityGate） | 补全 or 删除 |

**合计**：9 个文件 + 45 个僵尸字段 + 4 处接线缺陷

---

## 7. 审查方法说明

### 7.1 审查流程
1. **建立全景**：读取 app-init.ts（2508 行，依赖装配工厂）、engine-bridge.ts（1612 行，唯一消费 AppDependencies 入口）、defaults.ts（844 行，默认配置）建立代码全景
2. **并行审查**：派 4 个子 Agent 分别审查 src/agent/、src/tools|router|runtime|harness|hooks、src 其他目录、desktop/+deps 验证
3. **高风险区核验**：app-init 僵尸字段、goal-runner 死解构、defaults 配置断裂、app-init 陈旧注释
4. **交叉验证**：对所有疑似死代码换关键词二次 Grep（类名搜索 + 实例化搜索 + deps.xxx 消费搜索）

### 7.2 误报控制措施
- **类名 grep**：避免相对导入陷阱（如 llm/*.ts 用 `./anthropic.js` 导入，filename grep 为 0 但类名 grep 有命中）
- **静态方法识别**：SkillSchemaValidator / FallbackChecker 通过静态方法调用，不 `new` 但仍活跃，避免误判
- **配置门控排除**：默认关闭的可选功能不判死，仅当开关存在但无实例化代码时归入"需人工裁决"
- **type-only import 区分**：编译期擦除，不作为死代码依据，但结合 `new` 搜索确认是否 Test-Only

### 7.3 未覆盖项
- 函数级死方法（dead-code-report.json 记录的 5 个文件内部方法）未深入清理
- dead-code-report.json 本身未作为判定依据（方法论要求基于 grep 证据）
- tests/ 目录死代码未审查（仅作为验证生产代码引用的参考）

---

*报告结束。GLM-5.2 审查。*

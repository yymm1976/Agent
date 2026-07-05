# RouteDev 死代码全量审查报告

**审查工具/标注**: Claudesonnet  
**审查日期**: 2026-07-05  
**项目版本**: routedev 4.5.4  
**审查焦点**: 未被生产路径调用、功能残缺或未开启的死代码模块  

---

## 1. 执行摘要

本次审查以 `desktop/main/index.ts` → `RouteDevEngine` → `engine-bridge.ts` → `goal-runner.ts` 为主生产路径，结合 `app-init.ts` 依赖装配、配置默认值 `defaults.ts`、配置 schema 及设置页面组件，对 RouteDev 代码库进行全量死代码/半接入模块审计。

**核心结论**: 项目存在大量"已实例化但无生产消费"的高级模块，尤其是 Phase 62/66/67/69 整条执行链路通过 `ExecutionOrchestrator` 装配后却从未被 `goal-runner.ts` 调用，形成完整的死代码子系统。

---

## 2. 审查方法与可达性基线

### 2.1 生产入口路径

1. **Electron 桌面端**: `desktop/main/index.ts` → `RouteDevEngine` (`desktop/main/engine-bridge.ts`) → `engine.sendChat()` → `ReActAgentLoop.run()` / `/goal` 命令 → `goal-runner.ts`
2. **CLI 端**: `src/runtime/app-init.ts` 创建 `AppDependencies` → 注入 `ReActAgentLoop` / `GoalRunner` → 同上
3. **核心执行文件**: `src/runtime/goal-runner.ts` 负责 `/goal` 命令的 plan 执行；`src/agent/loop.ts` 负责普通聊天循环

### 2.2 判定标准

| 等级 | 判定条件 |
|------|----------|
| **Dead（死代码）** | 被 `app-init.ts` 实例化或导出，但无生产代码调用其公共方法；或源文件无任何生产 import |
| **Zombie（僵尸/半接入）** | 存在生产调用路径，但默认配置 `enabled: false` 且设置页无 UI 开关，用户无法启用 |
| **Test-only（仅测试）** | 仅被 `tests/` 或 `dead-code-report.json` 引用，无生产引用 |

---

## 3. 关键发现（按严重程度）

### 3.1 Critical：`ExecutionOrchestrator` 整条执行链路失联

- **位置**: `src/agent/execution-orchestrator.ts`
- **问题**: `app-init.ts` 在 L1965 调用 `createExecutionOrchestrator(...)` 并注入 Phase 62/66/67/69 全部模块，但 `goal-runner.ts` 完全未引用 `executionOrchestrator`，其 `execute()` 方法无任何生产调用者。
- **影响**: 以下所有被注入 ExecutionOrchestrator 的模块均沦为死代码：
  - **Phase 62 动态工作流**: `adversarialVerifier`, `rubricRegistry`, `loopUntilDoneGate`, `quarantineManager`, `actionAgentDispatcher`, `tournamentSelector`, `synthesizeBarrier`
  - **Phase 66 策略管道**: `checkpointPipeline`, `callOwnerCoordinator`, `stateSnapshotChain`, `reputationDeriver`
  - **Phase 67 推理质量诊断**: `miCrossScorer`, `snrAwareFilter`, `epistemicIntegrityChecker`, `qualityMetricsRecorder`
  - **Phase 69 Worktree 编排**: `worktreeManager`, `agentGroupResolver`
- **证据**:
  - `grep -n "ExecutionOrchestrator\|executionOrchestrator\|createExecutionOrchestrator" src/runtime/goal-runner.ts` 无结果
  - `grep -n "createExecutionOrchestrator" src/` 仅命中 `app-init.ts`
  - `ExecutionOrchestrator` 构造参数 `addSystemMessage: () => {}` 为空函数，进一步说明未接入真实消息通道

### 3.2 Critical：`EpistemicTokenProtector` 完全无生产消费

- **位置**: `src/agent/epistemic-token-protector.ts`
- **问题**: `app-init.ts` L1932 实例化并返回，但 `goal-runner.ts`、`execution-orchestrator.ts`、`loop.ts` 均未调用 `protectMessage()`。
- **影响**: Phase 67 中唯一完全没有生产消费的模块；配置 `reasoningQualityDiagnostics.epistemicTokenProtector.enabled: true` 但不起作用。
- **证据**: `grep -n "epistemicTokenProtector\|EpistemicTokenProtector" src/runtime/goal-runner.ts` 无结果

### 3.3 Important：Phase 65 记忆子模块半接入

- **位置**: `src/runtime/app-init.ts` L2677-2729
- **问题**: `memorySystem.enabled` 为 `true`，但仅以下模块被消费：
  - ✅ `memoryStore`（`goal-runner.ts` L1512 `memoryStore.write()`）
  - ✅ `hybridRetriever`（`goal-runner.ts` L1298 `hybridRetriever.retrieve()`）
  - ✅ `localMaintenance`（`goal-runner.ts` L1531 `localMaintenance.shouldMaintain()`）
  - ❌ `incrementalExtractor`：仅实例化，无生产调用
  - ❌ `conservativeMerger`：仅实例化，`goal-runner.ts` 解构后未使用
  - ❌ `rejectedAlternativeStore`：仅实例化，无生产调用
  - ❌ `bm25Index`：仅实例化，无生产调用
- **影响**: 记忆系统四模块中近一半为僵尸实例，占用启动资源但不产生价值。

### 3.4 Important：Phase 68/69/70 默认关闭且无 UI 开关

| 配置路径 | 默认值 | 设置页开关 | 状态 |
|----------|--------|------------|------|
| `phase68Integration.operationClassification.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase68Integration.provenanceGraph.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase68Integration.kanObstacleChecker.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase68Integration.quantitativeGate.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase69Integration.worktree.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase70Integration.toolOutputBudget.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase70Integration.microCompact.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase70Integration.contextCollapse.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase70Integration.compactPrompt.enabled` | `false` | ❌ 无 | 僵尸 |
| `phase70Integration.sessionMemory.enabled` | `false` | ❌ 无 | 僵尸 |
| `goal.difficultyRouting.enabled` | `false` | ❌ 无 | 僵尸 |
| `ccrCompression.enabled` | `false` | ❌ 无 | 僵尸 |
| `optimization.contentRouting.enabled` | `false` | ❌ 无 | 僵尸 |

- **影响**: 这些模块代码完整但默认关闭，且设置页面无对应开关，普通用户无法启用，形成"配置僵尸"。

### 3.5 Important：`ScheduleEngine` 空转

- **位置**: `src/scheduler/engine.ts`
- **问题**: `app-init.ts` L2141-2179 实例化并 `start()`，但整个 `src/` 中没有任何业务代码调用 `scheduleTask`、`listScheduledTasks` 或 `getNextRun`。
- **影响**: 定时任务引擎启动后空转，消耗定时器资源但无实际调度任务。

### 3.6 Important：Phase 52/53 部分开关默认关闭

- `phase52Integration.skillLifecycle.enabled: false` — 有 UI 开关（SettingsPhase52IntegrationTab）
- `phase53Integration.prefixCache.enabled: false` — 有 UI 开关（SettingsPhase53IntegrationTab）
- `phase53Integration.budgetMonitor.enabled: false` — 有 UI 开关（SettingsPhase53IntegrationTab）
- `orchestrationIntegration.strategyEnabled/stateGraphEnabled/branchOrchestrationEnabled: false` — 有 UI 开关（SettingsGoalTab）
- 这些模块虽默认关闭，但至少用户可通过设置页启用，风险低于无 UI 开关的僵尸模块。

### 3.7 Minor：`dead-code-report.json` 中大量仅类型/接口导出

- 现有死代码报告记录约 2209 条 dead exports、3286 条 test-only exports。
- 大量为 TypeScript 类型、接口、常量导出，对运行时无直接影响，但增加维护负担和编译时间。

---

## 4. 详细模块清单

### 4.1 生产路径完全未调用（Dead）

| 模块/文件 | 实例化位置 | 生产调用者 | 说明 |
|-----------|------------|------------|------|
| `src/agent/execution-orchestrator.ts` | `app-init.ts` L1965 | 无 | 整条执行子系统失联 |
| `src/agent/epistemic-token-protector.ts` | `app-init.ts` L1932 | 无 | 完全无消费 |
| `src/memory/incremental-extractor.ts` | `app-init.ts` L2686 | 无 | Phase 65 |
| `src/memory/conservative-merger.ts` | `app-init.ts` L2698 | 无（仅解构） | Phase 65 |
| `src/memory/rejected-alternative-store.ts` | `app-init.ts` L2699 | 无 | Phase 65 |
| `src/memory/bm25-index.ts` | `app-init.ts` L2706 | 无 | Phase 65 |
| `src/scheduler/engine.ts` | `app-init.ts` L2149 | 无（仅 start） | Phase 48 |
| `src/scheduler/cron-parser.ts` | `engine.ts` | 无外部调用 | Phase 48 |

### 4.2 通过 ExecutionOrchestrator 装配但整条链路死（Dead by Association）

| 模块/文件 | 在 ExecutionOrchestrator 中的使用 | 说明 |
|-----------|-----------------------------------|------|
| `src/agent/adversarial-verifier.ts` | L721 `advVerifier.verify()` | Phase 62 |
| `src/agent/rubric-registry.ts` | 注入 adversarialVerifier | Phase 62 |
| `src/agent/loop-until-done-gate.ts` | L1035 `loopUntilDoneGate.run()` | Phase 62 |
| `src/agent/action-agent-dispatcher.ts` | L808 `dispatch()` | Phase 62 |
| `src/agent/tournament-selector.ts` | L764 `select()` | Phase 62 |
| `src/agent/compose-pipeline.ts`（synthesizeBarrier） | L706 `synthesize()` | Phase 62 |
| `src/policies/checkpoint-pipeline.ts` | L452 `evaluateAction()` | Phase 66 |
| `src/policies/policy-engine.ts`（callOwnerCoordinator） | L476 | Phase 66 |
| `src/harness/state-snapshot-chain.ts` | L923 `writeSnapshot()` | Phase 66 |
| `src/memory/reputation-deriver.ts` | L948 `deriveReputation()` | Phase 66 |
| `src/evaluation/mi-cross-scorer.ts` | L860 `computeMIProxy()` | Phase 67 |
| `src/agent/snr-aware-filter.ts` | L834 `filter()` | Phase 67 |
| `src/agent/epistemic-integrity-checker.ts` | L882 `check()` | Phase 67 |
| `src/harness/quality-metrics-recorder.ts` | L904 `logWorkerDispatchWithRV()` | Phase 67 |
| `src/agent/multi/worktree-manager.ts` | L588 `create()` | Phase 69 |
| `src/agents/profiles/manager.ts`（agentGroupResolver） | L486 `register()` | Phase 69 |

### 4.3 默认关闭且无 UI 开关（Zombie）

| 配置键 | 对应模块文件 | 说明 |
|--------|--------------|------|
| `phase68Integration.operationClassification` | `src/skills/operation-classifier.ts` | 分类结果未影响后续路由 |
| `phase68Integration.provenanceGraph` | `src/memory/provenance-graph.ts` | 无持久化开关 UI |
| `phase68Integration.kanObstacleChecker` | `src/skills/kan-obstacle-checker.ts` | 默认 false |
| `phase68Integration.quantitativeGate` | `src/agent/quantitative-gate.ts` | 默认 false |
| `phase69Integration.worktree` | `src/agent/multi/worktree-manager.ts` | 默认 false |
| `phase70Integration.toolOutputBudget` | `src/agent/context-compaction.ts` 内 | 默认 false |
| `phase70Integration.microCompact` | 同上 | 默认 false |
| `phase70Integration.contextCollapse` | 同上 | 默认 false |
| `phase70Integration.compactPrompt` | 同上 | 默认 false |
| `phase70Integration.sessionMemory` | 同上 | 默认 false |
| `goal.difficultyRouting` | `src/agent/difficulty-assessor.ts` | 默认 false，无 UI |
| `ccrCompression.enabled` | `src/agent/ccr-cache.ts` | 默认 false，无 UI |
| `optimization.contentRouting.enabled` | `src/agent/memory/content-router.ts` | 默认 false，无 UI |

### 4.4 已正确接入的模块（白名单，供对比）

| 模块 | 消费位置 | 说明 |
|------|----------|------|
| `GoalAuditor` | `goal-runner.ts` 审计路径 | Phase 50，默认开启 |
| `GoalPersistence` | `goal-runner.ts` 状态保存 | Phase 50，默认开启 |
| `PathRouter` | `goal-runner.ts` 路径选择 | Phase 58 |
| `DagEngine` | `goal-runner.ts` DAG 执行 | Phase 53 |
| `DualLoopOrchestrator` | `loop.ts` L680 | Phase 55 |
| `BudgetMonitor` | `loop.ts` L1481 | Phase 53 |
| `MacroManager` | `loop.ts` L767 `expandMacros()` | Phase 48 |
| `CiteManager` / `CiteResolver` | `loop.ts` L1648 | Phase 48 |
| `PolicyEngine` | `loop.ts` L1088/1326 | Phase 42 |
| `ContextCompactor` + `autoCompactGuardian` | `context-manager.ts` | Phase 70，默认开启 |
| `RoutingOrchestrator` | `goal-runner.ts` L1340 | Phase 61 |
| `RoutingMemory/History/Verifier/RegretTracker` | `goal-runner.ts` L1423-1465 | Phase 61 |
| `MemoryStore/HybridRetriever/LocalMaintenance` | `goal-runner.ts` L1296-1535 | Phase 65 |
| `ProvenanceGraph/QuantitativeGate/OperationClassification` | `goal-runner.ts` L1312/1549/1572 | Phase 68（需手动开配置） |

---

## 5. 建议与修复优先级

### 5.1 P0（立即处理）

1. **决定 ExecutionOrchestrator 命运**
   - 选项 A：在 `goal-runner.ts` 中替换现有 `executePlanWithSingleAgent/Dag/Compose` 为 `executionOrchestrator.execute()`，真正启用 Phase 62/66/67/69。
   - 选项 B：如短期无接入计划，删除 `app-init.ts` 中 ExecutionOrchestrator 及其全部子模块实例化，减少启动开销和认知负担。
   - **推荐**: 选项 A 需评估回归风险；选项 B 更保守，适合当前以稳定为主的版本。

2. **清理或接入 `EpistemicTokenProtector`**
   - 要么在 `goal-runner.ts` 发送消息前调用 `protectMessage()`，要么删除该模块及配置，避免"启用但无效"的误导。

### 5.2 P1（高优先级）

1. **Phase 65 记忆模块去留**
   - 删除 `incrementalExtractor`、`conservativeMerger`、`rejectedAlternativeStore`、`bm25Index` 的实例化，或补充其生产消费路径。
   - 若保留，需在 `goal-runner.ts` 中接入写入/合并/检索逻辑。

2. **ScheduleEngine 空转治理**
   - 如暂无定时任务功能，停止 `ScheduleEngine` 实例化，避免无意义轮询。
   - 或实现最小任务注册入口（如周期性清理、备份）。

3. **补齐无 UI 开关的僵尸配置**
   - 对 `phase68Integration`、`phase69Integration`、`phase70Integration`、`goal.difficultyRouting`、`ccrCompression`、`optimization.contentRouting` 等，要么：
     - 在设置页增加对应标签/开关；
     - 或从 schema/defaults 中删除，避免遗留无效配置。

### 5.3 P2（中优先级）

1. **梳理 `dead-code-report.json` 中的类型导出**
   - 使用 `ts-prune` 或类似工具识别真实未使用导出，优先删除纯类型/接口僵尸。

2. **建立模块接入门禁**
   - 新增模块时强制要求：生产消费点、配置开关、设置页 UI（如适用）、配套测试。
   - 在 CI 中增加"app-init 返回的依赖必须在 goal-runner.ts 或 loop.ts 中解构"的静态检查。

---

## 6. 结论

RouteDev 当前最大的死代码风险不是单个文件，而是 **Phase 62/66/67/69 通过 `ExecutionOrchestrator` 形成的一条完整高级执行链路被实例化但从未接入主执行路径**。这导致大量新开发模块处于"伪运行"状态，既消耗启动资源，又给用户造成"功能已启用"的错觉。

建议下个版本优先决策 ExecutionOrchestrator 的去留，并清理无生产消费的孤立实例；对默认关闭且无 UI 的高级功能，应要么补齐入口，要么从配置中移除，保持配置与 UI 的一致性。

---

*本报告由 Claudesonnet 基于当前代码库静态分析生成，未运行动态测试；修复后建议通过 `pnpm test` 与 `pnpm typecheck` 验证。*

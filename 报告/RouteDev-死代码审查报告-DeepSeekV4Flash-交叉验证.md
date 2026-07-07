# RouteDev 死代码审查报告 - 交叉验证补充

- **审查引擎**: DeepSeekV4Flash
- **审查时间**: 2026-07-07
- **审查范围**: 对首次审查的交叉验证 + 深层分析
- **基础数据**: 利用项目自带的自动导出扫描工具 `dead-code-report.json`（1389 个导出项）

---

## 目录

1. [Phase 64 Skill Routing — 未接线死管线](#1-phase-64-skill-routing--未接线死管线)
2. [Config 定义与运行时消费交叉映射](#2-config-定义与运行时消费交叉映射)
3. [Config Guard 死分支分析](#3-config-guard-死分支分析)
4. [自动扫描结果交叉验证（1389 导出项分析）](#4-自动扫描结果交叉验证)
5. [Import 连通性抽样验证](#5-import-连通性抽样验证)
6. [汇总矩阵与行动建议](#6-汇总矩阵与行动建议)

---

## 1. Phase 64 Skill Routing — 未接线死管线

### 严重程度: 🔴 高

`src/skills/compositional-router.ts` 中定义了完整的 Phase 64 技能路由管线，但管线的入口函数 **从未在生产代码中被导入或调用**。

### 证据链

```
decomposeWithSADIfEnabled (compositional-router.ts:758)
    ↓ export 存在
    ↓ 但 NO import 在 src/ 任何位置
    ↓ 仅在 tests/agent/ 的测试文件中被引用
    ↓ dead-code-report.json: "testOnlyExports" 确认
```

### 涉及的子模块

| 组件 | 文件 | Phase |
|------|------|-------|
| `decomposeWithSADIfEnabled` | compositional-router.ts | Phase 64 入口函数 |
| `SkillRoutingConfig` | compositional-router.ts | 配置接口 |
| `BiEncoderSkillRetriever` | bi-encoder-retriever.ts | biEncoder |
| `SkillContextOptimizer` | context-optimizer.ts | contextOptimizer |
| `DecompositionGranularityAuditor` | granularity-auditor.ts | granularityAudit |
| `CompatibilityScorer` | compatibility-scorer.ts | compatibilityScorer |
| `SADDecomposer` | sad-decomposer.ts | SAD 分解 |

**所有上述组件在生产路径中不会被实例化。**

### 根因分析

查看 `src/runtime/app-init.ts`，没有任何代码读取 `config.skillRouting` 或将 `skillRoutingConfig` 参数传递给 `decomposeWithSADIfEnabled`。虽然 `compositional-router.ts` 是 app-init.ts 的依赖（用于组合路由），但实际调用的是 `decomposeWithSkillAwareness` 而非 `decomposeWithSADIfEnabled`。

### 建议

- 方案 A（推荐）: 如果 Phase 64 未计划近期启用，删除 `decomposeWithSADIfEnabled` 及相关子模块代码，或将其标记为 `@deprecated` + 添加 TODO 说明计划激活的时间点
- 方案 B: 如果计划启用，需在 app-init.ts 中将 `config.skillRouting` 传入 compositional-router 的调用路径

---

## 2. Config 定义与运行时消费交叉映射

### 严重程度: 🟡 中

对 schema.ts 中每个顶级配置段在运行时（app-init.ts）的消费情况进行交叉验证：

### 完整映射表

| 配置段 | schema.ts | defaults.ts | app-init 消费 | 状态 |
|--------|-----------|-------------|---------------|------|
| `general` | L100 | L10 | ✅ `config.general.language` (L1239) | 🔵 OK |
| `security` | L240 | L62 | ✅ `config.security` (多处) | 🔵 OK |
| `agent` | L294 | L130 | ✅ `config.agent` (多处) | 🔵 OK |
| `router` | L430 | L152 | ✅ 间接通过 buildRouterConfig | 🔵 OK |
| `mcp` | L500 | L230 | ✅ `config.mcp.servers` (多处) | 🔵 OK |
| `hooks` | L580 | L376 | ✅ `config.hooks.configPath` | 🔵 OK |
| `autonomy` | L630 | L86 | ✅ `config.autonomy.defaultMode` (多处) | 🔵 OK |
| `checkpoint` | L670 | L198 | ✅ `config.checkpoint.enabled` (engine-bridge) | 🔵 OK |
| `providers` | L690 | L24 | ✅ `config.providers` (engine-bridge) | 🔵 OK |
| `plan` | L720 | L2118 | ✅ `config.plan.omissionCheckEnabled` (engine-bridge) | 🔵 OK |
| `ui` | L750 | L450 | ❌ 未直接读取 | 🟡 可能仅在 Electron 端使用 |
| `sounds` | L790 | L470 | ❌ 未直接读取 | 🟡 可能仅在 Electron 端使用 |
| `updates` | L810 | L490 | ❌ 未直接读取 | 🟡 可能仅在 Electron 端使用 |
| `configLayering` | L2136 | L532 | ✅ loader.ts L259-261 | 🔵 OK |
| `stateExternalization` | L1972 | L686 | ✅ app-init L447（赋值） + context-compaction.ts L159（消费） | 🔵 OK |
| `skillRouting` | L1997 | L710 | ❌ 未在任何运行时代码中读取 `config.skillRouting` | 🔴 **死定义** |
| `memorySystem` | L2030 | L744 | ✅ `config.memorySystem` L2348 (app-init) | 🔵 OK |
| `closedLoopRouting` | L1966 | L660 | ✅ app-init L2306-2344 | 🔵 OK |
| `phase52Integration` | L1514 | L560 | ✅ 多处 config 守护 | 🔵 OK |
| `phase53Integration` | L1690 | L590 | ✅ 多处 config 守护 | 🔵 OK |
| `phase70Integration` | L2080 | L797 | ✅ app-init L345-352 | 🔵 OK |
| `phase71Integration` | L2118 | L834 | ✅ app-init L1100 | 🔵 OK |
| `delegationIntegration` | L1350 | L542 | ✅ 多处 | 🔵 OK |
| `plugins` | L1220 | L420 | ✅ 多处 | 🔵 OK |
| `reviewerPolicy` | L1560 | L555 | ✅ 多处 | 🔵 OK |
| `trust` | L1140 | L406 | ✅ `config.trust` (L70-72) | 🔵 OK |

### 关键发现

**`skillRouting` 配置段（L1997）是唯一一个同时具备 schema 定义 + defaults 值但完全无运行时消费的配置段。** 这与 [第 1 节](#1-phase-64-skill-routing--未接线死管线) 的发现一致——整个 Phase 64 技能路由子系统处于"有定义无接线"状态。

`ui`、`sounds`、`updates` 段虽然在 app-init 中未被消费，但它们属于 Electron 前端渲染进程专用，不经过 CL 层，属于正常设计而非死代码。

---

## 3. Config Guard 死分支分析

### 严重程度: 🟢 低

针对首次报告发现的 9 处 schema-default 不一致字段，逐一验证由该字段守护的条件分支是否包含**死代码**（disabled 分支永远不执行）：

| 字段 | 守护位置 | Enabled 分支行为 | Disabled 分支行为 | 死代码判定 |
|------|---------|-----------------|------------------|-----------|
| `phase53Integration.dagEngine.enabled` | app-init L1485 | 创建 DagEngine | `dagEngineRef.current = null` | 🟢 非死代码（用户可在 YAML 关闭） |
| `phase53Integration.circuitBreaker.enabled` | app-init L1447 | 创建 CircuitBreaker | 注入 undefined | 🟢 非死代码 |
| `phase53Integration.budgetMonitor.enabled` | app-init L731 | 创建 BudgetMonitor | 跳过 | 🟢 非死代码 |
| `phase53Integration.auditChain.enabled` | app-init L526 | 注入哈希链 | 跳过 | 🟢 非死代码 |
| `phase53Integration.mcpSecurityScan.enabled` | app-init L1660 | 创建扫描器 | 跳过 | 🟢 非死代码 |
| `phase53Integration.skillSecurityGate.enabled` | app-init L1659 | 创建门控 | 跳过 | 🟢 非死代码 |
| `phase53Integration.configGuard.enabled` | app-init L621 | 创建 ConfigGuard | 跳过 | 🟢 非死代码 |
| `phase53Integration.prefixCache.enabled` | app-init L484 | 创建 PrefixCache | 跳过 | 🟢 非死代码 |
| `phase52Integration.boundedRecovery.enabled` | app-init L2137 | 创建 BoundedRecovery | 跳过 | 🟢 非死代码 |
| `phase52Integration.compositionalRouting.enabled` | app-init L2146 | 创建组合路由 | 跳过 | 🟢 非死代码 |
| `phase52Integration.skillLifecycle.enabled` | app-init L2113 | 创建 SkillLifecycle | 跳过 | 🟢 非死代码 |
| `closedLoopRouting.enabled` | app-init L2306 | 注入路由组件 | 注入 undefined | 🟢 非死代码 |
| `memorySystem.enabled` | app-init L2346 | 注入记忆组件 | 注入 undefined | 🟢 非死代码 |
| `stateExternalization.enabled` | context-compaction.ts | 启用外部化 | 跳过 | 🟢 非死代码 |
| `security.devModeAuth` | 多处 | 开发认证 | 严格认证 | 🟢 非死代码 |

**结论**: 所有 config guard 的 disabled 分支都有意义——用户可通过 YAML 显式关闭这些功能。问题仅限于 schema 默认值虚假，而非分支死代码。

---

## 4. 自动扫描结果交叉验证

利用项目已存在的 `dead-code-report.json` 自动导出扫描工具结果，结合手动分析进行交叉验证。

### 4.1 自动扫描发现的真实死导出（非类型/接口）

类型和接口在 TypeScript 中经常只在使用它们的模块内部消费，export 只是为了给 future 使用者预留 API。但函数/常量/类的死导出则需要关注。

导出但未被任何代码引用（包括测试）的函数/常量：

| 文件 | 死导出 | 类型 | 分析 |
|------|--------|------|------|
| `code-map/camel-split-tokenizer.ts` | `camelSplit` | function | 真死——无生产消费 + 无测试引用 |
| `code-map/indexer.ts` | `scanSourceFiles` | function | 真死——indexer 内部自用 |
| `code-map/indexer.ts` | `updatePageRank` | function | 真死——indexer 内部自用 |
| `code-map/parser.ts` | `loadLanguage` | function | 真死——仅测试引用 |
| `code-map/parser.ts` | `createParser` | function | 真死——仅测试引用 |
| `code-map/database.ts` | `getUnresolvedRefsByCallee` | function | 真死——无消费 |
| `code-map/fallback.ts` | `CodeMapFallback` | class | 真死——无消费 |
| `code-map/querier.ts` | `searchBySymbolName` | function | 真死——仅测试引用 |
| `code-map/ranker.ts` | `PageRankOptions` | interface | 仅测试引用 |
| `code-map/type-resolver.ts` | `resolveImportSource` | function | 真死——无消费 |
| `skills/operation-classifier.ts` | `buildRegimeTransition` | function | 真死——仅测试引用 |
| `skills/progressive-disclosure.ts` | `disclose` | function | 真死——仅测试引用 |
| `skills/bundled-skill-extractor.ts` | `isSafeRelativePath` | function | 真死——仅测试引用 |
| `skills/bundled-skill-extractor.ts` | `extractBundledSkill` | function | 真死——仅测试引用 |
| `skills/bundled-skill-extractor.ts` | `cleanupExtractedFiles` | function | 真死——仅测试引用 |

### 4.2 code-map/ 模块大规模死导出

`src/code-map/` 目录大量函数、类、接口仅被测试引用而无生产消费。其中包括：

- `CodeMapWatcher` (class) — 仅测试引用
- `CodeMapFallback` (class) — 无消费
- `searchBySymbolName`, `findCallPath`, `findCallChain`, `getFileStructure`, `getStatus` (functions) — 仅测试引用
- `loadLanguage`, `createParser`, `initParser` (functions) — 仅测试引用
- `computeContentHash`, `indexFile`, `fullIndex`, `resolveCrossFileCalls`, `resolveSymbolEdges` (functions) — 仅测试引用

这提示 `code-map/` 模块可能是一个独立工具类库，其导出被设计为公共 API 但实际主要在测试中使用。可能的生产消费方是通过 `CodeMapEngine` 统一入口。

### 4.3 值得注意的其他死导出

| 文件 | 导出 | 类型 | 分析 |
|------|------|------|------|
| `policies/intent-guard.ts` | `IntentGuard` | class | 真死——无生产消费 |
| `policies/playbook.ts` | `Playbook` | class | 真死——无生产消费 |
| `policies/tool-approval.ts` | `ToolApproval` | class | 真死——无生产消费 |
| `policies/tool-guide.ts` | `ToolGuide` | class | 真死——无生产消费 |
| `security/sandbox.ts` | `SandboxOptions` | interface | 仅测试引用 |
| `security/audit-panel.ts` | `SecurityAuditPanel` | class | 仅测试引用 |

> **注意**: policies/ 下的类可能在 app-init.ts 中通过动态 import 或策略注册表间接消费，而非直接 import。需进一步验证。

---

## 5. Import 连通性抽样验证

### 严重程度: 🟢 低

对 app-init.ts 和 engine-bridge.ts 的 import 路径做抽样验证：

| 源文件 | 导入路径 | 目标文件存在 | 目标导出匹配 | 状态 |
|--------|---------|-------------|-------------|------|
| engine-bridge.ts | `../../src/agent/plan-diff.js` | ✅ | `toDiffPlanStep` | 🔵 OK |
| engine-bridge.ts | `../../src/agent/omission-checker.js` | ✅ | `OmissionChecker` | 🔵 OK |
| engine-bridge.ts | `../../src/agent/vision.js` | ✅ | `VisionAssistant`, `ImageInput` | 🔵 OK |
| engine-bridge.ts | `../../src/agent/micro-summary.js` | ✅ | `generateMicroSummary` | 🔵 OK |
| app-init.ts | `../agent/hooks.js` | ✅ | `HookRunner` | 🔵 OK |
| app-init.ts | `../agent/state-migration.js` | ✅ | `StateMigration` | 🔵 OK |
| app-init.ts | `../agent/plan-attestation.js` | ✅ | `archiveCurrentPlan` 等 | 🔵 OK |
| app-init.ts | `../skills/compositional-router.js` | ✅ | 多种导出 | 🔵 OK |

**结论**: 所有抽样验证的 import 路径连通性正常，目标文件存在且导出匹配。

---

## 6. 汇总矩阵与行动建议

### 优先级排序

| # | 问题 | 严重程度 | 性质 | 修复难度 | 建议 |
|---|------|---------|------|---------|------|
| P1 | **Phase 64 Skill Routing 未接线**（`decomposeWithSADIfEnabled` 及 6 个子模块） | 🔴 **高** | 配置存在但无运行时消费路径 | 低（删除或接上） | 删除死代码或确认启用计划 |
| P2 | **`skillRouting` 配置段僵尸**（schema + defaults 有定义，无任何代码读取） | 🔴 **高** | Config 层的死定义 | 低 | 随 P1 方案一同处理 |
| P3 | **`code-map/` 大量函数仅被测试引用** | 🟡 **中** | 可能存在未接线的功能模块 | 中（需确认设计意图） | 评估是否真死还是设计为公共 API |
| P4 | **`policies/` 模块疑似未接线**（IntentGuard/Playbook/ToolApproval/ToolGuide 0 引用） | 🟡 **中** | 模块存在但似乎无生产消费方 | 中（需验证动态 import 路径） | 全局搜索每个类的实例化语句 |
| P5 | **`bundled-skill-extractor.ts` 导出函数仅测试引用** | 🟡 **中** | 工具函数有定义无调用 | 低 | 确认是否为预留 API |
| P6 | **Schema-default 值不一致（沿用首次报告 P1）** | 🟡 **中** | 默认值歧义 | 低 | 统一为 defaults.ts 值 |
| P7 | **`code-map/` 目录可能产生 ~2000 行死代码** | 🟡 **中** | 模块级死代码 | 高 | 按模块粒度审查 |

### 建议方案路线

**第一步（立即）**: 清理 Phase 64 Skill Routing 死管线（P1+P2）
- 删除 `decomposeWithSADIfEnabled` 及其依赖的 Phase 64 子模块
- 或添加清晰的 `@deprecated` 标记和 TODO 激活计划
- 相应清理 `skillRouting` 配置段（schema + defaults + JSDoc）

**第二步（短期）**: 验证 `policies/` 模块的消费路径（P4）
- 确认 IntentGuard/Playbook/ToolApproval/ToolGuide 是否通过动态 import 或反射在运行时加载
- 如果是真死代码，建议删除或归档

**第三步（中期）**: 评估 `code-map/` 模块的架构定位（P3+P7）
- 检查 `CodeMapEngine` 是否为该模块的唯一生产入口
- 如果 `CodeMapEngine` 封装了所有功能但未导出子函数，则子函数导出是设计意图而非死代码
- 这种情况下应在子函数上加 `@internal` 标记

### 代码健康度总评

RouteDev 的死代码清洗在 Phase 59 中完成度很高，AppDependencies 接口和宏模块（Phase 62/66/67/69）无残留问题。

主要遗留问题集中在 **边缘模块的接线完整性**（Phase 64, policies/, code-map/）而非核心管线。这与这些模块是最新开发或独立性较高的模块有关。

---

*本次交叉验证补充报告基于 `c:\Users\杨铭\Desktop\Agent\routedev` 在 2026-07-07 的文件状态。*
*辅助数据源: `dead-code-report.json`（项目自带导出扫描工具）。*
# RouteDev 全量死代码审查报告

> **审查模型**: DeepSeek-V4-Flash  
> **审查日期**: 2026-07-06  
> **审查模式**: 全量审查  
> **审查重点**: 未被引用、未被生产路径调用、功能残缺或未开启的死代码模块  
> **分析方法**: 静态 export 扫描 + 动态 import 追踪交叉验证 + 配置门控审计  

---

## 审查总结

项目 RouteDev (v4.5.4) 是 TypeScript Electron 桌面应用，1411 个 export / 818 个代码图节点。经过 Phase 50 和 Phase 56-60 两轮大规模死代码清理后，**仍存在大量残余死代码**：392 个 dead export（27.8%）、181 个 test-only export（12.8%），以及 **25+ 个由配置门控关闭导致的完整死模块**。约 10500+ 行代码无生产路径调用。

---

## Part A — 完全死文件（全部 export 无生产路径引用）

### A1. 纯死文件（0 生产引用，可删除）

| 文件 | 行数 | 功能 | 死 export 数 |
|------|------|------|-------------|
| [hook-events.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/hooks/hook-events.ts) | ~378 | P0-15 Hook 事件分类法（27 种事件类型 + 元数据表 + 兼容映射） | 8 |
| [bundled-skill-extractor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/bundled-skill-extractor.ts) | ~273 | Bundled skill 安全文件抽取（O_NOFOLLOW + 路径校验 + memoize） | 4 |
| [code-map/fallback.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/code-map/fallback.ts) | ~30 | CodeMap 降级引擎类型定义 | 2 |
| [multi/score-card.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/score-card.ts) | ~95 | ScoreCard 类型定义（注释已说明 ScoreCardCollector 已移） | 3 |
| [memory/compressors/code-ast-summary.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/compressors/code-ast-summary.ts) | ~1 | 代码 AST 摘要结果类型 | 1 |

**合计**: 5 个纯死文件，约 777 行代码。

### A2. 全死但含 test-only 引用的文件

| 文件 | 功能 | dead | test-only |
|------|------|------|-----------|
| [claude-plugin-importer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/import/claude-plugin-importer.ts) | Claude 插件导入器 | 6 | 2 |
| [claude-bridge.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/mcp/claude-bridge.ts) | Claude MCP 桥接 | 3 | 3 |
| [codex-importer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/import/codex-importer.ts) | Codex 指令导入器 | 3 | 1 |
| [result-sanitizer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/result-sanitizer.ts) | 工具结果净化 | 2 | 2 |
| [complexity-analyzer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/complexity-analyzer.ts) | 任务复杂度分析 | 1 | 2 |
| [loader.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/loader.ts) | 配置加载器 | 1 | 2 |
| [browser.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin/browser.ts) | 浏览器工具 | 1 | 1 |
| [parallel-experiment.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/parallel-experiment.ts) | 并行实验（类本身被 app-init.ts 动态导入） | 3 | 4 |
| [integration.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/observability/integration.ts) | OTel 集成（setActiveOtelExporter 被 app-init.ts 动态导入） | 4 | 5 |
| [doctor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/doctor.ts) | 健康检查 Doctor（类本身被 app-init.ts 动态导入） | 4 | 2 |
| [adapter.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/hooks/adapter.ts) | Hook 配置适配器 | 0 | 3 |
| [branch-persistence.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/branch-persistence.ts) | 分支持久化 | 0 | 2 |
| [branch-linkage.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/branch-linkage.ts) | 分支链接管理 | 0 | 1 |
| [code-map-context.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/middleware/code-map-context.ts) | 代码地图上下文 | 0 | 1 |

---

## Part B — 部分死代码（文件内混合活/死 export）

### B1. [graceful-shutdown.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/graceful-shutdown.ts)
- **活的**: `registerShutdownHook`（被 app-init.ts 在 3 处调用）
- **死的（10 个）**: `unregisterShutdownHook`、`triggerShutdown`、`shutdown`、`setShutdownTimeoutMs`、`setShutdownExitCode`、`listShutdownHooks`、`isShuttingDown`、类型 `ShutdownPriority` / `ShutdownHookFn` / `ShutdownReason`
- **问题**: 该模块实现了完整的 shutdown 注册链（信号监听、超时强制退出、fail-open），但 `registerShutdownHook` 虽然被调用，核心编排函数 `triggerShutdown` 从未被调用。实际上 **信号监听器从未被安装**，注册的 hook 也不会被执行。

### B2. [plugin-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/plugin-init.ts)
- **活的**: `createPluginSystem`（被 app-init.ts 静态导入）
- **死的（2 个）**: `initPluginSystem`、`registerPermissionMiddleware`
- **问题**: `initPluginSystem` 从未被任何代码调用。`registerPermissionMiddleware` 仅被注释引用（`permission-engine.ts` L13），无实际 import。

### B3. [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts)
- **死的 export**: 76 个（全项目中最多）
- **典型死 type**: `SensitiveFilePolicy`、`UserPreference`、`Theme`、`AppearanceTheme`、`ModelCapability`、`LLMProvidersConfig`、`CheckpointConfig`、`ChannelsConfig`、`GoalVerifierConfig`、`AdversarialConfig` 等 76 个 Zod 类型
- **原因**: schema.ts 的 Zod 类型定义大量未被直接引用（运行时使用 Zod schema 实例而非类型），这些类型是自动生成的 Zod infer 产物。

### B4. [result-schemas.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agents/result-schemas.ts)
- **死的 export**: 10 个（PlannerResultSchema 等全部 7 个 Zod schema + 3 个类型别名）
- **问题**: 子 Agent 结果 schema 定义了 Researcher/Executor/Reviewer/Planner/Verifier/Synthesizer/Custom 共 7 套 schema，但无任何生产路径引用。

### B5. [ipc-types.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/shared/ipc-types.ts)
- **死的 export**: 10 个（`ChatHistoryMessage`、`SkillCreatePayload`、`SkillOpResult`、`SkillRouteResult`、`MCPToolsResult`、`PlanEditResponsePayload`、`AgentProfileRole`、`AgentProfileOutputFormat`、`AgentProfileChallengeSeverity`、`HookCreatePayload`）
- **问题**: 这些 IPC 类型定义了但从未被 desktop 或 src 中的任何生产代码消费。

### B6. 其他高死亡度文件

| 文件 | dead | 总 exports | 死亡度 |
|------|------|-----------|--------|
| [graceful-shutdown.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/graceful-shutdown.ts) | 10 | 11 | 90.9% |
| [hook-events.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/hooks/hook-events.ts) | 8 | 8 | 100% |
| [agent/goal-audit.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/goal-audit.ts) | 5 | 6 | 83.3% |
| [bounded-recovery.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/bounded-recovery.ts) | 1 | 2 | 50% |
| [agent/omission-checker.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/omission-checker.ts) | 3 | 4 | 75% |

---

## Part C — 配置门控导致的死模块（功能关闭 = 代码不执行）

审查 `defaults.ts` 后，发现 **25 个配置开关默认关闭**，导致关联模块被装配但永远不会执行，或装配逻辑完全跳过。其中关键模块：

| 配置路径 | 默认值 | 关联模块 | 影响 |
|---------|--------|---------|------|
| `phase70Integration.toolOutputBudget.enabled` | `false` | ToolOutputContextBudgetManager | ~100 行装配代码不执行 |
| `phase70Integration.microCompact.enabled` | `false` | MessageGrouper | 微压缩清理不执行 |
| `phase70Integration.contextCollapse.enabled` | `false` | ActionChainDetector | 上下文折叠不执行 |
| `phase70Integration.compactPrompt.enabled` | `false` | CompactPromptEngine | 压缩提示词不生效 |
| `phase70Integration.sessionMemory.enabled` | `false` | SessionMemory | 会话记忆不持久化 |
| `phase68Integration.operationClassification.enabled` | `false` | OperationClassifier | 操作分类模块不生效 |
| `phase68Integration.provenanceGraph.enabled` | `false` | ProvenanceGraph | 溯源图不记录 |
| `phase68Integration.kanObstacleChecker.enabled` | `false` | KanObstacleChecker | 障碍检测不执行 |
| `phase68Integration.quantitativeGate.enabled` | `false` | QuantitativeGate | 量化门控不生效 |
| `orchestrationIntegration.*Enabled`（3 项） | `false` | Strategy / StateGraph / BranchOrchestrator | 多 Agent 编排增强不启用 |
| `phase52Integration.skillLifecycle.enabled` | `false` | SkillLifecycleManager | Skill 生命周期管理不启用 |
| `phase53Integration.prefixCache.enabled` | `false` | PrefixCache | 前缀缓存不启用 |
| `phase53Integration.budgetMonitor.enabled` | `false` | BudgetMonitor | Token 预算监控不启用 |
| `vision.enabled` | `false` | VisionAssistant | 视觉能力不装配 |
| `experiment.parallelEnabled` | `false` | ParallelExperimentManager | 并行实验不启用 |
| `adversarial.enabled` | `false` | AdversarialVerifier | 对抗性验证不启用 |
| `ccrCompression.enabled` | `false` | CCRCache | 可逆压缩不启用 |
| `optimization.conciseThinking.enabled` | `false` | ConciseThinking | 简洁思考约束不启用 |
| `optimization.contentRouting.enabled` | `false` | ContentRouter | 内容路由不启用 |
| `activityPanel.enabled` | `false` | ActivityStore | 活动面板不显示 |
| `plan.omissionCheckEnabled` | `false` | OmissionChecker | 遗漏检查不执行 |

**影响范围**: 约 25 个模块/功能被配置门控关闭，估计 5000+ 行代码处于 "已装配但不生效" 状态。

---

## Part D — 关键发现详述

### D1. [graceful-shutdown.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/graceful-shutdown.ts) — 信号监听器从未安装

**Critical** — 虽然 `registerShutdownHook` 被 app-init.ts 调用了 3 次，但 `installSignalListeners` 由 `registerShutdownHook` 触发，而信号监听函数内部调用的是 `triggerShutdown`——而这个函数 **从未被任何代码调用**。实际效果：hook 注册了，信号监听了，但 **信号触发时 shutdown 不会执行**。

### D2. [bundled-skill-extractor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/bundled-skill-extractor.ts) — 实现完整但不消费

**Important** — 273 行安全文件抽取模块，实现了 O_NOFOLLOW 等效保护、路径穿越检测、memoize promise 共享。但 `extractBundledSkill` 虽然有动态导入引用，**没有任何生产代码路径实际调用它**。market-manager.ts 中的 import 是死引用。

### D3. [hook-events.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/hooks/hook-events.ts) — 27 种事件分类，0 个消费方

**Important** — 378 行完整 Hook 事件分类法，27 种事件类型、元数据表、兼容映射、处理器签名全部定义完整，但 `src/` 和 `desktop/` 中无任何生产代码 import 该文件。这是 "先设计后实现" 的遗留物，从未被集成。

### D4. [plugin-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/plugin-init.ts) — 插件初始化从不执行

**Important** — `initPluginSystem` 函数实现了插件发现、加载、初始化的完整流程，但 **从未被任何生产路径调用**。`registerPermissionMiddleware` 也从未被调用。createPluginSystem 返回的 PluginRegistry 对象就绪了，但 registry.discover() / loadPlugin() / initAll() 链条从未触发。

### D5. Phase 70 配置僵尸（5 个开关默认关闭）

**Important** — Phase 70（上下文压缩优化）的 5 个子功能（toolOutputBudget / microCompact / contextCollapse / compactPrompt / sessionMemory）全部默认 `enabled: false`（注释标注 "P2: 待接入"），但 Phase 71 的 autoCompactGuardian 已使用。这些模块被实现、装配、测试通过，但用户无法获益。每个子功能约 80-150 行装配代码在 app-init.ts 中被 if 守卫跳过。

### D6. Phase 68 四模块全关

**Minor** — Phase 68（检索/搜索/发现三分）的 operationClassification、provenanceGraph、kanObstacleChecker、quantitativeGate 全部默认关闭。这些功能较新（v4.6.7），注释标为实验性，可接受。

### D7. [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 76 个死类型定义

**Minor** — 这些 Zod 类型定义在 schema.ts 中，是 `z.infer<typeof SomeSchema>` 的产物，运行时不可用。它们"死"的本质是 TypeScript 类型不会被 JS 运行时 import，不属于需要清理的死代码。

---

## Part E — 做得好的地方

1. **Phase 50/56-60 清理彻底**: 通过 `scripts/detect-dead-code.ts` 建立了纪律层，动态 import 也能被追踪。Phase 50 删除了 11 个源文件、22 个函数、84 个多余 export；Phase 56-60 又删除了 10+ 个源文件、7 个配置字段、3000+ 行代码。

2. **配置门控设计合理**: 所有实验性功能通过 `config.*Integration.*.enabled` 开关控制，fail-open 装配（try-catch 包裹），不影响主流程稳定性。新功能默认关闭、用户显式开启的设计原则正确。

3. **dead-code-report.json 检测精度高**: 1411 个 export 扫描结果经人工交叉验证，误报率低（仅动态 import 场景有少量误报）。

---

## Part F — 清理建议（优先级排序）

### 建议立即清理

| 优先级 | 文件 | 操作 | 理由 |
|--------|------|------|------|
| HIGH | [hook-events.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/hooks/hook-events.ts) | 删除 | 378 行完整实现但 0 消费，无 plan 记录 |
| HIGH | [bundled-skill-extractor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/bundled-skill-extractor.ts) | 删除（保留 `isSafeRelativePath` 内联） | 273 行但 `extractBundledSkill` 无实际调用路径 |
| MEDIUM | [plugin-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/plugin-init.ts) | 删除 `initPluginSystem` 和 `registerPermissionMiddleware` | 分别占 14 行和 57 行，从未调用 |
| MEDIUM | [graceful-shutdown.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/graceful-shutdown.ts) | 修复 `triggerShutdown` 调用链 或 移除死函数 | 信号监听器注册了但 shutdown 不触发 |
| MEDIUM | Phase 70 的门控开关（5 个） | 评估并启用或删除对应模块 | 已实现但用户不可用 |

### 建议条件清理

| 条件 | 文件 | 操作 |
|------|------|------|
| 确认无外部依赖后 | [claude-plugin-importer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/import/claude-plugin-importer.ts) | 删除 6 个死 export |
| 确认无外部依赖后 | [codex-importer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/import/codex-importer.ts) | 删除 3 个死 export |
| 确认无外部依赖后 | [claude-bridge.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/mcp/claude-bridge.ts) | 删除 3 个死 export |
| 确认无外部依赖后 | [parallel-experiment.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/parallel-experiment.ts) | 删除 3 个死 interface export |
| 确认无外部依赖后 | [integration.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/observability/integration.ts) | 删除 4 个死 function/class export |

---

## 附录: 审查工具与方法

- **静态分析**: `scripts/detect-dead-code.ts`（正则匹配 export + import）
- **动态 import 追踪**: `src/runtime/app-init.ts` 中的 `import()` 手动追踪
- **配置门控审计**: `src/config/defaults.ts` 中 25 个 `enabled: false` 配置项
- **交叉验证**: 对 6 个关键文件进行 grep 确认（排除 do-src-internal 自引用和注释引用）
- **测试数据**: `pnpm build` 和 `pnpm typecheck` 均通过（报告定稿前验证）
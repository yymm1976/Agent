# RouteDev 死代码全量审查报告（豆包 seedcode）

> **审查日期**：2026-07-06
> **审查工具**：`scripts/detect-dead-code.ts` + 手动交叉验证
> **审查范围**：`src/` 全目录 + `desktop/` 目录
> **入口白名单**：6 个文件（router/llm/index.ts, runtime/app-init.ts, desktop/main/index.ts, desktop/preload/index.ts, desktop/renderer/src/App.tsx, desktop/renderer/src/main.tsx）

---

## 审查总结

RouteDev 项目当前存在 **392 个死代码 export** 和 **181 个 test-only export**，占总 export 数（1411）的约 40.6%。其中部分标记为"死代码"的模块实际上在生产代码中有引用（如 `GoalAuditor`、`delegation-policy`），这是因为检测脚本只追踪从入口白名单出发的调用链。真正的死代码主要集中在：安全策略模块、导入工具模块、代码地图模块、记忆系统模块、技能系统模块、路由子模块等。

**结论**：项目存在大量未接入生产路径的模块，建议分阶段清理。

---

## Critical（完全未接入，可直接删除）

### 1. 安全策略模块 — 完全未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/policies/intent-guard.ts` | `IntentGuard` (class) | 无任何生产代码引用 |
| `src/policies/playbook.ts` | `Playbook` (class) | 无任何生产代码引用 |
| `src/policies/policy-engine.ts` | `PolicyTrigger`, `PolicyAction`, `PolicyEvalResult`, `AgentAction`, `PolicyDecision`, `PolicyType` | 无任何生产代码引用 |
| `src/policies/tool-approval.ts` | `ToolApproval` (class) | 无任何生产代码引用 |
| `src/policies/tool-guide.ts` | `ToolGuide` (class) | 无任何生产代码引用 |

**问题**：安全策略框架完整实现但未接入生产路径，`IntentGuard`、`Playbook`、`PolicyEngine` 等核心类从未被实例化。

**建议**：若确认不再使用，直接删除整个 `src/policies/` 目录。

---

### 2. 导入工具模块 — 完全未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/import/anthropic-skills-loader.ts` | `AnthropicSkillsLoader` (class), `LoadResult` | 无任何生产代码引用 |
| `src/import/claude-plugin-importer.ts` | `ClaudePluginImporter` (class), `PluginMetadata`, `ImportedAgentProfile`, `ImportedMCPRef`, `ImportedHook`, `PluginImportResult`, `ImportFromPathOptions`, `ImportedSkill` | 无任何生产代码引用 |
| `src/import/codex-importer.ts` | `CodexInstructionImporter` (class), `CodexScanResult`, `CodexImportResult`, `CodexImportOptions` | 无任何生产代码引用 |
| `src/import/tool-name-mapper.ts` | `mapToolName`, `reverseMapToolName`, `getToolNameMap`, `ToolNameMapResult`, `SkillToolsValidation` | 无任何生产代码引用 |

**问题**：完整的第三方插件导入体系（Anthropic Skills、Claude Plugin、Codex）已实现但从未接入。

**建议**：标记为技术债务，后续需要时接入；或确认不再支持时删除。

---

### 3. MCP Claude Bridge — 完全未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/mcp/claude-bridge.ts` | `ClaudeMCPBridge` (class), `BridgeImportOptions`, `BridgeExportResult`, `ClaudeMcpServerConfig`, `BridgeImportResult`, `ClaudeMcpConfig` | 无任何生产代码引用 |

**问题**：Claude MCP 桥接模块完整实现但未接入。

**建议**：与导入工具模块一起处理。

---

### 4. 代码地图模块 — 大量未使用功能

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/code-map/artifact.ts` | `ARTIFACT_REL_PATH`, `RUNTIME_DB_REL_PATH` | 常量未使用 |
| `src/code-map/camel-split-tokenizer.ts` | `camelSplit` | 函数未使用 |
| `src/code-map/database.ts` | `getUnresolvedRefsByCallee`, `FtsSearchHit`, `close` | 函数/类型未使用 |
| `src/code-map/extractor.ts` | `ExtractionResult` | 接口未使用 |
| `src/code-map/fallback.ts` | `CodeMapFallback` (class), `CodeMapEngine` | 类/类型未使用 |
| `src/code-map/indexer.ts` | `scanSourceFiles`, `updatePageRank`, `computeContentHash`, `indexFile`, `fullIndex`, `resolveCrossFileCalls`, `resolveSymbolEdges` | 大量函数未使用 |
| `src/code-map/languages/go.ts` | `GO_SYMBOL_NODE_TYPES`, `GoTypeSpecResult` | Go 语言支持未启用 |
| `src/code-map/languages/java.ts` | `JAVA_SYMBOL_NODE_TYPES` | Java 语言支持未启用 |
| `src/code-map/parser.ts` | `loadLanguage`, `createParser`, `initParser` | 解析器加载函数未使用 |
| `src/code-map/querier.ts` | `searchBySymbolName`, `findCallPath`, `findCallChain`, `getFileStructure`, `getStatus` | 查询函数未使用 |
| `src/code-map/ranker.ts` | `PageRankOptions` | PageRank 排名未启用 |
| `src/code-map/type-resolver.ts` | `resolveImportSource`, `FileImportInfo`, `FileImportMap`, `ExportedSymbolMap` | 类型解析未启用 |
| `src/code-map/token-counter.ts` | `freeEncoder` | 函数未使用 |
| `src/code-map/watcher.ts` | `CodeMapWatcher` (class) | 监控器未启用 |
| `src/code-map/git-integration.ts` | `getSeedNodeIdsFromGit` | Git 集成未启用 |

**问题**：代码地图模块的核心功能（索引、查询、监控、多语言支持）大部分未启用，仅基础解析功能被使用。

**建议**：评估哪些功能需要保留，删除确认不再使用的部分。

---

## Important（部分功能未启用，需确认）

### 1. 记忆系统模块 — 大量类型未使用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/memory/bm25-index.ts` | `BM25Doc`, `BM25SearchResult`, `tokenize` | BM25 索引未启用 |
| `src/memory/local-maintenance.ts` | `LocalMaintenanceConfig`, `MaintenanceResult`, `ShouldMaintainResult` | 本地维护未启用 |
| `src/memory/provenance-graph.ts` | `ProvenanceEdge`, `TypedArtifact`, `ProducingOperation` | 溯源图未启用 |
| `src/memory/hybrid-retriever.ts` | `ScoredMemoryEntry` | 混合检索未启用 |
| `src/memory/codebase-memory.ts` | `CodebaseEntry`, `CodebaseMemoryOptions` | 代码库记忆未启用 |
| `src/memory/unified-memory.ts` | `RetrieveOptions`, `UnifiedMemoryStore`, `MemorySource`, `UnifiedMemoryStoreImpl` | 统一记忆未启用 |
| `src/memory/memory-store.ts` | `MemoryStoreConfig` | 配置未使用 |

**问题**：记忆系统的高级功能（BM25、溯源图、混合检索、统一记忆）未启用，仅基础记忆存储被使用。

**建议**：确认这些功能是否为未来规划，若是则保留；否则删除。

---

### 2. 技能系统模块 — 部分技能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/skills/bundled-skill-extractor.ts` | `isSafeRelativePath`, `extractBundledSkill`, `cleanupExtractedFiles`, `ExtractEntry`, `ExtractResult` | 捆绑技能提取未启用 |
| `src/skills/granularity-auditor.ts` | `GranularityIssue`, `DAResult`, `GranularityIssueType` | 粒度审计未启用 |
| `src/skills/kan-obstacle-checker.ts` | `KanObstacleResult` | KAN 障碍检查未启用 |
| `src/skills/compatibility-scorer.ts` | `ScoredEdge` | 兼容性评分未启用 |
| `src/skills/progressive-disclosure.ts` | `DisclosureLevel` | 渐进式披露未启用 |
| `src/skills/operation-classifier.ts` | `RegimeTransition`, `OperationKind` | 操作分类未启用 |

**问题**：多个技能模块实现了类型定义但未接入生产路径。

**建议**：检查技能注册流程，确认是否遗漏接入；或删除未使用的技能。

---

### 3. 路由子模块 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/router/deterministic-rules.ts` | `BUILTIN_DETERMINISTIC_RULES`, `DeterministicRule`, `DeterministicMatchType`, `DeterministicHandler` | 确定性规则未启用 |
| `src/router/execution-verifier.ts` | `VerifierConfig`, `VerificationTrace` | 执行验证未启用 |
| `src/router/regret-tracker.ts` | `RegretCurvePoint`, `CumulativeRegretResult` | 后悔追踪未启用 |
| `src/router/routing-history.ts` | `DimensionStats` | 路由历史统计未启用 |
| `src/router/tracker.ts` | `TokenUsageRecord`, `TaskBudgetStatus` | 令牌追踪未启用 |
| `src/router/classifier.ts` | `ClassifierConfig`, `DeterministicTier`, `ExtendedScenarioTier` | 分类器配置未启用 |
| `src/router/types.ts` | `ToolCallContent`, `ToolCallResult`, `MessageRole`, `LLMErrorType` | 类型定义未使用 |
| `src/router/embedder.ts` | `SkillsHashEmbedder`, `l2Normalize` | 嵌入器未启用 |
| `src/router/orchestrator.ts` | `OrchestratorConfig`, `OrchestratorResult` | 编排器配置未启用 |
| `src/router/token-counter.ts` | `estimateTokenCount`, `estimateMessageTokens`, `estimateSystemPromptTokens` | 令牌估算未启用 |

**问题**：路由系统的高级功能（确定性规则、后悔追踪、令牌追踪、嵌入器）未启用。

**建议**：确认这些功能是否为未来规划，若是则保留；否则删除。

---

### 4. 安全模块 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/security/audit-panel.ts` | `SecurityEvent`, `SecurityEventFilter`, `SecuritySummary`, `SecurityEventLevel` | 审计面板未启用 |
| `src/security/integrity-manifest.ts` | `IntegrityRecord`, `VerifyResult` | 完整性校验未启用 |

**问题**：安全审计和完整性校验功能未启用。

**建议**：评估安全需求，决定是否启用或删除。

---

### 5. Observability 模块 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/observability/analytics-queue.ts` | `detachAnalyticsSink`, `getAnalyticsQueueStatus` | 分析队列未启用 |
| `src/observability/otel-exporter.ts` | `OtelConfig`, `OtelExporterStatus` | OTel 导出未启用 |
| `src/observability/integration.ts` | `setActiveOtelExporter`, `getActiveOtelExporter`, `getActiveOtelBridge`, `TrajectoryOtelBridge` (class), `TrajectoryEvent` | OTel 集成未启用 |
| `src/observability/trajectory-exporter.ts` | `TrajectoryExporter` (class) | 轨迹导出未启用 |

**问题**：可观测性的高级功能（OTel 导出、分析队列）未启用，仅基础轨迹收集被使用。

**建议**：确认是否需要 OTel 集成，若是则保留；否则删除。

---

### 6. Agent 子系统 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/agent/omission-checker.ts` | `Omission`, `OmissionCheckerOptions`, `OmissionCategory`, `OmissionChecker` (class) | 遗漏检查未启用 |
| `src/agent/quality-aggregator.ts` | `QualityAggregator` (class) | 质量聚合未启用 |
| `src/agent/quantitative-gate.ts` | `GateEvaluation`, `QuantitativeGateConfig`, `DEFAULT_GATE_CONFIG`, `CandidateSolution`, `GateDecision` | 量化门未启用 |
| `src/agent/unified-reviewer.ts` | `UnifiedReviewResult`, `REVIEW_SYSTEM_PROMPT`, `UnifiedReviewerDeps` | 统一审查未启用 |
| `src/agent/workflow/dag-engine.ts` | `DagExecutionResult`, `DagEngineOptions` | DAG 引擎未启用 |
| `src/agent/budget-aware-renderer.ts` | `BudgetSnapshot`, `BudgetLevel`, `BudgetRenderConfig` | 预算感知渲染未启用 |
| `src/agent/budget-monitor.ts` | `BudgetAlert`, `BudgetMonitorOptions` | 预算监控未启用 |
| `src/agent/circuit-breaker.ts` | `CircuitStats`, `CircuitBreakerConfig`, `CircuitState` | 熔断未启用 |
| `src/agent/content-deduplicator.ts` | `ContentDedupConfig`, `DedupResult` | 内容去重未启用 |
| `src/agent/context-compaction.ts` | `CompactionResult`, `StateExternalizationConfig` | 上下文压缩未启用 |
| `src/agent/difficulty-assessor.ts` | `DIFFICULTY_LEVEL_DEFINITIONS`, `DifficultyAssessorOptions` | 难度评估未启用 |
| `src/agent/dual-loop-orchestrator.ts` | `OuterLoopContext`, `BoundedRecoveryEvent`, `DualLoopEventWithRecovery`, `DEFAULT_MAX_RERUNS` | 双循环编排未启用 |
| `src/agent/path-router.ts` | `LevelPathSelection`, `LevelSwitchSignals`, `ExecutionRoute`, `ExecutionRouterOptions` | 路径路由未启用 |
| `src/agent/plan-diff.ts` | `ModifiedStep`, `FieldChange` | 计划差异未启用 |
| `src/agent/state-migration.ts` | `StateMigrationInput`, `StateMigrationResult` | 状态迁移未启用 |

**问题**：Agent 子系统的大量高级功能（遗漏检查、质量聚合、量化门、统一审查、DAG 引擎、预算监控、熔断、双循环编排等）未启用。

**建议**：确认这些功能是否为未来规划，若是则保留；否则删除。

---

### 7. 子 Agent 系统 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/agents/activity-store.ts` | `splitModelLabel`, `AgentActivityRecord` | 活动存储未启用 |
| `src/agents/context-packer.ts` | `ROLE_WEIGHTS` | 上下文打包未启用 |
| `src/agents/delegation-contract.ts` | `ChallengeRequest`, `ParentResponse` | 委托契约未启用 |
| `src/agents/delegation-gate.ts` | `DEFAULT_GATE_RULES` | 委托门未启用 |
| `src/agents/profiles/builtin-templates.ts` | `PLANNER_PROFILE`, `VERIFIER_PROFILE`, `SYNTHESIZER_PROFILE`, `RESEARCHER_PROFILE`, `EXECUTOR_PROFILE`, `REVIEWER_PROFILE` | 内置配置文件未启用 |
| `src/agents/result-schemas.ts` | `PlannerResultSchema`, `VerifierResultSchema`, `SynthesizerResultSchema`, `ResearcherResult`, `ExecutorResult`, `ReviewerResult`, `CustomResult`, `PlannerResult`, `VerifierResult`, `SynthesizerResult`, `ResearcherResultSchema`, `ExecutorResultSchema`, `ReviewerResultSchema`, `CustomResultSchema` | 结果模式未启用 |
| `src/agents/sub-agent-lifecycle.ts` | `SubAgentState` | 子 Agent 生命周期未启用 |
| `src/agents/subagent-session.ts` | `isSessionExpired` | 会话过期检查未启用 |

**问题**：子 Agent 系统的完整体系（活动存储、上下文打包、委托契约、内置配置文件、结果模式）未启用。

**建议**：确认这些功能是否为未来规划，若是则保留；否则删除。

---

### 8. Cite 模块 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/cite/types.ts` | `CiteOrigin` | 类型未使用 |
| `src/cite/manager.ts` | `generateCiteId`, `createCiteItem`, `getTagStyle`, `getStatusBadge`, `CiteLimitExceededError`, `DuplicateCiteError` | 管理器功能未启用 |
| `src/cite/resolver.ts` | `DEFAULT_CITE_CONFIG`, `DEFAULT_SENSITIVE_PATTERNS`, `CiteResolverDeps` | 解析器未启用 |

**问题**：Cite 模块的管理和解析功能未启用。

**建议**：确认是否需要引用管理功能，若是则保留；否则删除。

---

### 9. 插件系统模块 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/plugins/filesystem-discovery.ts` | `ExtensionMetadata`, `AgentYAMLDefinition`, `ContextCost`, `ExtensionType`, `parseAgentYAML`, `CONTEXT_COST_DESCRIPTIONS`, `DEFAULT_COST_BY_TYPE`, `SkillDefinition` | 文件系统发现未启用 |
| `src/plugins/types.ts` | `ThemeColors`, `ThemePlugin` | 主题插件未启用 |

**问题**：插件系统的文件系统发现和主题功能未启用。

**建议**：确认是否需要这些插件功能，若是则保留；否则删除。

---

### 10. Runtime 模块 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/runtime/components/goal-progress.ts` | `estimateEta`, `countCompleted`, `GOAL_STATUS_ICON`, `GOAL_STATUS_LABEL` | 目标进度组件未启用 |
| `src/runtime/doctor.ts` | `DoctorConfig`, `DoctorProbeContext`, `ProbeStatus` | Doctor 诊断未启用 |
| `src/runtime/graceful-shutdown.ts` | `unregisterShutdownHook`, `triggerShutdown`, `shutdown`, `setShutdownTimeoutMs`, `setShutdownExitCode`, `listShutdownHooks`, `isShuttingDown`, `ShutdownPriority`, `ShutdownHookFn`, `ShutdownReason` | 优雅关闭未启用 |
| `src/runtime/notification.ts` | `NotificationOptions`, `NotificationLevel` | 通知未启用 |
| `src/runtime/plugin-init.ts` | `initPluginSystem`, `registerPermissionMiddleware` | 插件初始化未启用 |

**问题**：Runtime 模块的多项功能（目标进度、诊断、优雅关闭、通知、插件初始化）未启用。

**建议**：确认这些功能是否为未来规划，若是则保留；否则删除。

---

### 11. Hooks 模块 — 部分功能未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/hooks/hook-enhancement.ts` | `GoalHookEvent` | 目标钩子事件未启用 |
| `src/hooks/adapter.ts` | `configToDefinition`, `replaceVariables`, `executeShellCommand` | 适配器未启用 |
| `src/hooks/hook-events.ts` | `isValidHookEventType`, `getHookEventMetadata`, `listEventsByCategory`, `ALL_HOOK_EVENTS`, `HOOK_EVENT_METADATA`, `LEGACY_HOOK_EVENT_MAP`, `HookEventMetadata`, `HookEventCategory` | 钩子事件系统未启用 |

**问题**：Hooks 模块的增强、适配器和事件系统未启用。

**建议**：确认是否需要这些钩子功能，若是则保留；否则删除。

---

### 12. Tools 模块 — 部分工具未启用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `src/tools/builtin/browser.ts` | `BrowserToolArgs` | 浏览器工具参数未使用 |
| `src/tools/builtin/config-guard.ts` | `GuardDecision` | 配置守卫未启用 |
| `src/tools/builtin/edit-history.ts` | `EditHistory` (class), `EditHistoryEntry` | 编辑历史未启用 |
| `src/tools/builtin/file-read.ts` | `fileReadTool` | 文件读取工具未启用 |
| `src/tools/builtin/spawn-agent.ts` | `createDetachedSessionContext`, `extractDetachedSessionAnswer`, `buildForkedMessages`, `DetachedSessionOptions` | 分离会话未启用 |
| `src/tools/builtin/todo-store.ts` | `TodoItem`, `TodoSnapshot` | Todo 存储未启用 |
| `src/tools/builtin/web-search.ts` | `WebSearchResult` | 网页搜索结果未使用 |
| `src/tools/repo-map.ts` | `FileDependency`, `RepoMapOptions` | 仓库映射未启用 |
| `src/tools/result-sanitizer.ts` | `SanitizedResult`, `ERROR_LINE_PATTERN` | 结果清理未启用 |
| `src/tools/types.ts` | `StructuredToolResult`, `ToolDef`, `ToolStatus`, `ToolErrorCode` | 工具类型未使用 |

**问题**：多个内置工具和工具类型未启用。

**建议**：确认这些工具是否为未来规划，若是则保留；否则删除。

---

## Minor（类型定义未使用，不影响功能）

### 1. 配置 Schema 类型 — 大量类型未使用

`src/config/schema.ts` 中大量配置类型未被使用，包括：
- `SensitiveFilePolicy`, `UserPreference`, `Theme`, `AppearanceTheme`, `ModelCapability`
- `LLMProvidersConfig`, `CheckpointConfig`, `ChannelsConfig`, `GoalVerifierConfig`, `AdversarialConfig`, `AutonomyConfig`, `SoundsConfig`, `UIComponentsConfig`, `UIConfig`, `UpdatesConfig`, `MCPTransport`, `PromptConfigType`, `ProjectMemoryConfigType`, `TokenTrackingConfig`, `WorkflowConfig`, `SafetyConfig`, `WorkerContextStrategy`, `ClarificationConfig`, `OptimizationConfig`, `BackgroundBehaviorConfig`, `KnowledgeGraphConfig`, `LoopDetectionConfig`, `MiddlewareConfig`, `AgentConfig`, `WebSearchConfig`, `GeneralConfig`, `CodeGraphConfig`, `ExperimentsConfig`, `HooksConfig`, `TrustConfig`, `QualityConfig`, `ExpertiseConfig`, `CodeMapConfig`, `MarketConfig`, `PoliciesConfig`, `SubAgentsConfig`, `GoalConfig`, `CCRCompressionConfig`, `HookEnhancementConfig`, `ConversationConfig`, `PersonaConfig`, `VisionConfig`, `VoiceConfigType`, `DiscoveryConfig`, `CiteConfigType`, `MacrosConfig`, `CodexInstructionsMode`, `ImportConfig`, `GoalIntegrationConfig`, `OrchestrationIntegrationConfig`, `DelegationIntegrationConfig`, `Phase48IntegrationConfig`, `Phase49IntegrationConfig`, `ActivityPanelConfig`, `ErrorDisplayConfig`, `ModelDisplayConfig`, `PolicyEngineConfig`, `AuditChainConfigType`, `McpSecurityScanConfig`, `SkillSecurityGateConfig`, `ConfigGuardConfig`, `PrefixCacheConfig`, `BudgetMonitorConfig`, `DagEngineConfig`, `CircuitBreakerConfigType`, `DoctorConfig`, `ClosedLoopRoutingConfig`, `FileEditConfig`, `ToolsConfig`, `ObservabilityConfig`, `PlanConfig`

**问题**：配置 Schema 中大量类型定义未被使用，增加了维护负担。

**建议**：删除未使用的配置类型，保留实际使用的。

---

### 2. Desktop 组件类型 — 部分未使用

| 文件 | 死代码符号 | 状态 |
|------|-----------|------|
| `desktop/main/engine-bridge.ts` | `EngineBridgeOptions` | 接口未使用 |
| `desktop/renderer/src/components/DiscoveryPage.tsx` | `DiscoveryPageProps`, `ProjectType` | 组件未使用 |
| `desktop/renderer/src/components/ToolCallCard.tsx` | `getToolIcon`, `getPathFromArgs`, `getToolActionSummary`, `ToolCallDetail`, `ToolCallGroup`, `ToolCallStatus` | 组件功能未使用 |
| `desktop/renderer/src/components/ui/*.tsx` | 多个 UI 组件 Props 类型 | UI 组件未使用 |
| `desktop/renderer/src/hooks/useKeyboardShortcuts.ts` | `ShortcutCallbacks` | 钩子未使用 |
| `desktop/renderer/src/pages/settings-helpers.ts` | `ChannelOptionField` | 辅助函数未使用 |
| `desktop/renderer/src/store/useProjectsStore.ts` | `Conversation`, `Project`, `ArchivedConversation` | 存储类型未使用 |
| `desktop/renderer/src/store/useRouteDevStore.ts` | `RouteDevState`, `MessageRole`, `ToolCallStatus` | 存储类型未使用 |
| `desktop/shared/ipc-types.ts` | `ChatHistoryMessage`, `SkillCreatePayload`, `SkillOpResult`, `SkillRouteResult`, `MCPToolsResult`, `PlanEditResponsePayload`, `AgentProfileRole`, `AgentProfileOutputFormat`, `AgentProfileChallengeSeverity`, `HookCreatePayload` | IPC 类型未使用 |

**问题**：Desktop UI 的大量组件和类型未使用。

**建议**：删除未使用的组件和类型。

---

## 检测脚本误报（已验证在生产代码中被使用）

以下模块被检测脚本标记为死代码，但实际上在生产代码中有引用：

| 文件 | 误报符号 | 实际使用位置 |
|------|---------|-------------|
| `src/agent/goal-audit.ts` | `AuditResult`, `GoalAuditConfig`, `AuditParams`, `AuditOutcome`, `AuditLayer`, `DEFAULT_AUDIT_CONFIG`, `GoalAuditor` | `src/runtime/app-init.ts`, `src/runtime/goal-runner.ts` |
| `src/agents/delegation-policy.ts` | `DelegationDecision`, `TaskType`, `DelegationMode`, `classifyTask`, `TASK_TYPE_KEYWORDS`, `canDelegate`, `decideDelegation`, `createDelegationGuard` | `src/tools/builtin/spawn-agent.ts` |
| `src/agent/parallel-experiment.ts` | `ParallelExperimentManager`, `ExperimentIntent`, `ParallelExperimentResult`, `ExperimentComparison` | `src/runtime/app-init.ts` |
| `src/harness/experiment-manager.ts` | `Experiment`, `ExperimentDiff`, `AdoptResult`, `TaskProgress`, `RunInExperimentOptions`, `AdoptOptions`, `ExperimentManager` | `src/runtime/app-init.ts`, `src/agent/parallel-experiment.ts`, `src/agent/multi/branch-orchestrator.ts` |
| `src/skills/sad-decomposer.ts` | `SADResult` | `src/skills/compositional-router.ts` |
| `src/observability/trajectory-aggregator.ts` | `AggregatedMetrics`, `TrajectoryAggregator` | `src/harness/trace-collector.ts` |

**问题**：检测脚本只追踪从 6 个入口文件出发的调用链，未包含 `src/runtime/goal-runner.ts`、`src/tools/builtin/spawn-agent.ts` 等中间模块。

**建议**：扩展入口白名单，增加 `src/runtime/goal-runner.ts`、`src/tools/builtin/spawn-agent.ts` 等核心运行时模块。

---

## 做得好的地方

1. **死代码检测脚本**：项目已内置 `scripts/detect-dead-code.ts`，可自动化检测死代码，这是一个很好的工程实践。
2. **历史清理记录**：`docs/DEAD_CODE_AUDIT.md` 记录了 Phase 50 和 Phase 56-60 的清理工作，为本次审计提供了很好的参考。
3. **模块解耦**：大部分死代码模块与核心功能解耦，删除不会影响现有功能。

---

## 清理建议

### 第一阶段（高优先级）

1. 删除完全未接入的模块：`src/policies/`、`src/import/`、`src/mcp/claude-bridge.ts`
2. 删除代码地图模块中未使用的功能：`src/code-map/fallback.ts`、`src/code-map/watcher.ts`、`src/code-map/git-integration.ts`、`src/code-map/languages/go.ts`、`src/code-map/languages/java.ts`
3. 删除安全模块中未使用的功能：`src/security/audit-panel.ts`、`src/security/integrity-manifest.ts`

### 第二阶段（中优先级）

1. 删除记忆系统中未使用的功能：`src/memory/bm25-index.ts`、`src/memory/local-maintenance.ts`、`src/memory/provenance-graph.ts`、`src/memory/hybrid-retriever.ts`、`src/memory/codebase-memory.ts`、`src/memory/unified-memory.ts`
2. 删除技能系统中未使用的功能：`src/skills/bundled-skill-extractor.ts`、`src/skills/granularity-auditor.ts`、`src/skills/kan-obstacle-checker.ts`、`src/skills/compatibility-scorer.ts`、`src/skills/progressive-disclosure.ts`、`src/skills/operation-classifier.ts`
3. 删除路由子模块中未使用的功能：`src/router/deterministic-rules.ts`、`src/router/execution-verifier.ts`、`src/router/regret-tracker.ts`、`src/router/routing-history.ts`、`src/router/tracker.ts`、`src/router/classifier.ts`、`src/router/embedder.ts`、`src/router/orchestrator.ts`、`src/router/token-counter.ts`

### 第三阶段（低优先级）

1. 删除 Agent 子系统中未使用的功能：`src/agent/omission-checker.ts`、`src/agent/quality-aggregator.ts`、`src/agent/quantitative-gate.ts`、`src/agent/unified-reviewer.ts`、`src/agent/workflow/dag-engine.ts`、`src/agent/budget-aware-renderer.ts`、`src/agent/budget-monitor.ts`、`src/agent/circuit-breaker.ts`、`src/agent/content-deduplicator.ts`、`src/agent/context-compaction.ts`、`src/agent/difficulty-assessor.ts`、`src/agent/dual-loop-orchestrator.ts`、`src/agent/path-router.ts`、`src/agent/plan-diff.ts`、`src/agent/state-migration.ts`
2. 删除子 Agent 系统中未使用的功能：`src/agents/activity-store.ts`、`src/agents/context-packer.ts`、`src/agents/delegation-contract.ts`、`src/agents/delegation-gate.ts`、`src/agents/profiles/builtin-templates.ts`、`src/agents/result-schemas.ts`、`src/agents/sub-agent-lifecycle.ts`、`src/agents/subagent-session.ts`
3. 删除 Cite、插件、Runtime、Hooks、Tools 模块中未使用的功能

### 检测脚本优化

扩展入口白名单，增加以下模块：
- `src/runtime/goal-runner.ts`
- `src/tools/builtin/spawn-agent.ts`
- `src/harness/trace-collector.ts`
- `src/agent/loop.ts`

---

**审查结论**：项目存在大量未接入生产路径的死代码模块，约占总 export 数的 40.6%。建议分三阶段清理，优先删除完全未启用的安全策略、导入工具、MCP Bridge 等模块。同时优化死代码检测脚本的入口白名单，减少误报。
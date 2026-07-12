# RouteDev 能力四层分层清单（CAPABILITY_LAYERS）

> **日期：** 2026-07-11  
> **来源：** Phase 80 Task 1  
> **对齐蓝图：** `蓝图与Phase/BLUEPRINT-CORE-CAPABILITY-PACK-v3.md`  
> **枚举入口：** `src/runtime/app-init*.ts`、`src/tools/builtin/*`、`desktop/preload/index.ts`、`desktop/main/engine-bridge.ts`、`src/config/schema.ts`、`src/config/defaults.ts`

## 四层定义（与蓝图 v3 §2 一致）

| 层 | 默认 | 维护策略 | 用户可见 | 删除门槛 |
|----|------|----------|----------|----------|
| `core` | on | 主动强化、必须有测试 | 主界面 | 不可删 |
| `extended-pack` | off | 中等偏下、修 bug 不扩功能 | 设置页"高级"区 | 60 天零启用 |
| `standard-pack` | off | 冷处理：仅修崩溃 | 设置页"扩展"区 | 90 天零启用 |
| `freeze` | off | 停止一切接线 | 不出现 | 与清理窗口一起删 |

**冷处理策略列说明：** `保留接口方式 / 是否保留配置开关 / 预计迁移到的 Pack 名`

---

## 1. Core 层（默认开，必须强化）

> 编程场景基础能力，用户难以通过第三方 Skill/Pack 实现。蓝图 §2.1 对标 Pi 基础能力。

| ID | 名称 | 层 | 默认 | 入口 | 源码 | 依赖 | 冷处理策略 |
|----|------|----|----|------|------|------|-----------|
| C-01 | file-read | core | on | ToolRegistry | src/tools/builtin/file-read.ts | SecurityChecker | 强化+测试；不可删 |
| C-02 | file-write | core | on | ToolRegistry | src/tools/builtin/file-write.ts | SecurityChecker, ConfigGuard | 强化+测试；不可删 |
| C-03 | file-edit | core | on | ToolRegistry | src/tools/builtin/file-edit.ts | SecurityChecker, ConfigGuard | 强化+测试；不可删 |
| C-04 | file-search | core | on | ToolRegistry | src/tools/builtin/file-search.ts | search-utils | 强化+测试；不可删 |
| C-05 | list-directory | core | on | ToolRegistry | src/tools/builtin/list-directory.ts | — | 强化+测试；不可删 |
| C-06 | shell-exec | core | on | ToolRegistry | src/tools/builtin/shell-exec.ts | SecurityChecker, CommandSandbox | 强化+测试；不可删 |
| C-07 | git-op | core | on | ToolRegistry | src/tools/builtin/git-op.ts | SecurityChecker | 强化+测试；不可删 |
| C-08 | code-search | core | on | ToolRegistry | src/tools/builtin/code-search.ts | search-utils | 强化+测试；Core 差异化（蓝图 §2.1） |
| C-09 | ask-user | core | on | ToolRegistry | src/tools/builtin/ask-user.ts | — | 强化+测试；编程场景刚需 |
| C-10 | todo-write | core | on | ToolRegistry | src/tools/builtin/todo-write.ts | todo-store | 强化+测试；编程场景刚需 |
| C-12 | vfs-read/write/list/delete | core | on | ToolRegistry | src/agent/tools/vfs-tool.ts | VirtualFS | 强化+测试；Agent 工作内存抽象 |
| C-13 | plan-get/set/update/add/remove | core | on | ToolRegistry | src/agent/tools/plan-tool.ts | PlanState | 强化+测试；显式 plan 状态 |
| C-14 | ToolRegistry | core | on | app-init-tools | src/tools/registry.ts | — | 强化+测试；工具注册中心 |
| C-15 | ToolExecutor | core | on | app-init-tools | src/tools/executor.ts | registry, SecurityChecker | 强化+测试；不可删 |
| C-16 | SecurityChecker | core | on | app-init-tools | src/tools/security.ts | config.security | 强化+测试；路径/命令/域名检查 |
| C-17 | PermissionEngine | core | on | app-init-tools | src/tools/permission-engine.ts | — | 强化+测试；唯一权限源（蓝图 TD-03） |
| C-18 | PermissionMiddleware | core | on | app-init-agent | src/agent/middleware/permission-middleware.ts | PermissionEngine | 强化+测试；onActing 拦截 |
| C-19 | PolicyEngine | core | on | app-init-tools | src/policies/policy-engine.ts | intent-guard, tool-approval | 强化+测试；固定规则（Core 不做 popup） |
| C-20 | ConfigGuard | core | on | app-init-tools | src/tools/builtin/config-guard.ts | fileEdit, fileWrite | 强化+测试；防配置弱化 |
| C-21 | CommandSandbox | core | on | app-init-tools | src/security/sandbox.ts | shellExec | 强化+测试；危险命令拦截 |
| C-22 | ReActAgentLoop | core | on | app-init-tools | src/agent/loop.ts | adapter, guardedAdapter | 强化+测试；核心引擎 |
| C-23 | ToolRegistryAdapter | core | on | app-init-tools | src/tools/adapter.ts | registry, executor | 强化+测试；不可删 |
| C-24 | GuardedToolExecutorAdapter | core | on | app-init-tools | src/agent/work-modes.ts | adapter, WorkModeController | 强化+测试；不可删 |
| C-25 | ReadTracker | core | on | app-init-tools | src/tools/read-tracker.ts | — | 强化+测试；先读后写强制 |
| C-26 | ToolResultSanitizer | core | on | app-init-tools | src/tools/result-sanitizer.ts | — | 强化+测试；注入检测+截断 |
| C-27 | ToolOutputPipeline | core | on | app-init-tools | src/agent/context/tool-output-pipeline.ts | sanitizer | 强化+测试；统一压缩编排 |
| C-28 | MCPClientManager | core | on | app-init-tools | src/tools/mcp/client.ts | registry | 强化+测试；MCP 基础连接（蓝图 §2.1） |
| C-29 | McpSecurityScanner | core | on | app-init-tools | src/tools/mcp/security-scanner.ts | mcpManager | 强化+测试；投毒/仿冒扫描 |
| C-30 | SkillsRouter | core | on | app-init-tools | src/plugins/filesystem-discovery.ts | FilesystemDiscovery | 强化+测试；按需加载 |
| C-31 | ContextManager | core | on | app-init-memory | src/agent/memory/context-manager.ts | checkpointClient | 强化+测试；token 监控+压缩 |
| C-32 | CheckpointManager | core | on | app-init-memory | src/harness/checkpoint-manager.ts | — | 强化+测试；工作区快照（蓝图 §2.1） |
| C-33 | CheckpointWriter | core | on | app-init-memory | src/agent/memory/checkpoint-writer.ts | checkpointClient | 强化+测试；不可删 |
| C-34 | ContextCompactor | core | on | app-init-memory | src/agent/context-compaction.ts | estimateTokens | 强化+测试；五阶段压缩 |
| C-35 | MemoryRecallInjector | core | on | app-init-memory | src/agent/memory/recall-injector.ts | KnowledgeGraph | 强化+测试；基础召回 |
| C-36 | BranchManager | core | on | app-init-memory | src/agent/branch.ts | — | 强化+测试；会话分支（蓝图 §3） |
| C-37 | BranchPersistence | core | on | app-init-agent | src/agent/branch-persistence.ts | conversation | 强化+测试；JSONL 持久化 |
| C-38 | ~~BranchLinkageManager~~（已删除） | core | — | — | src/agent/branch-linkage.ts（已删除） | — | 已归档：模块已删除，保留编号占位 |
| C-39 | TraceCollector | core | on | app-init-observability | src/harness/trace-collector.ts | — | 强化+测试；基础可观测性 |
| C-40 | AuditLogger | core | on | app-init-observability | src/harness/audit-logger.ts | trace | 强化+测试；不可删 |
| C-41 | PromptTemplateManager | core | on | app-init-observability | src/prompts/manager.ts | — | 强化+测试；三级优先级 |
| C-42 | Blackboard | core | on | app-init-observability | src/agent/multi/blackboard.ts | — | 强化+测试；共享黑板（Core 共享实例） |
| C-43 | ProjectMemoryManager | core | on | app-init-observability | src/memory/project-memory.ts | — | 强化+测试；.routedev/ 维护 |
| C-44 | loadProjectDoc | core | on | app-init-observability | src/memory/project-memory.ts | — | 强化+测试；AGENTS.md/CLAUDE.md |
| C-45 | LLMClientManager | core | on | engine-bridge | src/router/llm/index.ts | config.providers | 强化+测试；不可删 |
| C-46 | ModelRouter | core | on | engine-bridge | src/router/router.ts | tracker | 强化+测试；省钱核心差异化 |
| C-47 | ScenarioClassifier | core | on | engine-bridge | src/router/classifier.ts | — | 强化+测试；混合分类 |
| C-48 | TokenTracker | core | on | engine-bridge | src/router/tracker.ts | — | 强化+测试；多维度归因 |
| C-49 | TokenProfiler | core | on | app-init-tools | src/agent/token-profiler.ts | agentLoop | 强化+测试；五分表 |
| C-50 | HookRunner | core | on | app-init-agent | src/agent/hooks.ts | trace | 强化+测试；扩展钩子 |
| C-51 | registerBuiltinHooks | core | on | app-init-agent | src/hooks/built-in.ts | hookRunner, audit | 强化+测试；文件验证+审计 |
| C-52 | HookConfigRegistry | core | on | app-init-agent | src/hooks/registry.ts | hookRunner | 强化+测试；模板+自定义 |
| C-53 | HookEnhancementManager | core | on | app-init-agent | src/hooks/hook-enhancement.ts | hookRunner | 强化+测试；命令安全审查 |
| C-54 | PathRouter | core | on | app-init-agent | src/agent/path-router.ts | — | 强化+测试；基础路径路由 |
| C-55 | LoopDetectionMiddleware | core | on | app-init-agent | src/agent/middleware/loop-detection.ts | — | 强化+测试；重复工具检测 |
| C-56 | MentionResolverMiddleware | core | on | app-init-agent | src/agent/middleware/mention-resolver.ts | cwd | 强化+测试；@mention 解析 |
| C-57 | ExperimentManager(基础) | core | on | app-init-agent | src/harness/experiment-manager.ts | — | 强化+测试；Git Worktree 基础（高级并行见 S-09） |
| C-58 | registerShutdownHook | core | on | app-init-* | src/runtime/graceful-shutdown.ts | — | 强化+测试；资源释放链 |
| C-59 | IPC: chat/config/command/tool/fs/project/window | core | on | preload/index.ts | desktop/preload/index.ts | engine-bridge | 强化+测试；基础 IPC |
| C-60 | IPC: mcp/skill/hook/checkpoint/plan/agent/session | core | on | preload/index.ts | desktop/preload/index.ts | bridges/* | 强化+测试；管理 IPC |
| C-61 | Slash: /clear /status /mcp /compact /help /skill /doctor | core | on | chat-bridge | desktop/main/bridges/chat-bridge.ts | — | 强化+测试；基础命令 |
| C-62 | config: providers/router/checkpoint/security/autonomy/mcp | core | on | schema.ts | src/config/schema.ts | — | 强化+测试；保留开关 |
| C-63 | config: prompts/projectMemory/permissionProfile/optimization | core | on | schema.ts | src/config/schema.ts | — | 强化+测试；保留开关 |
| C-64 | config: conversation/execution/middleware/hooks/hookEnhancement | core | on | schema.ts | src/config/schema.ts | — | 强化+测试；保留开关 |
| C-65 | config: tools/plan/memory/projectDoc | core | on | schema.ts | src/config/schema.ts | — | 强化+测试；保留开关 |
| C-66 | GoalVerifier | core | on | app-init-agent | src/agent/goal-verifier.ts | — | 强化+测试；对话也能用，目标达成验证（不归属任何 Pack） |
| C-67 | UnifiedReviewer | core | on | app-init-agent | src/agent/unified-reviewer.ts | agentLoop, tracker | 强化+测试；基础统一审查（对抗审查增强见 E-19/E-20，不归属任何 Pack） |
| C-68 | SessionTree | core | on | chat-bridge | src/session/session-tree.ts | SessionNode, crypto | 强化+测试；会话树存储模型（fork/clone/switchBranch/jumpToNode/fromLinear）；ChatBridge 懒初始化（Phase 84） |
| C-69 | SessionNode | core | on | chat-bridge | src/session/session-node.ts | — | 强化+测试；会话树节点定义（含 checkpointId 关联）（Phase 84） |
| C-70 | session-commands(/tree /fork /clone) | core | on | chat-bridge | src/session/session-commands.ts | SessionTree | 强化+测试；会话分支 slash 命令，已注册到 chat-bridge executeCommand（Phase 84） |

---

## 2. Extended Pack 层（默认关，中等偏下维护，修 bug 不扩功能）

> 用户能自建但预设更好用 + 有明确场景。完整且独特，比用户自建更好用。蓝图 §2.2。

| ID | 名称 | 层 | 默认 | 入口 | 源码 | 依赖 | 冷处理策略 |
|----|------|----|----|------|------|------|-----------|
| E-01 | spawn-agent 工具 | extended-pack | off | ToolRegistry(条件) | src/tools/builtin/spawn-agent.ts | createSpawnAgentFn | 修 bug 不扩功能 / 保留 config.subAgents / `pack.multi-agent` |
| E-02 | createSpawnAgentFn + 并行上限 + 防递归 | extended-pack | off | app-init-agent | src/tools/builtin/spawn-agent.ts | agentLoop, primaryClient | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-03 | OrchestrationIntegration(strategy/stateGraph) | extended-pack | off | app-init-agent | src/agent/multi/orchestrator.ts | blackboard, state-graph | 修 bug 不扩功能 / 保留 config.orchestrationIntegration / `pack.multi-agent` |
| E-04 | WorkerExecutor | extended-pack | off | app-init-agent | src/agent/multi/worker-executor.ts | orchestrator | 修 bug 不扩功能 / 保留类型 / `pack.multi-agent` |
| E-05 | ConflictDetector | extended-pack | off | app-init-agent | src/agent/multi/conflict.ts | — | 修 bug 不扩功能 / 保留接口 / `pack.multi-agent` |
| E-06 | SkillLifecycleManager | extended-pack | off | app-init-agent | src/skills/skill-lifecycle.ts | phase52Integration | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-07 | AgentProfileManager | extended-pack | off | app-init-agent | src/agents/profiles/manager.ts | — | 修 bug 不扩功能 / 保留 IPC profile:* / `pack.multi-agent` |
| E-08 | SubAgentLifecycle / SubAgentScoreCardCollector | extended-pack | off | app-init-agent | src/agents/sub-agent-lifecycle.ts | delegationIntegration | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-09 | ContextPacker / DelegationGate / DelegationEnforcer | extended-pack | off | app-init-agent | src/agents/context-packer.ts | delegationIntegration | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-10 | DelegationPolicy / ResultSchema | extended-pack | off | app-init-agent | src/agents/delegation-policy.ts | — | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-11 | AgentActivityStore | extended-pack | off | app-init-agent | src/agents/activity-store.ts | activityPanel | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-12 | GoalRunner(/goal 执行器) | extended-pack | off | chat-bridge→goal-bridge | src/runtime/goal-runner*.ts | pathRouter, dagEngine | 修 bug 不扩功能 / 保留 /goal 命令 / `pack.goal-advanced` |
| E-13 | GoalParser / GoalGates | extended-pack | off | goal-runner | src/agent/goal-*.ts | — | 修 bug 不扩功能 / 保留接口 / `pack.goal-advanced`（GoalVerifier 已归 Core C-66） |
| E-14 | GoalAuditor / GoalPersistence | extended-pack | off | app-init-agent | src/agent/goal-audit.ts, goal-persistence.ts | goalIntegration | 修 bug 不扩功能 / 保留 config.goalIntegration / `pack.goal-advanced` |
| E-15 | DagEngine | extended-pack | off | app-init-agent | src/agent/workflow/dag-engine.ts | phase53Integration.dagEngine | 修 bug 不扩功能 / 保留开关 / `pack.goal-advanced` |
| E-16 | TaskOrchestrator | extended-pack | off | app-init-agent | src/agent/task-orchestrator.ts | classifier, modelRouter | 修 bug 不扩功能 / 保留接口 / `pack.goal-advanced` |
| E-17 | DualLoopOrchestrator | extended-pack | off | app-init-agent | src/agent/dual-loop-orchestrator.ts | phase49Integration | 修 bug 不扩功能 / 保留开关 / `pack.goal-advanced` |
| E-19 | cross-model-reviewer | extended-pack | off | app-init-agent | src/agent/cross-model-reviewer.ts | — | 修 bug 不扩功能 / 保留接口 / `pack.adversarial`（UnifiedReviewer 已归 Core C-67） |
| E-20 | ReviewerPolicy(tieredReview) | extended-pack | off | app-init-agent | config.reviewerPolicy | DualLoopOrchestrator | 修 bug 不扩功能 / 保留开关 / `pack.adversarial` |
| E-21 | boundedRecovery | extended-pack | off | app-init-agent | src/agent/bounded-recovery.ts | phase52Integration | 修 bug 不扩功能 / 保留开关 / `pack.goal-advanced` |
| E-22 | CircuitBreaker | extended-pack | off | app-init-agent | src/agent/circuit-breaker.ts | phase53Integration.circuitBreaker | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-23 | BudgetMonitor | extended-pack | off | app-init-tools | src/agent/budget-monitor.ts | phase53Integration.budgetMonitor | 修 bug 不扩功能 / 保留开关 / `pack.goal-advanced` |
| E-24 | PrefixAwareCache | extended-pack | off | app-init-memory | src/agent/memory/prefix-cache.ts | phase53Integration.prefixCache | 修 bug 不扩功能 / 保留开关 / `pack.goal-advanced` |
| E-25 | IPC: profile:* / goal:* | extended-pack | off | preload/index.ts | desktop/preload/index.ts | bridges/* | 修 bug 不扩功能 / 保留 IPC / 各 Pack |
| E-26 | Slash: /goal | extended-pack | off | chat-bridge | desktop/main/bridges/chat-bridge.ts | goal-bridge | 修 bug 不扩功能 / 保留命令 / `pack.goal-advanced` |
| E-27 | config: goalIntegration/orchestrationIntegration | extended-pack | off | schema.ts | src/config/schema-agent.ts | — | 修 bug 不扩功能 / 保留开关 / 各 Pack |
| E-28 | config: delegationIntegration/delegationPolicy/subAgents | extended-pack | off | schema.ts | src/config/schema-agent.ts | — | 修 bug 不扩功能 / 保留开关 / `pack.multi-agent` |
| E-29 | config: goal/goalVerifier/adversarial/reviewerPolicy | extended-pack | off | schema.ts | src/config/schema-agent.ts | — | 修 bug 不扩功能 / 保留开关 / 各 Pack |
| E-30 | config: activityPanel/resultSchema/phase49Integration | extended-pack | off | schema.ts | src/config/schema-agent.ts | — | 修 bug 不扩功能 / 保留开关 / 各 Pack |
| E-31 | CompositionalRouter | extended-pack | off | app-init-router | src/skills/compositional-router.ts | phase52Integration.compositionalRouting | 修 bug 不扩功能 / 保留开关 / `pack.goal-advanced`（与 DagEngine 同属 goal 执行链） |

---

## 3. Standard Pack 层（默认关，冷处理，仅修崩溃）

> 几乎用不到但有接入接口 + 用户可自建。蓝图 §2.3。

| ID | 名称 | 层 | 默认 | 入口 | 源码 | 依赖 | 冷处理策略 |
|----|------|----|----|------|------|------|-----------|
| S-01 | web-search | standard-pack | off | ToolRegistry | src/tools/builtin/web-search.ts | webSearch config | 仅修崩溃 / 保留开关 / `pack.browser-web` |
| S-02 | web-fetch | standard-pack | off | ToolRegistry | src/tools/builtin/web-fetch.ts | — | 仅修崩溃 / 保留开关 / `pack.browser-web` |
| S-03 | browser | standard-pack | off | ToolRegistry(动态) | src/tools/builtin/browser.ts | — | 仅修崩溃 / 保留开关 / `pack.browser-web`；不加新爬取能力 |
| S-04 | code-graph-query | standard-pack | off | ToolRegistry | src/tools/builtin/code-graph-query.ts | CodeMapEngine | 仅修崩溃 / 保留开关 / `pack.code-map`；不加新语言 |
| S-05 | repo-map | standard-pack | off | ToolRegistry | src/tools/builtin/repo-map.ts | — | 仅修崩溃 / 保留开关 / `pack.code-map` |
| S-06 | CodeMapEngine + Watcher + Fallback | standard-pack | off | app-init-agent | src/code-map/indexer.ts, watcher.ts, fallback.ts | config.codeMap | 仅修崩溃 / 保留开关 / `pack.code-map` |
| S-07 | CodeMapContextMiddleware | standard-pack | off | app-init-agent | src/agent/middleware/code-map-context.ts | codegraph config | 仅修崩溃 / 保留开关 / `pack.code-map` |
| S-08 | ccr-retrieve | standard-pack | off | ToolRegistry(条件) | src/tools/builtin/ccr-retrieve.ts | ccrCache, ccrCompression | 仅修崩溃 / 保留开关 / `pack.compose` |
| S-09 | ParallelExperimentManager | standard-pack | off | app-init-agent | src/agent/parallel-experiment.ts | experimentManager | 仅修崩溃 / 保留开关 / `pack.session-export`；冲突检测部分见 F-04 |
| S-10 | CiteManager + CiteResolver | standard-pack | off | app-init-agent | src/cite/manager.ts, resolver.ts | phase48Integration.citeEnabled | 仅修崩溃 / 保留开关 / `pack.import-ecosystem`；不加新导入源 |
| S-11 | ClaudePluginImporter | standard-pack | off | app-init-agent | src/import/claude-plugin-importer.ts | phase48Integration.importEnabled | 仅修崩溃 / 保留开关 / `pack.import-ecosystem` |
| S-12 | CodexInstructionImporter | standard-pack | off | app-init-agent | src/import/codex-importer.ts | phase48Integration.importEnabled | 仅修崩溃 / 保留开关 / `pack.import-ecosystem` |
| S-13 | AnthropicSkillsLoader | standard-pack | off | app-init-agent | src/import/anthropic-skills-loader.ts | phase48Integration.importEnabled | 仅修崩溃 / 保留开关 / `pack.import-ecosystem` |
| S-14 | MacroManager | standard-pack | off | app-init-agent | src/macros/manager.ts | phase48Integration.macrosEnabled | 仅修崩溃 / 保留开关 / `pack.import-ecosystem` |
| S-15 | ComposePipeline | standard-pack | off | app-init-tools | src/agent/compose-pipeline.ts | WorkModeController | 仅修崩溃 / 保留开关 / `pack.compose`；不加新模板类型（自动选择见 F-05） |
| S-16 | IntegrityManifest | standard-pack | off | app-init-agent | src/security/integrity-manifest.ts | config.security.integrityCheck | 仅修崩溃 / 保留开关 / `pack.import-ecosystem` |
| S-17 | ClaudeMCPBridge | standard-pack | off | app-init-agent | src/mcp/claude-bridge.ts | phase48Integration.mcpBridgeEnabled | 仅修崩溃 / 保留开关 / `pack.import-ecosystem` |
| S-18 | TraceReplayer + Scorecard | standard-pack | off | trace-bridge | src/harness/trace-replayer.ts, scorecard.ts | — | 仅修崩溃 / 保留开关 / `pack.harness`；不加新评分维度 |
| S-19 | VisionAssistant | standard-pack | off | app-init-memory | src/agent/vision.ts | config.vision | 仅修崩溃 / 保留开关 / `pack.browser-web` |
| S-20 | IPC: experiment:* / trace:* | standard-pack | off | preload/index.ts | desktop/preload/index.ts | bridges/* | 仅修崩溃 / 保留 IPC / `pack.harness`,`pack.session-export` |
| S-21 | Slash: /replay /scorecard | standard-pack | off | chat-bridge | desktop/main/bridges/chat-bridge.ts | trace-bridge | 仅修崩溃 / 保留命令 / `pack.harness` |
| S-22 | config: codegraph/codeMap/webSearch | standard-pack | off | schema.ts | src/config/schema-memory.ts, schema-security.ts | — | 仅修崩溃 / 保留开关 / `pack.browser-web`,`pack.code-map` |
| S-23 | config: experiment/cite/macros/import/vision | standard-pack | off | schema.ts | src/config/schema-agent.ts | — | 仅修崩溃 / 保留开关 / 各 Pack |
| S-24 | config: ccrCompression | standard-pack | off | schema.ts | src/config/schema-memory.ts | — | 仅修崩溃 / 保留开关 / `pack.compose` |
| S-25 | notes-tool | standard-pack | off | ToolRegistry | src/tools/builtin/notes-tool.ts | NotesManager | 仅修崩溃 / 保留开关 / `tools.profile=full`（app-init-tools.ts 注释自标 standard-pack，仅 full profile 注册） |

---

## 4. Freeze 层（停止接线，不承诺）

> 价值未证明 + 有更好替代。蓝图 §2.4。停止一切接线；保留类型与存储接口。

| ID | 名称 | 层 | 默认 | 入口 | 源码 | 依赖 | 冷处理策略 |
|----|------|----|----|------|------|------|-----------|
| F-01 | TrustGradientManager(动态升级) | freeze | off | app-init-tools/agent | src/tools/trust-gradient.ts | config.trust | 停止接线 / 保留类型与静态档位 / 不承诺；Phase 79 已冻结动态升级 |
| F-02 | QualitySignalMiddleware(Implicit Feedback) | freeze | off | app-init-agent | src/agent/middleware/quality-signal.ts | config.quality | 停止接线 / 保留类型 / 不承诺；无证据 |
| F-03 | KG 高级算法(PageRank/社区检测) | freeze | off | graph.ts | src/agent/memory/graph-community.ts, graph.ts(高级部分) | KnowledgeGraph | 停止接线 / 保留存储接口 / 不承诺；tree-sitter+SQLite 已够 |
| F-04 | /goal 并行调度与冲突检测 | freeze | off | app-init-agent | src/agent/multi/orchestrator.ts(并行部分) | orchestrationIntegration | 冻结代码路径 / 保留类型 / 不承诺；无真实使用 |
| F-05 | Compose 自动选择 | freeze | off | app-init-tools | src/agent/work-modes.ts(自动路由部分) | WorkModeController | 移除自动路由 / 保留显式触发 / 不承诺 |
| F-06 | ExpertisePromptMiddleware(隐式适配) | freeze | off | app-init-agent | src/agent/middleware/expertise-prompt.ts | config.expertise | 停止接线 / 保留类型 / 不承诺；隐式经验推断无证据 |
| F-07 | ProvenanceGraph + KanObstacleChecker | freeze | off | app-init-memory | src/memory/provenance-graph.ts, src/skills/kan-obstacle-checker.ts | phase68Integration | 停止接线 / 保留类型 / 不承诺；KG 高级衍生 |
| F-08 | QuantitativeGate | freeze | off | app-init-memory | src/agent/quantitative-gate.ts | phase68Integration | 停止接线 / 保留类型 / 不承诺 |
| F-09 | closedLoopRouting / ACRouter | freeze | off | app-init-router | src/router/orchestrator.ts, routing-memory.ts, regret-tracker.ts | config.closedLoopRouting | 停止接线 / 保留类型 / 不承诺；实验性高级路由 |
| F-10 | memorySystem(Phase 65 重构) | freeze | off | app-init-memory | src/memory/memory-store.ts, hybrid-retriever.ts, local-maintenance.ts | config.memorySystem | 停止接线 / 保留类型 / 不承诺；实验性重构 |
| F-11 | config: trust/quality/expertise | freeze | off | schema.ts | src/config/schema-security.ts, schema-observability.ts | — | 停止接线 / 保留配置开关(不产品化) / 不承诺 |
| F-12 | config: phase68Integration/closedLoopRouting/memorySystem | freeze | off | schema.ts | src/config/schema-observability.ts, schema-router.ts, schema-memory.ts | — | 停止接线 / 保留配置开关 / 不承诺 |

---

## 5. 覆盖率统计

### 5.1 按入口枚举覆盖

| 入口 | 枚举模块数 | 已分层数 | 覆盖率 |
|------|-----------|---------|--------|
| src/tools/builtin/*（22 文件） | 22 | 22 | 100% |
| src/runtime/app-init*.ts（5 子系统装配项） | ~45 | 45 | 100% |
| desktop/preload/index.ts（IPC 通道组） | 14 | 14 | 100% |
| desktop/main/engine-bridge.ts + bridges（slash 命令 + 领域委托） | 11 | 11 | 100% |
| src/config/schema.ts（顶层配置开关组） | ~30 | 30 | 100% |

**总体覆盖率：** 136/136 ≈ **100%**（≥80% 验收标准达成）（截至 v4.5.4）

### 5.2 按层分布

| 层 | 模块数 | 占比 |
|----|--------|------|
| core | 70 | 52.6% |
| extended-pack | 28 | 21.1% |
| standard-pack | 24 | 18.0% |
| freeze | 12 | 9.0% |
| **unknown** | **0** | **0%** |

> 每个模块有且仅有一个四层标签，无 `unknown`（验收标准达成）。

### 5.3 与蓝图 v3 对齐校验

| 蓝图要求 | 本文档归属 | 校验 |
|---------|-----------|------|
| Multi-Agent → extended-pack（`pack.multi-agent`） | E-01 ~ E-11, E-22 | ✅ |
| Goal 高级编排 → extended-pack（`pack.goal-advanced`） | E-12 ~ E-17, E-21, E-23, E-24 | ✅ |
| 对抗审查 → extended-pack（`pack.adversarial`） | E-19, E-20（UnifiedReviewer 已归 Core C-67） | ✅ |
| 浏览器/Web → standard-pack（`pack.browser-web`） | S-01 ~ S-03, S-19 | ✅ |
| 代码地图 → standard-pack（`pack.code-map`） | S-04 ~ S-07 | ✅ |
| Progressive Trust → freeze | F-01 | ✅ |
| KG 高级算法 → freeze | F-03, F-07, F-08 | ✅ |

> 分层与蓝图 v3 §2.2/§2.3/§2.4 完全一致（验收标准达成）。

---

## 6. 维护纪律（引用蓝图 §8）

1. **先量后砍**：无调用日志不删生产模块
2. **冷处理优先于删除**：几乎用不到的进 standard-pack，不删代码
3. **Core 变更必须有测试**
4. **Extended Pack 修 bug 不扩功能**
5. **Freeze 停止一切接线**
6. **新增功能默认 off 或进 Pack**
7. **禁止**以"看起来高级"为理由把 freeze 拉回默认路径
8. **审查发现"功能缺失"时**：先查"Core 不做"清单，再决定是否实现

---

## 7. Phase 81-82 更新（能力 Pack 外置落地）

> **日期：** 2026-07-11  
> **来源：** Phase 81 Task 1-5 + Phase 82 Task 5  
> **核心变更：** 默认工具集收口为 10 个 Core 工具；非 Core 模块退出默认装配，由 `config.packs.<id>.enabled` 门控按需加载。

### 7.1 Phase 81：默认装配收口

- **工具注册档位**：新增 `tools.profile`（`core` / `full`，默认 `core`）。`core` 档位仅注册 ≤10 个核心工具（file-read/write/edit/search、list-directory、shell-exec、git-op、code-search、ask-user、todo-write），其余工具随对应 Pack 启用而注册。
- **Pack 装配开关**：新增 `config.packs.*` 配置组（14 个 Pack，默认全部 `false`），消费方按 `config.packs.<id>.enabled` 条件装配。详见 `src/config/schema-observability.ts` 的 `PacksConfigSchema`。
- **设置页四层分组**：`desktop/renderer/src/components/settings/SettingsPacksTab.tsx` 按基础区/高级区/扩展区/实验区四层展示，Freeze 区开关禁用仅展示。

### 7.2 Phase 82：已迁移 Pack 标注

以下 6 个 Pack 在 Phase 81-82 完成门控迁移，默认退出装配，用户可在设置页或配置文件中显式启用：

| Pack ID | 配置开关 | 所属层 | 迁移内容 | 迁移状态 |
|---------|----------|--------|----------|----------|
| `pack.goal-advanced` | `packs.goalAdvanced.enabled` | Extended | E-12~E-17, E-21, E-23, E-24（/goal 执行器 + DAG + 双循环 + 有界恢复 + 预算监控 + PrefixCache） | ✅ 已迁移 |
| `pack.multi-agent` | `packs.multiAgent.enabled` | Extended | E-01~E-11, E-22（spawn-agent + orchestrator + worker + 冲突检测 + 熔断 + Skill 生命周期 + Agent Profile + 委托体系） | ✅ 已迁移 |
| `pack.adversarial` | `packs.adversarial.enabled` | Extended | E-19, E-20（cross-model-reviewer + 分级审查策略；UnifiedReviewer 已归 Core C-67） | ✅ 已迁移 |
| `pack.browser-web` | `packs.browserWeb.enabled` | Standard | S-01~S-03, S-19（web-search + web-fetch + browser + VisionAssistant） | ✅ 已迁移 |
| `pack.code-map` | `packs.codeMap.enabled` | Standard | S-04~S-07（code-graph-query + repo-map + CodeMapEngine + Watcher + ContextMiddleware） | ✅ 已迁移 |
| `pack.harness` | `packs.harness.enabled` | Standard | S-18, S-20, S-21（TraceReplayer + Scorecard + experiment/trace IPC + /replay /scorecard） | ✅ 已迁移 |

> 其余 Pack（skillLifecycle / ccrCompression / vfsPlan / integrity / compose / trustGradient / kgAdvanced / acRouter）同样已在 Phase 81 完成门控迁移，默认 `false`。

### 7.3 Pack 接口引用

- **配置 Schema**：`src/config/schema-observability.ts` → `PacksConfigSchema`（14 个 Pack 开关，每个 `{ enabled: boolean }`）
- **配置默认值**：`src/config/defaults.ts` → `packs` 字段（全部默认 `false`）
- **消费方（装配门控）**：
  - `src/runtime/app-init-tools.ts`：工具注册按 `packs.<id>.enabled` 条件注册
  - `src/runtime/app-init-agent.ts`：Agent 子系统装配按 `packs.<id>.enabled` 条件装配
  - `src/runtime/goal-runner-recovery.ts`：恢复路径按 `packs.goalAdvanced.enabled` 门控
  - `src/agent/memory/graph.ts`：KG 高级算法按 `packs.kgAdvanced.enabled` 门控
- **设置页**：`desktop/renderer/src/components/settings/SettingsPacksTab.tsx`（四层分组展示 + 成本提示 + 层标签）
- **工具注册档位**：`src/config/schema-agent.ts` → `ToolProfileSchema`（`core` / `full`）

---

## 8. Phase 83-85 更新（Extended Pack 收口 / 会话分支 / 发布门禁）

> **日期：** 2026-07-11
> **来源：** Phase 83 Task 1 + Phase 84 Task 1 + Phase 85 Task 3
> **核心变更：** Extended Pack 接口审计收口；会话分支 Core 落地；v4.9.0 发布门禁文档对齐，"Core 不做"清单正式化。

### 8.1 Phase 83：Extended Pack 收口

- **GoalVerifier 迁回 Core**（C-66）：对话场景即可使用，不归属任何 Pack。原 Extended Pack 条目 E-13 已更新备注。
- **UnifiedReviewer 迁回 Core**（C-67）：基础统一审查归属 Core，对抗审查增强（cross-model-reviewer + ReviewerPolicy）保留在 Extended Pack（E-19 / E-20）。
- **/goal 并行调度与冲突检测冻结**：补登记到 Freeze 清单（F-04），代码路径不可达，不删代码，保留类型。
- **三个 Extended Pack 接口干净**：goal-advanced / multi-agent / adversarial 不泄露 Core 内部实现。本 Phase 未为任何 Pack 增加新能力。

### 8.2 Phase 84：会话分支 Core 落地

新增三个 Core 模块，支持 Pi 风格的会话分支：

| ID | 名称 | 源码 | 说明 |
|----|------|------|------|
| C-68 | SessionTree | `src/session/session-tree.ts` | 会话树存储模型（fork/clone/switchBranch/jumpToNode/fromLinear），ChatBridge 懒初始化 |
| C-69 | SessionNode | `src/session/session-node.ts` | 会话树节点定义，含 `checkpointId` 关联工作区快照 |
| C-70 | session-commands | `src/session/session-commands.ts` | `/tree` `/fork` `/clone` slash 命令，已注册到 chat-bridge executeCommand |

- **向后兼容**：旧线性消息通过 `SessionTree.fromLinear()` 自动导入为单分支树。
- **Checkpoint 联动**：fork 继承分叉点 checkpointId，回滚带 checkpoint 的节点同时还原工作区。

### 8.3 Phase 85：v4.9.0 发布门禁

- **"Core 不做"清单正式化**：`AGENTS.md` 新增 9 项 Core 不做能力（Multi-Agent / Goal 高级编排 / 对抗审查 / 浏览器 Web / 代码地图 / Trace 回放 / TrustGradient 动态升级 / Implicit Feedback / /goal 并行调度）与 8 条防回潮规则。
- **文档对齐**：本节补登记 Phase 83-84 的分层变更；`docs/SLIMDOWN_BOARD.md` 维护阶段更新至 Phase 85。
- **不新增模块**：本 Phase 不新增能力条目，仅做发布前文档同步与清单正式化。

### 8.4 分层统计更新（截至 Phase 85）

| 层 | 模块数 | 占比 | 变化 |
|----|--------|------|------|
| core | 70 | 52.6% | Phase 83 +2（C-66/C-67 迁回），Phase 84 +3（C-68/C-69/C-70） |
| extended-pack | 28 | 21.1% | Phase 83 收窄 E-19/E-20，移除原 E-13/E-18 归 Core |
| standard-pack | 24 | 18.0% | 无变化 |
| freeze | 12 | 9.0% | Phase 83 补登记 F-04（/goal 并行调度与冲突检测） |
| **unknown** | **0** | **0%** | — |

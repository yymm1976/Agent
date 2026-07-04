// src/cli/app-init.ts
// App 依赖初始化工厂：从 App.tsx 抽取所有服务实例的创建逻辑
// Phase 0c Task 3：App.tsx 装配收敛，目标 ≤300 行
//
// 设计原则：
//   1. 所有服务实例在此创建，App.tsx 只负责 React 状态和 UI
//   2. 返回的对象由 App.tsx 通过 useRef 持有，保证整个组件生命周期不变
//   3. 依赖 currentModel 的服务用初始值创建，后续通过 update 方法同步

import type { AppConfig } from '../config/schema.js';
import type { ClassificationResult, ILLMClient, RoutingResult, ScenarioTier } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { SecurityChecker } from '../tools/security.js';
import { ToolRegistryAdapter } from '../tools/adapter.js';
import { FileReadTool } from '../tools/builtin/file-read.js';
import { FileWriteTool } from '../tools/builtin/file-write.js';
import { FileEditTool } from '../tools/builtin/file-edit.js';
import { FileSearchTool } from '../tools/builtin/file-search.js';
import { ListDirectoryTool } from '../tools/builtin/list-directory.js';
import { ShellExecTool } from '../tools/builtin/shell-exec.js';
import { GitOpTool } from '../tools/builtin/git-op.js';
import { WebSearchTool } from '../tools/builtin/web-search.js';
import { WebFetchTool } from '../tools/builtin/web-fetch.js';
import { CodeSearchTool } from '../tools/builtin/code-search.js';
import { CodeGraphQueryTool } from '../tools/builtin/code-graph-query.js';
import { RepoMapTool } from '../tools/builtin/repo-map.js';
import { TodoWriteTool } from '../tools/builtin/todo-write.js';
import { AskUserTool } from '../tools/builtin/ask-user.js';
import { TodoStore } from '../tools/builtin/todo-store.js';
import { SpawnAgentTool, type SpawnAgentFunction, type SpawnAgentParams, type SubagentType, createChildRegistry, createConcurrencyLimitedSpawnFn, resolveProfileForSubagent, wrapSpawnAgentWithDelegation, type DelegationIntegrationDeps } from '../tools/builtin/spawn-agent.js';
// Phase 48 Task 4：接入 AgentProfileManager，让 UI 编辑的 profile 影响子 Agent 派遣
import { AgentProfileManager } from '../agents/profiles/manager.js';
import { NotesTool } from '../tools/builtin/notes-tool.js';
import { NotesManager } from '../agent/memory/notes.js';
// Phase 71 Task E1：进程内 VFS + 4 个 VFS 工具
import { createVFS } from '../agent/context/virtual-fs.js';
import { VfsReadTool, VfsWriteTool, VfsListTool, VfsDeleteTool } from '../agent/tools/vfs-tool.js';
// Phase 71 Task E2：显式 plan 状态 + 5 个 plan 工具
import { PlanState } from '../agent/context/plan-state.js';
import { PlanGetTool, PlanSetTool, PlanUpdateStepTool, PlanAddStepTool, PlanRemoveStepTool } from '../agent/tools/plan-tool.js';
import { createDefaultEngine, type PermissionEngine } from '../tools/permission-engine.js';
import { MCPClientManager } from '../tools/mcp/client.js';
import { ReActAgentLoop } from '../agent/loop.js';
// Phase 58：统一 PathRouter（合并 execution-router + level-path-router）
import { PathRouter } from '../agent/path-router.js';
import { TokenProfiler } from '../agent/token-profiler.js';
import { WorkModeController, GuardedToolExecutorAdapter } from '../agent/work-modes.js';
import { CheckpointManager } from '../harness/checkpoint-manager.js';
// E9-B 修复：ExperimentManager 提升为 App 单例（此前仅在 Phase 44 .then() 块内局部创建，
// 导致 /experiment 命令与 engine-bridge 各自重新实例化，丢失 ExperimentRunner 注入）
// experiment-manager.ts 无循环依赖（只依赖 Node 内置 + logger），可安全改为静态 import
import { ExperimentManager } from '../harness/experiment-manager.js';
import { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import { ContextManager } from '../agent/memory/context-manager.js';
// Phase 71 Task B3：记忆召回注入器——接通 KnowledgeGraph.recall() 到 system prompt
import { MemoryRecallInjector } from '../agent/memory/recall-injector.js';
// Phase 71 Task D7：Budget Offload 文件清理钩子（会话结束 + 孤儿文件清理）
import { registerOffloadCleaner } from '../agent/context/offload-cleaner.js';
import { ContextCompactor } from '../agent/context-compaction.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { VisionAssistant } from '../agent/vision.js';
import { BranchManager } from '../agent/branch.js';
import { InitAnalyzer } from '../agent/init-analyzer.js';
import { Blackboard } from '../agent/multi/blackboard.js';
import { Orchestrator, type OrchestrationIntegrationOptions } from '../agent/multi/orchestrator.js';
// Phase 50 Task 1：Goal 流程核心模块（按 config.goalIntegration 渐进接入）
import { GoalAuditor } from '../agent/goal-audit.js';
import { GoalPersistence } from '../agent/goal-persistence.js';
// Phase 59：GoalPromptBuilder 已删除（批次1 无价值 Integration）
// Phase 50 Task 3：子 Agent 委托体系核心模块（按 config.delegationIntegration 渐进接入）
import { ContextPacker } from '../agents/context-packer.js';
import { DelegationGate } from '../agents/delegation-gate.js';
import { SubAgentLifecycle } from '../agents/sub-agent-lifecycle.js';
import { SubAgentScoreCardCollector } from '../agents/sub-agent-score-card.js';
// CR-4b：接入 activity-store（子 Agent 活动面板）
import { AgentActivityStore } from '../agents/activity-store.js';
import { WorkerExecutor } from '../agent/multi/worker-executor.js';
import { TraceCollector } from '../harness/trace-collector.js';
import { AuditLogger } from '../harness/audit-logger.js';
import { logger } from '../utils/logger.js';
import { PromptTemplateManager } from '../prompts/manager.js';
import { ProjectMemoryManager, loadProjectDoc } from '../memory/project-memory.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import { HookRunner } from '../agent/hooks.js';
import { registerBuiltinHooks } from '../hooks/built-in.js';
import { HookEnhancementManager } from '../hooks/hook-enhancement.js';
import { getHookTemplates } from '../hooks/templates.js';
// Phase 32 Task 1：接入 Phase 31 模块（之前全部为死代码）
import { TaskOrchestrator, createTaskOrchestrator } from '../agent/task-orchestrator.js';
import { RequirementsGatherer, createRequirementsGatherer } from '../agent/requirements-gatherer.js';
import { TaskComplexityAnalyzer, createTaskComplexityAnalyzer } from '../agent/complexity-analyzer.js';
import { ExecutionOrchestrator, createExecutionOrchestrator } from '../agent/execution-orchestrator.js';
import { UnifiedReviewer, createUnifiedReviewer } from '../agent/unified-reviewer.js';
import { CompletionGate, createCompletionGate } from '../agent/completion-gate.js';
import { ReadTracker, createReadTracker } from '../tools/read-tracker.js';
import { ToolResultSanitizer, createToolResultSanitizer } from '../tools/result-sanitizer.js';
import { ToolOutputPipeline } from '../agent/context/tool-output-pipeline.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import { createPluginSystem } from './plugin-init.js';
import type { AgentMiddlewarePipeline } from '../agent/middleware.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { SkillsRouter, FilesystemDiscovery } from '../plugins/filesystem-discovery.js';
import { LoopDetectionMiddleware } from '../agent/middleware/loop-detection.js';
// Phase 71 Task B2：@-mention 统一引用协议中间件
import { MentionResolverMiddleware } from '../agent/middleware/mention-resolver.js';
import { homedir } from 'node:os';
import * as path from 'node:path';
// Phase 48 Task 6 修复：scheduler 模块静态 import（替代原 await import，避免非 async 函数中的 typecheck 错误）
import { ScheduleStore } from '../scheduler/store.js';
import { ScheduleEngine } from '../scheduler/engine.js';
// Phase 52 Task 1/3/5/6/7/8/9/10：Phase 52 模块接入（按 config.phase52Integration 开关守护）
import { SkillLifecycleManager } from '../skills/skill-lifecycle.js';
import { createBoundedRecoveryManager } from '../agent/bounded-recovery.js';
// Phase 55 Task 9：DualLoopOrchestrator 类型（goal-runner 通过 ref 引用实例）
import type { DualLoopOrchestrator } from '../agent/dual-loop-orchestrator.js';
// Phase 55：DagEngine 类型（异步创建，goal-runner 通过 ref 延迟读取）
import type { DagEngine } from '../agent/workflow/dag-engine.js';
// Phase 59：ArchitectureAwareMetricsCollector/SaturationMonitor import 已删除（批次1，实例化块移除）
// 注：类型仍被 score-card.ts / dual-loop-orchestrator.ts / completion-gate.ts 通过各自 import 引用
// CR-4b：接入 compositional-router（Phase 52 Task 4 组合式路由）
import { decomposeWithSkillAwareness, retrieveSkill, composeDAG, DEFAULT_ROUTING_CONFIG, type AtomicSubTask, type SkillMatch, type SkillDAGPlan, type CompositionalRoutingConfig } from '../skills/compositional-router.js';
// Phase 53 Task 5/7：MCP 安全扫描器 + 配置保护守卫（Task 6 SkillSecurityGate 使用动态 import）
import { McpSecurityScanner } from '../tools/mcp/security-scanner.js';
import { ConfigGuard } from '../tools/builtin/config-guard.js';
// Phase 55 Task 9：CCR 可逆压缩
import { CCRCache } from '../agent/ccr-cache.js';
import { CCRRetrieveTool } from '../tools/builtin/ccr-retrieve.js';
// Phase 61：ACRouter 闭环模型路由
import { RoutingHistory } from '../router/routing-history.js';
import { RoutingMemory } from '../router/routing-memory.js';
import { HashEmbedder, createEmbedder } from '../router/embedder.js';
import { RoutingOrchestrator } from '../router/orchestrator.js';
import { ExecutionVerifier } from '../router/execution-verifier.js';
import { RoutingRegretTracker } from '../router/regret-tracker.js';
// Phase 62：动态工作流模式与隔离治理
import { AdversarialVerifier } from '../agent/adversarial-verifier.js';
import { RubricRegistry } from '../agent/rubric-registry.js';
import { LoopUntilDoneGate } from '../agent/loop-until-done-gate.js';
import { QuarantineManager } from '../tools/quarantine-profile.js';
import { ActionAgentDispatcher } from '../agent/action-agent-dispatcher.js';
import { TournamentSelector } from '../agent/tournament-selector.js';
import { CrossModelReviewer } from '../agent/cross-model-reviewer.js';
// Phase 65：记忆系统重构
import { MemoryStore } from '../memory/memory-store.js';
import { IncrementalExtractor } from '../memory/incremental-extractor.js';
import { HybridRetriever } from '../memory/hybrid-retriever.js';
import { ConservativeMerger } from '../memory/conservative-merger.js';
import { RejectedAlternativeStore } from '../memory/rejected-alternative-store.js';
import { LocalMaintenancePolicy } from '../memory/local-maintenance.js';
import { BM25Index } from '../memory/bm25-index.js';
// Phase 66：策略管道与治理
import { CheckpointPipeline } from '../policies/checkpoint-pipeline.js';
import { CallOwnerCoordinator } from '../policies/call-owner-coordinator.js';
import { StateSnapshotChain } from '../harness/state-snapshot-chain.js';
import { ReputationDeriver } from '../memory/reputation-deriver.js';
// Phase 67：推理质量诊断
import { MICrossScorer } from '../evaluation/mi-cross-scorer.js';
import { SNRAwareFilter } from '../agent/snr-aware-filter.js';
import { EpistemicTokenProtector } from '../agent/epistemic-token-protector.js';
import { EpistemicIntegrityChecker } from '../agent/epistemic-integrity-checker.js';
import { EpistemicPreservingSummarizer } from '../agent/epistemic-preserving-summarizer.js';
import { QualityMetricsRecorder } from '../harness/quality-metrics-types.js';
// Phase 68：检索/搜索/发现三分与知识图谱
import { ProvenanceGraph } from '../memory/provenance-graph.js';
import { RejectedAlternativeStore as AgentRejectedAlternativeStore } from '../agent/rejected-alternative-store.js';
import { KanObstacleChecker } from '../skills/kan-obstacle-checker.js';
import { QuantitativeGate } from '../agent/quantitative-gate.js';
import { classifyOperation, buildRegimeTransition, type OperationSignal } from '../skills/operation-classifier.js';
// Phase 69：Worktree 隔离执行与多代理并行编排
import { WorktreeManager, DEFAULT_WORKTREE_CONFIG } from '../agent/multi/worktree-manager.js';
import { ResultComparator, DEFAULT_COMPARATOR_CONFIG } from '../agent/multi/result-comparator.js';
import { AgentGroupResolver } from '../agent/multi/agent-group-resolver.js';
import { ClaudeCodeAdapter, CLIAdapterRegistry, DEFAULT_CLAUDE_CODE_CONFIG } from '../agent/multi/cli-adapter.js';
// Phase 70：上下文压缩技术深度优化
import { ToolOutputBudgetManager, DEFAULT_BUDGET_CONFIG } from '../agent/memory/tool-output-budget.js';
import { MessageGrouper } from '../agent/memory/message-grouper.js';
import { ActionChainDetector } from '../agent/memory/action-chain-detector.js';
import { AutoCompactGuardian, DEFAULT_GUARDIAN_CONFIG } from '../agent/memory/auto-compact-guardian.js';
import { CompactPromptEngine } from '../agent/memory/compact-prompt-engine.js';
import { SessionMemoryStore } from '../agent/memory/session-memory-store.js';
import { CodebaseMemory } from '../memory/codebase-memory.js';
import { IntegrityManifest } from '../security/integrity-manifest.js';

/**
 * CR-4b：组合式路由器实例类型
 * 包装 compositional-router.ts 的 decomposeWithSkillAwareness / composeDAG，
 * 按配置注入路由参数，供上层 planner 调用。
 */
export interface CompositionalRouterInstance {
  /** 按配置分解任务为原子子任务（SAD 迭代技能感知分解） */
  decompose(
    task: string,
    availableSkills: Array<{ id: string; name: string; description: string; category: string }>,
    decomposeFn: (task: string) => Promise<AtomicSubTask[]>,
  ): Promise<AtomicSubTask[]>;
  /** 为子任务检索 Skill 并组合为 DAG 执行计划 */
  planDAG(
    subTasks: AtomicSubTask[],
    availableSkills: Array<{ id: string; name: string; description: string; category: string }>,
  ): SkillDAGPlan;
  /** 路由配置（只读快照） */
  readonly config: CompositionalRoutingConfig;
}

/** App 所需的全部服务依赖 */
export interface AppDependencies {
  // 工具链
  registry: ToolRegistry;
  mcpManager: MCPClientManager;
  securityChecker: SecurityChecker;
  toolExecutor: ToolExecutor;
  adapter: ToolRegistryAdapter;
  workModeController: WorkModeController;
  guardedAdapter: GuardedToolExecutorAdapter;
  agentLoop: ReActAgentLoop;
  // 插件系统
  middlewarePipeline: AgentMiddlewarePipeline;
  pluginRegistry: PluginRegistry;
  /** Phase 37：Skills 路由器（按需加载 Markdown Skill） */
  skillsRouter: SkillsRouter;
  /** Phase 37：文件系统发现器（发现/创建/删除 Skill 文件） */
  filesystemDiscovery: FilesystemDiscovery;
  // 权限
  permissionEngine: PermissionEngine;
  // 多 Agent
  orchestrator: Orchestrator;
  workerExecutor: WorkerExecutor;
  // 记忆与上下文
  checkpointManager: CheckpointManager;
  checkpointWriter: CheckpointWriter;
  contextManager: ContextManager;
  // 辅助 Agent
  visionAssistant: VisionAssistant | undefined;
  branchManager: BranchManager;
  initAnalyzer: InitAnalyzer | null;
  // 基础设施
  prompts: PromptTemplateManager;
  blackboard: Blackboard;
  trace: TraceCollector;
  audit: AuditLogger;
  projectMemory: ProjectMemoryManager;
  // 目标解析与验证（无状态，可复用）
  goalParser: GoalParser;
  goalVerifier: GoalVerifier;
  /** Phase 35 Task 2：生命周期钩子运行器（生产激活） */
  hookRunner: HookRunner;
  // LLM 客户端
  primaryClient: ILLMClient;
  checkpointClient: ILLMClient;
  /** Phase 30：Token Profiler（可观测性，可选） */
  profiler: TokenProfiler | null;
  // Phase 32 Task 1：Phase 31 模块（之前全部为死代码，现接入生产路径）
  /** 统一工作流编排器——App.tsx handleSubmit 的分发入口 */
  taskOrchestrator: TaskOrchestrator;
  /** 需求收集器——development 意图走需求确认阶段时使用 */
  requirementsGatherer: RequirementsGatherer;
  /** 任务复杂度分析器——规划阶段评估每步复杂度 */
  complexityAnalyzer: TaskComplexityAnalyzer;
  /** 执行编排器——根据复杂度选择单 Agent 或多 Agent 路径 */
  executionOrchestrator: ExecutionOrchestrator;
  /** 统一审查器——GoalVerifier + 代码审查双层验证 */
  unifiedReviewer: UnifiedReviewer;
  /** 独立代码验证门——typecheck/lint/tests 兜底 */
  completionGate: CompletionGate;
  /** 文件读取追踪器——先读后写强制 */
  readTracker: ReadTracker;
  /** 工具结果净化器——注入检测 + 智能截断 + 敏感字段脱敏 */
  resultSanitizer: ToolResultSanitizer;
  /** Phase 31/32 P0 接线：共享 systemPrompt ref，App.tsx 同步更新此 ref */
  sharedSystemPromptRef: { current: string };
  /** Phase 48 Task 3：调度引擎实例（scheduler.enabled !== false 时创建） */
  scheduleEngine?: import('../scheduler/engine.js').ScheduleEngine;
  /** Phase 50 Task 1：Goal 流程核心模块实例（按 config.goalIntegration 渐进接入，未开启时为 null） */
  goalAuditor: GoalAuditor | null;
  goalPersistence: GoalPersistence | null;
  // Phase 59：goalPromptBuilder 已删除（批次1 无价值 Integration）
  /** Phase 50 Task 3：子 Agent 委托体系模块实例（按 config.delegationIntegration 渐进接入，未开启时为 null） */
  subAgentLifecycle: SubAgentLifecycle | null;
  subAgentScoreCardCollector: SubAgentScoreCardCollector | null;
  /** Phase 52 Task 1：Skill 生命周期管理器（未启用时为 undefined） */
  skillLifecycleManager?: SkillLifecycleManager;
  // Phase 59：metricsCollector/saturationMonitor 接口字段已删除（批次1）
  // CR-4b：孤立模块接线点（按各自 config 开关守护，未启用时为 undefined）
  /** 子 Agent 活动面板存储（config.activityPanel.enabled） */
  activityStore?: AgentActivityStore;
  /** 组合式路由器（config.phase52Integration.compositionalRouting.enabled） */
  compositionalRouter?: CompositionalRouterInstance;
  /** Phase 58：统一路径路由器（合并原 executionRouter + levelPathRouter） */
  pathRouter: PathRouter;
  /** Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，goal-runner 通过 ref 延迟读取） */
  dualLoopOrchestratorRef: { current: DualLoopOrchestrator | null };
  /** Phase 55：DagEngine ref（异步创建，goal-runner 通过 ref 延迟读取，未注入时 executePlanWithDag 降级到 single） */
  dagEngineRef: { current: DagEngine | null };
  /**
   * E9-B 修复：实验管理器单例（基于 Git Worktree）
   * 全 App 生命周期内复用同一实例，确保 ExperimentRunner 注入持续生效。
   * /experiment 命令与 engine-bridge 都从此字段读取，避免重复实例化导致的 runner 丢失。
   */
  experimentManager: ExperimentManager;
  // Phase 61：ACRouter 闭环模型路由
  routingHistory?: RoutingHistory;
  routingMemory?: RoutingMemory;
  routingOrchestrator?: RoutingOrchestrator;
  executionVerifier?: ExecutionVerifier;
  routingRegretTracker?: RoutingRegretTracker;
  // Phase 62：动态工作流模式与隔离治理（可选，由 app-init.ts 在 dynamicWorkflow.enabled 时注入）
  adversarialVerifier?: AdversarialVerifier;
  rubricRegistry?: RubricRegistry;
  loopUntilDoneGate?: LoopUntilDoneGate;
  quarantineManager?: QuarantineManager;
  actionAgentDispatcher?: ActionAgentDispatcher;
  tournamentSelector?: TournamentSelector<unknown>;
  // Phase 65：记忆系统重构（可选，由 app-init.ts 在 memorySystem.enabled 时注入）
  memoryStore?: MemoryStore;
  incrementalExtractor?: IncrementalExtractor;
  hybridRetriever?: HybridRetriever;
  conservativeMerger?: ConservativeMerger;
  rejectedAlternativeStore?: RejectedAlternativeStore;
  localMaintenance?: LocalMaintenancePolicy;
  bm25Index?: BM25Index;
  // Phase 66：策略管道与治理（可选，由 app-init.ts 在 foundationProtocol.enabled 时注入）
  checkpointPipeline?: CheckpointPipeline;
  callOwnerCoordinator?: CallOwnerCoordinator;
  stateSnapshotChain?: StateSnapshotChain;
  reputationDeriver?: ReputationDeriver;
  // Phase 67：推理质量诊断（可选，由 app-init.ts 在 reasoningQualityDiagnostics.enabled 时注入）
  miCrossScorer?: MICrossScorer;
  snrAwareFilter?: SNRAwareFilter;
  epistemicTokenProtector?: EpistemicTokenProtector;
  epistemicIntegrityChecker?: EpistemicIntegrityChecker;
  epistemicPreservingSummarizer?: EpistemicPreservingSummarizer;
  qualityMetricsRecorder?: QualityMetricsRecorder;
  // Phase 68：检索/搜索/发现三分与知识图谱（可选，由 phase68Integration.enabled 时注入）
  provenanceGraph?: ProvenanceGraph;
  agentRejectedAlternativeStore?: AgentRejectedAlternativeStore;
  kanObstacleChecker?: KanObstacleChecker;
  quantitativeGate?: QuantitativeGate;
  classifyOperation?: (signal: OperationSignal, sessionId: string) => ReturnType<typeof classifyOperation>;
  buildRegimeTransition?: typeof buildRegimeTransition;
  // Phase 69：Worktree 隔离执行与多代理并行编排（可选）
  worktreeManager?: WorktreeManager;
  resultComparator?: ResultComparator;
  agentGroupResolver?: AgentGroupResolver;
  cliAdapterRegistry?: CLIAdapterRegistry;
  // Phase 70：上下文压缩技术深度优化（可选）
  toolOutputBudgetManager?: ToolOutputBudgetManager;
  messageGrouper?: MessageGrouper;
  actionChainDetector?: ActionChainDetector;
  autoCompactGuardian?: AutoCompactGuardian;
  compactPromptEngine?: CompactPromptEngine;
  sessionMemoryStore?: SessionMemoryStore;
  /** 代码库语义索引（config.memory.codebaseMemoryEnabled=true 时创建） */
  codebaseMemory?: CodebaseMemory;
}

/**
 * 创建 App 所需的全部服务依赖
 * 仅在组件首次渲染时调用一次（通过 useRef 持有返回值）
 *
 * @param config 全局配置
 * @param clientManager LLM 客户端管理器
 * @param currentModel 当前选中的模型 ID（用于初始化 ContextManager）
 * @param cwd 工作目录
 * @param classifier 场景分类器（Phase 32 Task 1：TaskOrchestrator 依赖）
 * @param modelRouter 模型路由器（Phase 32 Task 1：TaskOrchestrator 依赖）
 * @param tracker Token 追踪器（Phase 32 Task 1：ExecutionOrchestrator/UnifiedReviewer 依赖）
 */
export function createAppDependencies(
  config: AppConfig,
  clientManager: LLMClientManager,
  currentModel: string,
  cwd: string = process.cwd(),
  // Phase 32 Task 1：Phase 31 模块依赖的外部服务
  classifier?: ScenarioClassifier,
  modelRouter?: ModelRouter,
  tracker?: TokenTracker,
): AppDependencies {
  // ===== LLM 客户端解析 =====
  const checkpointModelId = config.checkpoint.modelId;
  const checkpointProvider = config.providers.find(p => p.models.some(m => m.id === checkpointModelId));
  const fallbackClient: ILLMClient | undefined = clientManager.listAll().values().next().value;
  const checkpointClient: ILLMClient = (checkpointProvider ? clientManager.get(checkpointProvider.id) ?? fallbackClient : fallbackClient) as ILLMClient;
  const primaryProviderId = config.providers[0]?.id ?? 'default';
  const primaryClient = (clientManager.get(primaryProviderId) ?? fallbackClient) as ILLMClient;

  // ===== 记忆与上下文 =====
  const checkpointManager = new CheckpointManager({
    enabled: config.checkpoint.enabled,
    maxCheckpoints: 10,
    workingDirectory: cwd,
  });
  const checkpointWriter = new CheckpointWriter(checkpointClient, checkpointModelId, config.checkpoint.maxTokensPerCheckpoint);
  const currentModelConfig = config.providers.flatMap(p => p.models).find(m => m.id === currentModel);
  const contextManager = new ContextManager(
    {
      contextWindow: currentModelConfig?.contextWindow ?? 128000,
      compressionThreshold: 0.8,
      keepRecentMessages: 6,
      checkpointEnabled: config.checkpoint.enabled,
      cwd,
      // Phase 45：将记忆配置注入 ContextManager，控制推理/自动学习/注入阈值
      memory: config.memory,
    },
    checkpointWriter,
  );

  // Phase 71 Task B3：装配记忆召回注入器
  // - contextManager 持有 KnowledgeGraph，recallInjector 通过 graph.recall() 唤醒死数据
  // - 同时注入到 contextManager（统一入口）和 agentLoop（run() 中消费）
  // - injectThreshold 来自 config.memory.injectThreshold（默认 0.7）
  // - maxMemories 用字面量 5（config.memory 无此字段）
  const recallInjector = new MemoryRecallInjector(
    contextManager.getKnowledgeGraph(),
    config.memory?.injectThreshold ?? 0.7,
    5,
  );
  contextManager.setRecallInjector(recallInjector);

  // A3：激活 ContextCompactor——消除双引擎不统一，让上下文压缩在生产路径生效
  // L5 summarize 回调使用 checkpointClient（已配置的辅助模型），失败时由 B12 的 try/catch 降级
  // Phase 55 Task 9：CCR 可逆压缩——compact 前缓存原始消息，LLM 可通过 ccr_retrieve 工具取回
  const ccrCache = new CCRCache(config.ccrCompression?.maxCacheSize ?? 50);

  // Phase 70：提前创建上下文压缩模块实例（供 ContextCompactor 和 AppDependencies 共享）
  const p70Cfg = config.phase70Integration;
  const p70ToolOutputBudgetManager = p70Cfg?.toolOutputBudget?.enabled
    ? new ToolOutputBudgetManager({
        ...DEFAULT_BUDGET_CONFIG,
        enabled: p70Cfg.toolOutputBudget.enabled,
        maxCharsPerOutput: p70Cfg.toolOutputBudget.maxCharsPerOutput,
        previewHeadChars: p70Cfg.toolOutputBudget.previewHeadChars,
        previewTailChars: p70Cfg.toolOutputBudget.previewTailChars,
        offloadDir: p70Cfg.toolOutputBudget.offloadDir,
      })
    : undefined;
  const p70MessageGrouper = p70Cfg?.microCompact?.enabled
    ? new MessageGrouper({
        cleanBeforeRounds: p70Cfg.microCompact.cleanBeforeRounds,
        keepRecentRounds: p70Cfg.microCompact.keepRecentRounds,
      })
    : undefined;
  const p70ActionChainDetector = p70Cfg?.contextCollapse?.enabled
    ? new ActionChainDetector(p70Cfg.contextCollapse.minToolCallsForChain)
    : undefined;
  const p70AutoCompactGuardian = p70Cfg?.autoCompactGuardian?.enabled
    ? new AutoCompactGuardian({
        ...DEFAULT_GUARDIAN_CONFIG,
        enabled: p70Cfg.autoCompactGuardian.enabled,
        contextWindow: p70Cfg.autoCompactGuardian.contextWindow,
        reservedTokensForSummary: p70Cfg.autoCompactGuardian.reservedTokensForSummary,
        autoCompactBuffer: p70Cfg.autoCompactGuardian.autoCompactBuffer,
        warningBuffer: p70Cfg.autoCompactGuardian.warningBuffer,
        errorBuffer: p70Cfg.autoCompactGuardian.errorBuffer,
        maxConsecutiveFailures: p70Cfg.autoCompactGuardian.maxConsecutiveFailures,
      })
    : undefined;
  const p70CompactPromptEngine = p70Cfg?.compactPrompt?.enabled
    ? new CompactPromptEngine(p70Cfg.compactPrompt.defaultDirection)
    : undefined;
  const p70SessionMemoryStore = (() => {
    // 跨会话持久化记忆：优先读 config.memory（Phase 45 记忆配置段）
    // 兼容 phase70Integration.sessionMemory.enabled 作为 fallback 开关
    const memCfg = config.memory;
    const persistentEnabled = memCfg?.sessionMemoryPersistent ?? true;
    const p70Enabled = p70Cfg?.sessionMemory?.enabled ?? false;
    if (!p70Enabled && !persistentEnabled) return undefined;

    const maxMemories = p70Cfg?.sessionMemory?.maxMemories ?? 100;
    // persistentPath 由 config.memory.sessionMemoryPath 解析得到，不写死
    const persistentPath = persistentEnabled
      ? path.resolve(cwd, memCfg?.sessionMemoryPath ?? '.routedev/session-memory.jsonl')
      : undefined;
    const store = new SessionMemoryStore(maxMemories, persistentPath);

    // 注册服务关闭钩子：进程退出前 flush 最终状态，避免 debounce 中的待写数据丢失
    if (persistentPath) {
      const handleClose = () => { store.close().catch(() => {}); };
      process.on('beforeExit', handleClose);
    }
    return store;
  })();

  // CodebaseMemory：扫描项目根目录建立语义索引，跨会话复用
  const codebaseMemory = (() => {
    const memCfg = config.memory;
    const enabled = memCfg?.codebaseMemoryEnabled ?? true;
    if (!enabled) return undefined;
    const maxFiles = memCfg?.codebaseMemoryMaxFiles ?? 500;
    const memory = new CodebaseMemory(cwd, { maxFiles });
    // 后台异步扫描，不阻塞主流程
    memory.scan().catch((err) => {
      logger.warn('CodebaseMemory: initial scan failed', { error: err instanceof Error ? err.message : String(err) });
    });
    return memory;
  })();

  const contextCompactor = new ContextCompactor({
    targetTokens: Math.floor((currentModelConfig?.contextWindow ?? 128000) * 0.6),
    estimateTokens,
    summarize: checkpointClient
      ? async (messages: import('../router/types.js').LLMMessage[]) => {
          // L5 摘要：用辅助模型生成对话摘要
          const conversationText = messages
            .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
            .join('\n');
          const summaryPrompt = `请将以下对话历史压缩为简洁摘要，保留关键决策、工具调用结果和未完成任务（< 500 字）：\n\n${conversationText.slice(0, 8000)}`;
          const result = await checkpointClient.complete({
            model: config.router.classifierModel,
            messages: [{ role: 'user', content: summaryPrompt }],
            temperature: 0.3,
          });
          return result.content;
        }
      : undefined,
    contextWindow: currentModelConfig?.contextWindow ?? 128000,
    ccrCache: config.ccrCompression?.enabled ? ccrCache : undefined,
    // Phase 70：上下文压缩技术深度优化
    toolOutputBudgetManager: p70ToolOutputBudgetManager,
    messageGrouper: p70MessageGrouper,
    actionChainDetector: p70ActionChainDetector,
    autoCompactGuardian: p70AutoCompactGuardian,
    compactPromptEngine: p70CompactPromptEngine,
    sessionMemoryStore: p70SessionMemoryStore,
  });
  contextManager.setCompactor(contextCompactor);

  // [I-4] OpenTelemetry exporter（P2.5）：受 config.observability.enabled 守护，fail-open
  // 使用变量路径让 TypeScript 无法静态解析，避免模块缺失时 typecheck 失败
  if (config.observability?.enabled) {
    const otelExporterModulePath = '../observability/otel-exporter.js';
    import(otelExporterModulePath)
      .then(({ OtelExporter }) => {
        const otelIntegrationModulePath = '../observability/integration.js';
        import(otelIntegrationModulePath)
          .then(({ setActiveOtelExporter }) => {
            const exporter = new OtelExporter({
              enabled: true,
              serviceName: config.observability!.serviceName || 'routedev',
              endpoint: config.observability!.endpoint,
              headers: config.observability!.headers,
              exportIntervalMs: config.observability!.exportIntervalMs,
            });
            setActiveOtelExporter(exporter);
            logger.info('OtelExporter enabled', { endpoint: config.observability!.endpoint });
          })
          .catch(() => { /* fail-open：integration 模块不可用时跳过 */ });
      })
      .catch(() => { /* fail-open：exporter 模块不可用时跳过 */ });
  }

  // Phase 53 Task 8：前缀感知缓存（受 config.phase53Integration.prefixCache.enabled 守护，fail-open）
  // 使用变量路径让 TypeScript 无法静态解析，避免模块尚未生成时 typecheck 失败
  const phase53PrefixCacheCfg = config.phase53Integration?.prefixCache;
  if (phase53PrefixCacheCfg?.enabled) {
    const prefixCacheModulePath = '../agent/memory/prefix-cache.js';
    import(prefixCacheModulePath)
      .then((mod: { PrefixAwareCache: new (opts?: { blockSize?: number; l1MaxSize?: number }) => unknown }) => {
        const cache = new mod.PrefixAwareCache({
          blockSize: phase53PrefixCacheCfg.blockSize,
          l1MaxSize: phase53PrefixCacheCfg.l1MaxSize,
        });
        // feature-detect：方法可能由其他子代理添加（避免硬依赖）
        const cm = contextManager as unknown as { setPrefixCache?: (c: unknown) => void };
        if (typeof cm.setPrefixCache === 'function') {
          cm.setPrefixCache(cache);
          logger.debug('PrefixAwareCache injected', { via: 'setPrefixCache' });
        }
      })
      .catch(() => { /* fail-open：缓存不可用时跳过 */ });
  }

  // ===== 辅助 Agent =====
  // Phase 57：vision 默认关闭，仅在 config.vision.enabled 时装配
  const visionAssistant = config.vision?.enabled
    ? new VisionAssistant(config.providers, (id: string) => clientManager.get(id))
    : undefined;
  const branchManager = new BranchManager();
  const initAnalyzer = primaryClient
    ? new InitAnalyzer({ llmClient: primaryClient, modelId: config.router.classifierModel, rootPath: cwd })
    : null;
  // ===== 基础设施 =====
  const prompts = new PromptTemplateManager({ projectOverrides: true });
  const blackboard = new Blackboard();
  const trace = new TraceCollector({ storageDir: undefined });
  const audit = new AuditLogger(trace.getSessionId() ?? 'app');
  const projectMemory = new ProjectMemoryManager(cwd, config.projectMemory);

  // Phase 71 Task D7：注册 offload 清理钩子
  // - 启动时立即清理 7 天前的孤儿文件（防止异常退出累积）
  // - 退出时（beforeExit / SIGINT / SIGTERM）清理当前 session 的 offload 文件
  // - 钩子内部 fail-open，清理失败不会导致进程崩溃
  const offloadSessionId = trace.getSessionId() ?? `app-${Date.now()}`;
  const offloadRootDir = path.resolve(cwd, '.routedev/offload');
  registerOffloadCleaner(offloadSessionId, offloadRootDir);

  // Phase 53 Task 4：哈希链审计接入（受 config.phase53Integration.auditChain.enabled 守护）
  // 启用后所有 audit.log() 写入的记录会附加 previousHash + hash 字段，形成防篡改链
  // Phase 59 Task 2：auditChain 默认 true，加 fail-open 守卫——装配失败不阻塞主流程
  const phase53AuditChainCfg = config.phase53Integration?.auditChain;
  if (phase53AuditChainCfg?.enabled) {
    try {
      audit.setChainConfig({
        enabled: true,
        logFile: phase53AuditChainCfg.logFile,
        overflowSealCount: phase53AuditChainCfg.overflowSealCount,
      });
      logger.debug('AuditLogger hash-chain enabled', { via: 'setChainConfig' });
    } catch (err) {
      logger.warn('Phase 59: auditChain 装配失败，fail-open 跳过', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 48 Task 2：接线 loadProjectDoc，激活多文件名 fallback（AGENTS.md / CLAUDE.md）
  // 异步加载，不阻塞主流程；加载后注入 projectMemory 供 system prompt 使用
  loadProjectDoc(cwd, config.projectDoc).then((doc) => {
    if (doc) {
      logger.info('ProjectDoc loaded', { length: doc.length });
      projectMemory.setProjectDoc(doc);
    } else {
      logger.debug('ProjectDoc: no project document found');
    }
  }).catch((err) => {
    logger.warn('ProjectDoc load failed', { error: err instanceof Error ? err.message : String(err) });
  });

  // ===== 工具链 =====
  // P0-1/P0-2/P1-4/P1-5/P1-6/P1-7：注册全部内置工具
  const registry = new ToolRegistry();
  // Phase 53 Task 7：提取 fileEditTool / fileWriteTool 实例，供 ConfigGuard 注入
  const fileEditTool = new FileEditTool();
  const fileWriteTool = new FileWriteTool();
  // 基础工具（原有）—— fileWriteTool 已提取为实例变量供 ConfigGuard 注入
  [FileReadTool, FileSearchTool, ShellExecTool, GitOpTool, WebSearchTool, CodeSearchTool]
    .forEach(T => registry.register(new T()));
  registry.register(fileWriteTool);
  // Phase 34 Task 4：Repo Map 代码检索增强
  registry.register(new RepoMapTool());
  // 短板 2 修复：代码地图查询工具（find_callers/find_callees/impact_analysis/search_symbols）
  registry.register(new CodeGraphQueryTool());
  // P1-4：文件编辑工具（str_replace，避免全量重写）
  registry.register(fileEditTool);
  // P0-2：目录列表工具（补全 work-modes.ts 的 list_directory 引用）
  registry.register(new ListDirectoryTool());
  // P1-7：网页抓取工具
  registry.register(new WebFetchTool());
  // [I-5] BrowserTool（P3.8）：动态 import 注册，避免静态解析失败
  const browserToolModulePath = '../tools/builtin/browser.js';
  import(browserToolModulePath)
    .then(({ BrowserTool }) => {
      registry.register(new BrowserTool());
      logger.debug('BrowserTool registered');
    })
    .catch(() => { /* fail-open：browser 工具不可用时跳过 */ });
  // P1-5：任务列表工具
  const todoStore = new TodoStore();
  registry.register(new TodoWriteTool(todoStore));
  registry.register(new AskUserTool());
  // P0-1：笔记工具（Agent 唯一写通道，需注入 NotesManager）
  const sessionDir = path.join(homedir(), '.qoderwork', 'routedev', 'sessions', trace.getSessionId() ?? `app-${Date.now()}`);
  const notesManager = new NotesManager(sessionDir);
  registry.register(new NotesTool(notesManager));
  // Phase 71 Task E1：进程内 VFS + 4 个 VFS 工具
  // - VirtualFS 实例由 app-init 创建，与 agentLoop 共享同一实例
  // - 4 个工具通过构造函数注入 VFS 实例，loop 通过 setVirtualFS 注入
  // - VFS 作为 Agent 工作内存统一抽象（todo/scratchpad/notes/中间产物）
  const virtualFS = createVFS();
  registry.register(new VfsReadTool(virtualFS));
  registry.register(new VfsWriteTool(virtualFS));
  registry.register(new VfsListTool(virtualFS));
  registry.register(new VfsDeleteTool(virtualFS));
  // Phase 71 Task E2：显式 plan 状态 + 5 个 plan 工具
  // - PlanState 复用上方 virtualFS 实例（plan 存储在 VFS 的 /plan/current.json）
  // - 5 个工具通过构造函数注入 PlanState 实例，loop 通过 setPlanState 注入
  // - plan 状态对 LLM 暴露为显式可读写实体，避免散落在 system prompt
  const planState = new PlanState(virtualFS);
  registry.register(new PlanGetTool(planState));
  registry.register(new PlanSetTool(planState));
  registry.register(new PlanUpdateStepTool(planState));
  registry.register(new PlanAddStepTool(planState));
  registry.register(new PlanRemoveStepTool(planState));
  // Phase 55 Task 9：CCR 取回工具（让 LLM 可按需取回被压缩的原始上下文）
  if (config.ccrCompression?.enabled) {
    registry.register(new CCRRetrieveTool(ccrCache));
  }

  // Phase 53 Task 7：ConfigGuard 注入（受 config.phase53Integration.configGuard.enabled 守护）
  // 启用后 file_edit / file_write 在执行前会检查是否弱化安全/治理配置
  // Phase 59 Task 2：configGuard 默认 true，加 fail-open 守卫——装配失败不阻塞主流程
  const phase53GuardCfg = config.phase53Integration?.configGuard;
  if (phase53GuardCfg?.enabled) {
    try {
      const configGuard = new ConfigGuard({
        warnOnFirst: phase53GuardCfg.warnOnFirst,
        protectedPatterns: phase53GuardCfg.protectedPatterns,
      });
      fileEditTool.setConfigGuard(configGuard);
      fileWriteTool.setConfigGuard(configGuard);
      logger.debug('ConfigGuard injected', { via: 'setConfigGuard' });
    } catch (err) {
      logger.warn('Phase 59: configGuard 装配失败，fail-open 跳过', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // [I-1 补充] FileEditTool 注入 requireConfirmation 开关（Phase 73）
  // 读取 config.tools.fileEdit.requireConfirmation（默认 false，向后兼容）
  fileEditTool.setRequireConfirmation(config.tools?.fileEdit?.requireConfirmation ?? false);

  const mcpManager = new MCPClientManager(registry);
  // CONCERN 修复：传入 MCP 配置，使 connectTimeout 和 autoReconnect 生效
  mcpManager.setMcpConfig(config.mcp);
  const securityChecker = new SecurityChecker(cwd, config.security, config.permissionProfile);
  const toolExecutor = new ToolExecutor(registry);
  toolExecutor.setSecurityChecker(securityChecker);
  // 修复：将配置中的 webSearch API Key 注入到工具环境变量，供 web_search 工具读取
  const webSearchEnv: Record<string, string> = {};
  if (config.webSearch?.glmApiKey) webSearchEnv['GLM_WEB_SEARCH_API_KEY'] = config.webSearch.glmApiKey;
  if (config.webSearch?.metasoApiKey) webSearchEnv['METASO_API_KEY'] = config.webSearch.metasoApiKey;
  if (config.webSearch?.baiduApiKey) webSearchEnv['BAIDU_API_KEY'] = config.webSearch.baiduApiKey;
  if (config.webSearch?.tavilyApiKey) webSearchEnv['TAVILY_API_KEY'] = config.webSearch.tavilyApiKey;
  if (config.webSearch?.bingApiKey) webSearchEnv['BING_SEARCH_API_KEY'] = config.webSearch.bingApiKey;
  if (config.webSearch?.perplexityApiKey) webSearchEnv['PERPLEXITY_API_KEY'] = config.webSearch.perplexityApiKey;
  if (config.webSearch?.exaApiKey) webSearchEnv['EXA_API_KEY'] = config.webSearch.exaApiKey;
  if (config.webSearch?.braveApiKey) webSearchEnv['BRAVE_SEARCH_API_KEY'] = config.webSearch.braveApiKey;
  if (config.webSearch?.searxngEndpoint) webSearchEnv['SEARXNG_ENDPOINT'] = config.webSearch.searxngEndpoint;

  const adapter = new ToolRegistryAdapter(registry, toolExecutor, {
    workingDirectory: cwd,
    allowedDirectories: [cwd],
    environment: { ...process.env, ...webSearchEnv } as Record<string, string>,
    timeoutMs: 30000,
  });
  // Phase 34：让工具执行通过 TraceCollector 记录 span
  adapter.setTraceCollector(trace);
  const workModeController = new WorkModeController();
  // Phase 32 Task 1.3：先创建 ReadTracker，供 GuardedToolExecutorAdapter 使用
  // 配置开关：optimization.safety.readBeforeWrite（默认 true）
  const readTracker = createReadTracker(cwd);
  const readBeforeWriteEnabled = config.optimization?.safety?.readBeforeWrite !== false;
  const guardedAdapter = new GuardedToolExecutorAdapter(adapter, workModeController, readTracker, readBeforeWriteEnabled);
  // 传入 autoApprovePatterns：从 config.autonomy 读取，让只读安全工具自动批准
  // 匹配的工具跳过用户确认，写入/执行类工具仍需确认
  const agentLoop = new ReActAgentLoop(guardedAdapter, {
    maxIterations: 50,
    toolsEnabled: true,
    autoApprovePatterns: config.autonomy?.autoApprovePatterns ?? [],
  });
  // Phase 34：注入 TraceCollector，记录 LLM 调用与循环事件
  agentLoop.setTraceCollector(trace);

  // Phase 71 Task B3：注入记忆召回注入器到 agentLoop
  // run() 在 systemPrompt 处理完后调用 recallInjector.recallToPrompt(userMessage)
  // 把 KnowledgeGraph 中相关记忆格式化为【相关记忆】片段追加到 systemPrompt
  agentLoop.setRecallInjector(recallInjector);

  // Phase 71 Task E1：注入 VirtualFS 到 agentLoop
  // loop 持有同一 VFS 实例（与上方注册的 4 个 VFS 工具共享），保证工具层与 loop 状态一致
  agentLoop.setVirtualFS(virtualFS);

  // Phase 71 Task E2：注入 PlanState 到 agentLoop
  // loop 持有同一 PlanState 实例（内部复用 virtualFS），保证工具层与 loop 状态一致
  agentLoop.setPlanState(planState);

  // 任务1：注入 ComposePipeline，让 Compose 模式具备阶段提示词注入和自动流转能力
  agentLoop.setComposePipeline(workModeController.getComposePipeline());
  // 任务3：注入简洁思考约束开关（来自 optimization.conciseThinking.enabled，默认 false）
  agentLoop.setConciseThinking(config.optimization?.conciseThinking?.enabled === true);

  // Phase 30 Task 1：Token Profiler（可观测性）
  // 默认开启——可观测性不应是实验性的
  const profiler = config.optimization?.tokenTracking?.enabled !== false
    ? new TokenProfiler()
    : null;
  if (profiler) {
    agentLoop.setProfiler(profiler);
  }

  // Phase 53 Task 9：预算监控（受 config.phase53Integration.budgetMonitor.enabled 守护，fail-open）
  // tokenLimit 取自 config.router.budget.dailyLimit（默认 500000），避免在 BudgetMonitorConfigSchema 重复定义
  const phase53BudgetCfg = config.phase53Integration?.budgetMonitor;
  if (phase53BudgetCfg?.enabled) {
    const budgetMonitorModulePath = '../agent/budget-monitor.js';
    import(budgetMonitorModulePath)
      .then((mod: { BudgetMonitor: new (opts: { tokenLimit: number; costLimit?: number; tokenWarnRatio?: number; toolLoopThreshold?: number }) => unknown }) => {
        const monitor = new mod.BudgetMonitor({
          tokenLimit: config.router.budget.dailyLimit,
          costLimit: phase53BudgetCfg.costLimitPerSession,
          tokenWarnRatio: phase53BudgetCfg.tokenWarnRatio,
          toolLoopThreshold: phase53BudgetCfg.toolLoopThreshold,
        });
        // feature-detect：方法可能由其他子代理添加
        const loop = agentLoop as unknown as { setBudgetMonitor?: (m: unknown) => void };
        if (typeof loop.setBudgetMonitor === 'function') {
          loop.setBudgetMonitor(monitor);
          logger.debug('BudgetMonitor injected', {
            via: 'setBudgetMonitor',
            tokenLimit: config.router.budget.dailyLimit,
          });
        }
      })
      .catch(() => { /* fail-open：监控器不可用时跳过 */ });
  }

  // P1-6：子 Agent 生成工具（需注入 spawnAgent 函数，依赖 agentLoop 和 primaryClient）
  // Phase 38 Task 2：防递归增强 + 并行上限
  //   - 防递归：通过 ToolRegistry.clone() + 移除 spawn_agent 实现（工具集层面物理阻断）
  //   - 并行上限：通过 createConcurrencyLimitedSpawnFn 包装器限制同时执行的子 Agent 数
  //   - 角色工具集：根据 subagentType 过滤子 Agent 可用工具
  //   - 移除旧的 MAX_SPAWN_DEPTH 计数器（不再需要，工具集隔离已物理阻断递归）
  //   - 移除旧的 register/unregister 竞态写法（不再修改共享 registry）
  // Phase 43：优先使用 config.subAgents 的派遣配置；未启用时直接不注册 spawn_agent
  const subAgentsCfg = config.subAgents;
  const subAgentsEnabled = subAgentsCfg?.enabled !== false;
  const MAX_CONCURRENT_SUB_AGENTS = subAgentsEnabled ? (subAgentsCfg?.maxParallel ?? config.agent?.maxConcurrentSubAgents ?? 3) : 0;
  // Phase 50 Task 3：声明外层作用域变量，delegationIntegration 开启时由 wrapSpawnAgentWithDelegation 块填充
  let delegationLifecycle: SubAgentLifecycle | null = null;
  let delegationScoreCardCollector: SubAgentScoreCardCollector | null = null;
  // CR-4b：活动面板存储（config.activityPanel.enabled 守护）
  // 在外层作用域实例化，既供 wrapSpawnAgentWithDelegation 注入，也供 AppDependencies 返回
  const activityPanelCfg = config.activityPanel;
  const activityStore = activityPanelCfg?.enabled
    ? new AgentActivityStore(activityPanelCfg.maxActiveDisplay, activityPanelCfg.maxRecentDisplay)
    : undefined;
  if (activityStore) {
    logger.info('app-init: AgentActivityStore 已启用', {
      maxActive: activityPanelCfg!.maxActiveDisplay,
      maxRecent: activityPanelCfg!.maxRecentDisplay,
    });
  }

  /**
   * 创建子 Agent 的 spawn 函数
   * Phase 38 Task 2：使用 childRegistry 隔离工具集，不再修改共享 registry
   * Phase 48 Task 4：接入 AgentProfileManager
   *   - 创建闭包级 profileManager 实例（懒加载，避免启动时阻塞）
   *   - createChildRegistry 时传入 profileManager，让 profile 工具白名单覆盖硬编码白名单
   *   - 子 Agent systemPrompt 优先使用 profile.systemPrompt（> options.systemPrompt > 默认值）
   */
  const createSpawnAgentFn = (): SpawnAgentFunction => {
    // Phase 48 Task 4：闭包级 AgentProfileManager 实例，所有 spawn 调用共享
    const profileManager = new AgentProfileManager(cwd);
    let profileManagerLoaded = false;

    return async (params, options) => {
      // 向后兼容：字符串参数转换为对象
      const normalizedParams: SpawnAgentParams = typeof params === 'string'
        ? { description: params, prompt: params }
        : params;
      const subagentType: SubagentType = normalizedParams.subagentType ?? 'general';

      if (!primaryClient) {
        return { success: false, result: '', error: 'LLM 客户端不可用' };
      }
      try {
        // Phase 48 Task 4：首次调用时加载 AgentProfileManager
        // 失败时仅记录警告，回退到硬编码白名单（fail-open，不阻塞 spawn）
        if (!profileManagerLoaded) {
          try {
            await profileManager.loadAll();
          } catch (err) {
            logger.warn('AgentProfileManager.loadAll 失败，回退到硬编码白名单', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          profileManagerLoaded = true;
        }

        // Phase 48 Task 4：解析子 Agent 对应的 profile（可能为 null）
        // - profile 非空时，createChildRegistry 会用 profile.allowedTools 覆盖硬编码白名单
        // - 同时下方会优先使用 profile.systemPrompt 作为子 Agent 系统提示词
        const profile = resolveProfileForSubagent(profileManager, subagentType);

        const defaultModel = config.providers[0]?.models[0];
        if (!defaultModel) {
          return { success: false, result: '', error: '未配置可用模型' };
        }
        let childClient = primaryClient;
        let routeDecision: RoutingResult;
        if (profile?.modelId && profile.modelId !== 'default') {
          const provider = config.providers.find(p => p.models.some(m => m.id === profile.modelId));
          const model = provider?.models.find(m => m.id === profile.modelId);
          if (!provider || !model) {
            return { success: false, result: '', error: `子 Agent Profile 指定的模型不存在: ${profile.modelId}` };
          }
          const modelClient = clientManager.get(provider.id);
          if (!modelClient || !modelClient.isReady()) {
            return { success: false, result: '', error: `子 Agent Profile 指定的提供商不可用: ${provider.id}` };
          }
          childClient = modelClient;
          routeDecision = {
            model,
            providerId: provider.id,
            fallbackUsed: false,
            originalTier: (model.tier ?? 'medium') as ScenarioTier,
            degraded: false,
          };
        } else if (classifier && modelRouter) {
          const classifyResult: ClassificationResult = await classifier.classify({ query: normalizedParams.description });
          routeDecision = await modelRouter.route(classifyResult);
          const routedClient = clientManager.get(routeDecision.providerId);
          if (!routedClient || !routedClient.isReady()) {
            return { success: false, result: '', error: `子 Agent 路由提供商不可用: ${routeDecision.providerId}` };
          }
          childClient = routedClient;
        } else {
          routeDecision = {
            model: defaultModel,
            providerId: primaryProviderId,
            fallbackUsed: false,
            originalTier: (defaultModel.tier ?? 'medium') as ScenarioTier,
            degraded: false,
          };
        }
        let responseText = '';
        let inputTokens = 0;
        let outputTokens = 0;

        // Phase 38 Task 2：创建子 Agent 专用 registry（防递归 + 角色白名单过滤）
        // 不再在共享 registry 上 register/unregister，消除竞态条件
        // Phase 48 Task 4：传入 profileManager，让 profile 工具白名单生效
        const childRegistry = createChildRegistry(registry, subagentType, profileManager);

        // 为子 Agent 创建专用 adapter（使用 childRegistry，实现工具集物理隔离）
        const childToolExecutor = new ToolExecutor(childRegistry);
        childToolExecutor.setSecurityChecker(securityChecker);
        const childAdapter = new ToolRegistryAdapter(childRegistry, childToolExecutor, {
          workingDirectory: cwd,
          allowedDirectories: [cwd],
          environment: { ...process.env, ...webSearchEnv } as Record<string, string>,
          timeoutMs: 30000,
        });
        childAdapter.setTraceCollector(trace);
        const childGuardedAdapter = new GuardedToolExecutorAdapter(
          childAdapter, workModeController, readTracker, readBeforeWriteEnabled,
        );

        // 创建临时 Agent Loop 实例，使用指定的 maxIterations
        // 透传 autoApprovePatterns，保持子 Agent 与主 Agent 一致的自动批准策略
        // Phase 48 Task 4：maxIterations 优先使用 profile.maxSteps（若 profile 存在）
        const profileMaxSteps = profile?.maxSteps && profile.maxSteps > 0
          ? profile.maxSteps
          : undefined;
        const requestedMaxIterations = normalizedParams.maxIterations
          ?? options?.maxIterations
          ?? profileMaxSteps
          ?? 20;
        const effectiveMaxIterations = profileMaxSteps
          ? Math.min(requestedMaxIterations, profileMaxSteps)
          : requestedMaxIterations;
        const childLoop = new ReActAgentLoop(childGuardedAdapter, {
          maxIterations: effectiveMaxIterations,
          toolsEnabled: true,
          parallelToolExecution: true,
          autoApprovePatterns: config.autonomy?.autoApprovePatterns ?? [],
        });
        childLoop.setMiddlewarePipeline(pluginSystem.middlewarePipeline);

        const childSystemPrompt = profile?.systemPrompt
          ?? options?.systemPrompt
          ?? '你是一个专注的子 Agent，负责完成分配给你的独立子任务。';

        for await (const event of childLoop.run({
          userMessage: normalizedParams.prompt,
          llmClient: childClient,
          routeDecision,
          conversationHistory: [],
          systemPrompt: childSystemPrompt,
        })) {
          switch (event.type) {
            case 'text_delta':
              responseText += event.text;
              break;
            case 'done':
              if (event.content) responseText = event.content;
              if (event.usage) {
                inputTokens = event.usage.inputTokens;
                outputTokens = event.usage.outputTokens;
              }
              break;
          }
        }
        return {
          success: true,
          result: responseText,
          tokenUsage: { inputTokens, outputTokens },
        };
      } catch (err) {
        return {
          success: false,
          result: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
  };
  // Phase 38 Task 2：用并行上限包装器包装 spawn 函数
  // 达到 MAX_CONCURRENT_SUB_AGENTS 时返回错误，执行期间计数器++，finally 中--
  // Phase 50 Task 3：delegationIntegration 任一开关开启时，再用 wrapSpawnAgentWithDelegation 包装
  //   包装顺序：innerSpawn → concurrencyLimit → delegation → SpawnAgentTool
  //   delegation 在最外层：每次 spawn 都经过委托体系检查（context/gate/enforcer/lifecycle/scorecard）
  //   未开启任一开关时 wrapper 是 passthrough（零开销）

  // Phase 55 Task 8：提前创建 workerProfileManager（供 delegationDeps.detachedSession 和 WorkerExecutor 共享）
  // 异步加载，不阻塞启动；WorkerExecutor.execute() 调用 resolveProfileForTask 时若未加载完成会回退到内置模板
  const workerProfileManager = new AgentProfileManager(cwd);
  workerProfileManager.loadAll().catch(err => {
    logger.warn('AgentProfileManager.loadAll 失败，WorkerExecutor 将回退到 WORKER_ROLE_PROMPTS', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Phase 52 Task 1：SkillLifecycleManager 提前创建（需在 delegationDeps 装配前就绪，
  // 以便注入 wrapSpawnAgentWithDelegation，在每次 spawn 完成后记录执行）
  let skillLifecycleManager: SkillLifecycleManager | undefined;
  if (config.phase52Integration?.skillLifecycle?.enabled) {
    skillLifecycleManager = new SkillLifecycleManager(config.phase52Integration.skillLifecycle);
    logger.info('app-init: SkillLifecycleManager 已启用');
  }

  if (subAgentsEnabled && MAX_CONCURRENT_SUB_AGENTS > 0) {
    let spawnAgentFn: SpawnAgentFunction = createConcurrencyLimitedSpawnFn(
      createSpawnAgentFn(),
      MAX_CONCURRENT_SUB_AGENTS,
    );
    const delegationCfg = config.delegationIntegration;
    // CR-4b：把 delegationPolicy / resultSchema / activityStore 也纳入包装触发条件
    //   任一开关开启即应用 wrapSpawnAgentWithDelegation，由 wrapper 内部各开关分别守护
    const delegationPolicyCfg = config.delegationPolicy;
    const resultSchemaCfg = config.resultSchema;
    const anyDelegationEnabled = !!(
      delegationCfg?.contextPackerEnabled ||
      delegationCfg?.delegationGateEnabled ||
      delegationCfg?.delegationEnforcerEnabled ||
      delegationCfg?.lifecycleEnabled ||
      delegationCfg?.scoreCardEnabled ||
      delegationPolicyCfg?.boundedDelegationEnabled ||
      resultSchemaCfg?.enabled ||
      !!activityStore
    );
    if (anyDelegationEnabled) {
      const contextPacker = delegationCfg?.contextPackerEnabled ? new ContextPacker() : undefined;
      const delegationGate = delegationCfg?.delegationGateEnabled ? new DelegationGate() : undefined;
      const subAgentLifecycle = delegationCfg?.lifecycleEnabled ? new SubAgentLifecycle() : null;
      const scoreCardCollector = delegationCfg?.scoreCardEnabled ? new SubAgentScoreCardCollector() : null;
      // CR-4b：构造 decideDelegation 所需策略对象（仅 boundedDelegationEnabled 启用时）
      const delegationPolicyEnabled = !!delegationPolicyCfg?.boundedDelegationEnabled;
      const delegationPolicy = delegationPolicyEnabled
        ? {
            hardDelegationTypes: (delegationPolicyCfg!.hardDelegationTypes ?? []).filter(
              (t): t is 'frontend' | 'research' | 'review' =>
                t === 'frontend' || t === 'research' || t === 'review',
            ),
            refuseIfSpecialistUnavailable: delegationPolicyCfg!.refuseIfSpecialistUnavailable ?? false,
            specialistAvailability: delegationPolicyCfg!.specialistAvailabilityOverride ?? {},
          }
        : undefined;
      const delegationDeps: DelegationIntegrationDeps = {
        contextPackerEnabled: delegationCfg?.contextPackerEnabled,
        contextPacker,
        delegationGateEnabled: delegationCfg?.delegationGateEnabled,
        delegationGate,
        delegationEnforcerEnabled: delegationCfg?.delegationEnforcerEnabled,
        parentAgent: { id: 'parent-root', activeSubAgents: [] },
        lifecycleEnabled: delegationCfg?.lifecycleEnabled,
        lifecycle: subAgentLifecycle ?? undefined,
        scoreCardEnabled: delegationCfg?.scoreCardEnabled,
        scoreCardCollector: scoreCardCollector ?? undefined,
        // CR-4b 新增接线点：委托三态策略 / 结果 schema 校验 / 活动面板
        delegationPolicyEnabled,
        delegationPolicy,
        resultSchemaEnabled: !!resultSchemaCfg?.enabled,
        resultSchemaStrict: resultSchemaCfg?.strictValidation,
        resultSchemaFallbackToText: resultSchemaCfg?.fallbackToText,
        activityStoreEnabled: !!activityStore,
        activityStore,
        // Phase 55 Task 8：修复 detachedSession 接线断层（原漏传导致 spawn-agent.ts:546 分支永不执行）
        detachedSessionEnabled: !!delegationPolicyCfg?.detachedSessionEnabled,
        profileManager: workerProfileManager,
        // Phase 52 Task 1：SkillLifecycleManager 注入，spawn 完成后记录执行记忆
        skillLifecycleManager,
      };
      spawnAgentFn = wrapSpawnAgentWithDelegation(spawnAgentFn, delegationDeps);
      logger.info('Phase 50: spawn_agent wrapped with delegation modules', {
        contextPacker: !!contextPacker,
        gate: !!delegationGate,
        enforcer: delegationCfg?.delegationEnforcerEnabled,
        lifecycle: !!subAgentLifecycle,
        scoreCard: !!scoreCardCollector,
        delegationPolicy: delegationPolicyEnabled,
        resultSchema: !!resultSchemaCfg?.enabled,
        activityStore: !!activityStore,
      });
      // 暴露实例到外层作用域，供 AppDependencies 返回
      delegationLifecycle = subAgentLifecycle;
      delegationScoreCardCollector = scoreCardCollector;
    }
    registry.register(new SpawnAgentTool(spawnAgentFn));
  }

  // ===== 插件系统 =====
  const pluginSystem = createPluginSystem(cwd, registry);
  // 将插件系统的中间件管线注入 Agent Loop，让 Hook 插件真正生效
  agentLoop.setMiddlewarePipeline(pluginSystem.middlewarePipeline);

  // Phase 38 Task 1：注册 LoopDetectionMiddleware 到 onReasoning 阶段
  // 配置来自 config.middleware.loopDetection（默认启用，windowSize=10，maxRepeats=3）
  const loopDetectionCfg = config.middleware?.loopDetection;
  if (loopDetectionCfg?.enabled !== false) {
    const loopDetection = new LoopDetectionMiddleware({
      windowSize: loopDetectionCfg?.windowSize,
      maxRepeats: loopDetectionCfg?.maxRepeats,
    });
    pluginSystem.middlewarePipeline.register('onReasoning', loopDetection.getHandler());
    logger.info('LoopDetectionMiddleware registered', {
      windowSize: loopDetectionCfg?.windowSize ?? 10,
      maxRepeats: loopDetectionCfg?.maxRepeats ?? 3,
    });
  }

  // Phase 71 Task B2：注册 MentionResolverMiddleware 到 onUserMessage 阶段
  // @-mention 统一引用协议：解析用户输入中的 @文件路径 / @符号名 / @URL
  // 把解析结果注入 ctx.metadata.mentions，并把 @-mention 标准化为绝对路径
  // fail-open：解析失败时不阻塞用户消息
  const mentionResolver = new MentionResolverMiddleware(cwd);
  pluginSystem.middlewarePipeline.register('onUserMessage', mentionResolver.getHandler());
  logger.info('MentionResolverMiddleware registered', { cwd });

  // ===== Phase 39：CodeMapContextMiddleware 接线 =====
  // 代码地图上下文中间件：自动注入项目结构到 system prompt
  // 注：code-map-context.ts 由其他子代理创建，使用变量路径动态 import 避免 typecheck 失败
  //     文件存在时正常加载并注册到 onSystemPrompt 阶段；不存在时跳过（fail-open）
  const codegraphCfg = config.codegraph;
  if (codegraphCfg) {
    // 使用变量路径让 TypeScript 无法静态解析（模块可能尚未创建）
    const codeMapModulePath = '../agent/middleware/code-map-context.js';
    import(codeMapModulePath)
      .then((mod: { CodeMapContextMiddleware: new (cwd: string, budgetTokens?: number) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
        const budgetTokens = config.codeMap?.budgetTokens ?? 2048;
        const codeMapMiddleware = new mod.CodeMapContextMiddleware(cwd, budgetTokens);
        pluginSystem.middlewarePipeline.register('onSystemPrompt', codeMapMiddleware.getHandler());
        logger.info('CodeMapContextMiddleware registered', {
          budgetTokens,
          enabled: codegraphCfg.enabled,
        });
      })
      .catch((err: unknown) => {
        // fail-open：code-map-context.ts 尚未创建时跳过，不影响主流程
        logger.debug('CodeMapContextMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 41/42：tree-sitter 代码地图引擎预热 =====
  // 启动时异步触发首次 fullIndex，不阻塞主流程（.then().catch() 模式）
  // 失败时仅 warn 不崩溃；middleware 首次调用时会再次尝试 fullIndex，
  // 若仍失败则降级到 regex 方案（fail-open）
  import('../code-map/indexer.js')
    .then(async (mod: { fullIndex: (rootDir: string, opts?: { maxFiles?: number }) => Promise<{ stats: unknown; db: unknown }> }) => {
      try {
        await mod.fullIndex(cwd, { maxFiles: 5000 });
        logger.info('CodeMap fullIndex prewarmed', { rootDir: cwd });
      } catch (err) {
        logger.warn('CodeMap fullIndex prewarm failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
    .catch((err: unknown) => {
      logger.warn('CodeMap indexer module not available', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // ===== Phase 39：HookConfigRegistry 接线 =====
  // 已移至 hookRunner 创建后执行（需要 hookRunner 实例进行注册）
  // 见下方 "HookConfigRegistry → HookRunner 接线" 段

  // ===== Phase 39：ExperimentManager 配置传递 =====
  // 实验分支管理器配置：maxActiveWorktrees / autoCleanup
  // 注：ExperimentManager 已存在（src/harness/experiment-manager.ts），
  //     此处仅记录配置，实际实例化由 engine-bridge 或 CLI command 负责
  const experimentsCfg = config.experiments;
  if (experimentsCfg) {
    logger.info('Experiments config loaded', {
      maxActiveWorktrees: experimentsCfg.maxActiveWorktrees,
      autoCleanup: experimentsCfg.autoCleanup,
    });
  }

  // ===== Phase 40：渐进式信任 / 质量监测 / 用户经验 接线 =====
  // 注：trust-gradient.ts 已存在；quality-signal.ts / expertise-manager.ts / expertise-prompt.ts
  //     由其他子代理并行创建，使用变量路径动态 import 避免 typecheck 失败（fail-open 策略）

  // 4.1 TrustGradientManager 接线
  //     构造函数接受 sessionId，接线后注入 PermissionEngine（若引擎支持）
  const trustCfg = config.trust;
  if (trustCfg) {
    const trustModulePath = '../tools/trust-gradient.js';
    import(trustModulePath)
      .then((mod: { TrustGradientManager: new (sessionId: string, level?: string) => { setLevel: (l: string) => void; getLevel: () => string } }) => {
        const sessionId = trace.getSessionId() ?? `app-${Date.now()}`;
        const trustManager = new mod.TrustGradientManager(sessionId, trustCfg.baseLevel);
        trustManager.setLevel(trustCfg.baseLevel);
        // 注入 PermissionEngine（feature-detect：方法可能由其他子代理添加）
        const engine = permissionEngine as unknown as { setTrustGradientManager?: (m: unknown) => void };
        if (typeof engine.setTrustGradientManager === 'function') {
          engine.setTrustGradientManager(trustManager);
        }
        logger.info('TrustGradientManager registered', {
          baseLevel: trustCfg.baseLevel,
          enableTemporaryGrants: trustCfg.enableTemporaryGrants,
          grantTTLMinutes: trustCfg.grantTTLMinutes,
        });
      })
      .catch((err: unknown) => {
        logger.debug('TrustGradientManager not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 4.2 QualitySignalMiddleware 接线
  //     注册到 onActing 阶段，检测隐式反馈并触发降级
  const qualityCfg = config.quality;
  if (qualityCfg?.enableImplicitFeedback !== false) {
    const qualityModulePath = '../agent/middleware/quality-signal.js';
    import(qualityModulePath)
      .then((mod: { QualitySignalMiddleware: new (opts?: unknown) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
        const qualityMiddleware = new mod.QualitySignalMiddleware({
          negativeSignalThreshold: qualityCfg.negativeSignalThreshold,
          signalRetentionDays: qualityCfg.signalRetentionDays,
          autoImproveKnowledgeGraph: qualityCfg.autoImproveKnowledgeGraph,
          debounceMs: qualityCfg.debounceMs,
        });
        pluginSystem.middlewarePipeline.register('onActing', qualityMiddleware.getHandler());
        logger.info('QualitySignalMiddleware registered', {
          negativeSignalThreshold: qualityCfg.negativeSignalThreshold,
          signalRetentionDays: qualityCfg.signalRetentionDays,
        });
      })
      .catch((err: unknown) => {
        // fail-open：quality-signal.ts 尚未创建时跳过
        logger.debug('QualitySignalMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 4.3 ExpertisePromptMiddleware 接线
  //     注册到 onSystemPrompt 阶段，根据经验等级注入差异化提示词
  const expertiseCfg = config.expertise;
  if (expertiseCfg) {
    const expertiseManagerPath = '../config/expertise-manager.js';
    const expertiseMiddlewarePath = '../agent/middleware/expertise-prompt.js';
    Promise.all([
      import(expertiseManagerPath),
      import(expertiseMiddlewarePath),
    ])
      .then(async ([mgrMod, mwMod]: [unknown, unknown]) => {
        const ManagerCtor = (mgrMod as { ExpertiseManager: new (p: string) => { load: () => Promise<void> } }).ExpertiseManager;
        const MiddlewareCtor = (mwMod as { ExpertisePromptMiddleware: new (m: unknown) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }).ExpertisePromptMiddleware;
        const expertiseManager = new ManagerCtor(path.join(cwd, '.routedev', 'expertise.json'));
        await expertiseManager.load();
        const expertiseMiddleware = new MiddlewareCtor(expertiseManager);
        pluginSystem.middlewarePipeline.register('onSystemPrompt', expertiseMiddleware.getHandler());
        logger.info('ExpertisePromptMiddleware registered', {
          level: expertiseCfg.level,
          enableAutoSuggestion: expertiseCfg.enableAutoSuggestion,
        });
      })
      .catch((err: unknown) => {
        // fail-open：expertise-manager.ts / expertise-prompt.ts 尚未创建时跳过
        logger.debug('ExpertisePromptMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 41：CodeMapEngine 接线（自研代码地图引擎） =====
  // 自研引擎：tree-sitter (WASM) + SQLite + PageRank + Aider 风格渲染
  // 注：code-map/index.ts 由其他子代理创建，使用变量路径动态 import 避免 typecheck 失败
  //     文件存在时正常加载并注册；不存在时 fail-open 回退到正则 repo-map
  const codeMapCfg = config.codeMap;
  if (codeMapCfg && codeMapCfg.engine !== 'disabled') {
    const codeMapModulePath = '../code-map/index.js';
    import(codeMapModulePath)
      .then(async (mod: { CodeMapEngine: new (cwd: string, opts?: unknown) => { init: () => Promise<void> } }) => {
        const engine = new mod.CodeMapEngine(cwd, {
          engine: codeMapCfg.engine,
          budgetTokens: codeMapCfg.budgetTokens,
          enableHCGS: codeMapCfg.enableHCGS,
          enableSemanticEdges: codeMapCfg.enableSemanticEdges,
          indexExclude: codeMapCfg.indexExclude,
          maxContextSymbols: codeMapCfg.maxContextSymbols,
          autoIndex: codeMapCfg.autoIndex,
        });
        await engine.init();
        logger.info('CodeMapEngine registered', {
          engine: codeMapCfg.engine,
          budgetTokens: codeMapCfg.budgetTokens,
          autoIndex: codeMapCfg.autoIndex,
        });
      })
      .catch((err: unknown) => {
        // fail-open：回退到正则 repo-map
        logger.debug('CodeMapEngine not available yet, falling back to regex repo-map', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 71 Task A5：CodeMap Watcher 接线 =====
  // watchMode 默认关闭，启用时监听源码文件变更并触发增量索引
  // fail-open：watcher 启动失败不阻塞主流程；进程退出时 close() 释放句柄
  if (config.codeMap?.watchMode === true) {
    const watcherModulePath = '../code-map/watcher.js';
    import(watcherModulePath)
      .then((mod: { CodeMapWatcher: new (rootDir: string, dbPath: string) => { start: () => void; close: () => void } }) => {
        const dbPath = path.join(cwd, '.routedev', 'code-map', 'code-map.db');
        const watcher = new mod.CodeMapWatcher(cwd, dbPath);
        watcher.start();
        logger.info('CodeMapWatcher started', { rootDir: cwd, watchMode: true });

        // 注册进程退出钩子，释放 fs.watch 句柄避免泄漏
        const handleClose = () => {
          try {
            watcher.close();
          } catch {
            // fail-open：关闭失败不影响退出
          }
        };
        process.on('beforeExit', handleClose);
        process.on('SIGINT', handleClose);
        process.on('SIGTERM', handleClose);
      })
      .catch((err: unknown) => {
        // fail-open：watcher 模块加载失败不阻塞主流程
        logger.warn('CodeMapWatcher not available, skip watch mode', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 42：PolicyEngine 接线（策略引擎） =====
  // Intent Guard + Playbook + Tool Guide + Tool Approval
  // 注：policies/policy-engine.ts 由其他子代理创建，使用变量路径动态 import 避免 typecheck 失败
  const policiesCfg = config.policies;
  const phase53PolicyCfg = config.phase53Integration?.policyEngine;
  if (policiesCfg?.enabled !== false) {
    const policyModulePath = '../policies/policy-engine.js';
    import(policyModulePath)
      .then((mod: { PolicyEngine: new () => { addPolicy: (p: unknown) => void; evaluateInput: (i: string) => unknown[]; evaluateToolCall: (t: string, a: unknown) => unknown[]; setDefaultPolicy?: (p: 'deny' | 'allow') => void } }) => {
        const engine = new mod.PolicyEngine();
        // Phase 53 Task 3：设置默认策略（fail-closed 控制）
        // phase53Integration.policyEngine.enabled=false 时 setPolicyEngine 不被调用，loop 不接入策略引擎
        // phase53Integration.policyEngine.enabled=true 时按 defaultPolicy 设置（默认 'deny'）
        if (phase53PolicyCfg?.enabled && typeof engine.setDefaultPolicy === 'function') {
          engine.setDefaultPolicy(phase53PolicyCfg.defaultPolicy ?? 'deny');
        }
        // 根据配置添加内置策略（Intent Guard / Playbook / Tool Guide / Tool Approval）
        // 各策略模块由其他子代理创建，使用变量路径让 TypeScript 无法静态解析（fail-open）
        if (policiesCfg.intentGuard !== false) {
          const guardPath = '../policies/intent-guard.js';
          import(guardPath)
            .then((guardMod: { createBuiltinIntentGuardPolicies?: () => unknown[] }) => {
              if (typeof guardMod.createBuiltinIntentGuardPolicies === 'function') {
                for (const p of guardMod.createBuiltinIntentGuardPolicies()) {
                  engine.addPolicy(p);
                }
              }
            })
            .catch(() => { /* fail-open */ });
        }
        if (policiesCfg.playbook !== false) {
          const playbookPath = '../policies/playbook.js';
          import(playbookPath)
            .then((pbMod: { createBuiltinPlaybookPolicies?: () => unknown[] }) => {
              if (typeof pbMod.createBuiltinPlaybookPolicies === 'function') {
                for (const p of pbMod.createBuiltinPlaybookPolicies()) {
                  engine.addPolicy(p);
                }
              }
            })
            .catch(() => { /* fail-open */ });
        }
        if (policiesCfg.toolGuide !== false) {
          const toolGuidePath = '../policies/tool-guide.js';
          import(toolGuidePath)
            .then((tgMod: { createBuiltinToolGuidePolicies?: () => unknown[] }) => {
              if (typeof tgMod.createBuiltinToolGuidePolicies === 'function') {
                for (const p of tgMod.createBuiltinToolGuidePolicies()) {
                  engine.addPolicy(p);
                }
              }
            })
            .catch(() => { /* fail-open */ });
        }
        if (policiesCfg.toolApproval !== false) {
          const toolApprovalPath = '../policies/tool-approval.js';
          import(toolApprovalPath)
            .then((taMod: { createBuiltinToolApprovalPolicies?: (mode: string) => unknown[] }) => {
              if (typeof taMod.createBuiltinToolApprovalPolicies === 'function') {
                for (const p of taMod.createBuiltinToolApprovalPolicies(policiesCfg.approvalMode)) {
                  engine.addPolicy(p);
                }
              }
            })
            .catch(() => { /* fail-open */ });
        }
        // 注册到 AgentLoop 的输入/工具调用链（feature-detect：方法可能由其他子代理添加）
        const loop = agentLoop as unknown as { setPolicyEngine?: (e: unknown) => void };
        if (typeof loop.setPolicyEngine === 'function') {
          loop.setPolicyEngine(engine);
        }
        logger.info('PolicyEngine registered', {
          intentGuard: policiesCfg.intentGuard,
          playbook: policiesCfg.playbook,
          toolGuide: policiesCfg.toolGuide,
          toolApproval: policiesCfg.toolApproval,
          approvalMode: policiesCfg.approvalMode,
        });
      })
      .catch((err: unknown) => {
        // fail-open：策略引擎不可用时跳过，不影响主流程
        logger.debug('PolicyEngine not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Skills 系统（Phase 37：按需加载 Markdown Skill） =====
  // 状态持久化到 ~/.qoderwork/routedev/skill-state.json（与 plugin-state.json 同目录）
  const skillStatePath = path.join(homedir(), '.qoderwork', 'routedev', 'skill-state.json');
  const skillsRouter = new SkillsRouter(skillStatePath);
  const filesystemDiscovery = new FilesystemDiscovery(cwd);
  // 异步发现并注册 Skill（不阻塞 App 初始化）
  filesystemDiscovery.discoverSkills().then((skills) => {
    for (const skill of skills) {
      skillsRouter.register(skill);
    }
    logger.info('Skills discovered and registered', { count: skills.length });
  }).catch((err) => {
    logger.warn('Failed to discover skills', { error: err instanceof Error ? err.message : String(err) });
  });

  // ===== 权限引擎 =====
  const permissionEngine = createDefaultEngine();
  // Phase 48 Task 1：从配置应用沙箱级与审批级覆盖（交互模式生效）
  if (config.security?.sandbox) {
    permissionEngine.setSandboxLevel(config.security.sandbox);
  }
  if (config.security?.approval) {
    for (const [category, level] of Object.entries(config.security.approval)) {
      permissionEngine.setApproval(category as never, level);
    }
  }

  // ===== 多 Agent =====
  // Phase 50 Task 2：orchestrationIntegration 开关开启时注入 StrategySelector/StateGraph/BranchOrchestrator
  // 未开启任何开关时传 undefined（Orchestrator 内部回退到原行为）
  const orchestrationIntegrationCfg = config.orchestrationIntegration;
  const orchestrationIntegration: OrchestrationIntegrationOptions | undefined = (
    orchestrationIntegrationCfg?.strategyEnabled ||
    orchestrationIntegrationCfg?.stateGraphEnabled ||
    orchestrationIntegrationCfg?.branchOrchestrationEnabled
  )
    ? {
        strategyEnabled: orchestrationIntegrationCfg?.strategyEnabled,
        stateGraphEnabled: orchestrationIntegrationCfg?.stateGraphEnabled,
        branchOrchestrationEnabled: orchestrationIntegrationCfg?.branchOrchestrationEnabled,
        // branchOrchestrator 实例需 ExperimentManager + RunnerFactory，这里不创建（生产 wiring 留给后续阶段）
        // branchOrchestrationEnabled=true 时 Orchestrator.planBranches 会因 branchOrchestrator 缺失安全回退
      }
    : undefined;
  const orchestrator = new Orchestrator(primaryClient, config.router.classifierModel, orchestrationIntegration);
  // Phase 54 Task 2：orchestrationIntegration 任一开关开启时创建 ContextPacker 并注入 WorkerExecutor
  // 注入后 WorkerExecutor.execute() 会调用 pack() 生成结构化上下文包（选择性传递可视化）
  // 未开启任一开关时 contextPacker 为 undefined，WorkerExecutor 回退到 filterContext（零回归）
  const workerContextPacker = orchestrationIntegration ? new ContextPacker() : undefined;
  // Phase 54：workerProfileManager 已在 Phase 55 Task 8 提前创建（供 delegationDeps.detachedSession 和 WorkerExecutor 共享）
  // Phase 35 Task 1：注入 workerContext 配置，启用上下文选择性传递
  const workerExecutor = new WorkerExecutor(agentLoop, {
    agentLoop,
    workerContextConfig: config.optimization?.workerContext,
    // Phase 54 Task 2：可选注入 ContextPacker
    contextPacker: workerContextPacker,
    // Phase 54：注入 AgentProfileManager，让 Worker 用 profile.systemPrompt 替换 WORKER_ROLE_PROMPTS
    profileManager: workerProfileManager,
  });
  if (workerContextPacker) {
    logger.info('Phase 54 Task 2: ContextPacker injected into WorkerExecutor', {
      strategyEnabled: !!orchestrationIntegrationCfg?.strategyEnabled,
      stateGraphEnabled: !!orchestrationIntegrationCfg?.stateGraphEnabled,
      branchOrchestrationEnabled: !!orchestrationIntegrationCfg?.branchOrchestrationEnabled,
    });
  }
  logger.info('Phase 54: AgentProfileManager injected into WorkerExecutor (async loading)');

  // Phase 53 Task 11：熔断器（受 config.phase53Integration.circuitBreaker.enabled 守护，fail-open）
  // 注入 workerExecutor + delegationLifecycle（如果存在），使用变量路径让 TypeScript 无法静态解析
  const phase53BreakerCfg = config.phase53Integration?.circuitBreaker;
  if (phase53BreakerCfg?.enabled) {
    const breakerModulePath = '../agent/circuit-breaker.js';
    import(breakerModulePath)
      .then((mod: { CircuitBreaker: new (config?: { failureThreshold?: number; resetTimeout?: number; halfOpenMaxAttempts?: number }) => unknown }) => {
        const breaker = new mod.CircuitBreaker({
          failureThreshold: phase53BreakerCfg.failureThreshold,
          resetTimeout: phase53BreakerCfg.resetTimeout,
          halfOpenMaxAttempts: phase53BreakerCfg.halfOpenMaxAttempts,
        });
        // feature-detect：workerExecutor 和 delegationLifecycle 的 setter 可能由其他子代理添加
        // delegationLifecycle 为外层 let 变量，闭包在此处捕获引用，import 异步回调执行时取最新值
        const we = workerExecutor as unknown as { setCircuitBreaker?: (b: unknown) => void };
        if (typeof we.setCircuitBreaker === 'function') {
          we.setCircuitBreaker(breaker);
        }
        const dl = delegationLifecycle as unknown as { setCircuitBreaker?: (b: unknown) => void } | null;
        if (dl && typeof dl.setCircuitBreaker === 'function') {
          dl.setCircuitBreaker(breaker);
        }
        logger.debug('CircuitBreaker injected', {
          via: 'setCircuitBreaker',
          failureThreshold: phase53BreakerCfg.failureThreshold,
          targets: {
            workerExecutor: typeof we.setCircuitBreaker === 'function',
            delegationLifecycle: !!dl && typeof dl.setCircuitBreaker === 'function',
          },
        });
      })
      .catch(() => { /* fail-open：熔断器不可用时跳过 */ });
  }

  // ===== 目标解析与验证（无状态） =====
  const goalParser = new GoalParser();
  // Phase 58：实例化 PathRouter（统一路径路由器，App.tsx 传给 createGoalRunner）
  const pathRouter = new PathRouter();
  // Phase 53 Task 10：DAG 引擎（受 config.phase53Integration.dagEngine.enabled 守护，fail-open）
  // 使用变量路径让 TypeScript 无法静态解析，避免模块尚未生成时 typecheck 失败
  // Phase 55：dagEngine ref（异步创建，供 goal-runner 通过 ref 延迟读取，与 dualLoopOrchestratorRef 同模式）
  const dagEngineRef: { current: DagEngine | null } = { current: null };
  const phase53DagCfg = config.phase53Integration?.dagEngine;
  if (phase53DagCfg?.enabled) {
    const dagEngineModulePath = '../agent/workflow/dag-engine.js';
    import(dagEngineModulePath)
      .then((mod: { DagEngine: new (opts?: { maxParallel?: number; retryLimit?: number; humanEscalationThreshold?: number }) => DagEngine }) => {
        const engine = new mod.DagEngine({
          maxParallel: phase53DagCfg.maxParallel,
          retryLimit: phase53DagCfg.retryLimit,
          humanEscalationThreshold: phase53DagCfg.humanEscalationThreshold,
        });
        // Phase 55：立即写入 ref，让 goal-runner 在 /goal 触发时能读取到实例
        dagEngineRef.current = engine;
      })
      .catch(() => { /* fail-open：DAG 引擎不可用时跳过 */ });
  }
  const goalVerifier = new GoalVerifier();

  // ===== Phase 50 Task 1：Goal 流程核心模块（按 config.goalIntegration 渐进接入） =====
  // 未开启的开关对应实例为 null，App.tsx 传给 createGoalRunner 时若为 undefined/null 则不接入
  const goalIntegrationCfg = config.goalIntegration;
  const goalAuditor = goalIntegrationCfg?.auditEnabled ? new GoalAuditor() : null;
  const goalPersistence = goalIntegrationCfg?.persistenceEnabled ? new GoalPersistence(cwd) : null;
  // Phase 59：goalPromptBuilder 已删除（批次1 无价值 Integration）
  if (goalIntegrationCfg && (goalAuditor || goalPersistence)) {
    logger.info('Phase 50: goalIntegration modules wired', {
      auditor: !!goalAuditor,
      persistence: !!goalPersistence,
    });
  }

  // ===== 持久化执行器（Phase 27 Task 6） =====
  // Phase 35 Task 2：创建 HookRunner 实例并注册内置钩子
  //   - 传入 TraceCollector：钩子执行时记录 span（禁止创建不带 trace 的 HookRunner）
  //   - 注册内置钩子：post-tool-call 文件验证 + session 生命周期日志
  const hookRunner = new HookRunner();
  hookRunner.setTraceCollector(trace);
  registerBuiltinHooks(hookRunner, audit, cwd, currentModel);

  // C6 修复：将 HookRunner 注入 agentLoop，触发工具级/会话级钩子
  agentLoop.setHookRunner(hookRunner);

  // ===== Phase 39：HookConfigRegistry → HookRunner 接线 =====
  // 加载用户 Hook 配置，通过 adapter 转换为 HookDefinition 后注册到 HookRunner
  // 注：registry.ts / adapter.ts 使用变量路径动态 import 避免 typecheck 失败（fail-open）
  const hooksCfg = config.hooks;
  if (hooksCfg?.enabled !== false) {
    // 使用变量路径让 TypeScript 无法静态解析（模块可能尚未创建）
    const registryModulePath = '../hooks/registry.js';
    import(registryModulePath)
      .then(async (mod: { HookConfigRegistry: new (configPath: string) => { load: () => Promise<void>; list: () => Array<{ id: string; enabled: boolean; [key: string]: unknown }>; get: (id: string) => { id: string; enabled: boolean; [key: string]: unknown } | undefined; add: (config: { id: string; enabled: boolean; [key: string]: unknown }) => void } }) => {
        const hookRegistry = new mod.HookConfigRegistry(path.join(cwd, hooksCfg.configPath));
        await hookRegistry.load();

        // 注册内置 Hook 模板到 HookConfigRegistry（用户可在 UI 中启用）
        // 模板默认 enabled=false，避免覆盖用户已自定义的同名 hook
        const templates = getHookTemplates();
        let templatesAdded = 0;
        for (const template of templates) {
          if (hookRegistry.get(template.id)) continue;
          hookRegistry.add({
            id: template.id,
            name: template.name,
            event: template.event,
            enabled: false,
            condition: template.condition,
            command: template.code,
            failBehavior: template.failBehavior,
            isTemplate: true,
            priority: template.priority,
          });
          templatesAdded++;
        }
        if (templatesAdded > 0) {
          logger.info('Hook 模板已注册到 Registry', { count: templatesAdded });
        }

        const configs = hookRegistry.list();
        let registered = 0;
        for (const cfg of configs) {
          if (cfg.enabled === false) continue;
          try {
            const adapterModulePath = '../hooks/adapter.js';
            const adapterMod = await import(adapterModulePath) as { configToDefinition: (cfg: unknown) => import('../agent/hooks.js').HookDefinition };
            const def = adapterMod.configToDefinition(cfg);
            hookRunner.register(def);
            registered++;
          } catch (err) {
            logger.warn('Hook 注册失败，跳过', {
              hookId: cfg.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        logger.info('HookConfigRegistry 接线完成', {
          configPath: hooksCfg.configPath,
          total: configs.length,
          registered,
        });
      })
      .catch((err: unknown) => {
        // fail-open：registry.ts 尚未创建时跳过，不影响主流程
        logger.debug('HookConfigRegistry not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Phase 43：Hook 增强配置接入
  // 创建 HookEnhancementManager 实例，根据配置控制函数 Hook、沙箱、试用、分组与安全审查
  const hookEnhancementCfg = config.hookEnhancement;
  const hookEnhancementManager = new HookEnhancementManager();
  // 注册命令安全审查钩子：对 shell_exec / git_op 的命令参数进行危险模式检测
  // 当 hookEnhancement 配置未显式关闭时默认启用（functionHooks/sandbox 为可选项）
  hookRunner.register({
    event: 'post-tool-call',
    name: 'builtin:command-safety-review',
    priority: 40, // 比内置文件验证钩子（50）更早执行
    handler: async (ctx) => {
      const toolName = ctx.toolName;
      const command = ctx.toolArgs?.command as string | undefined;
      if (!command || (toolName !== 'shell_exec' && toolName !== 'git_op')) {
        return { action: 'continue' };
      }
      const { safe, risks } = HookEnhancementManager.analyzeCommand(command);
      if (!safe) {
        return {
          action: 'warn',
          message: `⚠️ 命令安全警告: ${risks.join('; ')}`,
        };
      }
      return { action: 'continue' };
    },
  });
  logger.info('HookEnhancementManager registered', {
    functionHooks: hookEnhancementCfg?.functionHooks,
    sandbox: hookEnhancementCfg?.sandbox,
    trialDays: hookEnhancementCfg?.trialDays,
    hookGroups: hookEnhancementCfg?.hookGroups,
  });

  // ===== Phase 32 Task 1：Phase 31 模块实例化（之前全部为死代码） =====
  // 接线顺序：先创建无依赖的工具类（ReadTracker/Sanitizer/CompletionGate），
  // 再创建依赖 classifier+router+clientManager 的 TaskOrchestrator，
  // 最后创建依赖 agentLoop+tracker 的 ExecutionOrchestrator/UnifiedReviewer

  // 1. ReadTracker 已在工具链阶段创建（供 GuardedToolExecutorAdapter 使用）

  // 2. ToolResultSanitizer——工具结果净化（注入检测 + 智能截断）
  //    maxOutputChars 来自配置 optimization.safety.maxToolOutputChars（默认 16000）
  const maxOutputChars = config.optimization?.safety?.maxToolOutputChars ?? 16000;
  const resultSanitizer = createToolResultSanitizer(maxOutputChars);
  // Phase 32 Task 1.2：将 sanitizer 注入 agentLoop，所有工具结果在注入 LLM 上下文前都会经过净化
  agentLoop.setSanitizer(resultSanitizer);

  // Phase 71 Task D3/D7：注入 ToolOutputPipeline（统一 Sanitizer / Concise Thinking / Budget Offload 三阶段）
  // pipeline 未注入时 loop 走原 sanitizeToolResult 逻辑（零回归）；注入后收拢到一处编排
  // 配置消费链：phase70Integration.toolOutputBudget.enabled + optimization.conciseThinking.enabled
  const toolBudgetCfg = p70Cfg?.toolOutputBudget;
  agentLoop.setToolOutputPipeline(new ToolOutputPipeline({
    sanitizer: resultSanitizer,
    conciseThinkingEnabled: config.optimization?.conciseThinking?.enabled === true,
    budgetEnabled: toolBudgetCfg?.enabled === true,
    offloadDir: offloadRootDir,
    maxChars: toolBudgetCfg?.maxCharsPerOutput ?? 2000,
    sessionId: offloadSessionId,
  }));
  // Phase 32 Task 4.2：将 sanitizer 注入 MCPClientManager，检测 MCP 工具描述中的注入模式
  mcpManager.setSanitizer(resultSanitizer);
  // Phase 53 Task 5：McpSecurityScanner 注入（受 config.phase53Integration.mcpSecurityScan.enabled 守护）
  // 启用后 MCP 工具注册前会扫描 4 类威胁（投毒/仿冒/隐藏指令/地毯式替换）
  // Phase 59 Task 2：mcpSecurityScan 默认 true，加 fail-open 守卫——装配失败不阻塞主流程
  const phase53McpScanCfg = config.phase53Integration?.mcpSecurityScan;
  if (phase53McpScanCfg?.enabled) {
    try {
      const scanner = new McpSecurityScanner({
        knownToolNames: phase53McpScanCfg.knownToolNames,
        blockThreshold: phase53McpScanCfg.blockThreshold,
      });
      mcpManager.setSecurityScanner(scanner);
      logger.debug('McpSecurityScanner injected', { via: 'setSecurityScanner' });
    } catch (err) {
      logger.warn('Phase 59: mcpSecurityScan 装配失败，fail-open 跳过', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. CompletionGate——独立代码验证门（typecheck/lint/tests）
  //    配置来自 optimization.safety.completionGate / gateTimeout / gateRetry
  const safetyCfg = config.optimization?.safety;
  const completionGate = createCompletionGate({
    gateTimeout: safetyCfg?.gateTimeout ?? 180000,
    gateRetry: safetyCfg?.gateRetry ?? 1,
  });

  // Phase 62：动态工作流模式与隔离治理模块实例化（受 dynamicWorkflow.enabled 守护，默认 false）
  // 所有模块可选注入，未启用时为 undefined，execution-orchestrator 降级到原有行为
  const dwCfg = config.dynamicWorkflow;
  let adversarialVerifier: AdversarialVerifier | undefined;
  let rubricRegistry: RubricRegistry | undefined;
  let loopUntilDoneGate: LoopUntilDoneGate | undefined;
  let quarantineManager: QuarantineManager | undefined;
  let actionAgentDispatcher: ActionAgentDispatcher | undefined;
  let tournamentSelector: TournamentSelector<string> | undefined;
  if (dwCfg?.enabled) {
    // RubricRegistry——无依赖，内置 4 种 rubric（security-audit/refactor/new-feature/bug-fix）
    rubricRegistry = new RubricRegistry();

    // QuarantineManager——隔离未信任 Agent 的危险工具调用
    if (dwCfg.quarantine?.enabled) {
      const deniedTools = new Set(dwCfg.quarantine.untrustedDeniedTools ?? []);
      quarantineManager = new QuarantineManager(deniedTools, dwCfg.quarantine.contaminationTraceDepth ?? 10);
      // 注册受信任的主 Agent
      quarantineManager.registerTrusted('trusted-primary');
      // 注册未信任的 Worker Agent
      quarantineManager.registerUntrusted('untrusted-worker');

      // ActionAgentDispatcher——当隔离策略允许意图转发时创建
      // trustedExecutor 使用 agentLoop 包装的简单执行器（fail-open，实际转发逻辑由 execution-orchestrator 控制）
      if (dwCfg.quarantine.allowIntentForwarding) {
        const trustedExecutor = async (intent: import('../agent/action-agent-dispatcher.js').DispatchIntent, _allowedTools: string[]) => {
          logger.info('ActionAgentDispatcher: trusted executor 调用', { intentId: intent.intentId });
          return `[forwarded by trusted agent] ${intent.description}`;
        };
        actionAgentDispatcher = new ActionAgentDispatcher(
          quarantineManager,
          {
            trustedAgentId: 'trusted-primary',
            untrustedAgentId: 'untrusted-worker',
            intentForwardingEnabled: true,
          },
          trustedExecutor,
        );
      }
    }

    // AdversarialVerifier——需要 CrossModelReviewer + RubricRegistry
    if (dwCfg.adversarialVerification?.enabled) {
      const availableModels = config.providers.flatMap(p => p.models.map(m => m.id));
      const crossModelReviewer = new CrossModelReviewer(primaryClient, currentModel, availableModels);
      const rubricMap = new Map<string, import('../agent/adversarial-verifier.js').VerifierRubric>();
      for (const taskType of rubricRegistry.listTaskTypes()) {
        const rubric = rubricRegistry.get(taskType);
        if (rubric) rubricMap.set(taskType, rubric);
      }
      adversarialVerifier = new AdversarialVerifier(crossModelReviewer, rubricMap, {
        frequency: dwCfg.adversarialVerification.frequency,
        n: dwCfg.adversarialVerification.n,
        defaultRubric: {
          id: 'default',
          taskType: 'default',
          checks: [
            { description: '代码变更是否安全，无明显漏洞', severity: 'critical' },
            { description: '逻辑是否正确，边界处理是否完善', severity: 'major' },
            { description: '错误处理是否完善', severity: 'minor' },
          ],
        },
        verifierModelId: dwCfg.adversarialVerification.verifierModelId,
        forceCrossModel: dwCfg.adversarialVerification.forceCrossModel,
      });
    }

    // LoopUntilDoneGate——需要 CompletionGate
    if (dwCfg.loopUntilDone?.enabled) {
      loopUntilDoneGate = new LoopUntilDoneGate(completionGate, {
        maxRounds: dwCfg.loopUntilDone.maxRounds,
        stableRoundsRequired: dwCfg.loopUntilDone.stableRoundsRequired,
        minCompletionRatio: dwCfg.loopUntilDone.minCompletionRatio,
        gateTimeoutMs: safetyCfg?.gateTimeout ?? 180000,
      });
    }

    // TournamentSelector——需要 ILLMClient
    if (dwCfg.tournament?.enabled) {
      tournamentSelector = new TournamentSelector<string>(primaryClient, {
        candidateCount: dwCfg.tournament.candidateCount,
        singleElimination: dwCfg.tournament.singleElimination,
        judgeModelId: dwCfg.tournament.judgeModelId,
      });
    }

    logger.info('Phase 62: 动态工作流模式已启用', {
      adversarialVerification: dwCfg.adversarialVerification?.enabled ?? false,
      loopUntilDone: dwCfg.loopUntilDone?.enabled ?? false,
      quarantine: dwCfg.quarantine?.enabled ?? false,
      tournament: dwCfg.tournament?.enabled ?? false,
    });
  }

  // 4. RequirementsGatherer + ComplexityAnalyzer——无状态，工厂创建即可
  const requirementsGatherer = createRequirementsGatherer();
  const complexityAnalyzer = createTaskComplexityAnalyzer();

  // 5. TaskOrchestrator——统一工作流编排器
  //    依赖 classifier + modelRouter + clientManager + config
  //    classifier/modelRouter 可能在测试场景下未传入，此时用 null 断言（生产路径必传）
  const taskOrchestrator = createTaskOrchestrator(
    classifier as ScenarioClassifier,
    modelRouter as ModelRouter,
    config,
  );

  // C5 修复：接线 Steering Queue 消费者，让 ReActAgentLoop 能消费 taskOrchestrator 中的转向消息
  // 注：必须在 taskOrchestrator 声明之后调用，否则闭包捕获的变量处于 TDZ，调用时抛 ReferenceError
  agentLoop.setSteeringConsumer(() => {
    if (!taskOrchestrator.hasSteering()) return null;
    const drained = taskOrchestrator.drainSteering();
    if (drained.length === 0) return null;
    return drained.map((m) => ({ content: m.content, mode: m.mode }));
  });

  // 6. ExecutionOrchestrator + UnifiedReviewer——依赖 agentLoop + tracker
  //    tracker 可能在测试场景下未传入，此时传一个 noop tracker 的占位（生产路径必传）
  //    Phase 31/32 P0 接线：systemPrompt 改为 ref 模式，与 App.tsx systemPromptRef 共享
  //    App.tsx 在初始化后同步 sharedSystemPromptRef.current = systemPromptRef.current
  const sharedSystemPromptRef = { current: '' };

  // Phase 66/67/69 模块——提前创建，注入 ExecutionOrchestrator
  let p66CheckpointPipeline: CheckpointPipeline | undefined;
  let p66CallOwnerCoordinator: CallOwnerCoordinator | undefined;
  let p66StateSnapshotChain: StateSnapshotChain | undefined;
  let p66ReputationDeriver: ReputationDeriver | undefined;
  let p67MiCrossScorer: MICrossScorer | undefined;
  let p67SnrAwareFilter: SNRAwareFilter | undefined;
  let p67EpistemicIntegrityChecker: EpistemicIntegrityChecker | undefined;
  let p67EpistemicPreservingSummarizer: EpistemicPreservingSummarizer | undefined;
  let p67QualityMetricsRecorder: QualityMetricsRecorder | undefined;
  let p69WorktreeManager: WorktreeManager | undefined;
  let p69ResultComparator: ResultComparator | undefined;
  let p69AgentGroupResolver: AgentGroupResolver | undefined;
  let p69CliAdapterRegistry: CLIAdapterRegistry | undefined;

  // Phase 66 实例化
  const fpCfg = config.foundationProtocol;
  if (fpCfg?.enabled) {
    p66CheckpointPipeline = new CheckpointPipeline(
      {
        enabled: fpCfg.checkpointPipeline.enabled,
        enabledSegments: fpCfg.checkpointPipeline.enabledSegments as any,
        shortCircuit: fpCfg.checkpointPipeline.shortCircuit,
      },
      (policy: any, action: any) => true,
    );
    p66CallOwnerCoordinator = new CallOwnerCoordinator({
      enabled: fpCfg.callOwner.enabled,
      syncWaitMs: fpCfg.callOwner.syncWaitMs,
      persistPath: fpCfg.callOwner.persistPath,
    });
    p66StateSnapshotChain = new StateSnapshotChain({
      enabled: fpCfg.stateSnapshotChain.enabled,
      arbiterSecretEnv: fpCfg.stateSnapshotChain.arbiterSecretEnv,
    });
    p66ReputationDeriver = new ReputationDeriver({
      enabled: fpCfg.reputationDeriver.enabled,
      maxCacheAgeMs: fpCfg.reputationDeriver.maxCacheAgeMs,
    });
  }

  // Phase 67 实例化
  const rqdCfg = config.reasoningQualityDiagnostics;
  let p67EpistemicTokenProtector: EpistemicTokenProtector | undefined;
  if (rqdCfg?.enabled) {
    p67MiCrossScorer = new MICrossScorer({
      enabled: rqdCfg.miCrossScorer.enabled,
      collapseThreshold: rqdCfg.miCrossScorer.collapseThreshold,
      minPrompts: rqdCfg.miCrossScorer.minPrompts,
      samplesPerPrompt: rqdCfg.miCrossScorer.samplesPerPrompt,
    });
    p67SnrAwareFilter = new SNRAwareFilter({
      enabled: rqdCfg.snrAwareFilter.enabled,
      topP: rqdCfg.snrAwareFilter.topP,
      minRVThreshold: rqdCfg.snrAwareFilter.minRVThreshold,
      batchRejectRatio: rqdCfg.snrAwareFilter.batchRejectRatio,
    });
    p67EpistemicTokenProtector = new EpistemicTokenProtector({
      enabled: rqdCfg.epistemicTokenProtector.enabled,
      neighborhoodLines: rqdCfg.epistemicTokenProtector.neighborhoodLines,
      customTokens: rqdCfg.epistemicTokenProtector.customTokens,
    });
    p67EpistemicIntegrityChecker = new EpistemicIntegrityChecker(
      p67EpistemicTokenProtector,
      {
        enabled: rqdCfg.epistemicIntegrityChecker.enabled,
        overCompressionThreshold: rqdCfg.epistemicIntegrityChecker.overCompressionThreshold,
        minTokenCount: rqdCfg.epistemicIntegrityChecker.minTokenCount,
      },
    );
    p67EpistemicPreservingSummarizer = new EpistemicPreservingSummarizer(
      p67EpistemicTokenProtector,
      {
        enabled: rqdCfg.epistemicPreservingSummarizer.enabled,
        maxTokens: rqdCfg.epistemicPreservingSummarizer.maxTokens,
      },
    );
    p67QualityMetricsRecorder = new QualityMetricsRecorder({
      enabled: rqdCfg.auditMetricsLogging.logEpistemicStats,
    });
  }

  // Phase 69 实例化
  const p69Cfg = config.phase69Integration;
  if (p69Cfg) {
    if (p69Cfg.worktree?.enabled) {
      p69WorktreeManager = new WorktreeManager(process.cwd(), {
        ...DEFAULT_WORKTREE_CONFIG,
        enabled: p69Cfg.worktree.enabled,
        worktreeRoot: p69Cfg.worktree.worktreeRoot,
        maxWorktrees: p69Cfg.worktree.maxWorktrees,
        cleanupTimeoutMs: p69Cfg.worktree.cleanupTimeoutMs,
      });
    }
    if (p69Cfg.resultComparator) {
      p69ResultComparator = new ResultComparator({
        ...DEFAULT_COMPARATOR_CONFIG,
        autoSelect: p69Cfg.resultComparator.autoSelect,
        weights: {
          ...DEFAULT_COMPARATOR_CONFIG.weights,
          brevity: p69Cfg.resultComparator.weights.brevity,
          errorCount: p69Cfg.resultComparator.weights.errorCount,
          testPassRate: p69Cfg.resultComparator.weights.testPassRate,
        },
      });
    }
    p69AgentGroupResolver = new AgentGroupResolver();
    if (p69Cfg.cliAdapters?.enabled) {
      p69CliAdapterRegistry = new CLIAdapterRegistry();
      const claudeCodeAdapter = new ClaudeCodeAdapter({
        ...DEFAULT_CLAUDE_CODE_CONFIG,
        command: p69Cfg.cliAdapters.claudeCode.command,
        defaultArgs: p69Cfg.cliAdapters.claudeCode.defaultArgs,
        spawnTimeoutMs: p69Cfg.cliAdapters.claudeCode.spawnTimeoutMs,
      });
      p69CliAdapterRegistry.register(claudeCodeAdapter);
    }
  }

  const executionOrchestrator = createExecutionOrchestrator({
    agentLoop,
    tracker: tracker as TokenTracker,
    config,
    systemPromptRef: sharedSystemPromptRef,
    addSystemMessage: () => {}, // 由 App.tsx 通过 commandBridge.addSystemMessage 间接驱动
    // Phase 62：动态工作流模块（可选，由 dynamicWorkflow.enabled 守护）
    adversarialVerifier,
    rubricRegistry,
    loopUntilDoneGate,
    quarantineManager,
    actionAgentDispatcher,
    tournamentSelector,
    // Phase 66：策略管道与治理
    checkpointPipeline: p66CheckpointPipeline,
    callOwnerCoordinator: p66CallOwnerCoordinator,
    stateSnapshotChain: p66StateSnapshotChain,
    reputationDeriver: p66ReputationDeriver,
    // Phase 67：推理质量诊断
    miCrossScorer: p67MiCrossScorer,
    snrAwareFilter: p67SnrAwareFilter,
    epistemicIntegrityChecker: p67EpistemicIntegrityChecker,
    epistemicPreservingSummarizer: p67EpistemicPreservingSummarizer,
    qualityMetricsRecorder: p67QualityMetricsRecorder,
    // Phase 69：Worktree 隔离执行与多代理并行编排
    worktreeManager: p69WorktreeManager,
    resultComparator: p69ResultComparator,
    agentGroupResolver: p69AgentGroupResolver,
    cliAdapterRegistry: p69CliAdapterRegistry,
    // LLM 客户端——供 SynthesizeBarrier judging 策略等内部模块使用
    llmClient: primaryClient,
  });
  const unifiedReviewer = createUnifiedReviewer({
    agentLoop,
    tracker: tracker as TokenTracker,
    config,
    systemPromptRef: sharedSystemPromptRef,
    addSystemMessage: () => {},
  });

  // ===== Phase 43：查漏补缺——回退 / 仲裁 / Registry 接线 =====
  // 全部使用动态 import + fail-open，模块不可用时跳过不影响主流程

  // 1. CodeMapFallback 检测：tree-sitter 不可用时自动回退到 regex 引擎
  //    检测结果与配置引擎不一致时打印警告
  import('../code-map/fallback.js')
    .then(async (mod) => {
      const preferred = config.codeMap?.engine ?? 'tree-sitter';
      const resolved = await mod.CodeMapFallback.resolveEngine(preferred);
      if (resolved !== preferred) {
        logger.warn(mod.CodeMapFallback.getFallbackMessage(`configured=${preferred}, resolved=${resolved}`));
      }
      logger.info('CodeMapFallback resolved', { preferred, resolved });
    })
    .catch((err: unknown) => {
      logger.debug('CodeMapFallback not available', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // ===== Phase 44：消息节点持久化 / 分支联动 接线 =====
  // 全部使用动态 import + fail-open，模块不可用时跳过不影响主流程
  // 注：branch-persistence.ts / branch-linkage.ts 由其他子代理创建，
  //     使用变量路径动态 import 避免 typecheck 失败（fail-open 策略）

  // 1. BranchPersistence 接线：消息树 JSONL 持久化 + 备份 + 快照
  //    实例化后注册到 service context（feature-detect：方法可能由其他子代理添加）
  const conversationCfg = config.conversation;
  if (conversationCfg?.persistTree !== false) {
    const branchPersistencePath = '../agent/branch-persistence.js';
    import(branchPersistencePath)
      .then((mod: { BranchPersistence: new (cwd: string, opts?: unknown) => { init: () => Promise<void> } }) => {
        const persistence = new mod.BranchPersistence(cwd, {
          maxNodes: conversationCfg.maxNodes,
          maxBranches: conversationCfg.maxBranches,
          undoStackSize: conversationCfg.undoStackSize,
        });
        persistence.init().catch((e: unknown) => {
          logger.debug('BranchPersistence init failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        logger.info('BranchPersistence registered', {
          persistTree: conversationCfg.persistTree,
          maxNodes: conversationCfg.maxNodes,
        });
      })
      .catch((err: unknown) => {
        // fail-open：branch-persistence.ts 尚未创建时跳过，不影响主流程
        logger.debug('BranchPersistence not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 2. BranchLinkageManager 接线：消息分支与 /goal/experiment 双向映射
  //    实例化后异步加载磁盘状态，注册到 service context
  const branchLinkagePath = '../agent/branch-linkage.js';
  import(branchLinkagePath)
    .then((mod: { BranchLinkageManager: new (cwd: string) => { load: () => Promise<void> } }) => {
      const linkage = new mod.BranchLinkageManager(cwd);
      linkage.load().catch((e: unknown) => {
        logger.debug('BranchLinkageManager load failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
      logger.info('BranchLinkageManager registered');
    })
    .catch((err: unknown) => {
      // fail-open：branch-linkage.ts 尚未创建时跳过，不影响主流程
      logger.debug('BranchLinkageManager not available yet', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // 3. ExperimentManager 单例：在同步作用域创建，确保 /experiment 命令与 engine-bridge
  //    都能从 AppDependencies 读取同一实例（避免重复实例化导致 ExperimentRunner 丢失）
  //    注：ExperimentManager 构造仅做 ensureGitignore + loadRegistry，无重 IO，同步创建安全
  const experimentManager = new ExperimentManager(cwd);

  // 4. ParallelExperimentManager 接线：多分支并行实验
  //    config.experiment.parallelEnabled=false 时跳过注册（但 experimentManager 单例仍保留供 /experiment 使用）
  const experimentCfg = config.experiment;
  if (experimentCfg?.parallelEnabled !== false) {
    const pemPath = '../agent/parallel-experiment.js';
    const runnerPath = '../harness/experiment-runner.js';
    Promise.all([
      import(pemPath),
      import(runnerPath),
    ])
      .then(([pemMod, runnerMod]) => {
        // Phase 39 Task 3：注入 ExperimentRunner，让 runInExperiment 真正执行 Agent 任务
        // depsFactory 在 worktree 路径下创建独立的 AppDependencies，并附加 routeDecision 和 llmClient
        // 注：每次实验任务执行都会创建完整的依赖（MCP/工具/orchestrator 等），开销较大但隔离性强
        const depsFactory = (newCwd: string) => {
          const newDeps = createAppDependencies(
            config,
            clientManager,
            currentModel,
            newCwd,
            classifier,
            modelRouter,
            tracker,
          );
          // 构造简化路由决策：用第一个 provider 的第一个模型（与 spawn-agent 默认路由一致）
          const defaultModel = config.providers[0]?.models[0];
          if (!defaultModel) {
            throw new Error('未配置可用模型，无法创建实验 runner 依赖');
          }
          const routeDecision = {
            model: defaultModel,
            providerId: primaryProviderId,
            fallbackUsed: false,
            originalTier: defaultModel.tier ?? 'medium',
            degraded: false,
          };
          return {
            ...newDeps,
            routeDecision,
            llmClient: newDeps.primaryClient,
          };
        };
        const runner = runnerMod.createExperimentRunner(depsFactory);
        experimentManager.setExperimentRunner(runner);

        new pemMod.ParallelExperimentManager(experimentManager, experimentCfg);
        logger.info('ParallelExperimentManager registered', {
          maxParallel: experimentCfg?.maxParallel,
          conflictDetection: experimentCfg?.conflictDetection,
          runnerInjected: true,
        });
      })
      .catch((err: unknown) => {
        logger.debug('ParallelExperimentManager not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 45：PersonaEngine / PreferenceManager / VoiceManager 接线 =====
  // 全部使用动态 import + fail-open，模块不可用时跳过不影响主流程
  // 注：persona-engine.ts / preference-manager.ts 由其他子代理并行创建，
  //     voice-manager.ts 已由本 Phase 创建，使用变量路径动态 import 保持一致性

  // 1. PersonaEngine 接线：人格引擎（intensity=none 时不注入 system prompt）
  // Phase 57：改为读取 config.persona.systemPromptAppend，不再依赖 persona-templates
  const personaCfg = config.persona;
  if (personaCfg?.enabled !== false && personaCfg?.intensity !== 'none') {
    const personaModulePath = '../agent/persona-engine.js';
    import(personaModulePath)
      .then((mod: { PersonaEngine: new (systemPromptAppend?: string) => { setIntensity: (i: string) => void; buildPersonaFragment: (signals?: unknown) => string } }) => {
        const engine = new mod.PersonaEngine(personaCfg.systemPromptAppend ?? '');
        engine.setIntensity(personaCfg.intensity);
        logger.info('PersonaEngine registered', {
          enabled: personaCfg.enabled,
          intensity: personaCfg.intensity,
          hasCustomPrompt: !!(personaCfg.systemPromptAppend),
        });
      })
      .catch((err: unknown) => {
        // fail-open：persona-engine.ts 尚未创建时跳过，不影响主流程
        logger.debug('PersonaEngine not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 2. PreferenceManager 接线：用户偏好持久化
  //    实例化后异步加载磁盘状态
  const preferenceModulePath = '../agent/preference-manager.js';
  import(preferenceModulePath)
    .then((mod: { PreferenceManager: new (cwd: string) => { load: () => Promise<void>; setExplicit: (k: string, v: unknown, c?: number) => void } }) => {
      const prefMgr = new mod.PreferenceManager(cwd);
      prefMgr.load().catch((e: unknown) => {
        logger.debug('PreferenceManager load failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
      logger.info('PreferenceManager registered');
    })
    .catch((err: unknown) => {
      // fail-open：preference-manager.ts 尚未创建时跳过，不影响主流程
      logger.debug('PreferenceManager not available yet', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // 4. VoiceManager：语音输入/输出管理（仅 Desktop renderer 可用，CLI 跳过）
  //    voice-manager.ts 使用浏览器 API（webkitSpeechRecognition / SpeechSynthesisUtterance），
  //    在 Node CLI 环境 isAvailable() 永远返回 false，此处不再实例化。
  //    Desktop renderer 通过 preload 暴露的 API 自行接入。
  const voiceCfg = config.voice;
  if (voiceCfg && (voiceCfg.inputProvider !== 'off' || voiceCfg.outputProvider !== 'off')) {
    logger.debug('Voice config detected but skipped in CLI mode (browser-only)', {
      inputProvider: voiceCfg.inputProvider,
      outputProvider: voiceCfg.outputProvider,
    });
  }

  // Phase 48 Task 3：ScheduleEngine 实例化与启动
  // Phase 48 Task 6 修复：原代码在非 async 函数中使用 `await import`，导致 typecheck 失败。
  // 改为顶层静态 import（scheduler 模块无顶层副作用，安全）。
  // 若未来 createAppDependencies 改为 async，可恢复 `await import` 写法以支持延迟加载。
  let scheduleEngine: import('../scheduler/engine.js').ScheduleEngine | undefined;
  if (config.scheduler?.enabled !== false) {
    const scheduleStorePath = path.join(cwd, '.routedev', 'schedule-tasks.json');
    const scheduleStore = new ScheduleStore(scheduleStorePath);
    scheduleEngine = new ScheduleEngine({
      store: scheduleStore,
      onTaskTrigger: async (task) => {
        logger.info('Schedule triggered', { taskId: task.id, name: task.name });
        // 将定时任务目标注入 AgentLoop 执行
        try {
          const routeDecision = {
            model: config.providers[0]?.models[0],
            providerId: primaryProviderId,
            fallbackUsed: false,
            originalTier: config.providers[0]?.models[0]?.tier ?? 'medium',
            degraded: false,
          };
          if (primaryClient && routeDecision.model) {
            for await (const _event of agentLoop.run({
              userMessage: task.goal,
              llmClient: primaryClient,
              routeDecision,
              conversationHistory: [],
              systemPrompt: `定时任务: ${task.name}`,
            })) {
              // 消费事件流
            }
          }
        } catch (err) {
          logger.error('Schedule task failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
    scheduleEngine.start();
    logger.info('ScheduleEngine started', { checkInterval: '60s' });
  }

  // ===== Phase 50 Task 5：Phase 48 模块接入确认 =====
  // cite/import/macros/mcp 四模块按 config.phase48Integration 开关接入生产路径
  // 全部使用动态 import + fail-open，模块不可用时跳过不影响主流程
  const phase48Cfg = config.phase48Integration;

  // 依赖完整性校验清单实例化（受 config.security.integrityCheck 守护）
  // 启用后传入 ClaudePluginImporter / AnthropicSkillsLoader（CLI 路径）
  // SkillMarketManager 的 integrity 校验由 desktop/main/engine-bridge.ts 在 installSkill 时注入，
  // CLI 模式不直接操作 SkillMarketManager，故此处不传入
  let integrityManifest: IntegrityManifest | undefined;
  let integrityManifestLoadPromise: Promise<void> | undefined;
  if (config.security?.integrityCheck) {
    const manifestPath = path.resolve(cwd, config.security.integrityManifestPath);
    integrityManifest = new IntegrityManifest(manifestPath);
    // 异步加载 manifest（不阻塞主流程；phase48 块内部 await load 确保 verify 前记录就绪）
    integrityManifestLoadPromise = integrityManifest.load().catch((err: unknown) => {
      logger.warn('IntegrityManifest load failed', {
        path: manifestPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  if (phase48Cfg?.citeEnabled && config.cite?.enabled) {
    // CiteManager + CiteResolver 接入：引用管理器 + 引用解析器实例化并注入 AgentLoop
    // CiteManager 在 callLLMStream 末尾收集 [cite:type:source] 标记
    // CiteResolver 在 callLLMStream 开头解析收集到的引用，产出 injectedContext + skillPrompts
    // 两者缺一不可：缺 manager 无收集，缺 resolver 收集的是死数据（E5 补全）
    Promise.all([
      import('../cite/manager.js'),
      import('../cite/resolver.js'),
    ])
      .then(([managerMod, resolverMod]) => {
        const maxTags = config.cite?.maxTags ?? 10;
        const citeManager = new managerMod.CiteManager(maxTags);
        agentLoop.setCiteManager(citeManager);
        // CiteResolver 实例化：注入读取 Skill/Macro 的 provider（从 .routedev/skills/ 和 macros 读取）
        const citeResolver = new resolverMod.CiteResolver({
          config: config.cite,
          deps: {
            readSkillOrMacro: async (name: string, kind?: 'skill' | 'macro') => {
              try {
                const path = require('node:path');
                const fs = require('node:fs');
                const dir = kind === 'macro' ? 'macros' : 'skills';
                const file = path.join(cwd, '.routedev', dir, `${name}.md`);
                return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
              } catch {
                return null;
              }
            },
          },
        });
        agentLoop.setCiteResolver(citeResolver);
        logger.info('Phase 48 cite manager + resolver integrated', { enabled: true, maxTags });
      })
      .catch((err: unknown) => {
        logger.debug('CiteManager/Resolver not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase48Cfg?.importEnabled && config.import) {
    // 外部生态导入接入：ClaudePluginImporter / CodexInstructionImporter
    // 启动时扫描导入（fire-and-forget，不阻塞主流程）
    Promise.all([
      import('../import/claude-plugin-importer.js'),
      import('../import/codex-importer.js'),
      import('../import/anthropic-skills-loader.js'),
    ])
      .then(async ([pluginMod, codexMod, anthropicMod]) => {
        // 等待 IntegrityManifest 加载完成（若启用），确保 verify 前记录就绪
        if (integrityManifestLoadPromise) await integrityManifestLoadPromise;

        // ClaudePluginImporter：扫描项目根下的 .claude-plugin/ 目录并导入
        // 注入 integrityManifest：导入完成后 record 输出文件 SHA-256，下次导入前 verify 跳过重复
        const pluginImporter = new pluginMod.ClaudePluginImporter(integrityManifest);
        const claudePluginDir = path.join(cwd, '.claude-plugin');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const existsSync = require('node:fs').existsSync as (p: string) => boolean;
        if (existsSync(claudePluginDir)) {
          try {
            const result = await pluginImporter.importFromPath(cwd, {
              autoEnable: true,
              outputRoot: path.join(cwd, '.routedev'),
            });
            logger.info('Claude plugin imported', {
              skills: result.skills.length,
              agents: result.agents.length,
              hooks: result.hooks.length,
              warnings: result.warnings.length,
            });
          } catch (e: unknown) {
            logger.warn('ClaudePluginImporter import failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        // CodexInstructionImporter：扫描 .codex/ 目录并导入为系统提示词
        const codexImporter = new codexMod.CodexInstructionImporter();
        try {
          const scanResult = await codexImporter.scan(cwd);
          if (scanResult.found) {
            const importResult = await codexImporter.import({
              projectRoot: cwd,
              mode: 'system_prompt',
            });
            // 将 Codex 指令注入系统提示词（追加到 sharedSystemPromptRef）
            if (importResult.systemPromptContent) {
              sharedSystemPromptRef.current = `${sharedSystemPromptRef.current}\n\n--- Codex Instructions ---\n${importResult.systemPromptContent}`.trim();
              logger.info('Codex instructions integrated into system prompt', {
                files: importResult.importedFiles.length,
                bytes: importResult.totalBytes,
              });
            }
          }
        } catch (e: unknown) {
          logger.debug('CodexInstructionImporter import failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        // AnthropicSkillsLoader：扫描 anthropic_skills/ 目录并加载
        // 注入 integrityManifest：加载每个 SKILL.md 后 record，下次加载前 verify
        const anthropicSkillsDir = path.join(cwd, anthropicMod.AnthropicSkillsLoader.SKILLS_DIR_NAME);
        if (existsSync(anthropicSkillsDir)) {
          try {
            const anthropicLoader = new anthropicMod.AnthropicSkillsLoader(integrityManifest);
            const autoEnable = config.import?.anthropicSkillsAutoEnable ?? false;
            const loadResult = await anthropicLoader.load(cwd, { autoEnable });
            logger.info('Anthropic skills loaded', {
              loaded: loadResult.loaded.length,
              errors: loadResult.errors.length,
            });
          } catch (e: unknown) {
            logger.warn('AnthropicSkillsLoader load failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        logger.info('Phase 48 import module integrated', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('Import module not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase48Cfg?.macrosEnabled && config.macros?.enabled) {
    // MacroManager 接入：`!` 触发器宏系统
    import('../macros/manager.js')
      .then((mod) => {
        const macroManager = new mod.MacroManager(config.macros, cwd);
        macroManager.loadAll().catch((e: unknown) => {
          logger.debug('MacroManager loadAll failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        // 注入到 agentLoop（feature-detect：方法可能由其他子代理添加）
        const loop = agentLoop as unknown as { setMacroManager?: (m: unknown) => void };
        if (typeof loop.setMacroManager === 'function') {
          loop.setMacroManager(macroManager);
        }
        logger.info('Phase 48 macros module integrated', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('MacroManager not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase48Cfg?.mcpBridgeEnabled) {
    // ClaudeMCPBridge 接入：导入 Claude Code .mcp.json 配置
    import('../mcp/claude-bridge.js')
      .then((mod) => {
        // 创建桥接器实例，确认模块可加载
        const bridge = new mod.ClaudeMCPBridge();
        // 异步导入项目级 .mcp.json（若存在）
        const claudeConfigPath = path.join(cwd, '.mcp.json');
        bridge.importFromClaudeConfig(claudeConfigPath).then((result) => {
          if (result.servers.length > 0) {
            logger.info('ClaudeMCPBridge imported servers', { count: result.servers.length });
          }
        }).catch((e: unknown) => {
          logger.debug('ClaudeMCPBridge import failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        logger.info('Phase 48 mcp bridge module integrated', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('ClaudeMCPBridge not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 50 Task 6：Phase 49 模块接入确认 =====
  // 六模块按 config.phase49Integration 开关接入（默认全部 false，实验性）
  const phase49Cfg = config.phase49Integration;
  // Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，供 goal-runner 通过 ref 延迟读取）
  // 声明在 phase49 块之前，确保 .then() 回调内能写入、createGoalRunner deps 能引用
  const dualLoopOrchestratorRef: { current: DualLoopOrchestrator | null } = { current: null };
  if (phase49Cfg?.dualLoopEnabled) {
    // 双循环编排器接入：/goal 执行时可被调用
    import('../agent/dual-loop-orchestrator.js')
      .then((mod) => {
        const orchestrator = new mod.DualLoopOrchestrator();
        // Phase 55 Task 9：立即写入 ref，让 goal-runner 在 /goal 触发时能读取到实例
        dualLoopOrchestratorRef.current = orchestrator;
        // CR-1 修复：在 orchestrator 创建后立即注入 reviewerPolicy 和 boundedRecovery
        // 原 Phase 51/52 接线因"异步创建无同步引用"被跳过，导致配置读取后无法生效
        if (config.reviewerPolicy?.tieredReviewEnabled) {
          orchestrator.setReviewerPolicy(config.reviewerPolicy);
          logger.info('app-init: reviewerPolicy 已注入 DualLoopOrchestrator', {
            tieredReviewEnabled: true,
          });
        }
        if (config.phase52Integration?.boundedRecovery?.enabled) {
          orchestrator.setBoundedRecovery(config.phase52Integration.boundedRecovery);
          logger.info('app-init: boundedRecovery 已注入 DualLoopOrchestrator', {
            maxBacktrack: config.phase52Integration.boundedRecovery.maxBacktrack,
          });
        }
        // Phase 59：metricsCollector 注入已删除（archAwareMetrics 批次1 删除，metricsCollector 永远 undefined）
        // Phase 55 Task 8：注入 innerAgent（独立 ReActAgentLoop 实例，不注入 orchestrator，避免无限递归）
        // orchestrator.run(params) 会转交给 innerAgent.run(params)；若 innerAgent 是已注入 orchestrator 的
        // agentLoop，run() 会再次转交给 orchestrator，形成无限递归。故必须创建独立实例。
        const innerAgentLoop = new ReActAgentLoop(guardedAdapter, {
          maxIterations: 50,
          toolsEnabled: true,
          autoApprovePatterns: config.autonomy?.autoApprovePatterns ?? [],
        });
        innerAgentLoop.setTraceCollector(trace);
        orchestrator.setInnerAgent(innerAgentLoop);
        // Phase 55 Task 7：强类型调用 setDualLoopOrchestrator（删除 as unknown as 弱类型断言）
        agentLoop.setDualLoopOrchestrator(orchestrator);
        logger.info('Phase 49 DualLoopOrchestrator integrated', { enabled: true, innerAgent: true });
      })
      .catch((err: unknown) => {
        logger.debug('DualLoopOrchestrator not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase49Cfg?.qualityGateEnabled) {
    // Skill 质量门接入：Skill 生成时可被调用
    import('../skills/quality-gate.js')
      .then((mod) => {
        // 实例化保留供未来扩展；AgentLoop.setSkillQualityGate setter 尚不存在，未接入主流程
        const gate = new mod.SkillQualityGate();
        void gate;
        logger.debug('SkillQualityGate instantiated (not yet integrated into AgentLoop — setter does not exist)');
      })
      .catch((err: unknown) => {
        logger.debug('SkillQualityGate not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase49Cfg?.contextUsagePanelEnabled) {
    // 上下文占用率面板接入：context-compaction 调用
    import('../agent/context-usage-panel.js')
      .then((mod) => {
        new mod.ContextUsagePanel();
        logger.info('Phase 49 ContextUsagePanel integrated', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('ContextUsagePanel not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase49Cfg?.evaluationFrameworkEnabled) {
    // 评估集框架接入：Skill 生成或 /goal 完成时可选调用
    // 注：EvaluationFramework 构造需要 executeTarget/judge 回调，此处仅确认模块可加载
    // 实例化由 /goal 完成或 Skill 生成时按需创建（依赖注入 LLM 客户端）
    import('../evaluation/evaluation-framework.js')
      .then((mod) => {
        void mod;
        logger.info('Phase 49 EvaluationFramework module available', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('EvaluationFramework not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 52 模块接入（全部由 config.phase52Integration 开关守护）=====
  // 设计原则：未启用的模块不初始化，实例为 undefined；用 ?? 兜底避免 config 字段未定义时崩溃

  // Task 1：Skill 生命周期管理——已提前至 delegationDeps 装配前创建（供 spawn_agent 注入）

  // Phase 53 Task 6：SkillSecurityGate 注入（受 config.phase53Integration.skillSecurityGate.enabled 守护）
  // 启用后第三方技能安装前会经过 17 类漏洞扫描；lifecycle manager 未启用时仅实例化记录日志
  const phase53SkillGateCfg = config.phase53Integration?.skillSecurityGate;
  if (phase53SkillGateCfg?.enabled) {
    import('../skills/security-gate.js')
      .then((mod) => {
        const gate = new mod.SkillSecurityGate({
          autoInstallThreshold: phase53SkillGateCfg.autoInstallThreshold,
        });
        if (skillLifecycleManager) {
          skillLifecycleManager.setSecurityGate(gate);
          logger.debug('SkillSecurityGate injected', { via: 'setSecurityGate' });
        } else {
          logger.info('SkillSecurityGate instantiated but no consumer wired (skillLifecycleManager disabled)');
        }
      })
      .catch((err: unknown) => {
        // fail-open：SkillSecurityGate 不可用时不阻塞主流程
        logger.debug('SkillSecurityGate not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Task 3：有界局部恢复——已在 Phase 49 块中通过 DualLoopOrchestrator.setBoundedRecovery 接入
  // CR-1 修复：原因此处异步创建无同步引用而跳过，现改为在 Phase 49 .then() 回调中注入。
  // 此处保留日志确认配置已读取，实际注入在 Phase 49 块完成。
  if (config.phase52Integration?.boundedRecovery?.enabled) {
    logger.info('app-init: boundedRecovery 配置已确认，将在 Phase 49 DualLoopOrchestrator 创建时注入');
  }

  // Phase 59：archAwareMetrics/saturationMonitor 已删除（批次1 无价值 Integration）
  // 原实例化块已移除；类型仍被 score-card.ts / dual-loop-orchestrator.ts / completion-gate.ts 通过 type 引用
  // 故源文件 architecture-aware-metrics.ts / saturation-monitor.ts 保留，仅删配置字段与实例化

  // CR-4b：组合式路由器（config.phase52Integration.compositionalRouting.enabled 守护）
  // 包装 decomposeWithSkillAwareness / composeDAG，按配置注入路由参数，供上层 planner 调用
  let compositionalRouter: CompositionalRouterInstance | undefined;
  const compositionalRoutingCfg = config.phase52Integration?.compositionalRouting;
  if (compositionalRoutingCfg?.enabled) {
    const routingConfig: CompositionalRoutingConfig = {
      maxDecompositionIterations: compositionalRoutingCfg.maxDecompositionIterations ?? DEFAULT_ROUTING_CONFIG.maxDecompositionIterations,
      semanticRetrieval: compositionalRoutingCfg.semanticRetrieval ?? DEFAULT_ROUTING_CONFIG.semanticRetrieval,
      maxParallelSkills: compositionalRoutingCfg.maxParallelSkills ?? DEFAULT_ROUTING_CONFIG.maxParallelSkills,
    };
    compositionalRouter = {
      config: routingConfig,
      decompose: (task, availableSkills, decomposeFn) =>
        decomposeWithSkillAwareness(task, availableSkills, routingConfig, decomposeFn),
      planDAG: (subTasks, availableSkills) => {
        const matches: SkillMatch[] = [];
        for (const sub of subTasks) {
          const m = retrieveSkill(sub, availableSkills);
          if (m) matches.push(m);
        }
        return composeDAG(matches, subTasks);
      },
    };
    logger.info('app-init: CompositionalRouter 已启用', {
      maxDecompositionIterations: routingConfig.maxDecompositionIterations,
      maxParallelSkills: routingConfig.maxParallelSkills,
    });
  }

  // Phase 51 Task 1/7：Reviewer 分级策略——已在 Phase 49 块中通过 DualLoopOrchestrator.setReviewerPolicy 接入
  // CR-1 修复：原因此处异步创建无同步引用而跳过，现改为在 Phase 49 .then() 回调中注入。

  // ===== Phase 53 Task 12：Doctor 健康检查（受 config.phase53Integration.doctor.runOnStartup 守护） =====
  // 启动时异步运行环境探测，结果输出到 logger；不阻塞主流程
  // Doctor 实例不暴露到 AppDependencies（一次性启动检查，UI 无需持有）
  const phase53DoctorCfg = config.phase53Integration?.doctor;
  if (phase53DoctorCfg?.runOnStartup) {
    // 动态 import 避免未启用时引入 spawnSync 噪音
    const doctorPath = '../cli/doctor.js';
    import(doctorPath)
      .then((mod: { Doctor: new (cfg?: Partial<{ probeTimeout: number; runOnStartup: boolean }>, ctx?: { providers?: Array<{ id: string; baseUrl: string }>; mcpServers?: Array<{ id: string; command: string }>; cwd?: string }) => { runAllChecks: () => Promise<unknown[]>; formatReport: (r: unknown[]) => string } }) => {
        const doctor = new mod.Doctor(
          { probeTimeout: phase53DoctorCfg.probeTimeout, runOnStartup: true },
          {
            providers: config.providers.map(p => ({ id: p.id, baseUrl: p.baseUrl })),
            mcpServers: config.mcp.servers.map(s => ({ id: s.id, command: (s as { command?: string }).command ?? '' })),
            cwd,
          },
        );
        return doctor.runAllChecks().then((results: unknown[]) => {
          const report = doctor.formatReport(results);
          logger.info('Phase53 Doctor: startup probe complete', { report });
        });
      })
      .catch((err: unknown) => {
        // fail-open：Doctor 不可用时不阻塞主流程
        logger.debug('Phase53 Doctor not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return {
    registry,
    mcpManager,
    securityChecker,
    toolExecutor,
    adapter,
    workModeController,
    guardedAdapter,
    agentLoop,
    middlewarePipeline: pluginSystem.middlewarePipeline,
    pluginRegistry: pluginSystem.pluginRegistry,
    skillsRouter,
    filesystemDiscovery,
    permissionEngine,
    orchestrator,
    workerExecutor,
    checkpointManager,
    checkpointWriter,
    contextManager,
    visionAssistant,
    branchManager,
    initAnalyzer,
    prompts,
    blackboard,
    trace,
    audit,
    projectMemory,
    goalParser,
    goalVerifier,
    hookRunner,
    primaryClient,
    checkpointClient,
    profiler,
    // Phase 32 Task 1：Phase 31 模块（之前全部为死代码）
    taskOrchestrator,
    requirementsGatherer,
    complexityAnalyzer,
    executionOrchestrator,
    unifiedReviewer,
    completionGate,
    readTracker,
    resultSanitizer,
    // Phase 31/32 P0 接线：共享 systemPrompt ref，App.tsx 同步更新此 ref 让 ExecutionOrchestrator/UnifiedReviewer 获取最新系统提示词
    sharedSystemPromptRef,
    // Phase 48 Task 3：调度引擎实例
    scheduleEngine,
    // Phase 50 Task 1：goalIntegration 实例（App.tsx 传给 createGoalRunner）
    goalAuditor,
    goalPersistence,
    // Phase 59：goalPromptBuilder/metricsCollector/saturationMonitor 返回字段已删除（批次1）
    // Phase 50 Task 3：delegationIntegration 实例（供 UI / 测试观察）
    subAgentLifecycle: delegationLifecycle,
    subAgentScoreCardCollector: delegationScoreCardCollector,
    // Phase 52 模块（全部可选，未启用时为 undefined）
    skillLifecycleManager,
    // CR-4b：孤立模块接线点实例（按各自 config 开关守护，未启用时为 undefined）
    activityStore,
    compositionalRouter,
    // Phase 58：统一路径路由器（App.tsx 传给 createGoalRunner）
    pathRouter,
    // Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，goal-runner 通过 ref 延迟读取）
    dualLoopOrchestratorRef,
    // Phase 55：DagEngine ref（异步创建，goal-runner 通过 ref 延迟读取）
    dagEngineRef,
    // E9-B：ExperimentManager 单例（供 /experiment 命令与 engine-bridge 复用）
    experimentManager,
    // Phase 61：ACRouter 闭环模型路由
    ...(() => {
      const clrCfg = config.closedLoopRouting;
      if (!clrCfg?.enabled) return {};
      const routingHistory = new RoutingHistory({
        maxRecords: clrCfg.history.maxRecords,
        persistPath: path.resolve(cwd, clrCfg.history.persistPath),
      });
      routingHistory.load().catch(err => {
        logger.warn('RoutingHistory load failed', { error: err instanceof Error ? err.message : String(err) });
      });
      const embedder = createEmbedder(clrCfg.memory.embeddingProvider);
      const routingMemory = new RoutingMemory(routingHistory, embedder, {
        topK: clrCfg.memory.topK,
        minSimilarity: clrCfg.memory.minSimilarity,
        enabled: clrCfg.memory.enabled,
      });
      const executionVerifier = new ExecutionVerifier({
        enabled: clrCfg.verifier.enabled,
        signals: clrCfg.verifier.signals,
        timeoutMs: clrCfg.verifier.timeoutMs,
      });
      const routingRegretTracker = new RoutingRegretTracker(routingHistory);
      // Phase 61 接线：当 modelRouter 可用且 orchestrator.enabled 时，创建 RoutingOrchestrator
      // RoutingOrchestrator 内部整合 baseRouter + memory + history，做加权投票决策
      let routingOrchestrator: RoutingOrchestrator | undefined;
      if (modelRouter && clrCfg.orchestrator?.enabled) {
        routingOrchestrator = new RoutingOrchestrator(modelRouter, routingMemory, routingHistory, {
          enabled: clrCfg.orchestrator.enabled,
          neighborWeight: clrCfg.orchestrator.neighborWeight,
          priorWeight: clrCfg.orchestrator.priorWeight,
          baseWeight: clrCfg.orchestrator.baseWeight,
        });
      }
      logger.info('Phase 61: ACRouter closed-loop routing enabled', {
        memory: clrCfg.memory.enabled,
        verifier: clrCfg.verifier.enabled,
        orchestrator: clrCfg.orchestrator?.enabled ?? false,
      });
      return { routingHistory, routingMemory, executionVerifier, routingRegretTracker, routingOrchestrator };
    })(),
    // Phase 62：动态工作流模式与隔离治理模块
    adversarialVerifier,
    rubricRegistry,
    loopUntilDoneGate,
    quarantineManager,
    actionAgentDispatcher,
    tournamentSelector,
    // Phase 65：记忆系统重构
    ...(() => {
      const msCfg = config.memorySystem;
      if (!msCfg?.enabled) return {};
      const memoryStore = new MemoryStore({
        enabled: msCfg.store.enabled,
        dbPath: msCfg.store.dbPath,
        backend: msCfg.store.backend,
        embeddingProvider: msCfg.store.embeddingProvider,
      });
      const incrementalExtractor = new IncrementalExtractor(memoryStore, {
        enabled: msCfg.incrementalExtractor.enabled,
        mode: msCfg.incrementalExtractor.mode,
        modelId: msCfg.incrementalExtractor.modelId,
      });
      const hybridRetriever = new HybridRetriever(memoryStore, null, {
        enabled: msCfg.hybridRetriever.enabled,
        bm25Weight: msCfg.hybridRetriever.bm25Weight,
        embeddingWeight: msCfg.hybridRetriever.embeddingWeight,
        timeDecayHalfLifeDays: msCfg.hybridRetriever.timeDecayHalfLifeDays,
        topK: msCfg.hybridRetriever.topK,
      });
      const conservativeMerger = new ConservativeMerger(memoryStore);
      const rejectedAlternativeStore = new RejectedAlternativeStore(memoryStore);
      const localMaintenance = new LocalMaintenancePolicy(memoryStore, {
        enabled: msCfg.localMaintenance.enabled,
        triggerThreshold: msCfg.localMaintenance.triggerThreshold,
        reorganizeRatio: msCfg.localMaintenance.reorganizeRatio,
        minAccessCount: msCfg.localMaintenance.minAccessCount,
      });
      const bm25Index = new BM25Index();
      // [I-3] UnifiedMemoryStore 桥接 MemoryStore + KnowledgeGraph + CodebaseMemory（P0.2）
      // 使用变量路径让 TypeScript 无法静态解析，避免模块缺失时 typecheck 失败
      const unifiedMemoryModulePath = '../memory/unified-memory.js';
      import(unifiedMemoryModulePath)
        .then(({ UnifiedMemoryStoreImpl }) => {
          const knowledgeGraph = contextManager?.getKnowledgeGraph?.() ?? null;
          const unifiedMemory = new UnifiedMemoryStoreImpl(memoryStore, knowledgeGraph, codebaseMemory ?? null);
          logger.info('UnifiedMemoryStore initialized', {
            hasKnowledgeGraph: knowledgeGraph !== null,
            hasCodebaseMemory: codebaseMemory != null,
          });
        })
        .catch(() => { /* fail-open：unified-memory 模块不可用时跳过 */ });
      logger.info('Phase 65: Memory system refactor enabled', {
        store: msCfg.store.enabled,
        incrementalExtractor: msCfg.incrementalExtractor.enabled,
        hybridRetriever: msCfg.hybridRetriever.enabled,
        conservativeMerger: msCfg.conservativeMerger.enabled,
        rejectedAlternative: msCfg.rejectedAlternative.enabled,
        localMaintenance: msCfg.localMaintenance.enabled,
      });
      return { memoryStore, incrementalExtractor, hybridRetriever, conservativeMerger, rejectedAlternativeStore, localMaintenance, bm25Index };
    })(),
    // Phase 66：策略管道与治理（复用提前创建的实例）
    ...(() => {
      if (!fpCfg?.enabled) return {};
      return { checkpointPipeline: p66CheckpointPipeline, callOwnerCoordinator: p66CallOwnerCoordinator, stateSnapshotChain: p66StateSnapshotChain, reputationDeriver: p66ReputationDeriver };
    })(),
    // Phase 67：推理质量诊断（复用提前创建的实例）
    ...(() => {
      if (!rqdCfg?.enabled) return {};
      return { miCrossScorer: p67MiCrossScorer, snrAwareFilter: p67SnrAwareFilter, epistemicTokenProtector: p67EpistemicTokenProtector, epistemicIntegrityChecker: p67EpistemicIntegrityChecker, epistemicPreservingSummarizer: p67EpistemicPreservingSummarizer, qualityMetricsRecorder: p67QualityMetricsRecorder };
    })(),
    // Phase 68：检索/搜索/发现三分与知识图谱
    ...(() => {
      const p68Cfg = config.phase68Integration;
      if (!p68Cfg) return {};

      const result: Record<string, unknown> = {};

      if (p68Cfg.provenanceGraph?.enabled) {
        const provenanceGraph = new ProvenanceGraph(p68Cfg.provenanceGraph.maxArtifacts);
        if (p68Cfg.provenanceGraph.persistPath) {
          provenanceGraph.loadFromFile(p68Cfg.provenanceGraph.persistPath).catch(() => {});
        }
        result.provenanceGraph = provenanceGraph;
      }

      if (p68Cfg.rejectedAlternativeStore?.enabled) {
        const agentRejectedAlternativeStore = new AgentRejectedAlternativeStore(
          p68Cfg.rejectedAlternativeStore.maxRecords,
        );
        if (p68Cfg.rejectedAlternativeStore.persistPath) {
          agentRejectedAlternativeStore.loadFromFile(p68Cfg.rejectedAlternativeStore.persistPath).catch(() => {});
        }
        result.agentRejectedAlternativeStore = agentRejectedAlternativeStore;
      }

      if (p68Cfg.kanObstacleChecker?.enabled && result.provenanceGraph) {
        const kanObstacleChecker = new KanObstacleChecker(
          result.provenanceGraph as ProvenanceGraph,
          {
            enabled: p68Cfg.kanObstacleChecker.enabled,
            blockOnObstacle: p68Cfg.kanObstacleChecker.blockOnObstacle,
          },
        );
        result.kanObstacleChecker = kanObstacleChecker;
      }

      if (p68Cfg.quantitativeGate?.enabled) {
        const quantitativeGate = new QuantitativeGate({
          enabled: p68Cfg.quantitativeGate.enabled,
          mdlWeight: p68Cfg.quantitativeGate.mdlWeight,
          aicWeight: p68Cfg.quantitativeGate.aicWeight,
          acceptThreshold: p68Cfg.quantitativeGate.acceptThreshold,
          rejectThreshold: p68Cfg.quantitativeGate.rejectThreshold,
          complexityPenalty: p68Cfg.quantitativeGate.complexityPenalty,
        });
        result.quantitativeGate = quantitativeGate;
      }

      if (p68Cfg.operationClassification?.enabled) {
        result.classifyOperation = classifyOperation;
        result.buildRegimeTransition = buildRegimeTransition;
      }

      if (Object.keys(result).length > 0) {
        logger.info('Phase 68: Knowledge graph modules enabled', {
          provenanceGraph: !!result.provenanceGraph,
          provenanceGraphPersistPath: p68Cfg.provenanceGraph?.persistPath,
          agentRejectedAlternativeStore: !!result.agentRejectedAlternativeStore,
          rejectedPersistPath: p68Cfg.rejectedAlternativeStore?.persistPath,
          defaultQueryLimit: p68Cfg.rejectedAlternativeStore?.defaultQueryLimit,
          kanObstacleChecker: !!result.kanObstacleChecker,
          quantitativeGate: !!result.quantitativeGate,
          operationClassification: !!result.classifyOperation,
          logRegimeTransition: p68Cfg.operationClassification?.logRegimeTransition,
        });
      }

      return result as Partial<AppDependencies>;
    })(),
    // Phase 69：Worktree 隔离执行与多代理并行编排（复用提前创建的实例）
    ...(() => {
      if (!p69Cfg) return {};
      const result: Record<string, unknown> = {};
      if (p69WorktreeManager) result.worktreeManager = p69WorktreeManager;
      if (p69ResultComparator) result.resultComparator = p69ResultComparator;
      if (p69AgentGroupResolver) result.agentGroupResolver = p69AgentGroupResolver;
      if (p69CliAdapterRegistry) result.cliAdapterRegistry = p69CliAdapterRegistry;
      return result as Partial<AppDependencies>;
    })(),
    // Phase 70：上下文压缩技术深度优化（引用提前创建的实例，与 ContextCompactor 共享）
    ...(() => {
      if (!p70Cfg) return {};

      const result: Record<string, unknown> = {};

      if (p70ToolOutputBudgetManager) {
        result.toolOutputBudgetManager = p70ToolOutputBudgetManager;
      }

      if (p70MessageGrouper) {
        result.messageGrouper = p70MessageGrouper;
      }

      if (p70ActionChainDetector) {
        result.actionChainDetector = p70ActionChainDetector;
      }

      if (p70AutoCompactGuardian) {
        result.autoCompactGuardian = p70AutoCompactGuardian;
      }

      if (p70CompactPromptEngine) {
        result.compactPromptEngine = p70CompactPromptEngine;
      }

      if (p70SessionMemoryStore) {
        result.sessionMemoryStore = p70SessionMemoryStore;
      }

      if (codebaseMemory) {
        result.codebaseMemory = codebaseMemory;
      }

      if (Object.keys(result).length > 0) {
        logger.info('Phase 70: Context compaction modules enabled', {
          toolOutputBudgetManager: !!result.toolOutputBudgetManager,
          messageGrouper: !!result.messageGrouper,
          actionChainDetector: !!result.actionChainDetector,
          autoCompactGuardian: !!result.autoCompactGuardian,
          compactPromptEngine: !!result.compactPromptEngine,
          compactPromptDirection: p70Cfg?.compactPrompt?.defaultDirection,
          sessionMemoryStore: !!result.sessionMemoryStore,
          sessionMemoryPersistPath: p70Cfg?.sessionMemory?.persistPath,
          sessionMemoryMaxMemories: p70Cfg?.sessionMemory?.maxMemories,
          codebaseMemory: !!result.codebaseMemory,
        });
      }

      return result as Partial<AppDependencies>;
    })(),
  };
}

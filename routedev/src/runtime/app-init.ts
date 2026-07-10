// src/runtime/app-init.ts
// App 依赖初始化工厂（门面模块）：编排 5 个子装配模块
// Phase 0c Task 3：App.tsx 装配收敛
// TD-02：从原 2521 行拆分为 5 子模块 + 本门面（~300 行）
//
// 设计原则：
//   1. 所有服务实例在子模块中创建，本文件仅负责编排和合并
//   2. 返回的 AppDependencies 对象由 App.tsx 通过 useRef 持有
//   3. 依赖 currentModel 的服务用初始值创建，后续通过 update 方法同步
//   4. InitContext 作为共享可变上下文，在各子系统间传递中间产物
//
// 子系统调用顺序（依赖链）：
//   1. observability → trace/audit/prompts/blackboard（无依赖）
//   2. router → primaryClient/checkpointClient/compositionalRouter（无依赖）
//   3. memory → contextManager/recallInjector/ccrCache/p70*（依赖 router.checkpointClient）
//   4. tools → registry/agentLoop/toolExecutor/permissionEngine（依赖 observability.trace + memory.recallInjector）
//   5. agent → hookRunner/unifiedReviewer/goalPersistence/...（依赖 tools + memory + observability + router）

// ============================================================
// 类型导入（用于 AppDependencies 和 InitContext 接口定义）
// ============================================================
import type { AppConfig } from '../config/schema.js';
import type { ILLMClient } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { OperationSignal } from '../skills/operation-classifier.js';
import type { AtomicSubTask, SkillDAGPlan, CompositionalRoutingConfig } from '../skills/compositional-router.js';
import type { DualLoopOrchestrator } from '../agent/dual-loop-orchestrator.js';
import type { DagEngine } from '../agent/workflow/dag-engine.js';

// 值类型导入（AppDependencies 接口引用的类）
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { MCPClientManager } from '../tools/mcp/client.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { SkillsRouter, FilesystemDiscovery } from '../plugins/filesystem-discovery.js';
import type { CheckpointManager } from '../harness/checkpoint-manager.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import type { VisionAssistant } from '../agent/vision.js';
import type { PromptTemplateManager } from '../prompts/manager.js';
import type { Blackboard } from '../agent/multi/blackboard.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import type { AuditLogger } from '../harness/audit-logger.js';
import type { HookRunner } from '../agent/hooks.js';
import type { TokenProfiler } from '../agent/token-profiler.js';
import type { UnifiedReviewer } from '../agent/unified-reviewer.js';
import type { CompletionGate } from '../agent/completion-gate.js';
import type { GoalAuditor } from '../agent/goal-audit.js';
import type { GoalPersistence } from '../agent/goal-persistence.js';
import type { SkillLifecycleManager } from '../skills/skill-lifecycle.js';
import type { AgentActivityStore } from '../agents/activity-store.js';
import type { PathRouter } from '../agent/path-router.js';
import type { ExperimentManager } from '../harness/experiment-manager.js';
import type { RoutingHistory } from '../router/routing-history.js';
import type { RoutingMemory } from '../router/routing-memory.js';
import type { RoutingOrchestrator } from '../router/orchestrator.js';
import type { ExecutionVerifier } from '../router/execution-verifier.js';
import type { RoutingRegretTracker } from '../router/regret-tracker.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { HybridRetriever } from '../memory/hybrid-retriever.js';
import type { LocalMaintenancePolicy } from '../memory/local-maintenance.js';
import type { ProvenanceGraph } from '../memory/provenance-graph.js';
import type { KanObstacleChecker } from '../skills/kan-obstacle-checker.js';
import type { QuantitativeGate } from '../agent/quantitative-gate.js';
import type { classifyOperation } from '../skills/operation-classifier.js';

// InitContext 中间变量类型导入
import type { ProjectMemoryManager } from '../memory/project-memory.js';
import type { MemoryRecallInjector } from '../agent/memory/recall-injector.js';
import type { CCRCache } from '../agent/ccr-cache.js';
import type { BranchManager } from '../agent/branch.js';
import type { SecurityChecker } from '../tools/security.js';
import type { ToolRegistryAdapter } from '../tools/adapter.js';
import type { WorkModeController, GuardedToolExecutorAdapter } from '../agent/work-modes.js';
import type { ReadTracker } from '../tools/read-tracker.js';
import type { PermissionEngine } from '../tools/permission-engine.js';
import type { ToolResultSanitizer } from '../tools/result-sanitizer.js';
import type { PlanState } from '../agent/context/plan-state.js';
import type { TaskOrchestrator } from '../agent/task-orchestrator.js';
// F-027：Phase 70 上下文压缩模块类型（InitContext.p70* 字段原为 unknown，替换为具体类型）
import type { ToolOutputBudgetManager } from '../agent/memory/tool-output-budget.js';
import type { MessageGrouper } from '../agent/memory/message-grouper.js';
import type { ActionChainDetector } from '../agent/memory/action-chain-detector.js';
import type { AutoCompactGuardian } from '../agent/memory/auto-compact-guardian.js';
import type { CompactPromptEngine } from '../agent/memory/compact-prompt-engine.js';
import type { SessionMemoryStore } from '../agent/memory/session-memory-store.js';

// 子系统装配函数导入
import { createObservabilitySubsystem } from './app-init-observability.js';
import { createRouterSubsystem } from './app-init-router.js';
import { createMemorySubsystem } from './app-init-memory.js';
import { createToolSubsystem } from './app-init-tools.js';
import { createAgentSubsystem } from './app-init-agent.js';

// ============================================================
// 对外接口定义
// ============================================================

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
  toolExecutor: ToolExecutor;
  agentLoop: ReActAgentLoop;
  // 插件系统
  skillsRouter: SkillsRouter;
  filesystemDiscovery: FilesystemDiscovery;
  // 记忆与上下文
  checkpointManager: CheckpointManager;
  contextManager: ContextManager;
  visionAssistant: VisionAssistant | undefined;
  // 基础设施
  prompts: PromptTemplateManager;
  blackboard: Blackboard;
  trace: TraceCollector;
  audit: AuditLogger;
  hookRunner: HookRunner;
  // LLM 客户端
  checkpointClient: ILLMClient;
  profiler: TokenProfiler | null;
  // 审查与验证
  unifiedReviewer: UnifiedReviewer;
  completionGate: CompletionGate;
  sharedSystemPromptRef: { current: string };
  // Goal 流程
  goalAuditor: GoalAuditor | null;
  goalPersistence: GoalPersistence | null;
  skillLifecycleManager?: SkillLifecycleManager;
  activityStore?: AgentActivityStore;
  compositionalRouter?: CompositionalRouterInstance;
  pathRouter: PathRouter;
  dualLoopOrchestratorRef: { current: DualLoopOrchestrator | null };
  dagEngineRef: { current: DagEngine | null };
  experimentManager: ExperimentManager;
  // Phase 61：ACRouter 闭环模型路由
  routingHistory?: RoutingHistory;
  routingMemory?: RoutingMemory;
  routingOrchestrator?: RoutingOrchestrator;
  executionVerifier?: ExecutionVerifier;
  routingRegretTracker?: RoutingRegretTracker;
  // Phase 65：记忆系统重构
  memoryStore?: MemoryStore;
  hybridRetriever?: HybridRetriever;
  localMaintenance?: LocalMaintenancePolicy;
  // Phase 68：知识图谱
  provenanceGraph?: ProvenanceGraph;
  kanObstacleChecker?: KanObstacleChecker;
  quantitativeGate?: QuantitativeGate;
  classifyOperation?: (signal: OperationSignal, sessionId: string) => ReturnType<typeof classifyOperation>;
}

// ============================================================
// InitContext：共享可变装配上下文
// ============================================================

/**
 * 共享装配上下文：在各子系统间传递中间产物
 *
 * 设计模式：用一个可变对象替代闭包变量，各子系统：
 *   1. 从 ctx 读取自己需要的输入（如 config/cwd/trace/recallInjector）
 *   2. 创建自己的实例
 *   3. 将产出写回 ctx 供下游子系统消费
 *   4. 返回 Partial<AppDependencies> 供门面合并
 *
 * 字段填充顺序：
 *   createAppDependencies 设置输入 → observability → router → memory → tools → agent
 */
export interface InitContext {
  // ===== 输入参数（由 createAppDependencies 设置） =====
  config: AppConfig;
  cwd: string;
  clientManager: LLMClientManager;
  currentModel: string;
  classifier?: ScenarioClassifier;
  modelRouter?: ModelRouter;
  tracker?: TokenTracker;
  /** 递归工厂引用（供 agent 子系统的 depsFactory 创建 worktree 独立依赖） */
  createAppDependencies?: (
    config: AppConfig,
    clientManager: LLMClientManager,
    currentModel: string,
    cwd: string,
    classifier?: ScenarioClassifier,
    modelRouter?: ModelRouter,
    tracker?: TokenTracker,
  ) => AppDependencies;

  // ===== 由 router 子系统写入 =====
  checkpointClient?: ILLMClient;
  primaryClient?: ILLMClient;
  primaryProviderId?: string;
  fallbackClient?: ILLMClient;

  // ===== 由 observability 子系统写入 =====
  trace?: TraceCollector;
  audit?: AuditLogger;
  prompts?: PromptTemplateManager;
  blackboard?: Blackboard;
  projectMemory?: ProjectMemoryManager;
  offloadSessionId?: string;
  offloadRootDir?: string;

  // ===== 由 memory 子系统写入 =====
  checkpointManager?: CheckpointManager;
  contextManager?: ContextManager;
  recallInjector?: MemoryRecallInjector;
  ccrCache?: CCRCache;
  branchManager?: BranchManager;
  visionAssistant?: VisionAssistant | undefined;
  p70Cfg?: AppConfig['phase70Integration'];
  p70ToolOutputBudgetManager?: ToolOutputBudgetManager;
  p70MessageGrouper?: MessageGrouper;
  p70ActionChainDetector?: ActionChainDetector;
  p70AutoCompactGuardian?: AutoCompactGuardian;
  p70CompactPromptEngine?: CompactPromptEngine;
  p70SessionMemoryStore?: SessionMemoryStore;
  p70SessionMemoryPersistentPath?: string;

  // ===== 由 tools 子系统写入 =====
  registry?: ToolRegistry;
  mcpManager?: MCPClientManager;
  toolExecutor?: ToolExecutor;
  securityChecker?: SecurityChecker;
  adapter?: ToolRegistryAdapter;
  guardedAdapter?: GuardedToolExecutorAdapter;
  workModeController?: WorkModeController;
  readTracker?: ReadTracker;
  readBeforeWriteEnabled?: boolean;
  webSearchEnv?: Record<string, string>;
  permissionEngine?: PermissionEngine;
  skillsRouter?: SkillsRouter;
  filesystemDiscovery?: FilesystemDiscovery;
  resultSanitizer?: ToolResultSanitizer;
  virtualFS?: unknown;
  planState?: PlanState;
  agentLoop?: ReActAgentLoop;
  profiler?: TokenProfiler | null;

  // ===== 由 agent 子系统写入 =====
  hookRunner?: HookRunner;
  sharedSystemPromptRef?: { current: string };
  taskOrchestrator?: TaskOrchestrator;
  unifiedReviewer?: UnifiedReviewer;
  completionGate?: CompletionGate;
  pathRouter?: PathRouter;
  dualLoopOrchestratorRef?: { current: DualLoopOrchestrator | null };
  dagEngineRef?: { current: DagEngine | null };
  experimentManager?: ExperimentManager;
  goalAuditor?: GoalAuditor | null;
  goalPersistence?: GoalPersistence | null;
  skillLifecycleManager?: SkillLifecycleManager | undefined;
  activityStore?: AgentActivityStore | undefined;
}

// ============================================================
// 门面函数
// ============================================================

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
 * @param tracker Token 追踪器（Phase 32 Task 1：UnifiedReviewer 依赖）
 */
export function createAppDependencies(
  config: AppConfig,
  clientManager: LLMClientManager,
  currentModel: string,
  cwd: string = process.cwd(),
  classifier?: ScenarioClassifier,
  modelRouter?: ModelRouter,
  tracker?: TokenTracker,
): AppDependencies {
  // 创建共享装配上下文
  const ctx: InitContext = {
    config,
    cwd,
    clientManager,
    currentModel,
    classifier,
    modelRouter,
    tracker,
  };
  // 设置递归引用（供 agent 子系统的 depsFactory 创建 worktree 独立依赖）
  ctx.createAppDependencies = (
    cfg: AppConfig,
    cm: LLMClientManager,
    model: string,
    newCwd: string,
    cls?: ScenarioClassifier,
    mr?: ModelRouter,
    tr?: TokenTracker,
  ) => createAppDependencies(cfg, cm, model, newCwd, cls, mr, tr);

  // ===== 按依赖顺序调用 5 个子系统 =====

  // 1. 可观测性子系统（无依赖，创建 trace/audit/prompts/blackboard/projectMemory/offload*）
  //    内部还包含 OTel exporter / AuditChain / loadProjectDoc / Doctor / Analytics
  const observabilityDeps = createObservabilitySubsystem(ctx);

  // 2. 路由子系统（无依赖，创建 primaryClient/checkpointClient/compositionalRouter/ACRouter）
  const routerDeps = createRouterSubsystem(ctx);

  // 3. 记忆子系统（依赖 router.checkpointClient，创建 contextManager/recallInjector/ccrCache/p70*/visionAssistant）
  //    内部还包含 Phase 65 记忆重构 / Phase 68 知识图谱 / UnifiedMemoryStore
  const memoryDeps = createMemorySubsystem(ctx);

  // 4. 工具子系统（依赖 observability.trace + memory.recallInjector/ccrCache/offload*/p70Cfg）
  //    创建 registry/agentLoop/toolExecutor/securityChecker/permissionEngine/policyEngine/skillsRouter
  const toolsDeps = createToolSubsystem(ctx);

  // 5. Agent 子系统（依赖 tools + memory + observability + router 的全部产出）
  //    创建 hookRunner/unifiedReviewer/completionGate/goal*/pathRouter/dualLoop/dag/experiment
  //    内部还包含 Plugin / CodeMap / Hook / Phase 48/49/52/53/77 全部接线
  const agentDeps = createAgentSubsystem(ctx);

  // ===== 合并所有子系统的返回值 =====
  return {
    ...observabilityDeps,
    ...routerDeps,
    ...memoryDeps,
    ...toolsDeps,
    ...agentDeps,
  } as AppDependencies;
}

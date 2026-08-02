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
import { parseAppDependenciesMerge } from '../config/schemas/app-dependencies.js';
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
// TD-26：Phase 65 记忆系统类型已退役（MemoryStore/HybridRetriever/LocalMaintenance）
import type { ProvenanceGraph } from '../memory/provenance-graph.js';
import type { KanObstacleChecker } from '../skills/kan-obstacle-checker.js';
import type { QuantitativeGate } from '../agent/quantitative-gate.js';
import type { classifyOperation } from '../skills/operation-classifier.js';
// Phase 80 Task 2：本地使用计数器类型导入
import type { UsageCounter } from '../observability/usage-counter.js';
// Phase 97 Part I Task I2：触发率统计器类型导入
import type { HitStat } from '../memory/hit-stat.js';
// F-018：CapabilityPackRegistry 类型导入已移除（不再用于接口定义）

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
// Phase 97 Part D：工作区管理器类型
import type { WorkspaceManager } from '../workspace/manager.js';
// Phase 97 Part E：子会话注册表类型
import type { SubagentRegistry } from '../agents/subagent-registry.js';
// Phase 97 Part A：内核插槽类型与 routedev-native 薄适配
import type { AgentKernel } from '../agent/kernel.js';
import { NativeAgentKernel } from '../agent/kernel-native.js';
// Phase 97 Part F：自动化调度器类型
import type { AutomationScheduler } from './automation-scheduler.js';
import { AutomationScheduler as AutomationSchedulerImpl, migrateAutomationTasks } from './automation-scheduler.js';
import type { ToolResultSanitizer } from '../tools/result-sanitizer.js';
import type { PlanState } from '../agent/context/plan-state.js';
import type { TaskOrchestrator } from '../agent/task-orchestrator.js';
// Phase 94 Task 3：tools 子系统创建、agent 子系统注入到 agentLoop 的实例类型
import type { PolicyEngine } from '../policies/policy-engine.js';
import type { ToolOutputPipeline } from '../agent/context/tool-output-pipeline.js';
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
// F3-1 修复：全局未捕获异常处理器所需 logger
import { logger } from '../utils/logger.js';

/**
 * F3-1 修复：模块级 flag，确保全局异常处理器只注册一次
 *
 * Node.js 的 process.on('unhandledRejection' / 'uncaughtException') 重复注册会
 * 叠加多个监听器，导致同一条错误被记录多次。createAppDependencies 可能被递归
 * 调用（worktree 场景），用模块级 flag 保证只注册一次。
 */
let globalHandlersRegistered = false;

// ============================================================
// 对外接口定义
// ============================================================

/**
 * Phase 94 Task 2：EnabledPacks 功能矩阵
 *
 * 单点计算所有 Pack 的 enabled 状态，替代 27 处散布的 `config.packs?.xxx?.enabled` 读取。
 * 各 setup 函数从 ctx.enabledPacks 读取，避免每个子模块重复访问 config.packs。
 *
 * 设计原则：
 *   - 仅承载 packs?.xxx?.enabled 维度，不包含其他 config 字段的组合条件
 *   - trustGradient 在 Phase 79 后无条件 Core（TD-27），不设 enabled 门控
 *   - 新增 Pack 时在此接口和 computeEnabledPacks 中追加字段
 */
export interface EnabledPacks {
  /** 代码地图 Pack（codeMap engine + watchMode） */
  codeMap: boolean;
  /** 知识图谱高级算法 Pack（社区检测） */
  kgAdvanced: boolean;
  /** CCR 可逆压缩 Pack */
  ccrCompression: boolean;
  /** Compose 工作模式 Pack */
  compose: boolean;
  /** Skill 生命周期 Pack */
  skillLifecycle: boolean;
  /** 多 Agent Pack（subAgents / breaker） */
  multiAgent: boolean;
  /** Goal 高级 Pack（DAG / DualLoop / BoundedRecovery / TaskOrchestrator） */
  goalAdvanced: boolean;
  /** 完整性校验 Pack */
  integrity: boolean;
  /** 对抗审查 Pack（adversarial / crossModelReviewer） */
  adversarial: boolean;
  /** ACRouter 闭环模型路由 Pack */
  acRouter: boolean;
}

/**
 * Phase 94 Task 2：从 config 计算 EnabledPacks 功能矩阵
 *
 * 单点收敛所有 packs?.xxx?.enabled 读取，子模块通过 ctx.enabledPacks 访问。
 */
export function computeEnabledPacks(config: AppConfig): EnabledPacks {
  return {
    codeMap: config.packs?.codeMap?.enabled === true,
    kgAdvanced: config.packs?.kgAdvanced?.enabled === true,
    ccrCompression: config.packs?.ccrCompression?.enabled === true,
    compose: config.packs?.compose?.enabled === true,
    skillLifecycle: config.packs?.skillLifecycle?.enabled === true,
    multiAgent: config.packs?.multiAgent?.enabled === true,
    goalAdvanced: config.packs?.goalAdvanced?.enabled === true,
    integrity: config.packs?.integrity?.enabled === true,
    adversarial: config.packs?.adversarial?.enabled === true,
    acRouter: config.packs?.acRouter?.enabled === true,
  };
}

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
  /** Phase 79 Task 4：权限引擎实例，供 IPC tool:execute 复用权限校验 */
  permissionEngine?: PermissionEngine;
  /** Phase 97 Part D：工作区管理器（能力边界作用域） */
  workspaceManager: WorkspaceManager;
  /** Phase 97 Part E：子会话注册表（子 Agent 可见性——登记/查询/停止） */
  subagentRegistry: SubagentRegistry;
  /** Phase 97 Part F：自动化调度器（定时触发复用统一 Session 执行） */
  automationScheduler: AutomationScheduler;
  /** Phase 97 Part A：Agent 内核插槽（当前为 routedev-native 薄适配，包装 ReActAgentLoop） */
  agentKernel: AgentKernel;
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
  /** Phase 80 Task 2：本地使用计数器（fail-open，仅本地计数，禁止云上报） */
  usageCounter?: UsageCounter;
  /** Phase 97 Part I Task I2：触发率统计器（记忆/Skill/UserProfile 命中计数） */
  hitStat: HitStat;
  // F-018：packRegistry 僵尸字段已移除（Pack 加载机制保留在 app-init-tools.ts 内部）
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
  // TD-26：Phase 65 记忆系统已退役（memoryStore/hybridRetriever/localMaintenance 移除）
  // Phase 68：知识图谱
  provenanceGraph?: ProvenanceGraph;
  kanObstacleChecker?: KanObstacleChecker;
  quantitativeGate?: QuantitativeGate;
  classifyOperation?: (signal: OperationSignal, sessionId: string) => ReturnType<typeof classifyOperation>;

  /**
   * 释放所有子系统资源（G-007 修复）
   *
   * 按逆序调用各子系统的 dispose 方法（仅调用已存在的，不强制新增）。
   * 由 engine-bridge.destroy() 在销毁引擎时调用，确保旧依赖（timer/handle/MCP 连接等）
   * 在 reloadConfig 或进程退出前被正确释放，避免资源泄漏。
   */
  dispose(): Promise<void>;
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
  /**
   * Phase 94 Task 2：EnabledPacks 功能矩阵
   *
   * 由 createAppDependencies 在装配入口计算，各 setup 函数从 ctx.enabledPacks 读取，
   * 替代散布的 `config.packs?.xxx?.enabled` 读取（27 处收敛为单点计算）。
   */
  enabledPacks: EnabledPacks;
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

  // ===== 由 observability 子系统写入 =====
  trace?: TraceCollector;
  audit?: AuditLogger;
  prompts?: PromptTemplateManager;
  blackboard?: Blackboard;
  projectMemory?: ProjectMemoryManager;
  offloadSessionId?: string;
  offloadRootDir?: string;
  /** Phase 80 Task 2：本地使用计数器（由 observability 子系统创建） */
  usageCounter?: UsageCounter;
  /** Phase 97 Part I Task I2：触发率统计器（由 observability 子系统创建） */
  hitStat?: HitStat;
  /** Phase 97 Part D：工作区管理器（由 tools 子系统创建） */
  workspaceManager?: WorkspaceManager;
  /** Phase 97 Part E：子会话注册表（由 agent 子系统创建） */
  subagentRegistry?: SubagentRegistry;

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
  /** Phase 94 Task 3：PolicyEngine 实例（由 tools 子系统创建，供 agent 子系统注入到 agentLoop） */
  policyEngine?: PolicyEngine;
  /** Phase 94 Task 3：ToolOutputPipeline 实例（由 tools 子系统创建，供 agent 子系统注入到 agentLoop） */
  toolOutputPipeline?: ToolOutputPipeline;
  virtualFS?: unknown;
  planState?: PlanState;
  agentLoop?: ReActAgentLoop;
  profiler?: TokenProfiler | null;
  // F-018：packRegistry 僵尸字段已移除（tools 子系统内部保留 Pack 加载机制）

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
 * F-056 Disposable 接口：统一资源释放协议类型
 * 各 createXxxSubsystem 返回的 Partial<AppDependencies> 可包含 dispose 方法，
 * 用此接口替代内联的 `as { dispose?: () => Promise<void> }` 断言。
 */
interface Disposable {
  dispose?: () => Promise<void>;
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
  // F3-1 修复：注册全局未捕获异常处理器（只注册一次）
  // 不退出进程，仅记录日志；致命错误由 graceful-shutdown 处理
  if (!globalHandlersRegistered) {
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled promise rejection', { reason: String(reason) });
    });
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', {
        error: err.message,
        stack: err.stack,
        name: err.name,
      });
    });
    globalHandlersRegistered = true;
  }

  // 创建共享装配上下文
  const ctx: InitContext = {
    config,
    cwd,
    clientManager,
    currentModel,
    classifier,
    modelRouter,
    tracker,
    // Phase 94 Task 2：单点计算 EnabledPacks，供各 setup 函数读取
    enabledPacks: computeEnabledPacks(config),
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

  // 6. Phase 97 Part F：自动化调度器（定时触发复用统一 Session 执行）
  //    executor 由 desktop 装配层注入（engine.sendChat），调度器本身只做 cron 匹配与运行历史
  const automationScheduler = new AutomationSchedulerImpl(
    migrateAutomationTasks(config.automations),
  );

  // 7. Phase 97 Part A Task A3：routedev-native 内核薄适配（kernel 插槽）
  //    包装主 ReActAgentLoop 满足 AgentKernel 接口；EngineEventV1 sink 由 kernel.run 注入
  //    （当前生产入口 sendChat 仍直连 agentLoop；kernel 作为未来 Pi/Claude SDK 的插槽）
  //    k3：装配时注入 trace，kernel 路径的 EngineEventV1 同步写入 trace（携带 sequence/turnId）
  const agentKernel = new NativeAgentKernel((ctx.agentLoop ?? agentDeps.agentLoop) as ReActAgentLoop, {
    trace: ctx.trace ?? null,
  });

  // ===== 合并所有子系统的返回值 =====
  const merged = {
    ...observabilityDeps,
    ...routerDeps,
    ...memoryDeps,
    ...toolsDeps,
    ...agentDeps,
    // Phase 97 Part F：自动化调度器
    automationScheduler,
    // Phase 97 Part A：Agent 内核插槽（routedev-native 薄适配）
    agentKernel,
    // G-007：统一资源释放协议——按逆序调用各子系统 dispose（仅调用已存在的，不强制新增）
    async dispose() {
      // 逆序释放：agent → tools → memory → router → observability（与创建顺序相反）
      // F-056：用 Disposable 接口替代内联 as 断言
      // Phase 97 Part F：先停止自动化调度器（释放 timer）
      automationScheduler.stop();
      await (agentDeps as Disposable).dispose?.();
      await (toolsDeps as Disposable).dispose?.();
      await (memoryDeps as Disposable).dispose?.();
      await (routerDeps as Disposable).dispose?.();
      await (observabilityDeps as Disposable).dispose?.();
      // 释放传入的共享实例（tracker/clientManager/classifier/modelRouter）
      await (tracker as Disposable | undefined)?.dispose?.();
      await (clientManager as Disposable).dispose?.();
      await (classifier as Disposable | undefined)?.dispose?.();
      await (modelRouter as Disposable | undefined)?.dispose?.();
      logger.info('已释放所有依赖资源');
    },
  };
  // F-048 类型安全：子系统返回 Partial<AppDependencies>，合并后用 Zod 校验核心字段存在性（fail-closed）
  return parseAppDependenciesMerge(merged);
}

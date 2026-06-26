// src/cli/service-context.ts
// App 所需服务对象的容器，避免 App.tsx 继续膨胀
// 蓝图 17.1：集中管理 config / clientManager / router / tracker / agents / trace / audit / prompts / projectMemory
// Phase 17b：新增 CommandBridge（命令与 UI 桥接）+ checkpointManager + mcpManager

import type { AppConfig, AutonomyMode, OutputStyle } from '../config/schema.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { LLMMessage } from '../router/types.js';
import type { TokenProfiler } from '../agent/token-profiler.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import type { BranchManager } from '../agent/branch.js';
import type { VisionAssistant } from '../agent/vision.js';
import type { InitAnalyzer } from '../agent/init-analyzer.js';
import type { DreamConsolidator } from '../agent/dream-consolidator.js';
import type { GoalParser } from '../agent/goal-parser.js';
import type { GoalVerifier } from '../agent/goal-verifier.js';
import type { Blackboard } from '../agent/multi/blackboard.js';
import type { Orchestrator } from '../agent/multi/orchestrator.js';
import type { WorkerExecutor } from '../agent/multi/worker-executor.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import type { AuditLogger } from '../harness/audit-logger.js';
import type { PromptTemplateManager } from '../prompts/manager.js';
import type { ProjectMemoryManager } from '../memory/project-memory.js';
import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import type { CheckpointManager } from '../harness/checkpoint-manager.js';
import type { MCPClientManager } from '../tools/mcp/client.js';
import type { ScenarioTier } from '../router/types.js';
import type { WorkMode, WorkModeController } from '../agent/work-modes.js';
import type { GoalPlan, PlanStep } from '../agent/goal-types.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { CommandRegistry } from './command-registry.js';
import type { DurableExecutor } from '../agent/durable-executor.js';
// Phase 50 Task 7：接入 7 个 React 组件所需类型
import type { ExecutionSnapshot } from '../agent/durable-executor.js';
import type { TraceTimelineEntry } from './components/TracePanel.js';
import type { ConfigChange } from './components/ConfigReloadUI.js';

/** 命令与 UI 之间的桥接：命令通过回调影响 UI，不直接持有 React state */
export interface CommandBridge {
  /** 向聊天追加系统消息 */
  addSystemMessage: (content: string) => void;
  /** 清空聊天并重置上下文 */
  clearChat: () => void;
  /** 切换自治模式 */
  setAutonomyMode: (mode: AutonomyMode) => void;
  /** 切换工作模式（Phase 20） */
  setWorkMode: (mode: WorkMode) => void;
  /** 请求中断当前执行 */
  requestAbort: () => void;
  /** 请求确认（返回用户输入 'y'/'n'） */
  requestConfirm: (prompt: string) => Promise<boolean>;
  /** 请求用户编辑计划步骤（Phase 20：返回修改后的步骤或 null 表示取消） */
  requestPlanEdit: (plan: GoalPlan) => Promise<PlanStep[] | null>;
  /** 退出程序 */
  exit: () => void;
  /** 启动目标分解与执行（委托给 App 内部逻辑） */
  startGoal: (text: string) => void;
  /** 获取当前 UI 状态快照（供 /status 等命令使用） */
  getState: () => {
    currentModel: string;
    currentTier: ScenarioTier;
    isDegraded: boolean;
    autonomyMode: AutonomyMode;
    conversationHistoryLength: number;
    mcpConnectedCount: number;
    mcpTotalToolCount: number;
  };
  /** Phase 34：运行时切换输出样式 */
  setOutputStyle: (style: OutputStyle) => void;
  /** 获取当前对话历史（只读，供 /btw 等命令传递上下文给子 Agent） */
  getConversationHistory?: () => LLMMessage[];
  // ===== Phase 50 Task 7：7 个 React 组件接入回调（可选） =====
  /** 渲染 ResumePicker 组件（/resume 命令无 planId 且有多个快照时触发） */
  showResumePicker?: (snapshots: ExecutionSnapshot[]) => void;
  /** 渲染 TracePanel 组件（/trace view 命令触发） */
  showTracePanel?: (entries: TraceTimelineEntry[], sessionId?: string) => void;
  /** 渲染 DiffView 组件（/diff 命令触发） */
  showDiffView?: (diff: string, fileName?: string) => void;
  /** 关闭当前激活的面板（Esc 取消时触发） */
  closeActivePanel?: () => void;
  /** 通知配置变更（ConfigReloadNotice 组件渲染） */
  notifyConfigChanges?: (changes: ConfigChange[]) => void;
}

export interface ServiceContext {
  config: AppConfig;
  clientManager: LLMClientManager;
  router: ModelRouter;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  checkpointWriter: CheckpointWriter;
  checkpointManager: CheckpointManager;
  contextManager: ContextManager;
  branchManager: BranchManager;
  vision: VisionAssistant;
  initAnalyzer: InitAnalyzer;
  dream: DreamConsolidator;
  goalParser: GoalParser;
  goalVerifier: GoalVerifier;
  blackboard: Blackboard;
  orchestrator: Orchestrator;
  workerExecutor: WorkerExecutor;
  trace: TraceCollector;
  audit: AuditLogger;
  prompts: PromptTemplateManager;
  projectMemory: ProjectMemoryManager;
  toolExecutor: ToolExecutorAdapter;
  setToolExecutor: (executor: ToolExecutorAdapter) => void;
  mcpManager: MCPClientManager;
  commandBridge: CommandBridge;
  /** 工作模式控制器（Phase 20） */
  workModeController: WorkModeController;
  sessionId: string;
  cwd: string;
  /** 插件注册表（可选——插件系统初始化失败时为 undefined） */
  pluginRegistry?: PluginRegistry;
  /** 命令注册表（Phase 26 Task 3：消除 help.ts 的 as any 绕过） */
  commandRegistry?: CommandRegistry;
  /** 权限引擎（Phase 26 Task 4：/permissions 读取运行时实例） */
  permissionEngine?: import('../tools/permission-engine.js').PermissionEngine;
  /** 持久化执行器（Phase 27 Task 6：/resume 命令使用） */
  durableExecutor?: DurableExecutor;
  /** Phase 30：Token Profiler（可观测性，可选） */
  profiler?: TokenProfiler;
  /** Phase 48 Task 3：调度引擎实例（定时任务执行） */
  scheduleEngine?: import('../scheduler/engine.js').ScheduleEngine;
}

/**
 * Phase 0c Task 3：createServiceContext 改为接受 deps 对象（单一装配入口）
 * 原 27 个位置参数的签名已废弃，改为解构赋值
 *
 * @param deps 所有服务依赖（由 App.tsx 通过 createAppDependencies 创建）
 * @returns 完整的 ServiceContext
 */
export function createServiceContext(deps: ServiceContextDeps): ServiceContext {
  const sessionId = deps.trace.getSessionId() ?? `cli-${Date.now()}`;
  const ctx: ServiceContext = {
    config: deps.config,
    clientManager: deps.clientManager,
    router: deps.router,
    tracker: deps.tracker,
    agentLoop: deps.agentLoop,
    checkpointWriter: deps.checkpointWriter,
    checkpointManager: deps.checkpointManager,
    contextManager: deps.contextManager,
    branchManager: deps.branchManager,
    vision: deps.vision,
    initAnalyzer: deps.initAnalyzer,
    dream: deps.dream,
    goalParser: deps.goalParser,
    goalVerifier: deps.goalVerifier,
    blackboard: deps.blackboard,
    orchestrator: deps.orchestrator,
    workerExecutor: deps.workerExecutor,
    trace: deps.trace,
    audit: deps.audit,
    prompts: deps.prompts,
    projectMemory: deps.projectMemory,
    toolExecutor: deps.toolExecutor,
    setToolExecutor: deps.setToolExecutor ?? ((executor: ToolExecutorAdapter) => {
      ctx.toolExecutor = executor;
      deps.agentLoop.updateToolExecutor(executor);
    }),
    mcpManager: deps.mcpManager,
    commandBridge: deps.commandBridge,
    workModeController: deps.workModeController,
    sessionId,
    cwd: deps.cwd,
    ...(deps.pluginRegistry ? { pluginRegistry: deps.pluginRegistry } : {}),
    ...(deps.commandRegistry ? { commandRegistry: deps.commandRegistry } : {}),
    ...(deps.permissionEngine ? { permissionEngine: deps.permissionEngine } : {}),
    ...(deps.durableExecutor ? { durableExecutor: deps.durableExecutor } : {}),
    ...(deps.profiler ? { profiler: deps.profiler } : {}),
    ...(deps.scheduleEngine ? { scheduleEngine: deps.scheduleEngine } : {}),
  };
  return ctx;
}

/** ServiceContext 依赖对象（Phase 0c：替代原 27 个位置参数） */
export interface ServiceContextDeps {
  config: AppConfig;
  clientManager: LLMClientManager;
  router: ModelRouter;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  checkpointWriter: CheckpointWriter;
  contextManager: ContextManager;
  branchManager: BranchManager;
  vision: VisionAssistant;
  initAnalyzer: InitAnalyzer;
  dream: DreamConsolidator;
  goalParser: GoalParser;
  goalVerifier: GoalVerifier;
  blackboard: Blackboard;
  orchestrator: Orchestrator;
  workerExecutor: WorkerExecutor;
  trace: TraceCollector;
  audit: AuditLogger;
  prompts: PromptTemplateManager;
  projectMemory: ProjectMemoryManager;
  toolExecutor: ToolExecutorAdapter;
  checkpointManager: CheckpointManager;
  mcpManager: MCPClientManager;
  commandBridge: CommandBridge;
  workModeController: WorkModeController;
  cwd: string;
  pluginRegistry?: PluginRegistry;
  /** 命令注册表（Phase 26 Task 3） */
  commandRegistry?: CommandRegistry;
  /** 权限引擎（Phase 26 Task 4） */
  permissionEngine?: import('../tools/permission-engine.js').PermissionEngine;
  /** 持久化执行器（Phase 27 Task 6：/resume 命令使用） */
  durableExecutor?: DurableExecutor;
  /** Phase 30：Token Profiler（可观测性，可选） */
  profiler?: TokenProfiler;
  /** Phase 48 Task 3：调度引擎实例 */
  scheduleEngine?: import('../scheduler/engine.js').ScheduleEngine;
  /** 可选的工具执行器更新回调（用于运行时替换） */
  setToolExecutor?: (executor: ToolExecutorAdapter) => void;
}
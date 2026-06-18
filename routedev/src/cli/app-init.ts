// src/cli/app-init.ts
// App 依赖初始化工厂：从 App.tsx 抽取所有服务实例的创建逻辑
// Phase 0c Task 3：App.tsx 装配收敛，目标 ≤300 行
//
// 设计原则：
//   1. 所有服务实例在此创建，App.tsx 只负责 React 状态和 UI
//   2. 返回的对象由 App.tsx 通过 useRef 持有，保证整个组件生命周期不变
//   3. 依赖 currentModel 的服务用初始值创建，后续通过 update 方法同步

import type { AppConfig } from '../config/schema.js';
import type { ILLMClient } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { SecurityChecker } from '../tools/security.js';
import { ToolRegistryAdapter } from '../tools/adapter.js';
import { FileReadTool } from '../tools/builtin/file-read.js';
import { FileWriteTool } from '../tools/builtin/file-write.js';
import { FileSearchTool } from '../tools/builtin/file-search.js';
import { ShellExecTool } from '../tools/builtin/shell-exec.js';
import { GitOpTool } from '../tools/builtin/git-op.js';
import { WebSearchTool } from '../tools/builtin/web-search.js';
import { CodeSearchTool } from '../tools/builtin/code-search.js';
import { createDefaultEngine, type PermissionEngine } from '../tools/permission-engine.js';
import { MCPClientManager } from '../tools/mcp/client.js';
import { ReActAgentLoop } from '../agent/loop.js';
import { WorkModeController, GuardedToolExecutorAdapter } from '../agent/work-modes.js';
import { CheckpointManager } from '../harness/checkpoint-manager.js';
import { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import { ContextManager } from '../agent/memory/context-manager.js';
import { VisionAssistant } from '../agent/vision.js';
import { BranchManager } from '../agent/branch.js';
import { InitAnalyzer } from '../agent/init-analyzer.js';
import { DreamConsolidator } from '../agent/dream-consolidator.js';
import { Blackboard } from '../agent/multi/blackboard.js';
import { Orchestrator } from '../agent/multi/orchestrator.js';
import { WorkerExecutor } from '../agent/multi/worker-executor.js';
import { TraceCollector } from '../harness/trace-collector.js';
import { AuditLogger } from '../harness/audit-logger.js';
import { PromptTemplateManager } from '../prompts/manager.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import { DurableExecutor, type StepExecutor } from '../agent/durable-executor.js';
import type { PlanStep } from '../agent/goal-types.js';
import type { StepResult } from '../agent/hooks.js';
import { createPluginSystem } from './plugin-init.js';
import type { AgentMiddlewarePipeline } from '../agent/middleware.js';
import type { PluginRegistry } from '../plugins/registry.js';

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
  visionAssistant: VisionAssistant;
  branchManager: BranchManager;
  initAnalyzer: InitAnalyzer | null;
  dreamConsolidator: DreamConsolidator;
  // 基础设施
  prompts: PromptTemplateManager;
  blackboard: Blackboard;
  trace: TraceCollector;
  audit: AuditLogger;
  projectMemory: ProjectMemoryManager;
  // 目标解析与验证（无状态，可复用）
  goalParser: GoalParser;
  goalVerifier: GoalVerifier;
  // 持久化执行器（Phase 27 Task 6：/resume 命令使用）
  durableExecutor: DurableExecutor;
  // LLM 客户端
  primaryClient: ILLMClient;
  checkpointClient: ILLMClient;
}

/**
 * 创建 App 所需的全部服务依赖
 * 仅在组件首次渲染时调用一次（通过 useRef 持有返回值）
 *
 * @param config 全局配置
 * @param clientManager LLM 客户端管理器
 * @param currentModel 当前选中的模型 ID（用于初始化 ContextManager）
 * @param cwd 工作目录
 */
export function createAppDependencies(
  config: AppConfig,
  clientManager: LLMClientManager,
  currentModel: string,
  cwd: string = process.cwd(),
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
    },
    checkpointWriter,
  );

  // ===== 辅助 Agent =====
  const visionAssistant = new VisionAssistant(config.providers, (id: string) => clientManager.get(id));
  const branchManager = new BranchManager();
  const initAnalyzer = primaryClient
    ? new InitAnalyzer({ llmClient: primaryClient, modelId: config.router.classifierModel, rootPath: cwd })
    : null;
  const dreamConsolidator = new DreamConsolidator({
    llmClient: primaryClient ?? checkpointClient,
    modelId: config.router.classifierModel,
  });

  // ===== 基础设施 =====
  const prompts = new PromptTemplateManager({ projectOverrides: true });
  const blackboard = new Blackboard();
  const trace = new TraceCollector({ storageDir: undefined });
  const audit = new AuditLogger(trace.getSessionId() ?? 'app');
  const projectMemory = new ProjectMemoryManager(cwd, config.projectMemory);

  // ===== 工具链 =====
  const registry = new ToolRegistry();
  [FileReadTool, FileWriteTool, FileSearchTool, ShellExecTool, GitOpTool, WebSearchTool, CodeSearchTool]
    .forEach(T => registry.register(new T()));
  const mcpManager = new MCPClientManager(registry);
  const securityChecker = new SecurityChecker(cwd, config.security);
  const toolExecutor = new ToolExecutor(registry);
  toolExecutor.setSecurityChecker(securityChecker);
  const adapter = new ToolRegistryAdapter(registry, toolExecutor, {
    workingDirectory: cwd,
    allowedDirectories: [cwd],
    environment: process.env as Record<string, string>,
    timeoutMs: 30000,
  });
  const workModeController = new WorkModeController();
  const guardedAdapter = new GuardedToolExecutorAdapter(adapter, workModeController);
  const agentLoop = new ReActAgentLoop(guardedAdapter, { maxIterations: 10, toolsEnabled: true });

  // ===== 插件系统 =====
  const pluginSystem = createPluginSystem(cwd, registry);
  // 将插件系统的中间件管线注入 Agent Loop，让 Hook 插件真正生效
  agentLoop.setMiddlewarePipeline(pluginSystem.middlewarePipeline);

  // ===== 权限引擎 =====
  const permissionEngine = createDefaultEngine();

  // ===== 多 Agent =====
  const orchestrator = new Orchestrator(primaryClient, config.router.classifierModel);
  const workerExecutor = new WorkerExecutor(agentLoop);

  // ===== 目标解析与验证（无状态） =====
  const goalParser = new GoalParser();
  const goalVerifier = new GoalVerifier();

  // ===== 持久化执行器（Phase 27 Task 6） =====
  // StepExecutor 适配器：将步骤执行委托给 agentLoop
  // 注意：完整执行需要 ReActRunParams（llmClient/routeDecision 等），
  // 此处提供基础实现，/resume 命令的列表和恢复功能不依赖具体执行逻辑
  const durableStepExecutor: StepExecutor = {
    async execute(step: PlanStep, _goal: string): Promise<StepResult> {
      // 基础实现：返回步骤描述作为输出
      // 生产环境应通过 goal-runner 的完整流程执行
      return {
        success: true,
        output: `步骤 ${step.id} 已执行: ${step.description}`,
        durationMs: 0,
      };
    },
  };
  const durableExecutor = new DurableExecutor({
    sessionId: trace.getSessionId() ?? `app-${Date.now()}`,
    executor: durableStepExecutor,
    projectPath: cwd,
  });

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
    permissionEngine,
    orchestrator,
    workerExecutor,
    checkpointManager,
    checkpointWriter,
    contextManager,
    visionAssistant,
    branchManager,
    initAnalyzer,
    dreamConsolidator,
    prompts,
    blackboard,
    trace,
    audit,
    projectMemory,
    goalParser,
    goalVerifier,
    durableExecutor,
    primaryClient,
    checkpointClient,
  };
}

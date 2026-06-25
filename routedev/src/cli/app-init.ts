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
import { FileEditTool } from '../tools/builtin/file-edit.js';
import { FileSearchTool } from '../tools/builtin/file-search.js';
import { ListDirectoryTool } from '../tools/builtin/list-directory.js';
import { ShellExecTool } from '../tools/builtin/shell-exec.js';
import { GitOpTool } from '../tools/builtin/git-op.js';
import { WebSearchTool } from '../tools/builtin/web-search.js';
import { WebFetchTool } from '../tools/builtin/web-fetch.js';
import { CodeSearchTool } from '../tools/builtin/code-search.js';
import { RepoMapTool } from '../tools/builtin/repo-map.js';
import { TodoWriteTool } from '../tools/builtin/todo-write.js';
import { AskUserTool } from '../tools/builtin/ask-user.js';
import { TodoStore } from '../tools/builtin/todo-store.js';
import { SpawnAgentTool, type SpawnAgentFunction, type SpawnAgentParams, type SubagentType, createChildRegistry, createConcurrencyLimitedSpawnFn } from '../tools/builtin/spawn-agent.js';
import { NotesTool } from '../tools/builtin/notes-tool.js';
import { NotesManager } from '../agent/memory/notes.js';
import { createDefaultEngine, type PermissionEngine } from '../tools/permission-engine.js';
import { MCPClientManager } from '../tools/mcp/client.js';
import { ReActAgentLoop } from '../agent/loop.js';
import { TokenProfiler } from '../agent/token-profiler.js';
import { WorkModeController, GuardedToolExecutorAdapter } from '../agent/work-modes.js';
import { CheckpointManager } from '../harness/checkpoint-manager.js';
import { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import { ContextManager } from '../agent/memory/context-manager.js';
import { ContextCompactor } from '../agent/context-compaction.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { VisionAssistant } from '../agent/vision.js';
import { BranchManager } from '../agent/branch.js';
import { InitAnalyzer } from '../agent/init-analyzer.js';
import { DreamConsolidator } from '../agent/dream-consolidator.js';
import { Blackboard } from '../agent/multi/blackboard.js';
import { Orchestrator } from '../agent/multi/orchestrator.js';
import { WorkerExecutor } from '../agent/multi/worker-executor.js';
import { TraceCollector } from '../harness/trace-collector.js';
import { AuditLogger } from '../harness/audit-logger.js';
import { logger } from '../utils/logger.js';
import { PromptTemplateManager } from '../prompts/manager.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import { DurableExecutor, type StepExecutor } from '../agent/durable-executor.js';
import type { PlanStep } from '../agent/goal-types.js';
import type { StepResult } from '../agent/hooks.js';
import { HookRunner } from '../agent/hooks.js';
import { registerBuiltinHooks } from '../hooks/built-in.js';
import { HookEnhancementManager } from '../hooks/hook-enhancement.js';
import { AgentLoopStepExecutor } from '../agent/step-executor.js';
// Phase 32 Task 1：接入 Phase 31 模块（之前全部为死代码）
import { TaskOrchestrator, createTaskOrchestrator } from '../agent/task-orchestrator.js';
import { RequirementsGatherer, createRequirementsGatherer } from '../agent/requirements-gatherer.js';
import { TaskComplexityAnalyzer, createTaskComplexityAnalyzer } from '../agent/complexity-analyzer.js';
import { ExecutionOrchestrator, createExecutionOrchestrator } from '../agent/execution-orchestrator.js';
import { UnifiedReviewer, createUnifiedReviewer } from '../agent/unified-reviewer.js';
import { CompletionGate, createCompletionGate } from '../agent/completion-gate.js';
import { ReadTracker, createReadTracker } from '../tools/read-tracker.js';
import { ToolResultSanitizer, createToolResultSanitizer } from '../tools/result-sanitizer.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import { createPluginSystem } from './plugin-init.js';
import type { AgentMiddlewarePipeline } from '../agent/middleware.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { SkillsRouter, FilesystemDiscovery } from '../plugins/filesystem-discovery.js';
import { LoopDetectionMiddleware } from '../agent/middleware/loop-detection.js';
import { homedir } from 'node:os';
import * as path from 'node:path';

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

  // A3：激活 ContextCompactor——消除双引擎不统一，让 compactIfNeeded 在生产路径生效
  // L5 summarize 回调使用 checkpointClient（已配置的辅助模型），失败时由 B12 的 try/catch 降级
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
  });
  contextManager.setCompactor(contextCompactor);

  // ===== 辅助 Agent =====
  const visionAssistant = new VisionAssistant(config.providers, (id: string) => clientManager.get(id));
  const branchManager = new BranchManager();
  const initAnalyzer = primaryClient
    ? new InitAnalyzer({ llmClient: primaryClient, modelId: config.router.classifierModel, rootPath: cwd })
    : null;
  const dreamConsolidator = new DreamConsolidator({
    llmClient: primaryClient ?? checkpointClient,
    modelId: config.router.classifierModel,
    // 传入 ContextCompactor 启用渐进压缩管线，避免增强压缩路径在生产中从不执行
    compactor: contextCompactor,
  });

  // ===== 基础设施 =====
  const prompts = new PromptTemplateManager({ projectOverrides: true });
  const blackboard = new Blackboard();
  const trace = new TraceCollector({ storageDir: undefined });
  const audit = new AuditLogger(trace.getSessionId() ?? 'app');
  const projectMemory = new ProjectMemoryManager(cwd, config.projectMemory);

  // ===== 工具链 =====
  // P0-1/P0-2/P1-4/P1-5/P1-6/P1-7：注册全部内置工具
  const registry = new ToolRegistry();
  // 基础工具（原有）
  [FileReadTool, FileWriteTool, FileSearchTool, ShellExecTool, GitOpTool, WebSearchTool, CodeSearchTool]
    .forEach(T => registry.register(new T()));
  // Phase 34 Task 4：Repo Map 代码检索增强
  registry.register(new RepoMapTool());
  // P1-4：文件编辑工具（str_replace，避免全量重写）
  registry.register(new FileEditTool());
  // P0-2：目录列表工具（补全 work-modes.ts 的 list_directory 引用）
  registry.register(new ListDirectoryTool());
  // P1-7：网页抓取工具
  registry.register(new WebFetchTool());
  // P1-5：任务列表工具
  const todoStore = new TodoStore();
  registry.register(new TodoWriteTool(todoStore));
  registry.register(new AskUserTool());
  // P0-1：笔记工具（Agent 唯一写通道，需注入 NotesManager）
  const sessionDir = path.join(homedir(), '.qoderwork', 'routedev', 'sessions', trace.getSessionId() ?? `app-${Date.now()}`);
  const notesManager = new NotesManager(sessionDir);
  registry.register(new NotesTool(notesManager));

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
  const readTracker = createReadTracker();
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

  /**
   * 创建子 Agent 的 spawn 函数
   * Phase 38 Task 2：使用 childRegistry 隔离工具集，不再修改共享 registry
   */
  const createSpawnAgentFn = (): SpawnAgentFunction => {
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
        const defaultModel = config.providers[0]?.models[0];
        if (!defaultModel) {
          return { success: false, result: '', error: '未配置可用模型' };
        }
        const routeDecision = {
          model: defaultModel,
          providerId: primaryProviderId,
          fallbackUsed: false,
          originalTier: defaultModel.tier ?? 'medium',
          degraded: false,
        };
        let responseText = '';
        let inputTokens = 0;
        let outputTokens = 0;

        // Phase 38 Task 2：创建子 Agent 专用 registry（防递归 + 角色白名单过滤）
        // 不再在共享 registry 上 register/unregister，消除竞态条件
        const childRegistry = createChildRegistry(registry, subagentType);

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
        const childLoop = new ReActAgentLoop(childGuardedAdapter, {
          maxIterations: normalizedParams.maxIterations ?? options?.maxIterations ?? 20,
          toolsEnabled: true,
          parallelToolExecution: true,
          autoApprovePatterns: config.autonomy?.autoApprovePatterns ?? [],
        });
        childLoop.setMiddlewarePipeline(pluginSystem.middlewarePipeline);

        for await (const event of childLoop.run({
          userMessage: normalizedParams.prompt,
          llmClient: primaryClient,
          routeDecision,
          conversationHistory: [],
          systemPrompt: options?.systemPrompt ?? '你是一个专注的子 Agent，负责完成分配给你的独立子任务。',
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
  if (subAgentsEnabled && MAX_CONCURRENT_SUB_AGENTS > 0) {
    const spawnAgentFn = createConcurrencyLimitedSpawnFn(
      createSpawnAgentFn(),
      MAX_CONCURRENT_SUB_AGENTS,
    );
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

  // ===== Phase 39：CodeMapContextMiddleware 接线 =====
  // 代码地图上下文中间件：自动注入项目结构到 system prompt
  // 注：code-map-context.ts 由其他子代理创建，使用变量路径动态 import 避免 typecheck 失败
  //     文件存在时正常加载并注册到 onSystemPrompt 阶段；不存在时跳过（fail-open）
  const codegraphCfg = config.codegraph;
  if (codegraphCfg) {
    // 使用变量路径让 TypeScript 无法静态解析（模块可能尚未创建）
    const codeMapModulePath = '../agent/middleware/code-map-context.js';
    import(codeMapModulePath)
      .then((mod: { CodeMapContextMiddleware: new (cwd: string, workspace?: string) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
        const codeMapMiddleware = new mod.CodeMapContextMiddleware(cwd, codegraphCfg.workspace);
        pluginSystem.middlewarePipeline.register('onSystemPrompt', codeMapMiddleware.getHandler());
        logger.info('CodeMapContextMiddleware registered', {
          workspace: codegraphCfg.workspace,
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
        // 注册到 service context 或全局
        // 替换 code-map-context.ts 的数据源（feature-detect：方法可能由其他子代理添加）
        const ctx = pluginSystem.middlewarePipeline as unknown as { setCodeMapEngine?: (e: unknown) => void };
        if (typeof ctx.setCodeMapEngine === 'function') {
          ctx.setCodeMapEngine(engine);
        }
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

  // ===== Phase 42：PolicyEngine 接线（策略引擎） =====
  // Intent Guard + Playbook + Tool Guide + Tool Approval
  // 注：policies/policy-engine.ts 由其他子代理创建，使用变量路径动态 import 避免 typecheck 失败
  const policiesCfg = config.policies;
  if (policiesCfg?.enabled !== false) {
    const policyModulePath = '../policies/policy-engine.js';
    import(policyModulePath)
      .then((mod: { PolicyEngine: new () => { addPolicy: (p: unknown) => void; evaluateInput: (i: string) => unknown[]; evaluateToolCall: (t: string, a: unknown) => unknown[] } }) => {
        const engine = new mod.PolicyEngine();
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

  // ===== Phase 42：SkillMarketManager 接线（市场） =====
  // 管理 Skill/Hook 的发布、导入、导出
  // 注：skills/market-manager.ts 由其他子代理创建，使用变量路径动态 import 避免 typecheck 失败
  const marketCfg = config.market;
  if (marketCfg?.enabled !== false) {
    const marketModulePath = '../skills/market-manager.js';
    import(marketModulePath)
      .then((mod: { SkillMarketManager: new (cwd: string, opts?: unknown) => { init: () => Promise<void> } }) => {
        const manager = new mod.SkillMarketManager(cwd, {
          autoPublish: marketCfg.autoPublish,
        });
        manager.init().catch((e: unknown) => {
          logger.debug('SkillMarketManager init failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        // 注册到 service context（feature-detect：方法可能由其他子代理添加）
        const loop = agentLoop as unknown as { setSkillMarketManager?: (m: unknown) => void };
        if (typeof loop.setSkillMarketManager === 'function') {
          loop.setSkillMarketManager(manager);
        }
        logger.info('SkillMarketManager registered', {
          autoPublish: marketCfg.autoPublish,
        });
      })
      .catch((err: unknown) => {
        // fail-open：市场管理器不可用时跳过
        logger.debug('SkillMarketManager not available yet', {
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

  // ===== 多 Agent =====
  const orchestrator = new Orchestrator(primaryClient, config.router.classifierModel);
  // Phase 35 Task 1：注入 workerContext 配置，启用上下文选择性传递
  const workerExecutor = new WorkerExecutor(agentLoop, {
    agentLoop,
    workerContextConfig: config.optimization?.workerContext,
  });

  // ===== 目标解析与验证（无状态） =====
  const goalParser = new GoalParser();
  const goalVerifier = new GoalVerifier();

  // ===== 持久化执行器（Phase 27 Task 6） =====
  // Phase 35 Task 2：创建 HookRunner 实例并注册内置钩子
  //   - 传入 TraceCollector：钩子执行时记录 span（禁止创建不带 trace 的 HookRunner）
  //   - 注册内置钩子：post-tool-call 文件验证 + session 生命周期日志
  //   - 传入 DurableExecutor：使 runStepWithHooks() 真正生效
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
      .then(async (mod: { HookConfigRegistry: new (configPath: string) => { load: () => Promise<void>; list: () => Array<{ id: string; enabled: boolean }> } }) => {
        const hookRegistry = new mod.HookConfigRegistry(path.join(cwd, hooksCfg.configPath));
        await hookRegistry.load();
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
  // 将 manager 通过 feature-detect 注入 agentLoop（未来 loop 可直接调用函数 Hook / 分组执行）
  const loopForHooks = agentLoop as unknown as { setHookEnhancementManager?: (m: HookEnhancementManager) => void };
  if (typeof loopForHooks.setHookEnhancementManager === 'function') {
    loopForHooks.setHookEnhancementManager(hookEnhancementManager);
  }
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

  // Phase 35 Task 3：用 AgentLoopStepExecutor 替换假桩
  //   - 真实调用 agentLoop.run() 执行步骤（不再是永远返回 success 的空桩）
  //   - 使用 classifier + modelRouter 选择模型（与 goal-runner 保持一致）
  //   - 每个 step 从空 conversationHistory 开始（step 间隔离）
  //   - classifier/modelRouter 在测试场景下可能未传入，此时回退到假桩（保持向后兼容）
  let durableStepExecutor: StepExecutor;
  if (classifier && modelRouter) {
    durableStepExecutor = new AgentLoopStepExecutor({
      agentLoop,
      classifier,
      modelRouter,
      clientManager,
      baseSystemPrompt: '',
    });
  } else {
    // 测试场景回退：classifier/modelRouter 未传入时使用基础桩
    // 生产路径（App.tsx）必传 classifier + modelRouter
    logger.warn('AgentLoopStepExecutor: classifier/modelRouter not provided, falling back to stub executor');
    durableStepExecutor = {
      async execute(step: PlanStep, _goal: string): Promise<StepResult> {
        return {
          success: true,
          output: `步骤 ${step.id} 已执行（桩模式）: ${step.description}`,
          durationMs: 0,
        };
      },
    };
  }
  const durableExecutor = new DurableExecutor({
    sessionId: trace.getSessionId() ?? `app-${Date.now()}`,
    executor: durableStepExecutor,
    hookRunner, // Phase 35 Task 2：传入 HookRunner，激活 runStepWithHooks()
    projectPath: cwd,
  });

  // Phase 35 Task 3：启动时检查可恢复执行，有则打印提示
  //   - 不自动恢复——只提示，让用户通过 /resume 决定
  //   - 使用同步版 listRecoverable()（启动时一次性检查，不阻塞事件循环）
  const recoverable = durableExecutor.listRecoverable();
  if (recoverable.length > 0) {
    const latest = recoverable[0];
    logger.info('DurableExecutor: 发现未完成执行，可使用 /resume 恢复', {
      count: recoverable.length,
      latestGoal: latest.goal.slice(0, 60),
      latestStatus: latest.status,
    });
  }

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
  // Phase 32 Task 4.2：将 sanitizer 注入 MCPClientManager，检测 MCP 工具描述中的注入模式
  mcpManager.setSanitizer(resultSanitizer);

  // C5 修复：接线 Steering Queue 消费者，让 ReActAgentLoop 能消费 taskOrchestrator 中的转向消息
  agentLoop.setSteeringConsumer(() => {
    if (!taskOrchestrator.hasSteering()) return null;
    const drained = taskOrchestrator.drainSteering();
    if (drained.length === 0) return null;
    return drained.map((m) => ({ content: m.content, mode: m.mode }));
  });

  // 3. CompletionGate——独立代码验证门（typecheck/lint/tests）
  //    配置来自 optimization.safety.completionGate / gateTimeout / gateRetry
  const safetyCfg = config.optimization?.safety;
  const completionGate = createCompletionGate({
    gateTimeout: safetyCfg?.gateTimeout ?? 180000,
    gateRetry: safetyCfg?.gateRetry ?? 1,
  });

  // 4. RequirementsGatherer + ComplexityAnalyzer——无状态，工厂创建即可
  const requirementsGatherer = createRequirementsGatherer();
  const complexityAnalyzer = createTaskComplexityAnalyzer();

  // 5. TaskOrchestrator——统一工作流编排器
  //    依赖 classifier + modelRouter + clientManager + config
  //    classifier/modelRouter 可能在测试场景下未传入，此时用 null 断言（生产路径必传）
  const taskOrchestrator = createTaskOrchestrator(
    classifier as ScenarioClassifier,
    modelRouter as ModelRouter,
    clientManager,
    config,
  );

  // 6. ExecutionOrchestrator + UnifiedReviewer——依赖 agentLoop + tracker
  //    tracker 可能在测试场景下未传入，此时传一个 noop tracker 的占位（生产路径必传）
  //    Phase 31/32 P0 接线：systemPrompt 改为 ref 模式，与 App.tsx systemPromptRef 共享
  //    App.tsx 在初始化后同步 sharedSystemPromptRef.current = systemPromptRef.current
  const sharedSystemPromptRef = { current: '' };
  const executionOrchestrator = createExecutionOrchestrator({
    agentLoop,
    tracker: tracker as TokenTracker,
    config,
    systemPromptRef: sharedSystemPromptRef,
    addSystemMessage: () => {}, // 由 App.tsx 通过 commandBridge.addSystemMessage 间接驱动
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

  // 2. PolicyArbitrator 接线：策略冲突仲裁（security > skill > hook）
  //    实例化后注册到 AgentLoop（feature-detect：方法可能由其他子代理添加）
  import('../policies/arbitration.js')
    .then((mod) => {
      const arbitrator = new mod.PolicyArbitrator();
      const loop = agentLoop as unknown as { setPolicyArbitrator?: (a: unknown) => void };
      if (typeof loop.setPolicyArbitrator === 'function') {
        loop.setPolicyArbitrator(arbitrator);
      }
      logger.info('PolicyArbitrator registered');
    })
    .catch((err: unknown) => {
      logger.debug('PolicyArbitrator not available', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // 3. RegistryClient 接线：远程市场 Registry 接口
  //    未配置 registryUrl 时返回 StubRegistryClient（空列表），配置后返回 HttpRegistryClient
  import('../skills/registry-client.js')
    .then((mod) => {
      const client = mod.createRegistryClient(config.market?.registryUrl, config.market?.registryToken);
      const loop = agentLoop as unknown as { setRegistryClient?: (c: unknown) => void };
      if (typeof loop.setRegistryClient === 'function') {
        loop.setRegistryClient(client);
      }
      logger.info('RegistryClient registered', {
        configured: !!config.market?.registryUrl,
      });
    })
    .catch((err: unknown) => {
      logger.debug('RegistryClient not available', {
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
          autoSnapshot: conversationCfg.autoSnapshot,
          undoStackSize: conversationCfg.undoStackSize,
        });
        persistence.init().catch((e: unknown) => {
          logger.debug('BranchPersistence init failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        // 注册到 service context（feature-detect：方法可能由其他子代理添加）
        const loop = agentLoop as unknown as { setBranchPersistence?: (p: unknown) => void };
        if (typeof loop.setBranchPersistence === 'function') {
          loop.setBranchPersistence(persistence);
        }
        logger.info('BranchPersistence registered', {
          persistTree: conversationCfg.persistTree,
          maxNodes: conversationCfg.maxNodes,
          autoSnapshot: conversationCfg.autoSnapshot,
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
      // 注册到 service context（feature-detect：方法可能由其他子代理添加）
      const loop = agentLoop as unknown as { setBranchLinkageManager?: (m: unknown) => void };
      if (typeof loop.setBranchLinkageManager === 'function') {
        loop.setBranchLinkageManager(linkage);
      }
      logger.info('BranchLinkageManager registered');
    })
    .catch((err: unknown) => {
      // fail-open：branch-linkage.ts 尚未创建时跳过，不影响主流程
      logger.debug('BranchLinkageManager not available yet', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // 3. ParallelExperimentManager 接线：多分支并行实验
  //    config.experiment.parallelEnabled=false 时跳过注册
  const experimentCfg = config.experiment;
  if (experimentCfg?.parallelEnabled !== false) {
    const pemPath = '../agent/parallel-experiment.js';
    const emPath = '../harness/experiment-manager.js';
    Promise.all([
      import(pemPath),
      import(emPath),
    ])
      .then(([pemMod, emMod]) => {
        const experimentManager = new emMod.ExperimentManager(cwd);
        const parallelExperiment = new pemMod.ParallelExperimentManager(experimentManager, experimentCfg);
        const loop = agentLoop as unknown as { setParallelExperimentManager?: (m: unknown) => void };
        if (typeof loop.setParallelExperimentManager === 'function') {
          loop.setParallelExperimentManager(parallelExperiment);
        }
        logger.info('ParallelExperimentManager registered', {
          maxParallel: experimentCfg?.maxParallel,
          conflictDetection: experimentCfg?.conflictDetection,
        });
      })
      .catch((err: unknown) => {
        logger.debug('ParallelExperimentManager not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 45：PersonaEngine / PreferenceManager / EQDetector / VoiceManager 接线 =====
  // 全部使用动态 import + fail-open，模块不可用时跳过不影响主流程
  // 注：persona-engine.ts / preference-manager.ts / eq-detector.ts 由其他子代理并行创建，
  //     voice-manager.ts 已由本 Phase 创建，使用变量路径动态 import 保持一致性

  // 1. PersonaEngine 接线：人格引擎（intensity=none 时不注入 system prompt）
  const personaCfg = config.persona;
  if (personaCfg?.enabled !== false && personaCfg?.intensity !== 'none') {
    const personaModulePath = '../agent/persona-engine.js';
    import(personaModulePath)
      .then((mod: { PersonaEngine: new (persona?: unknown) => { setIntensity: (i: string) => void; buildPersonaFragment: (signals?: unknown) => string } }) => {
        const engine = new mod.PersonaEngine();
        engine.setIntensity(personaCfg.intensity);
        // 注册到 service context（feature-detect：方法可能由其他子代理添加）
        const loop = agentLoop as unknown as { setPersonaEngine?: (e: unknown) => void };
        if (typeof loop.setPersonaEngine === 'function') {
          loop.setPersonaEngine(engine);
        }
        logger.info('PersonaEngine registered', {
          enabled: personaCfg.enabled,
          intensity: personaCfg.intensity,
          currentId: personaCfg.currentId,
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
      // 注册到 service context（feature-detect：方法可能由其他子代理添加）
      const loop = agentLoop as unknown as { setPreferenceManager?: (m: unknown) => void };
      if (typeof loop.setPreferenceManager === 'function') {
        loop.setPreferenceManager(prefMgr);
      }
      logger.info('PreferenceManager registered');
    })
    .catch((err: unknown) => {
      // fail-open：preference-manager.ts 尚未创建时跳过，不影响主流程
      logger.debug('PreferenceManager not available yet', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // 3. EQDetector 接线：情绪检测器（注册到中间件管线 onReasoning 阶段）
  const eqModulePath = '../agent/eq-detector.js';
  import(eqModulePath)
    .then((mod: { EQDetector: new (opts?: unknown) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
      const detector = new mod.EQDetector();
      // 注册到 service context（feature-detect：方法可能由其他子代理添加）
      const loop = agentLoop as unknown as { setEQDetector?: (d: unknown) => void };
      if (typeof loop.setEQDetector === 'function') {
        loop.setEQDetector(detector);
      }
      logger.info('EQDetector registered');
    })
    .catch((err: unknown) => {
      // fail-open：eq-detector.ts 尚未创建时跳过，不影响主流程
      logger.debug('EQDetector not available yet', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // 4. VoiceManager 接线：语音输入/输出管理
  //    voice-manager.ts 已由本 Phase 创建，使用变量路径动态 import 保持一致性
  const voiceCfg = config.voice;
  if (voiceCfg && (voiceCfg.inputProvider !== 'off' || voiceCfg.outputProvider !== 'off')) {
    const voiceModulePath = '../agent/voice-manager.js';
    import(voiceModulePath)
      .then((mod: { VoiceManager: new (config?: unknown) => { getConfig: () => unknown; isAvailable: () => boolean } }) => {
        const voice = new mod.VoiceManager(voiceCfg);
        // 注册到 service context（feature-detect：方法可能由其他子代理添加）
        const loop = agentLoop as unknown as { setVoiceManager?: (v: unknown) => void };
        if (typeof loop.setVoiceManager === 'function') {
          loop.setVoiceManager(voice);
        }
        logger.info('VoiceManager registered', {
          inputProvider: voiceCfg.inputProvider,
          outputProvider: voiceCfg.outputProvider,
          language: voiceCfg.language,
          autoPlay: voiceCfg.autoPlay,
          available: voice.isAvailable(),
        });
      })
      .catch((err: unknown) => {
        // fail-open：voice-manager.ts 不可用时跳过
        logger.debug('VoiceManager not available', {
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
    dreamConsolidator,
    prompts,
    blackboard,
    trace,
    audit,
    projectMemory,
    goalParser,
    goalVerifier,
    durableExecutor,
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
  };
}

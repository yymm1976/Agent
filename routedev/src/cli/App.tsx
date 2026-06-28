// src/cli/App.tsx
// 主应用组件：整合 ChatView + StatusBar + InputBox，管理消息状态
// Phase 17b：命令全部迁移到 CommandRegistry，目标执行提取到 goal-runner.ts，聊天执行提取到 chat-runner.ts
// Phase 0c Task 3：装配逻辑收敛到 createAppDependencies + createServiceContext，App.tsx 只负责 React 状态和 UI

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ChatView, type ChatMessage } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import { StepEditor } from './components/StepEditor.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
// Phase 50 Task 7：接入 7 个 React 组件
import { BranchSwitcher } from './components/BranchSwitcher.js';
import { ResumePicker } from './components/ResumePicker.js';
import { ProgressBar } from './components/ProgressBar.js';
import { TracePanel, type TraceTimelineEntry } from './components/TracePanel.js';
import { DiffView } from './components/DiffView.js';
import { ConfigReloadNotice, generateReloadNotices, type ConfigChange } from './components/ConfigReloadUI.js';
import type { ScenarioTier, LLMMessage } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { AppConfig, AutonomyMode } from '../config/schema.js';
import { getSystemPrompt } from '../agent/prompts.js';
import type { GoalPlan, PlanStep } from '../agent/goal-types.js';
import type { WorkMode } from '../agent/work-modes.js';
import type { ExecutionSnapshot } from '../agent/durable-executor.js';
import { logger } from '../utils/logger.js';
import { CommandRegistry } from './command-registry.js';
import { loadCustomCommands } from './custom-commands.js';
import * as path from 'node:path';
import { createGoalRunner } from './goal-runner.js';
import { createChatRunner } from './chat-runner.js';
import { renderSplash, getVersion } from './splash.js';
import { ConfigWatcher } from '../config/watcher.js';
import { loadConfig } from '../config/loader.js';
import { getGlobalConfigPath, getProjectConfigPath } from '../utils/paths.js';
import { handleConfigReload } from './components/ConfigReloadUI.js';
import {
  autoCommand, semiCommand, manualCommand, pauseCommand, checkpointCommand, rollbackCommand, goalCommand,
  branchCommand, initCommand, dreamCommand, quitCommand, clearCommand, helpCommand, statusCommand, traceCommand,
  promptCommand, channelsCommand, costCommand, historyCommand, pluginCommand, diffCommand,
  buildCommand, planCommand, composeCommand, resumeCommand, tokenCommand,
  // Phase 31 Task 7.3：注册已定义但未注册的命令
  memoryCommand, permissionsCommand, configCommand,
  // Phase 34：输出样式切换命令
  outputStyleCommand,
  // Phase 36 Task 3：技术债管理命令
  techDebtCommand,
  // /swarm 群组多 Agent 协作 + /btw 临时问答
  swarmCommand, btwCommand,
  // Phase 47 Task 5：/review 独立子代理对抗性审查
  reviewCommand,
  // Phase 46 Task 5：注册已定义但未注册的命令
  clarifyCommand, experimentCommand, qualityCommand, scheduleCommand, trustCommand,
} from './commands/index.js';
import { initPluginSystem, registerPermissionMiddleware } from './plugin-init.js';
import { createAppDependencies } from './app-init.js';
import { createServiceContext, type ServiceContext, type CommandBridge } from './service-context.js';
// Phase 32 Task 2.4：接入 CacheStatsTracker（缓存命中统计）
import { CacheStatsTracker } from '../router/cache-optimizer.js';
// Phase 31/32 P0 接线：development 完整流水线所需依赖
import { GoalParser } from '../agent/goal-parser.js';
import type { ClassificationResult, RoutingResult, ILLMClient } from '../router/types.js';
import type { RequirementsSummary, ClarifyingQuestion } from '../agent/task-orchestrator-types.js';

interface AppProps {
  config: AppConfig;
  clientManager: LLMClientManager;
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  tracker: TokenTracker;
}

/**
 * Phase 31/32 P0 接线：development 流水线上下文
 * 在需求确认→计划生成→复杂度分析→执行编排→统一审查各阶段间传递状态
 */
interface DevelopmentContext {
  userInput: string;
  classification: ClassificationResult;
  routeDecision: RoutingResult;
  llmClient: ILLMClient;
  /** 需求摘要（阶段2产出，阶段3注入 GoalParser） */
  requirements?: RequirementsSummary;
  /** 用户对澄清问题的回答（第二轮 gather 时传入） */
  collectedAnswers?: ClarifyingQuestion[];
}

let messageIdCounter = 0;
function nextId(): string { return `msg-${++messageIdCounter}`; }

export function App({ config, clientManager, classifier, modelRouter, tracker }: AppProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: nextId(), role: 'system', content: 'RouteDev 已就绪。输入消息开始对话，输入 /help 查看命令列表。' },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>(config.autonomy.defaultMode);
  const [workMode, setWorkMode] = useState<WorkMode>('build');
  const [editingPlan, setEditingPlan] = useState<GoalPlan | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ prompt: string; resolve: (approved: boolean) => void } | null>(null);
  const [currentModel, setCurrentModel] = useState('gpt-4o-mini');
  const [currentTier, setCurrentTier] = useState<ScenarioTier>('simple');
  const [isDegraded, setIsDegraded] = useState(false);
  const [todayTokensUsed, setTodayTokensUsed] = useState(0);
  const [mcpStatus, setMcpStatus] = useState('disconnected');
  const [idleHintShown, setIdleHintShown] = useState(false);
  // Phase 34：outputStyle 提升到 UI 状态，支持运行时切换
  const [outputStyle, setOutputStyleState] = useState(config.ui.outputStyle);
  // Phase 50 Task 7：7 个 React 组件接入状态
  // - activePanel: 当前激活的命令面板（/resume | /trace | /diff 触发）
  // - goalProgress: goal 执行进度（ProgressBar 组件用）
  // - configReloadChanges: 配置变更通知（ConfigReloadNotice 组件用）
  // - showBranchSwitcher: 是否显示分支切换器
  const [activePanel, setActivePanel] = useState<
    | { type: 'resume'; snapshots: ExecutionSnapshot[] }
    | { type: 'trace'; entries: TraceTimelineEntry[]; sessionId?: string }
    | { type: 'diff'; diff: string; fileName?: string }
    | null
  >(null);
  const [goalProgress, setGoalProgress] = useState<{ current: number; total: number } | null>(null);
  const [configReloadChanges, setConfigReloadChanges] = useState<{ changes: ConfigChange[]; timestamp: Date } | null>(null);
  const [showBranchSwitcher, setShowBranchSwitcher] = useState(false);

  // ===== refs：UI 状态 =====
  const conversationHistoryRef = useRef<LLMMessage[]>([]);
  const pendingConfirmRef = useRef<{ resolve: (approved: boolean | { approved: boolean; payload?: unknown }) => void; toolName: string } | null>(null);
  const awaitingGoalConfirmRef = useRef<{ resolve: (approved: boolean) => void; plan: GoalPlan } | null>(null);
  const currentPlanRef = useRef<GoalPlan | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingPlanEditRef = useRef<{ resolve: (s: PlanStep[] | null) => void } | null>(null);
  const configRef = useRef(config);
  const lastInputTimeRef = useRef(Date.now());

  // Phase 31/32 P0 接线：development 流水线多轮交互状态
  // - developmentContextRef：存储当前 development 任务的上下文（在需求确认→计划→执行→审查各阶段间传递）
  // - awaitingRequirementsAnswerRef：等待用户回答澄清问题
  // - awaitingRequirementsConfirmRef：等待用户确认需求摘要
  const developmentContextRef = useRef<DevelopmentContext | null>(null);
  const awaitingRequirementsAnswerRef = useRef<{ questions: ClarifyingQuestion[] } | null>(null);
  const awaitingRequirementsConfirmRef = useRef<{ summary: RequirementsSummary } | null>(null);

  // ===== refs：服务依赖（Phase 0c：通过 createAppDependencies 一次性创建） =====
  // Phase 32 Task 1：传入 classifier/modelRouter/tracker 以实例化 Phase 31 模块
  const depsRef = useRef(createAppDependencies(config, clientManager, currentModel, process.cwd(), classifier, modelRouter, tracker));
  const deps = depsRef.current;

  // Phase 32 Task 2.4：注入 CacheStatsTracker 到 TokenTracker
  // 让 tracker.record() 自动记录缓存命中数据（Layer 5：会话级累计计数器）
  // 使用 useRef 确保 CacheStatsTracker 只创建一次，与 tracker 生命周期一致
  const cacheStatsTrackerRef = useRef(new CacheStatsTracker());
  useEffect(() => {
    tracker.setCacheStatsTracker(cacheStatsTrackerRef.current);
  }, [tracker]);
  const autonomyModeRef = useRef(autonomyMode);
  autonomyModeRef.current = autonomyMode;
  const commandBridgeRef = useRef<{ requestConfirm: (p: string) => Promise<boolean> } | null>(null);
  // Phase 21：注册 PermissionEngine 中间件（deny 规则不可绕过）
  registerPermissionMiddleware(deps.middlewarePipeline, deps.permissionEngine, autonomyModeRef, commandBridgeRef);

  // 初始化分支管理器：移入 useEffect，避免每次渲染都调用
  useEffect(() => {
    deps.branchManager.initFromHistory(conversationHistoryRef.current);
  }, [conversationHistoryRef.current.length]);

  // 命令注册表（注册所有 26 个命令，含 Phase 31 Task 7.3 新增的 3 个）
  const commandRegistryRef = useRef(new CommandRegistry());
  useEffect(() => {
    [autoCommand, semiCommand, manualCommand, pauseCommand, checkpointCommand, rollbackCommand, goalCommand, branchCommand, initCommand, dreamCommand, quitCommand, clearCommand, helpCommand, statusCommand, traceCommand, promptCommand, channelsCommand, costCommand, historyCommand, pluginCommand, diffCommand, buildCommand, planCommand, composeCommand, resumeCommand, tokenCommand, memoryCommand, permissionsCommand, configCommand, outputStyleCommand, techDebtCommand, swarmCommand, btwCommand, reviewCommand, clarifyCommand, experimentCommand, qualityCommand, scheduleCommand, trustCommand].forEach(c => commandRegistryRef.current.register(c));

    // Phase 47 Task 7：加载自定义 Slash 命令（.routedev/commands/ 目录）
    // 命名空间隔离：自定义命令与内置命令同名时，内置命令优先，自定义命令被忽略并 logger.warn（陷阱 #139）
    const commandsDir = path.join(process.cwd(), '.routedev', 'commands');
    const customCommands = loadCustomCommands(commandsDir);
    for (const cmd of customCommands) {
      if (commandRegistryRef.current.has(cmd.name)) {
        logger.warn(`Custom command /${cmd.name} conflicts with built-in command, ignored`, { name: cmd.name });
        continue;
      }
      commandRegistryRef.current.register(cmd);
    }
  }, []);

  // Phase 30 Task 5：systemPrompt 改为 ref 模式
  // - 初始值用 getSystemPrompt() fallback，保证首次渲染即可用
  // - useEffect 中异步调用 PromptTemplateManager.render() 更新 ref.current
  // - runner 持有 ref，每次 LLM 调用时读取 systemPromptRef.current，支持热更新
  const systemPromptRef = useRef(getSystemPrompt(config.general.language));

  // CommandBridge：命令通过回调影响 UI
  const commandBridge: CommandBridge = {
    addSystemMessage: (content: string) => setMessages(prev => [...prev, { id: nextId(), role: 'system', content }]),
    clearChat: () => { setMessages([{ id: nextId(), role: 'system', content: '对话已清空。' }]); conversationHistoryRef.current = []; deps.contextManager.resetTriggers(); },
    setAutonomyMode: (mode: AutonomyMode) => { setAutonomyMode(mode); autonomyModeRef.current = mode; },
    setWorkMode: (mode: WorkMode) => { setWorkMode(mode); deps.workModeController.setMode(mode); },
    requestAbort: () => { abortControllerRef.current?.abort(); abortControllerRef.current = null; if (currentPlanRef.current?.status === 'executing') currentPlanRef.current.status = 'failed'; setIsProcessing(false); },
    requestConfirm: async (prompt: string): Promise<boolean> => {
      return new Promise<boolean>(resolve => {
        setConfirmDialog({ prompt, resolve });
      });
    },
    requestPlanEdit: (plan: GoalPlan) => { setEditingPlan(plan); return new Promise(r => { pendingPlanEditRef.current = { resolve: r }; }); },
    exit: () => { logger.info('Session ended — goodbye', { sessionId: deps.trace.getSessionId() }); deps.pluginRegistry.destroyAll().catch(err => logger.warn('Plugin destroyAll failed', { error: String(err) })).finally(() => process.exit(0)); },
    startGoal: (text: string) => { goalRunnerRef.current.handleGoalCommand(`/goal ${text}`).catch(err => { logger.error('Goal command failed', { error: String(err) }); setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `❌ /goal 命令失败: ${err instanceof Error ? err.message : String(err)}` }]); }); },
    getState: () => ({ currentModel, currentTier, isDegraded, autonomyMode, conversationHistoryLength: conversationHistoryRef.current.length, mcpConnectedCount: deps.mcpManager.connectedCount, mcpTotalToolCount: deps.mcpManager.totalToolCount }),
    setOutputStyle: (style) => { setOutputStyleState(style); configRef.current.ui.outputStyle = style; },
    getConversationHistory: () => conversationHistoryRef.current.slice(),
    // Phase 50 Task 7：组件接入回调——命令触发对应 React 组件渲染
    showResumePicker: (snapshots: ExecutionSnapshot[]) => {
      if (configRef.current.ui.components?.resumePicker !== false) {
        setActivePanel({ type: 'resume', snapshots });
      }
    },
    showTracePanel: (entries: TraceTimelineEntry[], sessionId?: string) => {
      if (configRef.current.ui.components?.tracePanel === true) {
        setActivePanel({ type: 'trace', entries, sessionId });
      }
    },
    showDiffView: (diff: string, fileName?: string) => {
      if (configRef.current.ui.components?.diffView !== false) {
        setActivePanel({ type: 'diff', diff, fileName });
      }
    },
    closeActivePanel: () => setActivePanel(null),
    notifyConfigChanges: (changes: ConfigChange[]) => {
      if (configRef.current.ui.components?.configReloadNotice !== false && changes.length > 0) {
        setConfigReloadChanges({ changes, timestamp: new Date() });
      }
    },
  };
  commandBridgeRef.current = commandBridge; // Phase 21：供 PermissionEngine 中间件使用

  // 修复：将 commandBridge 的确认回调注入工具执行器，
  // 使 requiresConfirmation 的工具（写操作、网络等）能正常弹出确认对话框。
  deps.adapter.setRequestConfirmation(commandBridge.requestConfirm);

  // GoalRunner（目标分解与执行）
  const goalRunnerRef = useRef(createGoalRunner({
    classifier, modelRouter, clientManager, tracker,
    agentLoop: deps.agentLoop,
    checkpointManager: deps.checkpointManager,
    contextManager: deps.contextManager,
    config, systemPromptRef,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    currentPlanRef, awaitingGoalConfirmRef,
    addSystemMessage: (content: string) => setMessages(prev => [...prev, { id: nextId(), role: 'system', content }]),
    requestPlanEdit: (plan: GoalPlan) => commandBridge.requestPlanEdit(plan),
    setIsProcessing, nextId,
    setTodayTokensUsed,
    profiler: deps.profiler ?? undefined,
    // Phase 32 Task 1.4：接入 CompletionGate（独立代码验证门）
    completionGate: deps.completionGate,
    // Phase 50 Task 1：接入 goalIntegration 实例（未开启时为 null，createGoalRunner 内部按 falsy 跳过）
    goalAuditor: deps.goalAuditor ?? undefined,
    goalPersistence: deps.goalPersistence ?? undefined,
    goalPromptBuilder: deps.goalPromptBuilder ?? undefined,
    // Phase 54 Task 1/4：多 Agent 编排 + 统一审查器（三者同时注入后 /goal 走多 Agent 路径）
    orchestrator: deps.orchestrator,
    workerExecutor: deps.workerExecutor,
    blackboard: deps.blackboard,
    unifiedReviewer: deps.unifiedReviewer,
    // Phase 55 Task 8：执行路径判定器（app-init.ts 实例化，未注入时 goal-runner 降级到 legacy）
    executionRouter: deps.executionRouter,
    // Phase 55 Task 9：DualLoop 编排器 ref（异步创建，ref 延迟绑定，未注入时降级到 legacyIterativeLoop）
    dualLoopOrchestratorRef: deps.dualLoopOrchestratorRef,
    // Phase 55：DAG 引擎（app-init.ts 异步创建，ref 延迟读取，未注入时 executePlanWithDag 降级到 single）
    dagEngine: deps.dagEngineRef?.current ?? undefined,
    // Phase 55 Task 11：CompositionalRouter（app-init.ts 实例化，未注入时 executePlanWithCompose 降级到 DAG）
    compositionalRouter: deps.compositionalRouter,
  }));

  // ChatRunner（非命令聊天执行）
  const chatRunnerRef = useRef(createChatRunner({
    classifier, modelRouter, clientManager, tracker,
    agentLoop: deps.agentLoop,
    contextManager: deps.contextManager,
    visionAssistant: deps.visionAssistant,
    config, systemPromptRef,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    setMessages, setIsProcessing, setCurrentModel, setCurrentTier,
    setIsDegraded, setTodayTokensUsed, nextId,
    profiler: deps.profiler ?? undefined,
    // Phase 34：注入 Trace/Audit，用于 trajectory 过程评测汇总
    trace: deps.trace,
    audit: deps.audit,
    // Phase 34：运行时 outputStyle 读取（支持 /output-style 切换）
    getOutputStyle: () => outputStyle,
  }));

  // 构建 ServiceContext（Phase 0c：通过 createServiceContext 单一入口装配）
  const buildServiceContext = useCallback((): ServiceContext => {
    return createServiceContext({
      config, clientManager, router: modelRouter, tracker,
      agentLoop: deps.agentLoop,
      checkpointWriter: deps.checkpointWriter,
      checkpointManager: deps.checkpointManager,
      contextManager: deps.contextManager,
      branchManager: deps.branchManager,
      vision: deps.visionAssistant,
      initAnalyzer: deps.initAnalyzer!,
      dream: deps.dreamConsolidator,
      goalParser: deps.goalParser,
      goalVerifier: deps.goalVerifier,
      blackboard: deps.blackboard,
      orchestrator: deps.orchestrator,
      workerExecutor: deps.workerExecutor,
      trace: deps.trace,
      audit: deps.audit,
      prompts: deps.prompts,
      projectMemory: deps.projectMemory,
      toolExecutor: deps.guardedAdapter,
      setToolExecutor: () => {},
      mcpManager: deps.mcpManager,
      commandBridge,
      workModeController: deps.workModeController,
      cwd: process.cwd(),
      pluginRegistry: deps.pluginRegistry,
      durableExecutor: deps.durableExecutor,
      profiler: deps.profiler ?? undefined,
    });
  }, [config, clientManager, modelRouter, tracker, commandBridge, deps]);

  // 初始化副作用
  useEffect(() => {
    // 显示 splash（版本号从 package.json 读取）
    const splash = renderSplash({
      version: getVersion(),
      modelCount: clientManager.listAll().size,
      readyModels: clientManager.getReadyClients().length,
      channelsEnabled: config.channels.entries.filter(e => e.enabled).map(e => e.id),
      projectPath: process.cwd(),
    });
    setMessages(prev => [{ id: nextId(), role: 'system', content: splash }, ...prev]);

    // 初始化 CheckpointManager + 加载持久化 memory checkpoint
    deps.checkpointManager.init().catch(err => logger.warn('CheckpointManager init failed', { error: String(err) }));
    deps.contextManager.loadCheckpoint().catch(err => logger.warn('ContextManager loadCheckpoint failed', { error: String(err) }));

    // Phase 25：上下文压缩导致信息丢失时向用户发出警告
    deps.contextManager.onCompression((event) => {
      if (event.messagesCompressed > 0 || event.offloadedOutputs > 0) {
        const msg = `[警告] 上下文压缩导致信息可能丢失：${event.messagesCompressed} 条消息被摘要，${event.offloadedOutputs} 条工具输出被 offload。压缩前 ${event.tokensBefore} tokens → 压缩后 ${event.tokensAfter} tokens。`;
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: msg }]);
      }
    });

    // 启动 ConfigWatcher：监听全局和项目级配置文件变更
    const globalConfigPath = getGlobalConfigPath();
    const projectConfigPath = getProjectConfigPath(process.cwd());
    const watcher = new ConfigWatcher(globalConfigPath, { debounceMs: 500 });
    const projectWatcher = new ConfigWatcher(projectConfigPath, { debounceMs: 500 });
    const onConfigReload = () => {
      try {
        const fresh = loadConfig() as unknown as Record<string, unknown>;
        const oldConfig = configRef.current as unknown as Record<string, unknown>;
        // Phase 50 Task 7：保留原有文本通知（兼容旧 UI），同时触发 ConfigReloadNotice 组件渲染
        handleConfigReload(oldConfig, fresh).forEach((m: string) =>
          setMessages(p => [...p, { id: nextId(), role: 'system', content: m }]),
        );
        // 触发 ConfigReloadNotice 组件渲染（受 configReloadNotice 开关控制）
        const notices = generateReloadNotices(oldConfig, fresh);
        if (notices.length > 0) {
          commandBridge.notifyConfigChanges?.(notices);
        }
        configRef.current = fresh as unknown as typeof config;
      } catch {
        setMessages(p => [...p, { id: nextId(), role: 'system', content: '[配置] 配置已变更，将在下次请求时生效。' }]);
      }
    };
    watcher.on('reload', onConfigReload);
    projectWatcher.on('reload', onConfigReload);
    watcher.on('error', (err: unknown) => logger.warn('ConfigWatcher error', { error: String(err) }));
    projectWatcher.on('error', (err: unknown) => logger.warn('ProjectConfigWatcher error', { error: String(err) }));
    watcher.start();
    projectWatcher.start();

    // 自动连接 MCP servers
    if (config.mcp.autoConnect) {
      const enabledServers = config.mcp.servers.filter(s => s.enabled);
      if (enabledServers.length > 0) {
        setMcpStatus('connecting');
        (async () => {
          for (const server of enabledServers) {
            const info = await deps.mcpManager.connect(server);
            if (info.status === 'error') {
              setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `MCP server "${server.name}" 连接失败: ${info.error}` }]);
            }
          }
          setMcpStatus(deps.mcpManager.connectedCount > 0 ? 'connected' : 'disconnected');
        })().catch(err => logger.error('Failed to connect MCP servers', { error: String(err) }));
      }
    }

    return () => {
      watcher.stop();
      projectWatcher.stop();
      deps.mcpManager.disconnectAll().catch(err => logger.error('Failed to disconnect MCP servers', { error: String(err) }));
    };
  }, [config.mcp.autoConnect, config.mcp.servers, config.channels.entries, clientManager, deps]);

  // Phase 30 Task 5：异步渲染系统提示词，更新 systemPromptRef.current
  // - 通过 PromptTemplateManager 支持项目级/用户级覆盖
  // - 渲染失败时保留 fallback（getSystemPrompt 返回的初始值），不阻断启动
  // - 依赖 config 和 autonomyMode：自主度或语言变化时重新渲染
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 收集渲染上下文（动态字段留空，由 runner 在每次调用时补充）
        const projectRules = (await deps.projectMemory.readRules().catch(() => null)) ?? '';
        const projectMemorySummary = (await deps.projectMemory.getSummary().catch(() => '') ) ?? '';
        const blackboardSummary = deps.blackboard.formatForPrompt();
        const context = {
          language: config.general.language,
          autonomyMode,
          projectRules,
          projectMemory: projectMemorySummary,
          blackboard: blackboardSummary,
          availableTools: '',
          conversationContext: '',
          routeDecision: '',
          entityState: '',
          conciseThinking: '',
          cwd: process.cwd(),
        };
        const rendered = await deps.prompts.render('main.system', context);
        if (!cancelled && rendered) {
          systemPromptRef.current = rendered;
          // Phase 31/32 P0 接线：同步共享 systemPromptRef，让 ExecutionOrchestrator/UnifiedReviewer 获取最新系统提示词
          deps.sharedSystemPromptRef.current = rendered;
          logger.debug('System prompt rendered via PromptTemplateManager', {
            length: rendered.length,
            source: 'template',
          });
        }
      } catch (err) {
        // 渲染失败保留 fallback，不阻断功能
        logger.warn('PromptTemplateManager render failed, using fallback', { error: String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [config.general.language, autonomyMode, deps.prompts, deps.projectMemory, deps.blackboard]);

  // Phase 22：插件系统初始化——独立 useEffect，依赖 [] 仅运行一次
    useEffect(() => {
      initPluginSystem(deps.pluginRegistry).catch(err => logger.warn('Plugin init failed', { error: String(err) }));
    }, [deps]);

    // Phase 50 Task 7：监听 currentPlanRef 变化，更新 ProgressBar 进度
    // goal-runner 在每步完成时调用 addSystemMessage(renderGoalProgressText(plan))，
    // 这里通过轮询 currentPlanRef 同步 goalProgress 状态供 ProgressBar 组件使用
    useEffect(() => {
      const interval = setInterval(() => {
        const plan = currentPlanRef.current;
        if (!plan || configRef.current.ui.components?.progressBar === false) {
          if (goalProgress !== null) setGoalProgress(null);
          return;
        }
        if (plan.status === 'executing' && plan.steps.length > 0) {
          const completed = plan.steps.filter(s => s.status === 'completed').length;
          setGoalProgress({ current: completed, total: plan.steps.length });
        } else if (plan.status === 'completed' || plan.status === 'failed') {
          // 任务结束时清理进度条
          if (goalProgress !== null) setGoalProgress(null);
        }
      }, 500);
      return () => clearInterval(interval);
    }, [goalProgress]);

    // Phase 50 Task 7：BranchSwitcher 接入——有分支时显示分支切换器
    // 通过轮询 branchManager.listBranches() 检测分支创建/删除
    useEffect(() => {
      if (configRef.current.ui.components?.branchSwitcher === false) {
        setShowBranchSwitcher(false);
        return;
      }
      const interval = setInterval(() => {
        const branches = deps.branchManager.listBranches();
        const shouldShow = branches.length > 1; // 仅当有多个分支时显示
        setShowBranchSwitcher(prev => prev !== shouldShow ? shouldShow : prev);
      }, 2000);
      return () => clearInterval(interval);
    }, [deps.branchManager]);

    // Phase 25：空闲提示——等待输入超过配置秒数后显示一次
    useEffect(() => {
      const idleMs = (configRef.current.ui.idleHintSeconds ?? 30) * 1000;
      const interval = setInterval(() => {
        if (
          !isProcessing &&
          !confirmDialog &&
          !editingPlan &&
          !idleHintShown &&
          Date.now() - lastInputTimeRef.current > idleMs
        ) {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '💡 提示: 输入 /help 查看可用命令' }]);
          setIdleHintShown(true);
        }
      }, 5000);
      return () => clearInterval(interval);
    }, [isProcessing, confirmDialog, editingPlan, idleHintShown]);

    // Phase 31/32 P0 接线：development 流水线辅助函数
    // 使用 ref 持有函数引用，避免 useCallback 依赖链膨胀，同时确保总是调用最新版本
    const runRequirementsGathererRef = useRef<(ctx: DevelopmentContext) => Promise<void>>(async () => {});
    const runDevelopmentPipelineRef = useRef<(ctx: DevelopmentContext, stage: 'planning' | 'execution' | 'review') => Promise<void>>(async () => {});

    /**
     * 运行需求收集器——处理 gather() 异步生成器的事件
     * - questions → 显示问题，设置 awaitingRequirementsAnswerRef，等待用户回答
     * - summary → 显示摘要，设置 awaitingRequirementsConfirmRef，等待用户确认
     * - skipped → 直接进入计划生成阶段
     */
    runRequirementsGathererRef.current = async (ctx: DevelopmentContext) => {
      for await (const event of deps.requirementsGatherer.gather({
        userInput: ctx.userInput,
        classification: ctx.classification,
        llmClient: ctx.llmClient,
        routeDecision: ctx.routeDecision,
        collectedAnswers: ctx.collectedAnswers,
      })) {
        if (event.type === 'questions') {
          // 显示澄清问题，等待用户回答
          developmentContextRef.current = ctx;
          awaitingRequirementsAnswerRef.current = { questions: event.questions };
          const questionsText = event.questions
            .map(q => `Q${q.id}: ${q.question}${q.options ? `\n  选项: ${q.options.join(' / ')}` : ''}`)
            .join('\n');
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📝 需要澄清以下问题：\n${questionsText}\n\n请回答以上问题：` }]);
          return; // 退出循环，等待用户回答后再次调用 gather()
        }
        if (event.type === 'summary') {
          // 显示需求摘要，等待用户确认
          developmentContextRef.current = ctx;
          ctx.requirements = event.summary;
          awaitingRequirementsConfirmRef.current = { summary: event.summary };
          const summaryText = [
            `目标: ${event.summary.goal}`,
            event.summary.scope.length > 0 ? `范围: ${event.summary.scope.join(', ')}` : '',
            event.summary.constraints.length > 0 ? `约束: ${event.summary.constraints.join('; ')}` : '',
            event.summary.acceptanceCriteria.length > 0 ? `验收标准: ${event.summary.acceptanceCriteria.join('; ')}` : '',
            `预估复杂度: ${event.summary.estimatedComplexity}`,
          ].filter(Boolean).join('\n');
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📋 需求摘要：\n${summaryText}\n\n确认执行？[y/n]` }]);
          return; // 退出循环，等待用户确认
        }
        if (event.type === 'skipped') {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `⏭ 需求确认已跳过：${event.reason}` }]);
          // 继续后续阶段
        }
      }
      // gather() 结束（skipped 或无事件）→ 直接进入计划生成
      await runDevelopmentPipelineRef.current(ctx, 'planning');
    };

    /**
     * 运行 development 流水线——从指定阶段开始执行
     * - planning: GoalParser 生成计划 → StepEditor 编辑 → 复杂度分析 → 执行 → 审查
     * - execution: 直接执行（计划已就绪）
     * - review: 直接审查（执行已完成）
     */
    runDevelopmentPipelineRef.current = async (ctx: DevelopmentContext, stage: 'planning' | 'execution' | 'review') => {
      try {
        if (stage === 'planning') {
          // ===== 阶段3：计划生成 =====
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '📋 正在生成执行计划...' }]);
          const parser = new GoalParser();
          const plan = await parser.parse(ctx.requirements?.goal ?? ctx.userInput, {
            routeDecision: ctx.routeDecision,
            llmClient: ctx.llmClient,
            requirements: ctx.requirements,
          });

          // 通过 StepEditor 让用户编辑步骤
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '📋 计划已生成，请在编辑器中审查和修改步骤...' }]);
          const editedSteps = await commandBridge.requestPlanEdit(plan);
          if (editedSteps === null) {
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '❌ 已取消任务' }]);
            setIsProcessing(false);
            return;
          }
          plan.steps = editedSteps;
          currentPlanRef.current = plan;

          // ===== 阶段3b：复杂度分析 =====
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '🔬 正在分析步骤复杂度...' }]);
          const complexityMap = await deps.complexityAnalyzer.analyze({
            steps: plan.steps,
            requirements: ctx.requirements ?? { goal: ctx.userInput, scope: [], constraints: [], acceptanceCriteria: [], estimatedComplexity: 'medium' },
            llmClient: ctx.llmClient,
            routeDecision: ctx.routeDecision,
          });
          const multiAgentSteps = Array.from(complexityMap.values()).filter(c => c.needsSubAgent).length;
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📊 复杂度分析完成：${plan.steps.length} 个步骤，${multiAgentSteps > 0 ? `${multiAgentSteps} 个需要子 Agent，将使用多 Agent 模式` : '全部使用单 Agent 模式'}` }]);

          // ===== 阶段4：执行编排 =====
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '🚀 开始执行...' }]);
          const executionResult = await deps.executionOrchestrator.execute({
            plan,
            complexityMap,
            llmClient: ctx.llmClient,
            routeDecision: ctx.routeDecision,
            conversationHistory: conversationHistoryRef.current,
          });

          const successCount = executionResult.results.filter(r => r.success).length;
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📦 执行完成：${successCount}/${executionResult.results.length} 步骤成功（${executionResult.mode === 'multi' ? '多 Agent' : '单 Agent'} 模式）` }]);

          // ===== 阶段5：统一审查 =====
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '🔍 开始统一审查...' }]);
          const reviewResult = await deps.unifiedReviewer.review({
            plan,
            executionResults: executionResult.results,
            llmClient: ctx.llmClient,
            routeDecision: ctx.routeDecision,
            conversationHistory: conversationHistoryRef.current,
          });

          const icon = reviewResult.passed ? '🎉' : '⚠️';
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `${icon} 任务完成。审查${reviewResult.passed ? '通过' : '未通过'}：${reviewResult.summary}` }]);
        }
      } catch (err) {
        logger.error('Development pipeline failed', { error: String(err) });
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `❌ 任务执行失败: ${err instanceof Error ? err.message : String(err)}` }]);
      } finally {
        // 清理 development 上下文
        developmentContextRef.current = null;
        setIsProcessing(false);
      }
    };

    const handleSubmit = useCallback(async (text: string) => {
    // 重置空闲提示计时器
    lastInputTimeRef.current = Date.now();
    setIdleHintShown(false);

    // 1. 工具确认 pending 优先
    if (pendingConfirmRef.current) {
      const pending = pendingConfirmRef.current;
      pendingConfirmRef.current = null;
      const approved = /^[yY]/.test(text.trim());
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `${approved ? '✅ 已批准' : '❌ 已拒绝'}: ${pending.toolName}` }]);
      pending.resolve(approved);
      return;
    }

    // 2. 目标确认 pending
    if (awaitingGoalConfirmRef.current) {
      const pending = awaitingGoalConfirmRef.current;
      awaitingGoalConfirmRef.current = null;
      const approved = /^[yY]/.test(text.trim());
      if (approved) {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '✅ 已确认，开始执行目标计划...' }]);
        currentPlanRef.current = pending.plan;
        goalRunnerRef.current.executeGoalPlan(pending.plan).catch(err => logger.error('Goal plan execution failed', { error: String(err) }));
      } else {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '❌ 已取消目标计划' }]);
      }
      pending.resolve(approved);
      return;
    }

    // Phase 31/32 P0 接线：development 流水线多轮交互——需求确认
    // 2a. 等待用户回答澄清问题
    if (awaitingRequirementsAnswerRef.current) {
      const pending = awaitingRequirementsAnswerRef.current;
      awaitingRequirementsAnswerRef.current = null;
      const ctx = developmentContextRef.current;
      if (!ctx) {
        logger.error('DevelopmentContext missing while awaiting requirements answer');
        setIsProcessing(false);
        return;
      }
      // 将用户回答解析为 ClarifyingQuestion（options 字段存自由回答）
      const answers: ClarifyingQuestion[] = pending.questions.map(q => ({
        id: q.id,
        question: q.question,
        options: [text],
      }));
      ctx.collectedAnswers = answers;
      setMessages(prev => [...prev, { id: nextId(), role: 'user', content: text }]);
      // 重新调用 gather()，这次传入 collectedAnswers → 生成摘要
      await runRequirementsGathererRef.current(ctx);
      return;
    }
    // 2b. 等待用户确认需求摘要
    if (awaitingRequirementsConfirmRef.current) {
      const pending = awaitingRequirementsConfirmRef.current;
      awaitingRequirementsConfirmRef.current = null;
      const ctx = developmentContextRef.current;
      developmentContextRef.current = null;
      if (!ctx) {
        logger.error('DevelopmentContext missing while awaiting requirements confirm');
        setIsProcessing(false);
        return;
      }
      const approved = /^[yY]/.test(text.trim());
      setMessages(prev => [...prev, { id: nextId(), role: 'user', content: text }]);
      if (approved) {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '✅ 需求已确认，开始生成计划...' }]);
        ctx.requirements = pending.summary;
        await runDevelopmentPipelineRef.current(ctx, 'planning');
      } else {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '❌ 已取消任务' }]);
        setIsProcessing(false);
      }
      return;
    }

    // 3. 添加用户消息
    setMessages(prev => [...prev, { id: nextId(), role: 'user', content: text }]);

    // 4. 命令处理（通过 CommandRegistry）
    if (text.startsWith('/')) {
      const ctx = buildServiceContext();
      const result = await commandRegistryRef.current.execute(text, ctx);
      if (result.type === 'handled') {
        if (result.messages) {
          for (const content of result.messages) {
            if (content === '__CLEAR__') {
              commandBridge.clearChat();
            } else {
              setMessages(prev => [...prev, { id: nextId(), role: 'system', content }]);
            }
          }
        }
        setIsProcessing(false);
        return;
      }
      // Phase 47 Task 7：passthrough 结果——已注册命令（如自定义命令）返回渲染后的 prompt
      // 将渲染后的输入发送给 Agent（通过 ChatRunner）
      const commandName = text.slice(1).split(/\s/)[0];
      if (commandRegistryRef.current.has(commandName)) {
        setIsProcessing(true);
        await chatRunnerRef.current.runChat(result.input);
        return;
      }
      // 未知命令
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `未知命令: ${text.split(' ')[0]}。输入 /help 查看可用命令。` }]);
      setIsProcessing(false);
      return;
    }

    // 5. 非命令输入 → Phase 32 Task 1：先经过 TaskOrchestrator 分发
    setIsProcessing(true);
    // unifiedPipeline 开关：默认 true 走统一流水线，false 时回退到原 ChatRunner 直达
    const unifiedPipelineEnabled = config.optimization?.workflow?.unifiedPipeline !== false;
    if (unifiedPipelineEnabled) {
      try {
        const action = await deps.taskOrchestrator.handle(text);
        await dispatchOrchestratorAction(action);
      } catch (err) {
        logger.error('TaskOrchestrator handle failed, fallback to ChatRunner', { error: String(err) });
        await chatRunnerRef.current.runChat(text);
      }
    } else {
      // 回退路径：unifiedPipeline 为 false 时保持原行为
      await chatRunnerRef.current.runChat(text);
    }
  }, [buildServiceContext, commandBridge]);

  /**
   * Phase 31/32 P0 接线：分发 TaskOrchestrator 返回的 Action
   *
   * OrchestratorAction 类型：
   *   - direct_chat: quick_answer 短路，直达 ChatRunner
   *   - pipeline_start (planning): 走 /plan 命令路径
   *   - pipeline_start (development): 走完整流水线——需求确认→计划生成→复杂度分析→执行编排→统一审查
   *   - 其余类型（requirements_question/plan_ready/execution_progress/review_result/completed）
   *     由 TaskOrchestrator 内部状态机驱动，当前阶段不主动触发
   */
  const dispatchOrchestratorAction = useCallback(async (action: import('../agent/task-orchestrator-types.js').OrchestratorAction): Promise<void> => {
    switch (action.type) {
      case 'direct_chat':
        // quick_answer 短路：直达 ChatRunner，无额外 LLM 调用
        await chatRunnerRef.current.runChat(action.input);
        return;
      case 'pipeline_start':
        // planning 意图：走 /plan 命令路径
        if (action.intent === 'planning') {
          const ctx = buildServiceContext();
          const result = await commandRegistryRef.current.execute(`/plan ${action.input}`, ctx);
          if (result.type === 'handled' && result.messages) {
            for (const content of result.messages) {
              if (content === '__CLEAR__') {
                commandBridge.clearChat();
              } else {
                setMessages(prev => [...prev, { id: nextId(), role: 'system', content }]);
              }
            }
          }
          setIsProcessing(false);
          return;
        }
        // Phase 31/32 P0 接线：development 意图——走完整流水线
        if (action.intent === 'development') {
          const task = deps.taskOrchestrator.getCurrentTask();
          if (!task || !task.routing) {
            // 上下文缺失，回退到 ChatRunner
            logger.warn('Development pipeline: TaskContext or routing missing, fallback to ChatRunner');
            await chatRunnerRef.current.runChat(action.input);
            return;
          }
          const llmClient = clientManager.get(task.routing.providerId);
          if (!llmClient || !llmClient.isReady()) {
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `❌ 错误: 提供商 ${task.routing.providerId} 不可用` }]);
            setIsProcessing(false);
            return;
          }
          // 构建 development 上下文
          const devCtx: DevelopmentContext = {
            userInput: action.input,
            classification: task.classification,
            routeDecision: task.routing,
            llmClient,
          };
          // 检查是否应跳过需求确认
          if (deps.taskOrchestrator.shouldSkipRequirements(action.input, task.classification)) {
            // 跳过需求确认，直接进入计划生成
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '⏭ 跳过需求确认，直接执行...' }]);
            await runDevelopmentPipelineRef.current(devCtx, 'planning');
          } else {
            // 启动需求确认阶段
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '📝 开始需求确认...' }]);
            await runRequirementsGathererRef.current(devCtx);
          }
          return;
        }
        // 其他 intent（explicit_goal 等）：回退到 ChatRunner
        await chatRunnerRef.current.runChat(action.input);
        return;
      case 'requirements_question':
      case 'plan_ready':
      case 'execution_progress':
      case 'review_result':
      case 'completed':
        // 这些类型由 TaskOrchestrator 状态机后续阶段触发，当前不处理
        logger.warn('OrchestratorAction type not yet handled in dispatch', { type: action.type });
        setIsProcessing(false);
        return;
    }
  }, [buildServiceContext, commandBridge, deps.taskOrchestrator, clientManager]);

  /** 关闭确认对话框并通知结果 */
  function closeConfirm(approved: boolean) {
    const prompt = confirmDialog?.prompt ?? '';
    confirmDialog?.resolve(approved);
    setConfirmDialog(null);
    setMessages(prev => [
      ...prev,
      { id: nextId(), role: 'system', content: approved ? `✅ 已确认: ${prompt}` : `❌ 操作已取消: ${prompt}` },
    ]);
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView
          messages={messages}
          outputStyle={outputStyle}
          enableDisclosure={configRef.current.ui.components?.disclosureLevel !== false}
        />
        {/* Phase 50 Task 7：ConfigReloadNotice 配置变更通知卡片 */}
        {configReloadChanges && (
          <ConfigReloadNotice changes={configReloadChanges.changes} timestamp={configReloadChanges.timestamp} />
        )}
        {/* Phase 50 Task 7：ProgressBar goal 执行进度 */}
        {goalProgress && (
          <Box flexDirection="column" paddingX={1} marginTop={0}>
            <Text>{' '}目标进度</Text>
            <ProgressBar current={goalProgress.current} total={goalProgress.total} />
          </Box>
        )}
        {/* Phase 50 Task 7：BranchSwitcher 分支树可视化 */}
        {showBranchSwitcher && (
          <BranchSwitcher
            branches={deps.branchManager.listBranches()}
            activeBranchId={deps.branchManager.getActiveBranchId()}
          />
        )}
        {/* Phase 50 Task 7：命令触发的交互式面板（/resume | /trace | /diff） */}
        {activePanel?.type === 'resume' && (
          <ResumePicker
            snapshots={activePanel.snapshots}
            onResume={(planId) => {
              setActivePanel(null);
              setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `🔄 恢复执行: ${planId}（请通过 /resume ${planId} 完成恢复）` }]);
            }}
            onCancel={() => setActivePanel(null)}
          />
        )}
        {activePanel?.type === 'trace' && (
          <TracePanel entries={activePanel.entries} sessionId={activePanel.sessionId} />
        )}
        {activePanel?.type === 'diff' && (
          <DiffView
            diff={activePanel.diff}
            fileName={activePanel.fileName}
            onApplyDiff={() => { setActivePanel(null); }}
            onRejectDiff={() => { setActivePanel(null); }}
          />
        )}
        {editingPlan && <StepEditor plan={editingPlan} outputStyle={outputStyle} onConfirm={(s) => { pendingPlanEditRef.current?.resolve(s); pendingPlanEditRef.current = null; setEditingPlan(null); }} onCancel={() => { pendingPlanEditRef.current?.resolve(null); pendingPlanEditRef.current = null; setEditingPlan(null); }} />}
        {confirmDialog && (
          <ConfirmDialog
            operation={confirmDialog.prompt}
            impact="该操作可能影响当前项目状态，请确认是否继续。"
            riskLevel="medium"
            onConfirm={() => closeConfirm(true)}
            onDeny={() => closeConfirm(false)}
          />
        )}
      </Box>
      <Box paddingX={1}>
        <StatusBar
          currentModel={currentModel}
          currentTier={currentTier}
          isDegraded={isDegraded}
          todayTokensUsed={todayTokensUsed}
          autonomyMode={autonomyMode}
          workMode={workMode}
          composeSummary={workMode === 'compose' ? { phase: deps.workModeController.getComposePhase() ?? 'requirements', progress: `${(['requirements', 'coding', 'testing', 'review'].indexOf(deps.workModeController.getComposePhase() ?? 'requirements') + 1)}/4` } : null}
          outputStyle={outputStyle}
        />
      </Box>
      <Box paddingX={1}>
        <InputBox onSubmit={handleSubmit} disabled={isProcessing || !!confirmDialog} />
      </Box>
    </Box>
  );
}

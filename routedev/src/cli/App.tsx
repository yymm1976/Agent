// src/cli/App.tsx
// 主应用组件：整合 ChatView + StatusBar + InputBox，管理消息状态
// Phase 17b：命令全部迁移到 CommandRegistry，目标执行提取到 goal-runner.ts，聊天执行提取到 chat-runner.ts
// Phase 0c Task 3：装配逻辑收敛到 createAppDependencies + createServiceContext，App.tsx 只负责 React 状态和 UI

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box } from 'ink';
import { ChatView, type ChatMessage } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import { StepEditor } from './components/StepEditor.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import type { ScenarioTier, LLMMessage } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { AppConfig, AutonomyMode } from '../config/schema.js';
import { getSystemPrompt } from '../agent/prompts.js';
import type { GoalPlan, PlanStep } from '../agent/goal-types.js';
import type { WorkMode } from '../agent/work-modes.js';
import { logger } from '../utils/logger.js';
import { CommandRegistry } from './command-registry.js';
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
  buildCommand, planCommand, composeCommand, resumeCommand,
} from './commands/index.js';
import { initPluginSystem, registerPermissionMiddleware } from './plugin-init.js';
import { createAppDependencies } from './app-init.js';
import { createServiceContext, type ServiceContext, type CommandBridge } from './service-context.js';

interface AppProps {
  config: AppConfig;
  clientManager: LLMClientManager;
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  tracker: TokenTracker;
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

  // ===== refs：UI 状态 =====
  const conversationHistoryRef = useRef<LLMMessage[]>([]);
  const pendingConfirmRef = useRef<{ resolve: (approved: boolean) => void; toolName: string } | null>(null);
  const awaitingGoalConfirmRef = useRef<{ resolve: (approved: boolean) => void; plan: GoalPlan } | null>(null);
  const currentPlanRef = useRef<GoalPlan | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingPlanEditRef = useRef<{ resolve: (s: PlanStep[] | null) => void } | null>(null);
  const configRef = useRef(config);
  const lastInputTimeRef = useRef(Date.now());

  // ===== refs：服务依赖（Phase 0c：通过 createAppDependencies 一次性创建） =====
  const depsRef = useRef(createAppDependencies(config, clientManager, currentModel));
  const deps = depsRef.current;
  const autonomyModeRef = useRef(autonomyMode);
  autonomyModeRef.current = autonomyMode;
  const commandBridgeRef = useRef<{ requestConfirm: (p: string) => Promise<boolean> } | null>(null);
  // Phase 21：注册 PermissionEngine 中间件（deny 规则不可绕过）
  registerPermissionMiddleware(deps.middlewarePipeline, deps.permissionEngine, autonomyModeRef, commandBridgeRef);

  // 初始化分支管理器
  deps.branchManager.initFromHistory(conversationHistoryRef.current);

  // 命令注册表（注册所有 23 个命令）
  const commandRegistryRef = useRef(new CommandRegistry());
  const commandsRegistered = useRef(false);
  if (!commandsRegistered.current) {
    commandsRegistered.current = true;
    [autoCommand, semiCommand, manualCommand, pauseCommand, checkpointCommand, rollbackCommand, goalCommand, branchCommand, initCommand, dreamCommand, quitCommand, clearCommand, helpCommand, statusCommand, traceCommand, promptCommand, channelsCommand, costCommand, historyCommand, pluginCommand, diffCommand, buildCommand, planCommand, composeCommand, resumeCommand].forEach(c => commandRegistryRef.current.register(c));
  }

  const systemPrompt = getSystemPrompt(config.general.language);

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
  };
  commandBridgeRef.current = commandBridge; // Phase 21：供 PermissionEngine 中间件使用

  // GoalRunner（目标分解与执行）
  const goalRunnerRef = useRef(createGoalRunner({
    classifier, modelRouter, clientManager, tracker,
    agentLoop: deps.agentLoop,
    checkpointManager: deps.checkpointManager,
    contextManager: deps.contextManager,
    config, systemPrompt,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    currentPlanRef, awaitingGoalConfirmRef,
    addSystemMessage: (content: string) => setMessages(prev => [...prev, { id: nextId(), role: 'system', content }]),
    requestPlanEdit: (plan: GoalPlan) => commandBridge.requestPlanEdit(plan),
    setIsProcessing, nextId,
  }));

  // ChatRunner（非命令聊天执行）
  const chatRunnerRef = useRef(createChatRunner({
    classifier, modelRouter, clientManager, tracker,
    agentLoop: deps.agentLoop,
    contextManager: deps.contextManager,
    visionAssistant: deps.visionAssistant,
    config, systemPrompt,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    setMessages, setIsProcessing, setCurrentModel, setCurrentTier,
    setIsDegraded, setTodayTokensUsed, nextId,
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
        handleConfigReload(configRef.current as unknown as Record<string, unknown>, fresh).forEach((m: string) =>
          setMessages(p => [...p, { id: nextId(), role: 'system', content: m }]),
        );
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

  // Phase 22：插件系统初始化——独立 useEffect，依赖 [] 仅运行一次
    useEffect(() => {
      initPluginSystem(deps.pluginRegistry).catch(err => logger.warn('Plugin init failed', { error: String(err) }));
    }, [deps]);

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
      // 未知命令
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `未知命令: ${text.split(' ')[0]}。输入 /help 查看可用命令。` }]);
      setIsProcessing(false);
      return;
    }

    // 5. 非命令输入 → 委托给 ChatRunner
    setIsProcessing(true);
    await chatRunnerRef.current.runChat(text);
  }, [buildServiceContext, commandBridge]);

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
        <ChatView messages={messages} />
        {editingPlan && <StepEditor plan={editingPlan} onConfirm={(s) => { pendingPlanEditRef.current?.resolve(s); pendingPlanEditRef.current = null; setEditingPlan(null); }} onCancel={() => { pendingPlanEditRef.current?.resolve(null); pendingPlanEditRef.current = null; setEditingPlan(null); }} />}
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
        />
      </Box>
      <Box paddingX={1}>
        <InputBox onSubmit={handleSubmit} disabled={isProcessing || !!confirmDialog} />
      </Box>
    </Box>
  );
}

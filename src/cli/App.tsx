// src/cli/App.tsx
// 主应用组件：整合 ChatView + StatusBar + InputBox，管理消息状态
// Phase 5: 使用 ReAct Agent Loop 替代直接 LLM 调用

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box } from 'ink';
import { ChatView, type ChatMessage } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import type { ScenarioTier, LLMMessage, ILLMClient } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { AppConfig } from '../config/schema.js';
import { ReActAgentLoop } from '../agent/loop.js';
import { getSystemPrompt } from '../agent/prompts.js';
import type { ReActEvent } from '../agent/loop-config.js';
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
import { PermissionChecker } from '../tools/permission.js';
import { MCPClientManager } from '../tools/mcp/client.js';
import { logger } from '../utils/logger.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import type { GoalPlan } from '../agent/goal-types.js';
import type { AutonomyMode } from '../config/schema.js';
import { CheckpointManager } from '../harness/checkpoint-manager.js';
import { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import { ContextManager } from '../agent/memory/context-manager.js';
import { VisionAssistant } from '../agent/vision.js';
import type { ImageInput } from '../agent/vision.js';
import { BranchManager } from '../agent/branch.js';
import { InitAnalyzer } from '../agent/init-analyzer.js';
import { DreamConsolidator } from '../agent/dream-consolidator.js';

interface AppProps {
  config: AppConfig;
  clientManager: LLMClientManager;
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  tracker: TokenTracker;
}

let messageIdCounter = 0;
function nextId(): string {
  return `msg-${++messageIdCounter}`;
}

export function App({ config, clientManager, classifier, modelRouter, tracker }: AppProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: 'system',
      content: 'RouteDev 已就绪。输入消息开始对话，输入 /help 查看命令列表。',
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>(config.autonomy.defaultMode);
  const [workMode] = useState('build');
  const [currentModel, setCurrentModel] = useState('gpt-4o-mini');
  const [currentTier, setCurrentTier] = useState<ScenarioTier>('simple');
  const [isDegraded, setIsDegraded] = useState(false);
  const [todayTokensUsed, setTodayTokensUsed] = useState(0);

  // 对话历史（用于传递给 ReAct Loop）
  const conversationHistoryRef = useRef<LLMMessage[]>([]);

  // 工具确认 pending resolve（Phase 9 自主模式）
  const pendingConfirmRef = useRef<{
    resolve: (approved: boolean) => void;
    toolName: string;
  } | null>(null);

  // 目标确认 pending resolve（Phase 9 /goal 命令）
  const awaitingGoalConfirmRef = useRef<{
    resolve: (approved: boolean) => void;
    plan: GoalPlan;
  } | null>(null);

  // 当前目标计划（执行中）
  const currentPlanRef = useRef<GoalPlan | null>(null);

  // 检查点管理器（Phase 10）
  const checkpointManagerRef = useRef(new CheckpointManager({
    enabled: config.checkpoint.enabled,
    maxCheckpoints: 10,
    workingDirectory: process.cwd(),
  }));

  // AbortController 用于 /pause 命令
  const abortControllerRef = useRef<AbortController | null>(null);

  // Phase 11：CheckpointWriter + ContextManager
  const checkpointModelId = config.checkpoint.modelId;
  const checkpointProvider = config.providers.find(p =>
    p.models.some(m => m.id === checkpointModelId)
  );
  const fallbackClient: ILLMClient | undefined = clientManager.listAll().values().next().value;
  const checkpointClient: ILLMClient = (checkpointProvider
    ? clientManager.get(checkpointProvider.id) ?? fallbackClient
    : fallbackClient) as ILLMClient;

  const writerRef = useRef(new CheckpointWriter(
    checkpointClient,
    checkpointModelId,
    config.checkpoint.maxTokensPerCheckpoint,
  ));

  const currentModelConfig = config.providers
    .flatMap(p => p.models)
    .find(m => m.id === currentModel);

  const contextManagerRef = useRef(new ContextManager(
    {
      contextWindow: currentModelConfig?.contextWindow ?? 128000,
      compressionThreshold: 0.8,
      keepRecentMessages: 6,
      checkpointEnabled: config.checkpoint.enabled,
    },
    writerRef.current,
  ));

  // Phase 12：VisionAssistant
  const visionAssistantRef = useRef(new VisionAssistant(
    config.providers,
    (providerId: string) => clientManager.get(providerId),
  ));

  // Phase 12：BranchManager
  const branchManagerRef = useRef(new BranchManager());
  branchManagerRef.current.initFromHistory(conversationHistoryRef.current);

  // Phase 12：InitAnalyzer（懒创建）
  const primaryProviderId = config.providers[0]?.id ?? 'default';
  const primaryClient = clientManager.get(primaryProviderId) ?? fallbackClient;
  const initAnalyzerRef = useRef<InitAnalyzer | null>(null);
  if (!initAnalyzerRef.current && primaryClient) {
    initAnalyzerRef.current = new InitAnalyzer({
      llmClient: primaryClient,
      modelId: config.router.classifierModel,
      rootPath: process.cwd(),
    });
  }

  // Phase 12：DreamConsolidator
  const dreamConsolidatorRef = useRef(new DreamConsolidator({
    llmClient: primaryClient ?? checkpointClient,
    modelId: config.router.classifierModel,
  }));

  // 初始化工具注册表
  const registryRef = useRef(new ToolRegistry());
  if (registryRef.current.size === 0) {
    registryRef.current.register(new FileReadTool());
    registryRef.current.register(new FileWriteTool());
    registryRef.current.register(new FileSearchTool());
    registryRef.current.register(new ShellExecTool());
    registryRef.current.register(new GitOpTool());
    registryRef.current.register(new WebSearchTool());
    registryRef.current.register(new CodeSearchTool());
  }

  // 初始化 MCP 客户端管理器
  const mcpManagerRef = useRef(new MCPClientManager(registryRef.current));
  const [mcpStatus, setMcpStatus] = useState('disconnected');

  // 自动连接配置的 MCP servers
  useEffect(() => {
    async function connectMcpServers() {
      if (!config.mcp.autoConnect) return;

      const enabledServers = config.mcp.servers.filter(s => s.enabled);
      if (enabledServers.length === 0) return;

      setMcpStatus('connecting');
      for (const server of enabledServers) {
        const info = await mcpManagerRef.current.connect(server);
        if (info.status === 'error') {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `MCP server "${server.name}" 连接失败: ${info.error}`,
          }]);
        }
      }
      setMcpStatus(mcpManagerRef.current.connectedCount > 0 ? 'connected' : 'disconnected');
    }

    connectMcpServers().catch(err => {
      logger.error('Failed to connect MCP servers', { error: String(err) });
    });

    return () => {
      mcpManagerRef.current.disconnectAll().catch(err => {
        logger.error('Failed to disconnect MCP servers', { error: String(err) });
      });
    };
  }, [config.mcp.autoConnect, config.mcp.servers]);

  // 初始化 CheckpointManager（Phase 10）
  useEffect(() => {
    checkpointManagerRef.current.init().catch(err => {
      logger.warn('CheckpointManager init failed', { error: String(err) });
    });
  }, []);

  // Phase 11：加载持久化的 memory checkpoint
  useEffect(() => {
    contextManagerRef.current.loadCheckpoint().catch(err => {
      logger.warn('ContextManager loadCheckpoint failed', { error: String(err) });
    });
  }, []);

  // 初始化权限检查器（Phase 9 自主模式）
  const permissionCheckerRef = useRef(
    new PermissionChecker(config.autonomy.defaultMode, config.autonomy.autoApprovePatterns),
  );
  permissionCheckerRef.current.addRule({ toolPattern: 'file_*', level: 'auto', description: '文件操作自动执行' });
  permissionCheckerRef.current.addRule({ toolPattern: 'code_search', level: 'auto', description: '代码搜索自动执行' });
  permissionCheckerRef.current.addRule({ toolPattern: 'shell_exec', level: 'confirm', description: 'Shell 命令需要确认' });
  permissionCheckerRef.current.addRule({ toolPattern: 'git_op', level: 'confirm', description: 'Git 写操作需要确认' });
  permissionCheckerRef.current.addRule({ toolPattern: 'web_search', level: 'confirm', description: '网络搜索需要确认' });

  // 初始化安全检查器
  const securityCheckerRef = useRef(new SecurityChecker(process.cwd(), config.security));

  // 初始化工具执行器
  const toolExecutorRef = useRef(new ToolExecutor(registryRef.current));
  toolExecutorRef.current.setPermissionChecker(permissionCheckerRef.current);
  toolExecutorRef.current.setSecurityChecker(securityCheckerRef.current);

  // 创建桥梁适配器
  const adapterRef = useRef(new ToolRegistryAdapter(
    registryRef.current,
    toolExecutorRef.current,
    {
      workingDirectory: process.cwd(),
      allowedDirectories: [process.cwd()],
      environment: process.env as Record<string, string>,
      timeoutMs: 30000,
    }
  ));

  // ReAct Agent Loop 实例（启用工具）
  const agentLoopRef = useRef<ReActAgentLoop>(
    new ReActAgentLoop(adapterRef.current, {
      maxIterations: 10,
      toolsEnabled: true,
    })
  );

  // 系统提示
  const systemPrompt = getSystemPrompt(config.general.language);

  const handleSubmit = useCallback(async (text: string) => {
    // 1. 工具确认 pending 优先
    if (pendingConfirmRef.current) {
      const pending = pendingConfirmRef.current;
      pendingConfirmRef.current = null;
      const approved = /^[yY]/.test(text.trim());
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        content: `${approved ? '✅ 已批准' : '❌ 已拒绝'}: ${pending.toolName}`,
      }]);
      pending.resolve(approved);
      return;
    }

    // 2. 目标确认 pending
    if (awaitingGoalConfirmRef.current) {
      const pending = awaitingGoalConfirmRef.current;
      awaitingGoalConfirmRef.current = null;
      const approved = /^[yY]/.test(text.trim());
      if (approved) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '✅ 已确认，开始执行目标计划...',
        }]);
        currentPlanRef.current = pending.plan;
        executeGoalPlan(pending.plan).catch(err => {
          logger.error('Goal plan execution failed', { error: String(err) });
        });
      } else {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '❌ 已取消目标计划',
        }]);
      }
      pending.resolve(approved);
      return;
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
    };
    setMessages(prev => [...prev, userMsg]);

    // 处理命令
    if (text.startsWith('/')) {
      handleCommand(text);
      return;
    }

    setIsProcessing(true);

    try {
      // 1. 场景分类
      const classifyResult = await classifier.classify({ query: text });
      setCurrentTier(classifyResult.tier);

      // 2. 路由决策
      const routeDecision = await modelRouter.route(classifyResult);
      setCurrentModel(routeDecision.model.id);
      setIsDegraded(routeDecision.degraded);

      // 3. 获取 LLM 客户端
      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        const errMsg: ChatMessage = {
          id: nextId(),
          role: 'system',
          content: `错误: 提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。`,
        };
        setMessages(prev => [...prev, errMsg]);
        setIsProcessing(false);
        return;
      }

      // 4. 创建助手消息（流式更新）
      const assistantId = nextId();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        tier: classifyResult.tier,
        modelId: routeDecision.model.id,
        isStreaming: true,
      };
      setMessages(prev => [...prev, assistantMsg]);

      // 5. 运行 ReAct Agent Loop
      let accumulatedContent = '';
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // Phase 12：处理 @图片引用
      let actualUserMessage = text;
      const imageRefs = VisionAssistant.extractImageReferences(text);
      if (imageRefs.length > 0 && (VisionAssistant.needsVision(text) || true)) {
        const loadedImages: ImageInput[] = [];
        for (const ref of imageRefs) {
          const img = await VisionAssistant.loadImage(ref);
          if (img) loadedImages.push(img);
        }
        if (loadedImages.length > 0) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `📷 正在分析 ${loadedImages.length} 张图片...`,
          }]);
          const visionResult = await visionAssistantRef.current.analyze(
            loadedImages,
            `用户问题: ${text}`,
          );
          if (visionResult) {
            // 用图片描述替换 @filename 引用
            actualUserMessage = text;
            for (const img of loadedImages) {
              if (img.fileName) {
                actualUserMessage = actualUserMessage.replace(`@${img.fileName}`, `[图片:${img.fileName}]`);
              }
            }
            actualUserMessage = `[图片分析结果]\n${visionResult.description}\n\n[用户原问题]\n${actualUserMessage}`;
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `✓ 图片分析完成（${visionResult.modelId}，${visionResult.inputTokens + visionResult.outputTokens} tokens）`,
            }]);
          } else {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '⚠️ 没有可用的多模态模型，将按纯文本处理',
            }]);
          }
        }
      }

      try {
        // Phase 10：为本次对话创建 AbortController
        const chatAbort = new AbortController();
        abortControllerRef.current = chatAbort;
        for await (const event of agentLoopRef.current.run({
          userMessage: actualUserMessage,
          llmClient: client,
          routeDecision,
          conversationHistory: conversationHistoryRef.current,
          systemPrompt,
          signal: chatAbort.signal,
          onConfirmTool: async (toolName, args) => {
            return new Promise<boolean>(resolve => {
              pendingConfirmRef.current = { resolve, toolName };
              const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
              setMessages(prev => [...prev, {
                id: nextId(),
                role: 'system',
                content: `⚠️  工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`,
              }]);
              setIsProcessing(false);
            });
          },
        })) {
          // 处理事件
          switch (event.type) {
            case 'text_delta':
              accumulatedContent += event.text;
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId
                    ? { ...m, content: accumulatedContent }
                    : m
                )
              );
              break;

            case 'tool_call_start':
              setMessages(prev => [...prev, {
                id: nextId(),
                role: 'system',
                content: `🔧 调用工具: ${event.toolName}`,
              }]);
              break;

            case 'approval_required':
              // approval_required 事件本身只是信号，真正的提示在 onConfirmTool 中已经发出
              break;

            case 'tool_call_result':
              if (event.isError) {
                setMessages(prev => [...prev, {
                  id: nextId(),
                  role: 'system',
                  content: `❌ 工具 ${event.toolName} 执行失败`,
                }]);
              }
              break;

            case 'error':
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId
                    ? { ...m, content: accumulatedContent + `\n⚠️ ${event.error}` }
                    : m
                )
              );
              break;

            case 'done':
              finalUsage = event.usage;
              break;
          }
        }

        // 更新 Token 统计
        setTodayTokensUsed(prev => prev + finalUsage.totalTokens);
        tracker.record(finalUsage, {
          modelId: routeDecision.model.id,
          agentId: 'default',
          stepId: 'chat',
        });

        // 更新对话历史
        conversationHistoryRef.current.push({ role: 'user', content: actualUserMessage });
        conversationHistoryRef.current.push({ role: 'assistant', content: accumulatedContent });

        // 限制历史长度（保留最近 20 条）
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
        }

        // ===== Phase 11：增量 Checkpoint + 压缩 =====
        if (config.checkpoint.enabled) {
          const usagePercent = tracker.getUsagePercent();
          const triggers = config.checkpoint.triggers.map(t => ({
            level: t.level,
            action: t.action as 'initial' | 'incremental' | 'compress',
          }));

          const triggerAction = contextManagerRef.current.shouldTriggerCheckpoint(usagePercent, triggers);
          if (triggerAction) {
            const cp = await contextManagerRef.current.triggerCheckpoint(
              triggerAction,
              conversationHistoryRef.current,
              usagePercent,
            );
            if (cp) {
              setMessages(prev => [...prev, {
                id: nextId(),
                role: 'system',
                content: `🧠 记忆已保存 (${triggerAction}): ${cp.currentIntent}`,
              }]);
              await contextManagerRef.current.saveCheckpoint();
            }
          }

          // 上下文压缩检查
          const estimatedTokens = conversationHistoryRef.current.reduce((acc, msg) => {
            const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            return acc + Math.ceil(text.length / 4);
          }, 0);

          if (contextManagerRef.current.shouldCompress(
            conversationHistoryRef.current.length,
            estimatedTokens,
          )) {
            const { compressed, result } = contextManagerRef.current.compress(
              conversationHistoryRef.current,
            );
            conversationHistoryRef.current = compressed;
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `📦 上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条`,
            }]);
          }
        }

        // 完成流式输出
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId
              ? { ...m, content: accumulatedContent, isStreaming: false }
              : m
          )
        );
      } catch (error) {
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId
              ? { ...m, content: `错误: ${error instanceof Error ? error.message : String(error)}`, isStreaming: false }
              : m
          )
        );
      }
    } catch (error) {
      const errMsg: ChatMessage = {
        id: nextId(),
        role: 'system',
        content: `错误: ${error instanceof Error ? error.message : String(error)}`,
      };
      setMessages(prev => [...prev, errMsg]);
    } finally {
      setIsProcessing(false);
    }
  }, [classifier, modelRouter, clientManager, tracker, systemPrompt]);

  const handleCommand = useCallback(async (text: string) => {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/help':
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: [
            '可用命令：',
            '  /help               - 显示帮助',
            '  /status             - 查看当前状态',
            '  /auto               - 切换到全自动模式',
            '  /semi               - 切换到半自动模式（关键操作确认）',
            '  /manual             - 切换到手动模式（所有操作确认）',
            '  /goal "目标"        - 目标分解与执行（可选 --verify "验证条件"）',
            '  /pause              - 中断当前执行',
            '  /memory show        - 查看当前记忆',
            '  /memory write       - 手动写入记忆',
            '  /memory clear       - 清除记忆',
            '  /branch list        - 查看对话分支',
            '  /branch edit N ...  - 在第 N 条消息创建分支',
            '  /branch switch ID   - 切换到指定分支',
            '  /init               - 分析项目结构生成 .routedev-rules.md',
            '  /dream              - 整理记忆（合并去重）',
            '  /channels list      - 查看已配置的渠道',
            '  /checkpoint list    - 查看所有检查点',
            '  /checkpoint create  - 手动创建检查点',
            '  /rollback <id>      - 回滚到指定检查点（破坏性操作）',
            '  /clear              - 清空对话',
            '  /quit               - 退出',
          ].join('\n'),
        }]);
        break;

      case '/auto':
        setAutonomyMode('auto');
        permissionCheckerRef.current.setAutonomyMode('auto');
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '🤖 已切换到 auto 模式：所有工具调用自动执行（无确认）',
        }]);
        break;

      case '/semi':
        setAutonomyMode('semi');
        permissionCheckerRef.current.setAutonomyMode('semi');
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '🌓 已切换到 semi 模式：confirm 级别工具需确认',
        }]);
        break;

      case '/manual':
        setAutonomyMode('manual');
        permissionCheckerRef.current.setAutonomyMode('manual');
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '🖐️  已切换到 manual 模式：所有 confirm 级别工具需确认',
        }]);
        break;

      case '/goal':
        // 解析 /goal "目标" --verify "验证条件"
        handleGoalCommand(text).catch(err => {
          logger.error('Goal command failed', { error: String(err) });
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `❌ /goal 命令失败: ${err instanceof Error ? err.message : String(err)}`,
          }]);
        });
        break;

      case '/pause':
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '⏸ 已中断当前执行。后续步骤已跳过。',
          }]);
          if (currentPlanRef.current?.status === 'executing') {
            currentPlanRef.current.status = 'failed';
          }
          setIsProcessing(false);
        } else {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '当前没有正在执行的任务。',
          }]);
        }
        break;

      case '/checkpoint': {
        const subCmd = parts[1]?.toLowerCase();
        if (subCmd === 'create') {
          const desc = parts.slice(2).join(' ') || '手动创建的检查点';
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '💾 正在创建检查点...',
          }]);
          const cp = await checkpointManagerRef.current.create({
            description: desc,
            isAutoCreated: false,
          });
          if (cp) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `💾 检查点已创建: cp-${cp.id} (${cp.gitCommitHash.slice(0, 7)}, ${cp.filesSnapshot.length} 个文件)`,
            }]);
          } else {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '检查点创建失败（可能没有变更或不在 Git 仓库中）。',
            }]);
          }
        } else if (subCmd === undefined || subCmd === 'list') {
          const cps = checkpointManagerRef.current.list();
          if (cps.length === 0) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '没有检查点记录。检查点会在 /goal 步骤执行前自动创建。',
            }]);
          } else {
            const lines = cps.map((cp, i) => {
              const time = new Date(cp.timestamp).toLocaleString('zh-CN');
              const auto = cp.isAutoCreated ? '自动' : '手动';
              const files = cp.filesSnapshot.length;
              return `  ${i + 1}. [cp-${cp.id}] ${cp.description}\n     ${time} | ${cp.gitCommitHash.slice(0, 7)} | ${files} 文件 | ${auto}`;
            });
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `检查点列表 (${cps.length}):\n${lines.join('\n')}`,
            }]);
          }
        } else {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: [
              '检查点命令：',
              '  /checkpoint list    - 查看所有检查点',
              '  /checkpoint create  - 手动创建检查点',
            ].join('\n'),
          }]);
        }
        break;
      }

      case '/rollback': {
        const cpId = parts[1];
        if (!cpId) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '用法: /rollback <checkpoint-id>\n例: /rollback a1b2c3d4\n使用 /checkpoint list 查看可用检查点。',
          }]);
          break;
        }
        const cps = checkpointManagerRef.current.list();
        const target = cps.find(c => c.id === cpId || c.id.startsWith(cpId));
        if (!target) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `未找到检查点 "${cpId}"。使用 /checkpoint list 查看可用检查点。`,
          }]);
          break;
        }
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: [
            `⚠️ 即将回滚到检查点: cp-${target.id}`,
            `  描述: ${target.description}`,
            `  提交: ${target.gitCommitHash.slice(0, 7)}`,
            `  时间: ${new Date(target.timestamp).toLocaleString('zh-CN')}`,
            '',
            `⚠️ 这是破坏性操作（git reset --hard），回滚后当前未提交的变更将丢失！`,
            `输入 y 确认回滚，n 取消`,
          ].join('\n'),
        }]);
        const confirmed = await new Promise<boolean>((resolve) => {
          pendingConfirmRef.current = {
            resolve,
            toolName: `回滚到 cp-${target.id}`,
          };
        });
        if (confirmed) {
          const success = await checkpointManagerRef.current.rollback(target.id);
          if (success) {
            const remaining = checkpointManagerRef.current.count;
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `✓ 已回滚到 cp-${target.id} (${target.gitCommitHash.slice(0, 7)})。剩余 ${remaining} 个检查点。`,
            }]);
          } else {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '回滚失败。请检查 Git 状态。',
            }]);
          }
        } else {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '回滚已取消。',
          }]);
        }
        break;
      }

      case '/status':
        const stats = tracker.getStats();
        const cpCount = checkpointManagerRef.current.count;
        const cpEnabled = checkpointManagerRef.current.isEnabled;
        const memoryCheckpoint = contextManagerRef.current.getCheckpoint();
        const memoryStatus = memoryCheckpoint
          ? `有 (${memoryCheckpoint.currentIntent.slice(0, 30)})`
          : '无';
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: [
            `当前模型: ${currentModel}`,
            `场景等级: ${currentTier}`,
            `已降级: ${isDegraded ? '是' : '否'}`,
            `自主度模式: ${autonomyMode}`,
            `今日 Token: ${stats.total.totalTokens}`,
            `对话历史: ${conversationHistoryRef.current.length} 条消息`,
            `检查点: ${cpCount} 个${cpEnabled ? '' : ' (未启用 / 非 Git 仓库)'}`,
            `记忆: ${memoryStatus}`,
            `分支: ${branchManagerRef.current.listBranches().length} 个 (active: ${branchManagerRef.current.getActiveBranchId()?.slice(0, 4) ?? '无'})`,
            `MCP: ${mcpManagerRef.current.connectedCount} 个 server, ${mcpManagerRef.current.totalToolCount} 个工具`,
          ].join('\n'),
        }]);
        break;

      case '/clear':
        setMessages([{
          id: nextId(),
          role: 'system',
          content: '对话已清空。',
        }]);
        conversationHistoryRef.current = [];
        // Phase 11：重置 memory 触发状态
        contextManagerRef.current.resetTriggers();
        break;

      case '/memory': {
        const subCmd = parts[1]?.toLowerCase();

        if (subCmd === 'show' || subCmd === undefined) {
          const checkpoint = contextManagerRef.current.getCheckpoint();
          if (!checkpoint) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '还没有记忆数据。记忆会在 token 消耗达到阈值时自动创建。',
            }]);
          } else {
            const lines: string[] = [
              `🧠 当前记忆：`,
              `  意图: ${checkpoint.currentIntent}`,
              `  下一步: ${checkpoint.nextAction || '无'}`,
              `  约束: ${checkpoint.workingConstraints.length > 0 ? checkpoint.workingConstraints.join('; ') : '无'}`,
              `  当前文件: ${checkpoint.currentWorkingFiles.length > 0 ? checkpoint.currentWorkingFiles.join(', ') : '无'}`,
              `  涉及文件: ${checkpoint.involvedFiles.length} 个`,
              `  错误记录: ${checkpoint.errorsAndFixes.length} 条`,
              `  设计决策: ${checkpoint.designDecisions.length} 条`,
            ];
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: lines.join('\n'),
            }]);
          }
        } else if (subCmd === 'notes') {
          const notes = await writerRef.current.readNotes();
          if (!notes.trim()) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: 'notes.md 为空。',
            }]);
          } else {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `📝 notes.md:\n${notes}`,
            }]);
          }
        } else if (subCmd === 'write') {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '🧠 正在手动写入记忆...',
          }]);
          const usagePercent = tracker.getUsagePercent();
          const cp = await contextManagerRef.current.triggerCheckpoint(
            'incremental',
            conversationHistoryRef.current,
            usagePercent,
          );
          if (cp) {
            await contextManagerRef.current.saveCheckpoint();
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `🧠 记忆已保存: ${cp.currentIntent}`,
            }]);
          } else {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '记忆写入失败。',
            }]);
          }
        } else if (subCmd === 'clear') {
          contextManagerRef.current.resetTriggers();
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '记忆已清除。下次对话将重新开始记忆积累。',
          }]);
        } else {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: [
              '记忆命令：',
              '  /memory show   - 查看当前记忆',
              '  /memory notes  - 查看 notes.md',
              '  /memory write  - 手动写入记忆',
              '  /memory clear  - 清除记忆',
            ].join('\n'),
          }]);
        }
        break;
      }

      case '/branch': {
        const subCmd = parts[1]?.toLowerCase();

        if (subCmd === 'list' || subCmd === undefined) {
          const branches = branchManagerRef.current.listBranches();
          if (branches.length === 0) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '没有分支。在消息前输入 /branch edit 可以创建分支。',
            }]);
          } else {
            const lines = branches.map((b, i) => {
              const marker = b.isActive ? '→' : ' ';
              return `  ${marker} [${i + 1}] ${b.id} - ${b.name} (${b.messageCount} 条消息)`;
            });
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `对话分支 (${branches.length}):\n${lines.join('\n')}`,
            }]);
          }
        } else if (subCmd === 'edit') {
          const editArg = parts.slice(2).join(' ');
          // 格式: /branch edit <index> <new content>
          const spaceIdx = editArg.indexOf(' ');
          if (spaceIdx < 0) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '用法: /branch edit <消息索引> <新内容>\n例: /branch edit 3 修正一下: 这个函数应该返回字符串',
            }]);
            break;
          }
          const indexStr = editArg.slice(0, spaceIdx);
          const newContent = editArg.slice(spaceIdx + 1);
          const idx = parseInt(indexStr, 10);
          if (isNaN(idx) || idx < 1) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `无效的索引: ${indexStr}（应为正整数）`,
            }]);
            break;
          }
          const newBranchId = branchManagerRef.current.editByHistoryIndex(idx - 1, newContent);
          if (newBranchId) {
            // 用新分支的消息路径替换 conversationHistoryRef
            const newPath = branchManagerRef.current.getPath(newBranchId);
            conversationHistoryRef.current = newPath;
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `🌿 已创建新分支 [${newBranchId}]，第 ${idx} 条消息已替换为新内容。\n使用 /branch switch 切换回主线。`,
            }]);
          } else {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `编辑失败: 索引 ${idx} 超出范围`,
            }]);
          }
        } else if (subCmd === 'switch') {
          const targetId = parts[2];
          if (!targetId) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '用法: /branch switch <branch-id>\n使用 /branch list 查看所有分支。',
            }]);
            break;
          }
          const newPath = branchManagerRef.current.switchBranch(targetId);
          if (newPath) {
            conversationHistoryRef.current = newPath;
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `✓ 已切换到分支 [${branchManagerRef.current.getActiveBranchId()}]`,
            }]);
          } else {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `未找到分支 "${targetId}"`,
            }]);
          }
        } else {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: [
              '分支对话命令：',
              '  /branch list          - 查看所有分支',
              '  /branch edit N <...>  - 在第 N 条消息处创建分支',
              '  /branch switch <id>   - 切换到指定分支',
            ].join('\n'),
          }]);
        }
        break;
      }

      case '/init': {
        if (!initAnalyzerRef.current) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '❌ InitAnalyzer 不可用（没有 LLM 客户端）',
          }]);
          break;
        }
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '🔍 正在分析项目结构...',
        }]);
        try {
          const info = await initAnalyzerRef.current.analyze();
          const rules = await initAnalyzerRef.current.generateRules(info);
          const filePath = await initAnalyzerRef.current.saveRules(rules);
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `✓ 项目规则已生成: ${filePath}\n- 主要语言: ${info.primaryLanguage}\n- 检测到框架: ${info.detectedFrameworks.join(', ') || '无'}\n- 包含测试: ${info.hasTests ? '是' : '否'}`,
          }]);
        } catch (error) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `❌ /init 失败: ${error instanceof Error ? error.message : String(error)}`,
          }]);
        }
        break;
      }

      case '/dream': {
        const checkpoint = contextManagerRef.current.getCheckpoint();
        if (!checkpoint) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '没有记忆可整理。请先与 AI 对话积累记忆。',
          }]);
          break;
        }
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '💤 正在整理记忆...',
        }]);
        const result = await dreamConsolidatorRef.current.consolidate(checkpoint);
        contextManagerRef.current.setCheckpoint(result.consolidated);
        await contextManagerRef.current.saveCheckpoint();
        await dreamConsolidatorRef.current.saveToDisk(result.consolidated, result);
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: result.summary,
        }]);
        break;
      }

      case '/channels': {
        const subCmd = parts[1]?.toLowerCase();
        if (subCmd === 'list' || subCmd === undefined) {
          const entries = config.channels.entries;
          if (entries.length === 0) {
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: [
                '未配置任何渠道。',
                '',
                '要使用渠道功能：',
                '  1. 在 config.yaml 的 channels.entries 中添加渠道配置',
                '  2. 运行 `routedev serve` 启动服务器模式',
                '  3. 在企业微信管理后台配置回调 URL',
              ].join('\n'),
            }]);
          } else {
            const lines = entries.map(e => {
              const hasCreds = e.type === 'wechat-work'
                ? !!(e.options.corpId && e.options.corpSecret)
                : Object.keys(e.options).length > 0;
              const status = e.enabled ? (hasCreds ? '✓ 已配置' : '⚠ 缺少凭据') : '✗ 已禁用';
              return `  ${status}  [${e.type}] ${e.id} - ${e.enabled ? '启用' : '禁用'}`;
            });
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: [
                `已配置渠道 (${entries.length}):`,
                ...lines,
                '',
                `服务器端口: ${config.channels.port}`,
                `响应长度限制: ${config.channels.maxResponseLength}`,
              ].join('\n'),
            }]);
          }
        } else if (subCmd === 'port') {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `服务器端口: ${config.channels.port}\n使用 'routedev serve' 启动`,
          }]);
        } else {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: [
              '渠道命令：',
              '  /channels list  - 查看已配置的渠道',
              '  /channels port  - 查看服务器端口',
            ].join('\n'),
          }]);
        }
        break;
      }

      case '/quit':
      case '/exit':
        console.log('\n再见！');
        process.exit(0);
        break;

      default:
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: `未知命令: ${cmd}。输入 /help 查看可用命令。`,
        }]);
    }

    setIsProcessing(false);
  }, [currentModel, currentTier, isDegraded, tracker]);

  // /goal 命令处理：解析目标描述与验证条件，调用 GoalParser 生成计划，请求用户确认
  const handleGoalCommand = useCallback(async (text: string) => {
    setIsProcessing(true);

    // 解析: /goal "目标描述" --verify "验证条件"
    const goalMatch = text.match(/^\/goal\s+"([^"]+)"/);
    if (!goalMatch) {
      // 尝试无引号匹配（目标描述不含空格）
      const noQuoteMatch = text.match(/^\/goal\s+(\S+)/);
      if (!noQuoteMatch) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: '❌ 用法: /goal "目标描述" [--verify "验证条件"]',
        }]);
        setIsProcessing(false);
        return;
      }
      var description = noQuoteMatch[1];
    } else {
      var description = goalMatch[1];
    }

    const verifyMatch = text.match(/--verify\s+"([^"]+)"/);
    const verificationCriteria = verifyMatch ? verifyMatch[1] : undefined;

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system',
      content: `🎯 解析目标: ${description}${verificationCriteria ? `\n验证条件: ${verificationCriteria}` : ''}`,
    }]);

    // 路由决策（用于 GoalParser）
    const classifyResult = await classifier.classify({ query: description });
    const routeDecision = await modelRouter.route(classifyResult);
    const client = clientManager.get(routeDecision.providerId);
    if (!client || !client.isReady()) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        content: `❌ 错误: 提供商 ${routeDecision.providerId} 不可用`,
      }]);
      setIsProcessing(false);
      return;
    }

    const parser = new GoalParser();
    const plan = await parser.parse(description, {
      verificationCriteria,
      routeDecision,
      llmClient: client,
    });

    // 展示步骤计划
    const planText = [
      '📋 目标计划：',
      ...plan.steps.map(s => `  ${s.id}. ${s.description}`),
      '',
      '确认开始执行？[y/n]',
    ].join('\n');

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system',
      content: planText,
    }]);

    // 等待用户确认
    awaitingGoalConfirmRef.current = {
      resolve: () => { /* 实际 resolve 在 handleSubmit 中完成 */ },
      plan,
    };
    // 不调用 resolve，awaitingGoalConfirmRef 由 handleSubmit 清空
  }, [classifier, modelRouter, clientManager]);
  const executeGoalPlan = useCallback(async (plan: GoalPlan) => {
    setIsProcessing(true);
    plan.status = 'executing';
    currentPlanRef.current = plan;

    // Phase 10：持久化 GoalPlan
    await checkpointManagerRef.current.saveGoalPlan(plan);

    for (const step of plan.steps) {
      // Phase 10：检查是否已被 /pause 中断
      if (abortControllerRef.current?.signal.aborted) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: `⏸ 目标已暂停。已完成 ${plan.steps.indexOf(step)}/${plan.steps.length} 个步骤。`,
        }]);
        plan.status = 'failed';
        break;
      }

      // Phase 10：步骤执行前自动创建检查点
      if (config.checkpoint.enabled) {
        const checkpoint = await checkpointManagerRef.current.create({
          description: `步骤 ${step.id} 前快照: ${step.description.slice(0, 40)}`,
          stepId: step.id,
          goalId: plan.id,
          isAutoCreated: true,
        });
        if (checkpoint) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `💾 检查点已创建: cp-${checkpoint.id} (${checkpoint.filesSnapshot.length} 个文件)`,
          }]);
        }
      }

      step.status = 'in_progress';
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        content: `▶ 步骤 ${step.id}/${plan.steps.length}: ${step.description}`,
      }]);

      try {
        const classifyResult = await classifier.classify({ query: step.description });
        const routeDecision = await modelRouter.route(classifyResult);
        const client = clientManager.get(routeDecision.providerId);
        if (!client || !client.isReady()) {
          step.status = 'failed';
          step.error = `提供商 ${routeDecision.providerId} 不可用`;
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `❌ 步骤 ${step.id} 失败: ${step.error}`,
          }]);
          continue;
        }

        let stepContent = '';
        // Phase 10：每个步骤创建独立的 AbortController
        const stepAbort = new AbortController();
        abortControllerRef.current = stepAbort;
        for await (const event of agentLoopRef.current.run({
          userMessage: step.description,
          llmClient: client,
          routeDecision,
          conversationHistory: conversationHistoryRef.current,
          systemPrompt,
          signal: stepAbort.signal,
          onConfirmTool: async (toolName, args) => {
            return new Promise<boolean>(resolve => {
              pendingConfirmRef.current = { resolve, toolName };
              const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
              setMessages(prev => [...prev, {
                id: nextId(),
                role: 'system',
                content: `⚠️  目标步骤 · 工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}`,
              }]);
            });
          },
        })) {
          if (event.type === 'text_delta') stepContent += event.text;
          if (event.type === 'done') {
            tracker.record(event.usage, {
              modelId: routeDecision.model.id,
              agentId: 'goal',
              stepId: `step-${step.id}`,
            });
          }
        }

        step.status = 'completed';
        step.result = stepContent.slice(0, 200);
        conversationHistoryRef.current.push({ role: 'user', content: step.description });
        conversationHistoryRef.current.push({ role: 'assistant', content: stepContent });
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
        }

        // ===== Phase 11：步骤间 checkpoint + 压缩 =====
        if (config.checkpoint.enabled) {
          const usagePercent = tracker.getUsagePercent();
          const triggers = config.checkpoint.triggers.map(t => ({
            level: t.level,
            action: t.action as 'initial' | 'incremental' | 'compress',
          }));

          const triggerAction = contextManagerRef.current.shouldTriggerCheckpoint(usagePercent, triggers);
          if (triggerAction) {
            await contextManagerRef.current.triggerCheckpoint(
              triggerAction,
              conversationHistoryRef.current,
              usagePercent,
            );
            await contextManagerRef.current.saveCheckpoint();
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `🧠 步骤间记忆已保存 (${triggerAction})`,
            }]);
          }

          const estimatedTokens = conversationHistoryRef.current.reduce((acc, msg) => {
            const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            return acc + Math.ceil(text.length / 4);
          }, 0);

          if (contextManagerRef.current.shouldCompress(conversationHistoryRef.current.length, estimatedTokens)) {
            const { compressed } = contextManagerRef.current.compress(conversationHistoryRef.current);
            conversationHistoryRef.current = compressed;
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '📦 上下文已压缩（步骤间）',
            }]);
          }
        }
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: `✅ 步骤 ${step.id} 完成`,
        }]);
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: `❌ 步骤 ${step.id} 失败: ${step.error}`,
        }]);
      }
    }

    plan.status = 'verifying';
    plan.completedAt = Date.now();
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system',
      content: '🔍 正在验证目标完成度...',
    }]);

    // 验证：使用 verifier 路由
    try {
      const verifierQuery = plan.description;
      const verifyClassify = await classifier.classify({ query: verifierQuery });
      const verifyRoute = await modelRouter.route(verifyClassify);
      const verifyClient = clientManager.get(verifyRoute.providerId);
      if (verifyClient && verifyClient.isReady()) {
        const verifier = new GoalVerifier();
        const result = await verifier.verify(plan, {
          routeDecision: verifyRoute,
          llmClient: verifyClient,
        });
        plan.verificationResult = result;
        plan.status = result.passed ? 'completed' : 'failed';
        const passedIcon = result.passed ? '✅' : '⚠️';
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: `${passedIcon} 验证结果 (置信度 ${(result.confidence * 100).toFixed(0)}%): ${result.reasoning}\n${result.missingItems.length > 0 ? `缺失项: ${result.missingItems.join('; ')}` : ''}`,
        }]);
      }
    } catch (error) {
      logger.error('Goal verification failed', { error: String(error) });
      plan.status = 'completed';
    }

    currentPlanRef.current = null;
    setIsProcessing(false);
  }, [classifier, modelRouter, clientManager, tracker, systemPrompt]);

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView messages={messages} />
      </Box>
      <Box paddingX={1}>
        <StatusBar
          currentModel={currentModel}
          currentTier={currentTier}
          isDegraded={isDegraded}
          todayTokensUsed={todayTokensUsed}
          autonomyMode={autonomyMode}
          workMode={workMode}
        />
      </Box>
      <Box paddingX={1}>
        <InputBox onSubmit={handleSubmit} disabled={isProcessing} />
      </Box>
    </Box>
  );
}

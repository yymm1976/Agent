// src/cli/App.tsx
// 主应用组件：整合 ChatView + StatusBar + InputBox，管理消息状态
// Phase 5: 使用 ReAct Agent Loop 替代直接 LLM 调用

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box } from 'ink';
import { ChatView, type ChatMessage } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import type { ScenarioTier, LLMMessage } from '../router/types.js';
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
  const [autonomyMode] = useState(config.autonomy.defaultMode);
  const [workMode] = useState('build');
  const [currentModel, setCurrentModel] = useState('gpt-4o-mini');
  const [currentTier, setCurrentTier] = useState<ScenarioTier>('simple');
  const [isDegraded, setIsDegraded] = useState(false);
  const [todayTokensUsed, setTodayTokensUsed] = useState(0);

  // 对话历史（用于传递给 ReAct Loop）
  const conversationHistoryRef = useRef<LLMMessage[]>([]);

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

  // 初始化权限检查器（MVP：confirm 级别自动放行）
  const permissionCheckerRef = useRef(new PermissionChecker(true));
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

      try {
        for await (const event of agentLoopRef.current.run({
          userMessage: text,
          llmClient: client,
          routeDecision,
          conversationHistory: conversationHistoryRef.current,
          systemPrompt,
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
        conversationHistoryRef.current.push({ role: 'user', content: text });
        conversationHistoryRef.current.push({ role: 'assistant', content: accumulatedContent });

        // 限制历史长度（保留最近 20 条）
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
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

  const handleCommand = useCallback((text: string) => {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/help':
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: [
            '可用命令：',
            '  /help     - 显示帮助',
            '  /status   - 查看当前状态',
            '  /clear    - 清空对话',
            '  /quit     - 退出',
          ].join('\n'),
        }]);
        break;

      case '/status':
        const stats = tracker.getStats();
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: [
            `当前模型: ${currentModel}`,
            `场景等级: ${currentTier}`,
            `已降级: ${isDegraded ? '是' : '否'}`,
            `今日 Token: ${stats.total.totalTokens}`,
            `对话历史: ${conversationHistoryRef.current.length} 条消息`,
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
        break;

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

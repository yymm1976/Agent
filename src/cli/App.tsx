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
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import type { GoalPlan } from '../agent/goal-types.js';
import type { AutonomyMode } from '../config/schema.js';
import { CheckpointManager } from '../harness/checkpoint-manager.js';

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

      try {
        // Phase 10：为本次对话创建 AbortController
        const chatAbort = new AbortController();
        abortControllerRef.current = chatAbort;
        for await (const event of agentLoopRef.current.run({
          userMessage: text,
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

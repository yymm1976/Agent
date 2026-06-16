// src/cli/App.tsx
// 主应用组件：整合 ChatView + StatusBar + InputBox，管理消息状态

import React, { useState, useCallback } from 'react';
import { Box } from 'ink';
import { ChatView, type ChatMessage } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import type { ScenarioTier } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { AppConfig } from '../config/schema.js';

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

      // 4. 构建消息列表
      const llmMessages = [
        { role: 'system' as const, content: '你是 RouteDev，一个智能开发助手。用中文回答。' },
        { role: 'user' as const, content: text },
      ];

      // 5. 调用 LLM（非流式简化版本）
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

      try {
        const response = await client.complete({
          model: routeDecision.model.id,
          messages: llmMessages,
          maxTokens: 4000,
        });

        // 更新 Token 统计
        setTodayTokensUsed(prev => prev + response.usage.totalTokens);
        tracker.record(response.usage, {
          modelId: routeDecision.model.id,
          agentId: 'default',
          stepId: 'chat',
        });

        // 更新消息
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId
              ? { ...m, content: response.content, isStreaming: false }
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
  }, [classifier, modelRouter, clientManager, tracker]);

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
          ].join('\n'),
        }]);
        break;

      case '/clear':
        setMessages([{
          id: nextId(),
          role: 'system',
          content: '对话已清空。',
        }]);
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

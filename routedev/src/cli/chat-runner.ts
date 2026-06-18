// src/cli/chat-runner.ts
// 聊天运行器：从 App.tsx 提取的非命令输入处理逻辑
// 负责：分类路由 → 视觉处理 → Agent Loop 迭代 → Token 统计 → 检查点/压缩

import type { LLMMessage, ILLMClient, ScenarioTier } from '../router/types.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { TokenTracker } from '../router/tracker.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import { VisionAssistant, type ImageInput } from '../agent/vision.js';
import type { AppConfig } from '../config/schema.js';
import type { ChatMessage } from './components/ChatView.js';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { notifyRoutingFallback } from './notification.js';

/** ChatRunner 依赖的外部对象（由 App.tsx 注入） */
export interface ChatRunnerDeps {
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  clientManager: LLMClientManager;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  contextManager: ContextManager;
  visionAssistant: VisionAssistant;
  config: AppConfig;
  systemPrompt: string;
  /** 对话历史 ref（会被读写） */
  conversationHistoryRef: { current: LLMMessage[] };
  /** 工具确认 pending ref（会被读写） */
  pendingConfirmRef: { current: { resolve: (approved: boolean) => void; toolName: string } | null };
  /** 中断控制器 ref（会被读写） */
  abortControllerRef: { current: AbortController | null };
  /** 设置消息（用于追加/更新消息） */
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  /** 设置处理状态 */
  setIsProcessing: (v: boolean) => void;
  /** 设置当前模型 */
  setCurrentModel: (m: string) => void;
  /** 设置当前场景层级 */
  setCurrentTier: (t: ScenarioTier) => void;
  /** 设置降级标志 */
  setIsDegraded: (v: boolean) => void;
  /** 累加今日 Token 用量 */
  setTodayTokensUsed: (updater: (prev: number) => number) => void;
  /** 生成消息 ID */
  nextId: () => string;
}

/** 创建聊天运行器 */
export function createChatRunner(deps: ChatRunnerDeps) {
  const {
    classifier, modelRouter, clientManager, tracker, agentLoop,
    contextManager, visionAssistant, config, systemPrompt,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    setMessages, setIsProcessing, setCurrentModel, setCurrentTier,
    setIsDegraded, setTodayTokensUsed, nextId,
  } = deps;

  /**
   * 处理非命令输入：分类路由 → 视觉处理 → Agent Loop → Token 统计 → 检查点/压缩
   * 调用方需在调用前已将用户消息追加到 messages，并设置 isProcessing=true
   */
  async function runChat(text: string): Promise<void> {
    try {
      const classifyResult = await classifier.classify({ query: text });
      setCurrentTier(classifyResult.tier);
      const routeDecision = await modelRouter.route(classifyResult);
      const fallbackNotice = notifyRoutingFallback(routeDecision);
      if (fallbackNotice) {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: fallbackNotice }]);
      }
      setCurrentModel(routeDecision.model.id);
      setIsDegraded(routeDecision.degraded);

      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `错误: 提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。` }]);
        setIsProcessing(false);
        return;
      }

      const assistantId = nextId();
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', tier: classifyResult.tier, modelId: routeDecision.model.id, isStreaming: true }]);

      let accumulatedContent = '';
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // 处理 @图片引用
      let actualUserMessage = text;
      const imageRefs = VisionAssistant.extractImageReferences(text);
      if (imageRefs.length > 0) {
        const loadedImages: ImageInput[] = [];
        for (const ref of imageRefs) {
          const img = await VisionAssistant.loadImage(ref, process.cwd());
          if (img) loadedImages.push(img);
        }
        if (loadedImages.length > 0) {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📷 正在分析 ${loadedImages.length} 张图片...` }]);
          const visionResult = await visionAssistant.analyze(loadedImages, `用户问题: ${text}`);
          if (visionResult) {
            for (const img of loadedImages) {
              if (img.fileName) actualUserMessage = actualUserMessage.replace(`@${img.fileName}`, `[图片:${img.fileName}]`);
            }
            actualUserMessage = `[图片分析结果]\n${visionResult.description}\n\n[用户原问题]\n${actualUserMessage}`;
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `✓ 图片分析完成（${visionResult.modelId}，${visionResult.inputTokens + visionResult.outputTokens} tokens）` }]);
          }
        }
      }

      try {
        const chatAbort = new AbortController();
        abortControllerRef.current = chatAbort;
        for await (const event of agentLoop.run({
          userMessage: actualUserMessage, llmClient: client, routeDecision,
          conversationHistory: conversationHistoryRef.current, systemPrompt,
          signal: chatAbort.signal,
          onConfirmTool: async (toolName, args) => new Promise<boolean>(resolve => {
            pendingConfirmRef.current = { resolve, toolName };
            const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `⚠️  工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}` }]);
            setIsProcessing(false);
          }),
        })) {
          switch (event.type) {
            case 'text_delta':
              accumulatedContent += event.text;
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulatedContent } : m));
              break;
            case 'tool_call_start':
              setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `🔧 调用工具: ${event.toolName}` }]);
              break;
            case 'tool_call_result':
              if (event.isError) setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `❌ 工具 ${event.toolName} 执行失败` }]);
              break;
            case 'error':
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulatedContent + `\n⚠️ ${event.error}` } : m));
              break;
            case 'done':
              finalUsage = event.usage;
              break;
          }
        }

        // 更新 Token 统计 + 对话历史
        setTodayTokensUsed(prev => prev + finalUsage.totalTokens);
        tracker.record(finalUsage, { modelId: routeDecision.model.id, agentId: 'default', stepId: 'chat' });
        conversationHistoryRef.current.push({ role: 'user', content: actualUserMessage });
        conversationHistoryRef.current.push({ role: 'assistant', content: accumulatedContent });
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
        }

        // 增量 Checkpoint + 压缩
        if (config.checkpoint.enabled) {
          const usagePercent = tracker.getUsagePercent();
          const triggers = config.checkpoint.triggers.map(t => ({ level: t.level, action: t.action as 'initial' | 'incremental' | 'compress' }));
          const triggerAction = contextManager.shouldTriggerCheckpoint(usagePercent, triggers);
          if (triggerAction) {
            const cp = await contextManager.triggerCheckpoint(triggerAction, conversationHistoryRef.current, usagePercent);
            if (cp) {
              setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `🧠 记忆已保存 (${triggerAction}): ${cp.currentIntent}` }]);
              await contextManager.saveCheckpoint();
            }
          }
          const estimatedTokens = conversationHistoryRef.current.reduce((acc, msg) => {
            const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            return acc + estimateTokens(t);
          }, 0);
          if (contextManager.shouldCompress(conversationHistoryRef.current.length, estimatedTokens)) {
            const { compressed, result } = contextManager.compress(conversationHistoryRef.current);
            conversationHistoryRef.current = compressed;
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📦 上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条` }]);
          }
        }

        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulatedContent, isStreaming: false } : m));
      } catch (error) {
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: `错误: ${error instanceof Error ? error.message : String(error)}`, isStreaming: false } : m));
      }
    } catch (error) {
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `错误: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setIsProcessing(false);
    }
  }

  return { runChat };
}

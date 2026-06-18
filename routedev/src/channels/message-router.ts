// src/channels/message-router.ts
// MessageRouter：处理渠道消息（classify → route → LLM → 回复）
// 渠道模式不执行工具（避免渠道用户无法确认的情况）

import type { ChannelMessage, ChannelType } from './types.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, LLMMessage } from '../router/types.js';
import type { ModelRouter } from '../router/router.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { TokenTracker } from '../router/tracker.js';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { DEFAULT_SYSTEM_PROMPT_ZH } from '../agent/prompts.js';

export interface MessageRouterConfig {
  maxResponseLength: number;
  /** 用户上下文有效期（ms） */
  contextTtlMs: number;
  /** 模型上下文窗口 */
  contextWindow: number;
  /** 压缩阈值 */
  compressionThreshold: number;
}

export interface UserContext {
  userId: string;
  channelType: ChannelType;
  history: LLMMessage[];
  lastActiveAt: number;
  totalMessages: number;
}

export interface MessageRouterDeps {
  llmClient: ILLMClient;
  router: ModelRouter;
  classifier: ScenarioClassifier;
  tracker: TokenTracker;
}

export class MessageRouter {
  private userContexts = new Map<string, UserContext>();
  private config: MessageRouterConfig;
  private deps: MessageRouterDeps;

  constructor(config: MessageRouterConfig, deps: MessageRouterDeps) {
    this.config = config;
    this.deps = deps;
  }

  async handleMessage(message: ChannelMessage): Promise<string> {
    const userId = `${message.channelType}:${message.sender.id}`;

    // 1. 获取或创建用户上下文
    let ctx = this.userContexts.get(userId);
    if (!ctx) {
      ctx = {
        userId,
        channelType: message.channelType,
        history: [],
        lastActiveAt: Date.now(),
        totalMessages: 0,
      };
      this.userContexts.set(userId, ctx);
    }
    ctx.lastActiveAt = Date.now();
    ctx.totalMessages++;

    // 2. 记录用户消息
    ctx.history.push({ role: 'user', content: message.text });

    // 3. 上下文压缩检查
    const estimatedTokens = ctx.history.reduce((acc, h) => {
      const text = typeof h.content === 'string' ? h.content : '';
      return acc + estimateTokens(text);
    }, 0);
    if (estimatedTokens > this.config.contextWindow * this.config.compressionThreshold) {
      const keepCount = 4;
      const summary: string[] = [`[历史摘要] 之前有 ${ctx.history.length - keepCount} 条对话`];
      const summaryContent = this.extractFileMentions(
        ctx.history.slice(0, ctx.history.length - keepCount),
      );
      if (summaryContent) summary.push(`提及文件: ${summaryContent}`);
      ctx.history = [
        { role: 'user', content: summary.join('\n') },
        ...ctx.history.slice(-keepCount),
      ];
    }

    // 4. 路由决策
    let modelId = '';
    let contextWindow = this.config.contextWindow;
    try {
      const classification = await this.deps.classifier.classify({
        query: message.text,
        context: {},
      });
      const routing = await this.deps.router.route(classification);
      modelId = routing.model.id;
      contextWindow = routing.model.contextWindow ?? contextWindow;
    } catch (error) {
      logger.error('MessageRouter: routing failed', { error: String(error) });
      return '抱歉，路由服务暂时不可用。';
    }

    // 5. 调用 LLM（直接调用，渠道模式不执行工具）
    const systemPrompt = DEFAULT_SYSTEM_PROMPT_ZH +
      '\n\n当前是渠道模式（企业微信等），请给出简洁、清晰的回复。';
    const messages: LLMMessage[] = [
      ...ctx.history.slice(0, -1),
      ctx.history[ctx.history.length - 1],
    ];

    const request: LLMRequestOptions = {
      model: modelId,
      messages,
      systemPrompt,
      maxTokens: 1500,
      temperature: 0.7,
    };

    let responseText = '';
    let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    try {
      const response: LLMResponse = await this.deps.llmClient.complete(request);
      responseText = response.content;
      finalUsage = response.usage;
    } catch (error) {
      logger.error('MessageRouter: LLM call failed', { error: String(error) });
      return '抱歉，处理消息时发生错误。';
    }

    this.deps.tracker.record(finalUsage, {
      modelId,
      agentId: 'channel',
      stepId: message.channelType,
    });

    // 6. 记录助手回复
    ctx.history.push({ role: 'assistant', content: responseText });

    // 7. 限制历史长度
    if (ctx.history.length > 20) {
      ctx.history = ctx.history.slice(-20);
    }

    return responseText;
  }

  /** 获取用户上下文（用于调试） */
  getUserContext(userId: string): UserContext | undefined {
    return this.userContexts.get(userId);
  }

  /** 获取所有用户上下文数量 */
  getUserCount(): number {
    return this.userContexts.size;
  }

  /** 清理过期用户上下文 */
  cleanupExpiredContexts(): number {
    const now = Date.now();
    let removed = 0;
    for (const [userId, ctx] of this.userContexts) {
      if (now - ctx.lastActiveAt > this.config.contextTtlMs) {
        this.userContexts.delete(userId);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info('Cleaned up expired user contexts', { count: removed });
    }
    return removed;
  }

  /** 长回复分段（适配渠道字符限制） */
  splitLongResponse(text: string, maxLength?: number): string[] {
    const max = maxLength ?? this.config.maxResponseLength;
    if (text.length <= max) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= max) {
        chunks.push(remaining);
        break;
      }
      let cutAt = remaining.lastIndexOf('\n', max);
      if (cutAt < max / 2) cutAt = remaining.lastIndexOf('。', max);
      if (cutAt < max / 2) cutAt = remaining.lastIndexOf('. ', max);
      if (cutAt < max / 2) cutAt = max;

      chunks.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }
    return chunks;
  }

  private extractFileMentions(messages: LLMMessage[]): string {
    const files = new Set<string>();
    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      const matches = text.match(/[\w/.-]+\.[a-z]{1,5}/g);
      if (matches) matches.forEach(f => files.add(f));
    }
    return [...files].slice(0, 10).join(', ');
  }

  /** 重置所有用户上下文 */
  reset(): void {
    this.userContexts.clear();
  }
}
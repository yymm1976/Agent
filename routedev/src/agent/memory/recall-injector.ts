// src/agent/memory/recall-injector.ts
// Phase 71 Task B3：记忆召回注入器——把 KnowledgeGraph.recall() 结果格式化为 system prompt 片段
//
// 工作时机：
//   - 由 ReActAgentLoop.run() 在每轮循环开始时调用 recallToPrompt(userMessage)
//   - 召回结果按 injectThreshold 过滤后格式化为【相关记忆】片段
//   - 注入到 systemPrompt 末尾，让 LLM 在推理时能引用历史决策/事实
//
// fail-open 原则：
//   - graph.recall 抛错时返回空字符串，不阻塞 ReAct 循环
//   - 空查询返回空字符串

import type { KnowledgeGraph } from './graph.js';
import { logger } from '../../utils/logger.js';

/** 召回并适配后的记忆条目（对外暴露，便于测试与扩展） */
export interface RecalledMemory {
  /** 记忆内容（GraphNode.content） */
  fact: string;
  /** 置信度（recall 返回的 score，综合 PPR 与置信度） */
  confidence: number;
  /** 来源（GraphNode.type：'fact'|'decision'|'skill'|'event'） */
  source: string;
  /** 召回时间戳 */
  recalledAt: number;
}

/**
 * 记忆召回注入器
 *
 * 把 KnowledgeGraph.recall() 的原始结果适配为 RecalledMemory，
 * 按 injectThreshold 过滤后格式化为可注入 system prompt 的字符串片段。
 */
export class MemoryRecallInjector {
  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly injectThreshold: number = 0.7,
    private readonly maxMemories: number = 5,
  ) {}

  /**
   * 根据当前 query 召回相关记忆，格式化为 system prompt 片段。
   *
   * @param query 当前用户消息或上下文查询字符串
   * @returns 格式化后的【相关记忆】片段；无召回或全部低于阈值时返回空字符串
   *
   * fail-open：graph.recall 抛错时返回空字符串，不阻塞主流程
   */
  recallToPrompt(query: string): string {
    try {
      if (!query || query.trim().length === 0) return '';
      const memories = this.graph.recall(query, { maxResults: this.maxMemories });
      // 适配 GraphNode → RecalledMemory
      const adapted: RecalledMemory[] = memories.map(m => ({
        fact: m.node.content,
        confidence: m.score,
        source: m.node.type,
        recalledAt: Date.now(),
      }));
      const filtered = adapted.filter(m => m.confidence >= this.injectThreshold);
      if (filtered.length === 0) return '';

      const lines = filtered.map(m =>
        `- ${m.fact}（置信度: ${m.confidence.toFixed(2)}, 来源: ${m.source}）`,
      );
      return `\n\n【相关记忆】\n${lines.join('\n')}`;
    } catch (err) {
      logger.warn('memory recall failed, fail-open', { err });
      return ''; // fail-open
    }
  }
}

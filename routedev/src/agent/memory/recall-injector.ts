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
// Phase 71 Task B4：episodic memory（type-only import，避免运行时循环依赖）
import type { EpisodicMemory } from './episodic-memory.js';
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
    /**
     * Phase 71 Task B4：episodic memory（可选）
     * 注入后 recallToPromptWithEpisodes 会额外召回相似 episode 的解决路径
     */
    private readonly episodicMemory?: EpisodicMemory,
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

  /**
   * Phase 71 Task B4：增强版召回——注入相关记忆 + 相似 episode 的解决路径
   *
   * 在原 recallToPrompt 基础上，额外召回 episodic memory 中相似问题的解决路径，
   * 让 LLM 在遇到相似问题时能复用历史成功路径（学习 OpenHands episode replay）。
   *
   * @param query 当前用户消息或上下文查询字符串
   * @returns 格式化后的【相关记忆】+【相似解决路径】片段；无召回时返回原 recallToPrompt 结果
   *
   * fail-open：
   *   - episodicMemory 未注入时只返回 memoryPrompt（向后兼容）
   *   - recallSimilar 抛错时只返回 memoryPrompt（recallSimilar 内部已 try/catch，此处再加一层保险）
   */
  async recallToPromptWithEpisodes(query: string): Promise<string> {
    const memoryPrompt = this.recallToPrompt(query);
    if (!this.episodicMemory) return memoryPrompt;

    try {
      const episodes = await this.episodicMemory.recallSimilar(query, 2);
      if (episodes.length === 0) return memoryPrompt;

      const episodeLines = episodes.map(e =>
        `- 相似问题「${e.query}」的解决路径：${e.solutionPath.join(' → ')}`,
      );
      return memoryPrompt + `\n\n【相似解决路径】\n${episodeLines.join('\n')}`;
    } catch (err) {
      logger.warn('episodic recall failed, fail-open', { err });
      return memoryPrompt; // fail-open
    }
  }
}

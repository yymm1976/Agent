// src/agent/memory/episodic-memory.ts
// Phase 71 Task B4：episodic memory——把成功的问题解决路径作为 episode 存储
// 遇到相似问题时复用，学习 OpenHands 的 episode replay 机制
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

export interface Episode {
  /** 唯一 ID */
  id: string;
  /** 用户原始问题 */
  query: string;
  /** 解决步骤摘要（按顺序） */
  solutionPath: string[];
  /** 结果：成功/失败 */
  outcome: 'success' | 'failure';
  /** 使用的工具列表 */
  toolsUsed: string[];
  /** 总耗时（毫秒） */
  durationMs: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 标签（用于分类检索） */
  tags: string[];
}

export class EpisodicMemory {
  constructor(private storePath: string) {}

  /** 存储 episode（追加写入 JSONL 文件） */
  async store(episode: Episode): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      const line = JSON.stringify(episode) + '\n';
      await fs.appendFile(this.storePath, line, 'utf-8');
    } catch (err) {
      logger.warn('episodic memory store failed, fail-open', { err });
    }
  }

  /** 召回相似 episode（关键词匹配，P2 可升级为 embedding） */
  async recallSimilar(query: string, limit = 3): Promise<Episode[]> {
    try {
      const content = await fs.readFile(this.storePath, 'utf-8');
      const episodes: Episode[] = content.trim().split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Episode);
      return episodes
        .map(e => ({ episode: e, score: this.scoreSimilarity(query, e.query) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.episode);
    } catch {
      return []; // fail-open：文件不存在或损坏时返回空
    }
  }

  /** Jaccard 相似度评分（关键词交集 / 并集） */
  private scoreSimilarity(query: string, episodeQuery: string): number {
    const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
    const episodeWords = new Set(episodeQuery.toLowerCase().split(/\s+/).filter(Boolean));
    if (queryWords.size === 0 || episodeWords.size === 0) return 0;
    const intersection = [...queryWords].filter(w => episodeWords.has(w));
    return intersection.length / Math.max(queryWords.size, episodeWords.size);
  }
}

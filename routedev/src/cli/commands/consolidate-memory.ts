// src/cli/commands/consolidate-memory.ts
// 记忆整理命令：/consolidate-memory
// Phase 57：从 /dream 改名，去拟人化措辞
// Phase 60：删除 /dream deprecated alias，/consolidate-memory 是唯一入口

import type { CommandDefinition } from '../command-registry.js';
import { consolidateToGraph } from '../../agent/memory/consolidation.js';
import { logger } from '../../utils/logger.js';

export const consolidateMemoryCommand: CommandDefinition = {
  name: 'consolidate-memory',
  description: '整理项目记忆到知识图谱',
  handler: async (_args, ctx) => {
    const { contextManager, commandBridge } = ctx;

    const checkpoint = contextManager.getCheckpoint();
    if (!checkpoint) {
      return { type: 'handled', messages: ['没有记忆可整理。请先与 AI 对话积累记忆。'] };
    }

    commandBridge.addSystemMessage('📋 正在整理记忆...');
    // Phase 57：记忆整理逻辑（原 DreamConsolidator 已在 Phase 56 删除）
    // 当前仅执行知识图谱注入，不做 LLM 整理
    const messages: string[] = ['记忆整理完成'];

    try {
      const ingest = consolidateToGraph({ consolidated: checkpoint }, contextManager.getKnowledgeGraph());
      messages.push(
        `知识图谱注入：新建 ${ingest.created}，合并 ${ingest.merged}，替代 ${ingest.superseded}，归档 ${ingest.archived}`,
      );
      contextManager.saveGraphToDisk();
    } catch (e) {
      logger.warn('consolidateToGraph 失败，已跳过', { error: String(e) });
    }

    return { type: 'handled', messages };
  },
};

// src/cli/commands/dream.ts
// 记忆整理命令：/dream

import type { CommandDefinition } from '../command-registry.js';
import { ingestToGraph } from '../../agent/memory/dream-to-graph.js';
import { logger } from '../../utils/logger.js';

export const dreamCommand: CommandDefinition = {
  name: 'dream',
  description: '整理与巩固对话记忆',
  handler: async (_args, ctx) => {
    const { dream, contextManager, commandBridge } = ctx;

    const checkpoint = contextManager.getCheckpoint();
    if (!checkpoint) {
      return { type: 'handled', messages: ['没有记忆可整理。请先与 AI 对话积累记忆。'] };
    }

    commandBridge.addSystemMessage('💤 正在整理记忆...');
    const result = await dream.consolidate(checkpoint);
    contextManager.setCheckpoint(result.consolidated);
    await contextManager.saveCheckpoint();
    await dream.saveToDisk(result.consolidated, result);

    // Phase 38 Task 3.1：将 dream 结果注入知识图谱（失败不阻断 /dream）
    const messages = [result.summary];
    try {
      const ingest = ingestToGraph(result, contextManager.getKnowledgeGraph());
      messages.push(
        `知识图谱注入：新建 ${ingest.created}，合并 ${ingest.merged}，替代 ${ingest.superseded}，归档 ${ingest.archived}`,
      );
      // 触发持久化（debounce）
      contextManager.saveGraphToDisk();
    } catch (e) {
      logger.warn('ingestToGraph 失败，已跳过', { error: String(e) });
    }

    return { type: 'handled', messages };
  },
};

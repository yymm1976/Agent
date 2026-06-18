// src/cli/commands/dream.ts
// 记忆整理命令：/dream

import type { CommandDefinition } from '../command-registry.js';

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

    return { type: 'handled', messages: [result.summary] };
  },
};

// src/cli/commands/pause.ts
// 中断当前执行命令：/pause

import type { CommandDefinition } from '../command-registry.js';

export const pauseCommand: CommandDefinition = {
  name: 'pause',
  aliases: ['stop', 'abort'],
  description: '中断当前执行',
  handler: async (_args, ctx) => {
    ctx.commandBridge.requestAbort();
    return { type: 'handled', messages: ['⏸ 已发送中断信号。'] };
  },
};

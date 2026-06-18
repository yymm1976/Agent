// src/cli/commands/quit.ts
// 退出程序命令：/quit

import type { CommandDefinition } from '../command-registry.js';

export const quitCommand: CommandDefinition = {
  name: 'quit',
  aliases: ['exit', 'q'],
  description: '退出程序',
  handler: async (_args, ctx) => {
    // commandBridge.exit() 内部会记录审计日志后调用 process.exit(0)
    ctx.commandBridge.exit();
    return { type: 'handled' }; // 实际不会执行到，exit() 会终止进程
  },
};

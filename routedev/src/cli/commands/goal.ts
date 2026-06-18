// src/cli/commands/goal.ts
// 目标分解与执行命令：/goal "目标描述" [--verify "验证条件"]
// 实际执行委托给 App 内部的 handleGoalCommand（通过 commandBridge.startGoal）

import type { CommandDefinition } from '../command-registry.js';

export const goalCommand: CommandDefinition = {
  name: 'goal',
  description: '目标分解与执行',
  usage: '/goal "目标描述" [--verify "验证条件"]',
  handler: async (args, ctx) => {
    if (!args.trim()) {
      return { type: 'handled', messages: ['用法: /goal "目标描述" [--verify "验证条件"]'] };
    }
    // 委托给 App 内部的 handleGoalCommand
    ctx.commandBridge.startGoal(args);
    return { type: 'handled' };
  },
};

// src/cli/commands/history.ts
// 对话历史摘要查看命令：/history [条数]

import type { CommandDefinition } from '../command-registry.js';

export const historyCommand: CommandDefinition = {
  name: 'history',
  description: '查看对话历史摘要',
  usage: '/history [条数]',
  handler: async (args, ctx) => {
    const { branchManager, commandBridge } = ctx;
    const count = parseInt(args.trim(), 10) || 10;

    const branches = branchManager.listBranches();
    const activeBranch = branches.find(b => b.isActive);

    if (!activeBranch) {
      return { type: 'handled', messages: ['暂无对话历史。'] };
    }

    const state = commandBridge.getState();
    const lines = [
      `对话历史（最近 ${count} 条，分支 ${activeBranch.name}）:`,
      `  总消息数: ${state.conversationHistoryLength}`,
      `  分支消息数: ${activeBranch.messageCount}`,
      `  分支 ID: ${activeBranch.id}`,
      `  创建时间: ${new Date(activeBranch.createdAt).toLocaleString('zh-CN')}`,
    ];

    return { type: 'handled', messages: [lines.join('\n')] };
  },
};

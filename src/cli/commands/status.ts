// src/cli/commands/status.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';

export const statusCommand: CommandDefinition = {
  name: 'status',
  description: '显示系统状态',
  handler: async (_args, ctx) => {
    const { tracker, router, clientManager, config } = ctx;
    const ready = clientManager.getReadyClients();
    const clients = clientManager.listAll();
    const stats = tracker.getStats();
    const lines = [
      '系统状态: 运行中',
      `模型就绪: ${ready.length}/${clients.size}`,
      `预算模式: ${config.router.budget.mode}`,
      `日预算: ${config.router.budget.dailyLimit}`,
      `Token 使用: ${stats.total.totalTokens ?? 0} tokens`,
    ];
    return { type: 'handled', messages: [lines.join('\n')] };
  },
};

// src/cli/commands/cost.ts
// Token 用量与费用查看命令：/cost

import type { CommandDefinition } from '../command-registry.js';

export const costCommand: CommandDefinition = {
  name: 'cost',
  description: '查看 Token 用量与费用',
  handler: async (_args, ctx) => {
    const { tracker } = ctx;
    const stats = tracker.getStats();

    const lines: string[] = ['Token 用量统计:'];
    lines.push(
      `  总计: ${stats.total.totalTokens ?? 0} tokens (输入 ${stats.total.inputTokens ?? 0}, 输出 ${stats.total.outputTokens ?? 0})`,
    );

    // byModel 是 Record<string, TokenUsageInfo>，不是 Map
    const modelEntries = Object.entries(stats.byModel);
    if (modelEntries.length > 0) {
      lines.push('\n按模型:');
      for (const [model, usage] of modelEntries) {
        lines.push(`  ${model}: ${usage.totalTokens ?? 0} tokens`);
      }
    }

    const agentEntries = Object.entries(stats.byAgent);
    if (agentEntries.length > 0) {
      lines.push('\n按 Agent:');
      for (const [agent, usage] of agentEntries) {
        lines.push(`  ${agent}: ${usage.totalTokens ?? 0} tokens`);
      }
    }

    return { type: 'handled', messages: [lines.join('\n')] };
  },
};

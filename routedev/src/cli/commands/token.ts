// src/cli/commands/token.ts
// Phase 30 Task 1：Token 可观测性命令 /token
// 展示当前会话的 TokenProfiler 汇总（各组件平均占比、Top 3 消耗者、最近 5 次快照）

import type { CommandDefinition } from '../command-registry.js';
import { formatTokenProfileText } from '../../agent/token-profiler.js';

export const tokenCommand: CommandDefinition = {
  name: 'token',
  description: '查看 Token 用量分析（Phase 30：分组件可观测性）',
  usage: '/token',
  handler: async (_args, ctx) => {
    // 优先使用 profiler（Phase 30 分组件可观测性）
    if (ctx.profiler) {
      const text = formatTokenProfileText(ctx.profiler);
      return { type: 'handled', messages: [text] };
    }

    // fallback：profiler 未启用时展示 tracker 的基础统计
    const { tracker } = ctx;
    const stats = tracker.getStats();
    const lines: string[] = [
      '📊 Token 用量统计（无分组件分析，未启用 TokenProfiler）',
      '───────────────────────────',
      `总计：${stats.total.totalTokens ?? 0} tokens`,
      `  输入：${stats.total.inputTokens ?? 0}`,
      `  输出：${stats.total.outputTokens ?? 0}`,
      '',
      `预算使用：${Math.round(tracker.getUsagePercent() * 100)}%`,
      '',
      '💡 提示：在配置中设置 optimization.tokenTracking.enabled: true 可启用分组件可观测性',
    ];
    return { type: 'handled', messages: [lines.join('\n')] };
  },
};

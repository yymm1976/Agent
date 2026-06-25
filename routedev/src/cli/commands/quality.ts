// src/cli/commands/quality.ts
// Phase 40 Task 3：/quality 命令——质量仪表盘
// 展示各模型的调用次数、成功率、负面信号率
// 展示最近 N 次隐式反馈信号的时间线
// 展示总体任务完成率估算

import type { CommandDefinition } from '../command-registry.js';
import { getGlobalQualityAggregator } from '../../agent/quality-aggregator.js';

/** 展示最近反馈信号的数量 */
const RECENT_SIGNALS_LIMIT = 10;

export const qualityCommand: CommandDefinition = {
  name: 'quality',
  description: '查看模型质量仪表盘（Phase 40：质量监测与隐式反馈）',
  usage: '/quality',
  handler: async (_args, _ctx) => {
    const aggregator = getGlobalQualityAggregator();
    const allStats = aggregator.getAllStats();

    const lines: string[] = [
      '📊 模型质量仪表盘',
      '═══════════════════════════════════════',
    ];

    if (allStats.length === 0) {
      lines.push('');
      lines.push('（暂无质量数据）');
      lines.push('');
      lines.push('提示：质量信号会在工具调用和用户行为发生时自动采集。');
      return { type: 'handled', messages: [lines.join('\n')] };
    }

    // 模型质量统计表
    lines.push('');
    lines.push('【各模型质量统计】');
    lines.push('─'.repeat(60));
    lines.push(
      '模型 ID'.padEnd(28) +
      '调用次数'.padStart(8) +
      '负面信号'.padStart(8) +
      '负面率'.padStart(8) +
      '状态'.padStart(8),
    );
    lines.push('─'.repeat(60));

    let totalCalls = 0;
    let totalNegative = 0;

    for (const stat of allStats) {
      totalCalls += stat.totalCalls;
      totalNegative += stat.negativeSignals;
      const degradeInfo = aggregator.shouldDegrade(stat.modelId);
      const coldStart = aggregator.isColdStart(stat.modelId);
      const status = coldStart
        ? '冷启动'
        : degradeInfo.degrade
          ? '⚠️降级'
          : '✓正常';
      lines.push(
        stat.modelId.slice(0, 26).padEnd(28) +
        String(stat.totalCalls).padStart(8) +
        String(stat.negativeSignals).padStart(8) +
        `${(stat.negativeSignalRate * 100).toFixed(1)}%`.padStart(8) +
        status.padStart(8),
      );
    }

    // 总体统计
    lines.push('─'.repeat(60));
    const overallNegativeRate = totalCalls > 0 ? totalNegative / totalCalls : 0;
    const overallSuccessRate = totalCalls > 0 ? 1 - overallNegativeRate : 0;
    lines.push(
      '总计'.padEnd(28) +
      String(totalCalls).padStart(8) +
      String(totalNegative).padStart(8) +
      `${(overallNegativeRate * 100).toFixed(1)}%`.padStart(8),
    );

    // 总体任务完成率估算
    lines.push('');
    lines.push('【总体任务完成率估算】');
    lines.push(`  成功率: ${(overallSuccessRate * 100).toFixed(1)}%`);
    lines.push(`  负面信号率: ${(overallNegativeRate * 100).toFixed(1)}%`);
    lines.push(`  总调用次数: ${totalCalls}`);

    // 降级建议
    const degradeSuggestions = allStats
      .map(s => ({ stat: s, advice: aggregator.shouldDegrade(s.modelId) }))
      .filter(x => x.advice.degrade);
    if (degradeSuggestions.length > 0) {
      lines.push('');
      lines.push('【⚠️ 降级建议】');
      for (const { stat, advice } of degradeSuggestions) {
        lines.push(`  ${stat.modelId}: ${advice.reason}`);
      }
    }

    // 冷启动模型
    const coldStartModels = allStats.filter(s => aggregator.isColdStart(s.modelId));
    if (coldStartModels.length > 0) {
      lines.push('');
      lines.push('【冷启动期模型】（样本不足，暂不评估降级）');
      for (const s of coldStartModels) {
        lines.push(`  ${s.modelId}: ${s.totalCalls} 次（需 ≥50 次才脱离冷启动）`);
      }
    }

    lines.push('');
    lines.push('─'.repeat(60));
    lines.push(`最近展示 ${RECENT_SIGNALS_LIMIT} 条反馈信号时间线请通过 /trace audit 查看`);

    return { type: 'handled', messages: [lines.join('\n')] };
  },
};

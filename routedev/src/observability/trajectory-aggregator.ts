// src/observability/trajectory-aggregator.ts
// Phase 35 Task 4：跨会话轨迹聚合分析
//
// 输入：多条 TrajectoryBundle（由 TrajectoryExporter 导出）
// 输出：AggregatedMetrics（跨会话的聚合指标）
//
// 与 Phase 34 Task 5 的区别：
//   Phase 34 做单任务级过程指标（一次 goal 执行的 token/工具调用/重试次数）
//   本模块做跨任务级聚合分析（多条轨迹的统计汇总）

import type { TrajectoryBundle } from './trajectory-exporter.js';
import { logger } from '../utils/logger.js';

/**
 * 聚合后的跨会话指标
 */
export interface AggregatedMetrics {
  /** 会话总数 */
  totalSessions: number;
  /** 每个会话的平均 token 消耗（无 token 数据的会话不计入） */
  avgTokensPerSession: number;
  /** 每个 goal 的平均执行耗时（毫秒） */
  avgDurationPerGoal: number;
  /** 成功率（completed / total，0-1） */
  successRate: number;
  /** 工具使用频率 Top 5（按调用次数降序） */
  topToolsByUsage: Array<{ toolName: string; callCount: number }>;
  /** 按模型的 token 分布 */
  modelUsageBreakdown: Record<string, number>;
  /** goal 完成数 */
  completedGoals: number;
  /** goal 失败数 */
  failedGoals: number;
}

/**
 * 轨迹聚合分析器
 *
 * 用法：
 *   const aggregator = new TrajectoryAggregator();
 *   // 方式一：一次性传入所有 bundles
 *   const metrics = aggregator.aggregate(bundles);
 *   // 方式二：随会话推进累积，最后聚合
 *   aggregator.addBundle(bundle1);
 *   aggregator.addBundle(bundle2);
 *   const metrics2 = aggregator.aggregate();
 */
export class TrajectoryAggregator {
  /** Phase 48 Task 6：累积的 bundles（harness 在 endSession 时推入，/trace 命令共享读取） */
  private accumulatedBundles: TrajectoryBundle[] = [];

  /**
   * 累积一条轨迹 bundle
   *
   * 设计目的：让 TraceCollector 在 endSession 时把当前会话的 bundle 推入，
   * 之后 /trace summary 命令调用 aggregate() 即可拿到包含当前会话的聚合结果，
   * 实现 harness 与 /trace 命令共享同一 aggregator 实例。
   *
   * @param bundle 单条轨迹快照
   */
  addBundle(bundle: TrajectoryBundle): void {
    this.accumulatedBundles.push(bundle);
  }

  /**
   * 读取已累积的 bundles（供 /trace 命令与磁盘读取的 bundles 合并使用）
   */
  getAccumulatedBundles(): TrajectoryBundle[] {
    return [...this.accumulatedBundles];
  }

  /**
   * 聚合多条轨迹
   *
   * @param bundles 轨迹快照列表；不传时使用 addBundle() 累积的 bundles
   * @returns 聚合指标
   */
  aggregate(bundles?: TrajectoryBundle[]): AggregatedMetrics {
    const target = bundles ?? this.accumulatedBundles;
    if (target.length === 0) {
      return {
        totalSessions: 0,
        avgTokensPerSession: 0,
        avgDurationPerGoal: 0,
        successRate: 0,
        topToolsByUsage: [],
        modelUsageBreakdown: {},
        completedGoals: 0,
        failedGoals: 0,
      };
    }

    let totalTokens = 0;
    let sessionsWithTokens = 0;
    let totalDuration = 0;
    let goalsWithDuration = 0;
    let completedGoals = 0;
    let failedGoals = 0;
    const toolCounts: Map<string, number> = new Map();
    const modelUsage: Record<string, number> = {};

    for (const bundle of target) {
      // 统计 token
      if (bundle.tokenSummary?.total?.totalTokens) {
        totalTokens += bundle.tokenSummary.total.totalTokens;
        sessionsWithTokens++;
      }

      // 统计 goal 状态和耗时
      if (bundle.goalSummary) {
        if (bundle.goalSummary.status === 'completed') {
          completedGoals++;
        } else if (bundle.goalSummary.status === 'failed') {
          failedGoals++;
        }
        if (bundle.goalSummary.durationMs > 0) {
          totalDuration += bundle.goalSummary.durationMs;
          goalsWithDuration++;
        }
      }

      // 统计工具使用（从 traceRecords 中提取 tool_call 类型）
      for (const record of bundle.traceRecords) {
        if (record.event === 'tool_call' && record.data?.toolName) {
          const toolName = String(record.data.toolName);
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        }
      }

      // 统计模型使用（从 tokenSummary.byModel 中提取）
      if (bundle.tokenSummary?.byModel) {
        for (const [modelId, usage] of Object.entries(bundle.tokenSummary.byModel)) {
          const tokens = usage.totalTokens ?? 0;
          modelUsage[modelId] = (modelUsage[modelId] ?? 0) + tokens;
        }
      }
    }

    // 计算工具使用 Top 5
    const topTools = Array.from(toolCounts.entries())
      .map(([toolName, callCount]) => ({ toolName, callCount }))
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 5);

    const totalGoals = completedGoals + failedGoals;
    const successRate = totalGoals > 0 ? completedGoals / totalGoals : 0;

    const metrics: AggregatedMetrics = {
      totalSessions: target.length,
      avgTokensPerSession: sessionsWithTokens > 0 ? Math.round(totalTokens / sessionsWithTokens) : 0,
      avgDurationPerGoal: goalsWithDuration > 0 ? Math.round(totalDuration / goalsWithDuration) : 0,
      successRate,
      topToolsByUsage: topTools,
      modelUsageBreakdown: modelUsage,
      completedGoals,
      failedGoals,
    };

    logger.info('TrajectoryAggregator: aggregation complete', {
      totalSessions: metrics.totalSessions,
      completedGoals: metrics.completedGoals,
      failedGoals: metrics.failedGoals,
      successRate: metrics.successRate.toFixed(2),
    });

    return metrics;
  }

  /**
   * 将聚合指标格式化为可读文本
   */
  formatAsText(metrics: AggregatedMetrics): string {
    const lines: string[] = [
      '===== 轨迹聚合分析 =====',
      `会话总数: ${metrics.totalSessions}`,
      `Goal 完成: ${metrics.completedGoals} | 失败: ${metrics.failedGoals} | 成功率: ${(metrics.successRate * 100).toFixed(1)}%`,
      `平均 token/会话: ${metrics.avgTokensPerSession}`,
      `平均 goal 耗时: ${metrics.avgDurationPerGoal}ms`,
      '',
      '工具使用 Top 5:',
    ];

    if (metrics.topToolsByUsage.length === 0) {
      lines.push('  (无工具调用记录)');
    } else {
      for (const t of metrics.topToolsByUsage) {
        lines.push(`  ${t.toolName}: ${t.callCount} 次`);
      }
    }

    lines.push('', '模型 token 分布:');
    const modelEntries = Object.entries(metrics.modelUsageBreakdown);
    if (modelEntries.length === 0) {
      lines.push('  (无模型使用记录)');
    } else {
      for (const [modelId, tokens] of modelEntries) {
        lines.push(`  ${modelId}: ${tokens} tokens`);
      }
    }

    return lines.join('\n');
  }
}

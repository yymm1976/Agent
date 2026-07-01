// src/agent/quality-aggregator.ts
// Phase 40 Task 3：质量信号聚合器
// 按模型 ID 聚合质量信号，计算负面信号率，提供降级建议
// 冷启动期内（totalCalls < coldStartThreshold）不降级，避免样本不足误判
//
// 现状说明（Phase 52 processEvaluation 接线核查）：
//   预期的 "class ProcessEvaluation" 在代码库中不存在（Grep "class ProcessEvaluation" 无匹配）。
//   processEvaluation 能力实际由 SelfEvolutionFramework.setProcessDefectIntegration /
//   EvaluationFramework.setProcessDefectIntegration 承载，在 app-init.ts 中已按
//   config.phase52Integration.processEvaluation.enabled 守护接入（仅 selfEvolution
//   同步启用时生效，optimize 时调用 classifyDefect + buildCalibratedScorecard 产出评分卡）。
//   因此本聚合器不追加对 ProcessEvaluation 的调用——无独立类可注入。

/** 单个模型的质量统计 */
interface ModelQualityStats {
  modelId: string;
  totalCalls: number;
  negativeSignals: number;
  negativeSignalRate: number; // negativeSignals / totalCalls
  lastUpdated: number;
}

/** 默认负面信号率阈值（超过则建议降级） */
const DEFAULT_NEGATIVE_THRESHOLD = 0.4;

/** 默认冷启动阈值（样本不足时不降级） */
const DEFAULT_COLD_START_THRESHOLD = 50;

export class QualityAggregator {
  private stats: Map<string, ModelQualityStats> = new Map();
  private negativeThreshold: number;
  private coldStartThreshold: number;

  constructor(
    negativeThreshold: number = DEFAULT_NEGATIVE_THRESHOLD,
    coldStartThreshold: number = DEFAULT_COLD_START_THRESHOLD,
  ) {
    this.negativeThreshold = negativeThreshold;
    this.coldStartThreshold = coldStartThreshold;
  }

  /** 记录一次信号（按 modelId 聚合） */
  recordSignal(modelId: string, isNegative: boolean): void {
    const now = Date.now();
    const existing = this.stats.get(modelId);
    if (existing) {
      existing.totalCalls++;
      if (isNegative) existing.negativeSignals++;
      existing.negativeSignalRate = existing.negativeSignals / existing.totalCalls;
      existing.lastUpdated = now;
    } else {
      const stat: ModelQualityStats = {
        modelId,
        totalCalls: 1,
        negativeSignals: isNegative ? 1 : 0,
        negativeSignalRate: isNegative ? 1 : 0,
        lastUpdated: now,
      };
      this.stats.set(modelId, stat);
    }
  }

  /** 获取指定模型的统计 */
  getStats(modelId: string): ModelQualityStats | null {
    return this.stats.get(modelId) ?? null;
  }

  /** 获取所有模型的统计 */
  getAllStats(): ModelQualityStats[] {
    return Array.from(this.stats.values()).sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  /**
   * 是否建议降级
   * 冷启动期内不降级；负面信号率超过阈值时建议降级
   */
  shouldDegrade(modelId: string): { degrade: boolean; reason: string } {
    const stat = this.stats.get(modelId);
    if (!stat) {
      return { degrade: false, reason: `无模型 ${modelId} 的质量数据` };
    }

    if (this.isColdStart(modelId)) {
      return {
        degrade: false,
        reason: `冷启动期内（${stat.totalCalls}/${this.coldStartThreshold}），样本不足，暂不降级`,
      };
    }

    if (stat.negativeSignalRate > this.negativeThreshold) {
      return {
        degrade: true,
        reason: `负面信号率 ${(stat.negativeSignalRate * 100).toFixed(1)}% 超过阈值 ${(this.negativeThreshold * 100).toFixed(1)}%（${stat.negativeSignals}/${stat.totalCalls}）`,
      };
    }

    return {
      degrade: false,
      reason: `负面信号率 ${(stat.negativeSignalRate * 100).toFixed(1)}% 在阈值内（${stat.negativeSignals}/${stat.totalCalls}）`,
    };
  }

  /** 冷启动期检测 */
  isColdStart(modelId: string): boolean {
    const stat = this.stats.get(modelId);
    return (stat?.totalCalls ?? 0) < this.coldStartThreshold;
  }

  /** 清空所有统计 */
  reset(): void {
    this.stats.clear();
  }
}

// ===== 模块级单例（供 /quality 命令和中间件共享） =====

let globalAggregator: QualityAggregator | null = null;

/** 获取全局 QualityAggregator 单例 */
export function getGlobalQualityAggregator(): QualityAggregator {
  if (!globalAggregator) {
    globalAggregator = new QualityAggregator();
  }
  return globalAggregator;
}

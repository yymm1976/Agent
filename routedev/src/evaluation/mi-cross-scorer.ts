// src/evaluation/mi-cross-scorer.ts
// Phase 67 Task 1：推理质量诊断——MI 代理评分器
//
// 核心思想（知识库原文）：
//   "推理过程的质量可以用互信息（MI）代理衡量：
//    - retrievalAcc：模型对 prompt 的正确检索比例
//    - randomBaseline：随机基线 = 1/P（P = prompts 数量）
//    - miZScore：(avgRetrievalAcc - randomBaseline) / stdDev
//    - 当 miZScore 持续低于坍缩阈值时，说明推理已坍缩到无意义的随机输出"
//
// 实现：
//   - Welford 算法增量更新标准差（避免全量重算，支持在线流式评分）
//   - EMA 平滑 miZScore（α=0.9，突出近期趋势）
//   - 条件熵 estimateConditionalEntropy（衡量输出分布的不确定性）
//   - collapseWarning：miZScoreEma < collapseThreshold 时触发
//
// fail-open：所有错误都返回占位快照（collapseWarning=false），不抛异常。

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 单个 prompt 的推理评分 */
export interface ReasoningScore {
  /** prompt 标识 */
  promptId: string;
  /** 正确检索比例（0-1） */
  retrievalAcc: number;
  /** 随机基线（0-1） */
  randomBaseline: number;
}

/** MI 代理快照（一次 computeMIProxy 调用的结果） */
export interface MIProxySnapshot {
  /** 参与计算的 prompt 数量 */
  prompts: number;
  /** 平均正确检索比例 */
  avgRetrievalAcc: number;
  /** 随机基线 = 1/P */
  randomBaseline: number;
  /** MI Z-Score：(avgRetrievalAcc - randomBaseline) / stdDev */
  miZScore: number;
  /** miZScore 的 EMA 平滑值（α=0.9） */
  miZScoreEma: number;
  /** 条件熵 -Σ p(xi) log2 p(xi) */
  conditionalEntropy: number;
  /** 是否触发坍缩告警（miZScoreEma < collapseThreshold） */
  collapseWarning: boolean;
}

/** 配置 */
export interface MICrossScorerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 坍缩阈值（miZScoreEma 低于此值时触发告警） */
  collapseThreshold: number;
  /** 最小 prompt 数量（不足时返回占位快照） */
  minPrompts: number;
  /** 每个 prompt 的采样数（用于 Welford 增量更新） */
  samplesPerPrompt: number;
}

// ============================================================
// 默认配置（与 schema.ts 中的默认值对齐）
// ============================================================

export const DEFAULT_MI_CROSS_SCORER_CONFIG: MICrossScorerConfig = {
  enabled: false,
  collapseThreshold: 1.5,
  minPrompts: 2,
  samplesPerPrompt: 4,
};

/** EMA 平滑系数 */
const EMA_ALPHA = 0.9;

// ============================================================
// MICrossScorer
// ============================================================

/**
 * MI 代理评分器
 *
 * 使用方式：
 *   const scorer = new MICrossScorer({ enabled: true, collapseThreshold: 1.5, minPrompts: 2, samplesPerPrompt: 4 });
 *   const snapshot = scorer.computeMIProxy(scores);
 *   if (snapshot.collapseWarning) {
 *     // 触发坍缩告警，停止推理或切换模型
 *   }
 */
export class MICrossScorer {
  private config: MICrossScorerConfig;
  /** 上一次的 miZScore EMA（用于本次 EMA 平滑） */
  private prevEma: number = 0;
  /** Welford 算法的运行统计量（用于 zScoreNormalize 增量更新） */
  private welfordCount = 0;
  private welfordMean = 0;
  private welfordM2 = 0;

  constructor(config: MICrossScorerConfig = DEFAULT_MI_CROSS_SCORER_CONFIG) {
    this.config = { ...config };
  }

  /**
   * 计算 MI 代理快照
   *
   * 算法：
   *   1. P < minPrompts → 返回占位快照（collapseWarning=false）
   *   2. avgRetrievalAcc = mean(retrievalAcc)
   *   3. randomBaseline = 1/P
   *   4. miZScore = (avgRetrievalAcc - randomBaseline) / stdDev（Welford 增量更新）
   *   5. miZScoreEma = α × miZScore + (1-α) × prevEma
   *   6. conditionalEntropy = -Σ p(xi) log2 p(xi)
   *   7. collapseWarning = miZScoreEma < collapseThreshold
   *
   * fail-open：所有计算错误都返回占位快照，不抛异常。
   */
  computeMIProxy(scores: ReasoningScore[]): MIProxySnapshot {
    // 配置关闭时返回占位快照
    if (!this.config.enabled) {
      return this.placeholderSnapshot(0);
    }

    const P = scores.length;
    if (P < this.config.minPrompts) {
      // 不足最小 prompt 数量，返回占位快照（collapseWarning=false）
      return this.placeholderSnapshot(P);
    }

    try {
      // 1. 计算 avgRetrievalAcc
      const retrievalAccs = scores.map(s => s.retrievalAcc);
      const avgRetrievalAcc = retrievalAccs.reduce((a, b) => a + b, 0) / P;

      // 2. 计算 randomBaseline = 1/P
      const randomBaseline = 1 / P;

      // 3. 用 Welford 算法计算标准差（增量更新）
      const stdDev = this.zScoreNormalize(retrievalAccs);
      // zScoreNormalize 返回的是 z-score 数组的某种聚合，这里我们直接用 Welford 累积的 stdDev
      // 但根据规范，zScoreNormalize 返回单个 number —— 我们让 stdDev 来自 Welford 累积统计
      const welfordStdDev = this.getWelfordStdDev();

      // 4. 计算 miZScore = (avgRetrievalAcc - randomBaseline) / stdDev
      let miZScore = 0;
      if (welfordStdDev > 0) {
        miZScore = (avgRetrievalAcc - randomBaseline) / welfordStdDev;
      } else if (avgRetrievalAcc !== randomBaseline) {
        // stdDev=0 但有偏移：用极大值表示强信号
        miZScore = avgRetrievalAcc > randomBaseline ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      }

      // 5. EMA 平滑
      const miZScoreEma = this.emaSmooth(
        Number.isFinite(miZScore) ? miZScore : (miZScore > 0 ? 1e6 : -1e6),
        this.prevEma,
        EMA_ALPHA,
      );
      this.prevEma = miZScoreEma;

      // 6. 条件熵
      const conditionalEntropy = this.estimateConditionalEntropy(retrievalAccs);

      // 7. 坍缩告警
      const collapseWarning = miZScoreEma < this.config.collapseThreshold;

      return {
        prompts: P,
        avgRetrievalAcc,
        randomBaseline,
        miZScore: Number.isFinite(miZScore) ? miZScore : (miZScore > 0 ? 1e6 : -1e6),
        miZScoreEma,
        conditionalEntropy,
        collapseWarning,
      };
    } catch (err) {
      // fail-open：计算异常时返回占位快照
      logger.warn('MICrossScorer: computeMIProxy 异常，返回占位快照', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.placeholderSnapshot(P);
    }
  }

  /**
   * 返回数组中最大值的索引（argmax）
   *
   * 用于在多个候选 prompt 中选择 retrievalAcc 最高的一个
   */
  argmax(scores: number[]): number {
    if (scores.length === 0) return -1;
    let maxIdx = 0;
    let maxVal = scores[0];
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > maxVal) {
        maxVal = scores[i];
        maxIdx = i;
      }
    }
    return maxIdx;
  }

  /**
   * 估算条件熵
   *
   * 公式：H = -Σ p(xi) log2 p(xi)
   *
   * 把 probs 视为概率分布（无需归一化，本函数内部归一化）
   * 空数组或全零数组返回 0
   */
  estimateConditionalEntropy(probs: number[]): number {
    if (probs.length === 0) return 0;
    const sum = probs.reduce((a, b) => a + b, 0);
    if (sum <= 0) return 0;

    let entropy = 0;
    for (const p of probs) {
      if (p <= 0) continue; // 约定 0 * log(0) = 0
      const pi = p / sum;
      entropy -= pi * Math.log2(pi);
    }
    return entropy;
  }

  /**
   * Z-score 归一化（Welford 增量更新）
   *
   * 对传入的 values 增量更新内部 Welford 统计量，并返回当前累积的标准差
   *
   * 注意：根据任务规范，此方法返回单个 number（标准差），
   * 而非 z-score 数组——这样调用方可以在 computeMIProxy 中复用统计量
   */
  zScoreNormalize(values: number[]): number {
    // 空数组：不更新统计量，返回当前累积的标准差
    if (values.length === 0) {
      return this.getWelfordStdDev();
    }

    // 增量更新 Welford 统计量
    for (const x of values) {
      this.welfordCount++;
      const delta = x - this.welfordMean;
      this.welfordMean += delta / this.welfordCount;
      const delta2 = x - this.welfordMean;
      this.welfordM2 += delta * delta2;
    }

    // 返回当前累积的标准差（总体标准差）
    return this.getWelfordStdDev();
  }

  /**
   * EMA 平滑
   *
   * 公式：ema = α × current + (1-α) × previous
   */
  emaSmooth(current: number, previous: number, alpha: number): number {
    return alpha * current + (1 - alpha) * previous;
  }

  /**
   * 重置内部状态（Welford 统计量 + EMA）
   *
   * 用于新会话开始时清空历史
   */
  reset(): void {
    this.prevEma = 0;
    this.welfordCount = 0;
    this.welfordMean = 0;
    this.welfordM2 = 0;
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /** 获取 Welford 累积的总体标准差 */
  private getWelfordStdDev(): number {
    if (this.welfordCount < 1) return 0;
    const variance = this.welfordM2 / this.welfordCount;
    return Math.sqrt(variance);
  }

  /** 构造占位快照（用于 P < minPrompts 或 fail-open 场景） */
  private placeholderSnapshot(prompts: number): MIProxySnapshot {
    return {
      prompts,
      avgRetrievalAcc: 0,
      randomBaseline: prompts > 0 ? 1 / prompts : 0,
      miZScore: 0,
      miZScoreEma: 0,
      conditionalEntropy: 0,
      collapseWarning: false,
    };
  }
}

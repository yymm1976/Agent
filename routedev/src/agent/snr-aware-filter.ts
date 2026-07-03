// src/agent/snr-aware-filter.ts
// Phase 67 Task 2：SNR 感知过滤——基于奖励方差的批量任务筛选
//
// 核心思想（知识库原文）：
//   "并不是所有 worker 任务都值得执行——
//    1. 按 RV（reward variance）降序排列
//    2. 保留前 topP 比例（如 0.9 保留前 90% 高 RV 任务）
//    3. 零信号任务占比超阈值时直接拒绝整个 batch
//    RV 估计方式：
//      - 历史数据：查匹配的 reward 方差
//      - 采样模式：取最近 G=4 条的方差
//      - 都没有：降级默认 RV=0.5"
//
// fail-open：所有错误都返回降级结果（不抛异常），保证主流程不被阻断。

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 带 RV 估计的 worker 任务 */
export interface WorkerTaskWithRV {
  /** 任务 ID */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 估算的奖励方差（0-1，越高越值得执行） */
  estimatedRewardVariance: number;
  /** 是否被保留（true=参与执行，false=被过滤） */
  retained: boolean;
}

/** top-p 过滤结果 */
export interface TopPFilterResult {
  /** 保留的高 RV 任务 */
  retainedTasks: WorkerTaskWithRV[];
  /** 被过滤掉的低 RV 任务 */
  filteredOutTasks: WorkerTaskWithRV[];
  /** 是否拒绝整个 batch（零信号占比超阈值） */
  batchRejected: boolean;
  /** 实际保留比例（retained / total） */
  actualRetainRatio: number;
}

/** 配置 */
export interface SNRAwareFilterConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 保留前 N% 高 RV 任务（0-1，默认 0.9） */
  topP: number;
  /** 最小 RV 阈值（低于此值视为零信号任务） */
  minRVThreshold: number;
  /** batch 拒绝比例（零信号任务占比超过此值时拒绝整个 batch） */
  batchRejectRatio: number;
}

// ============================================================
// 默认配置（与 schema.ts 中的默认值对齐）
// ============================================================

export const DEFAULT_SNR_AWARE_FILTER_CONFIG: SNRAwareFilterConfig = {
  enabled: false,
  topP: 0.9,
  minRVThreshold: 0.01,
  batchRejectRatio: 0.7,
};

/** 采样模式的样本数 G */
const SAMPLE_WINDOW = 4;

/** 降级默认 RV */
const FALLBACK_RV = 0.5;

// ============================================================
// SNRAwareFilter
// ============================================================

/**
 * SNR 感知过滤器
 *
 * 使用方式：
 *   const filter = new SNRAwareFilter({ enabled: true, topP: 0.9, ... });
 *   const result = filter.filter(tasksWithRV);
 *   if (result.batchRejected) {
 *     // 整个 batch 被拒绝，跳过本轮调度
 *   } else {
 *     // 仅执行 retainedTasks
 *   }
 */
export class SNRAwareFilter {
  private config: SNRAwareFilterConfig;

  constructor(config: SNRAwareFilterConfig = DEFAULT_SNR_AWARE_FILTER_CONFIG) {
    this.config = { ...config };
  }

  /**
   * top-p 过滤
   *
   * 算法：
   *   1. 按 RV 降序排列
   *   2. 保留前 topP 比例（如 0.9 保留前 90%）
   *   3. 统计零信号任务占比（RV < minRVThreshold）
   *   4. batchRejected = 零信号占比 > batchRejectRatio
   *   5. batchRejected=true 时跳过整个 batch（retainedTasks 为空）
   *
   * fail-open：异常时返回全部任务保留（actualRetainRatio=1，batchRejected=false）。
   */
  filter(tasksWithRV: WorkerTaskWithRV[]): TopPFilterResult {
    // 配置关闭时全部保留
    if (!this.config.enabled) {
      return this.allRetained(tasksWithRV);
    }

    // 空任务列表降级
    if (tasksWithRV.length === 0) {
      return {
        retainedTasks: [],
        filteredOutTasks: [],
        batchRejected: false,
        actualRetainRatio: 0,
      };
    }

    try {
      // 1. 统计零信号任务占比
      const zeroSignalCount = tasksWithRV.filter(
        t => t.estimatedRewardVariance < this.config.minRVThreshold,
      ).length;
      const zeroSignalRatio = zeroSignalCount / tasksWithRV.length;

      // 2. 判定是否拒绝整个 batch
      const batchRejected = zeroSignalRatio > this.config.batchRejectRatio;
      if (batchRejected) {
        // batch 拒绝：所有任务标记为未保留
        const allFiltered = tasksWithRV.map(t => ({ ...t, retained: false }));
        logger.warn('SNRAwareFilter: batch 拒绝（零信号占比过高）', {
          total: tasksWithRV.length,
          zeroSignalCount,
          zeroSignalRatio,
          threshold: this.config.batchRejectRatio,
        });
        return {
          retainedTasks: [],
          filteredOutTasks: allFiltered,
          batchRejected: true,
          actualRetainRatio: 0,
        };
      }

      // 3. 按 RV 降序排列
      const sorted = [...tasksWithRV].sort(
        (a, b) => b.estimatedRewardVariance - a.estimatedRewardVariance,
      );

      // 4. 保留前 topP 比例
      // 至少保留 1 个任务（避免 topP=0 时全空）
      const retainCount = Math.max(1, Math.ceil(sorted.length * this.config.topP));
      const retainedTasks = sorted.slice(0, retainCount).map(t => ({ ...t, retained: true }));
      const filteredOutTasks = sorted.slice(retainCount).map(t => ({ ...t, retained: false }));

      const actualRetainRatio = retainedTasks.length / tasksWithRV.length;

      return {
        retainedTasks,
        filteredOutTasks,
        batchRejected: false,
        actualRetainRatio,
      };
    } catch (err) {
      // fail-open：异常时全部保留
      logger.warn('SNRAwareFilter: filter 异常，降级为全部保留', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.allRetained(tasksWithRV);
    }
  }

  /**
   * 估算任务的奖励方差
   *
   * 三种模式：
   *   1. 历史模式：从 rewardHistory 中查找描述完全匹配的历史 reward，计算方差
   *   2. 采样模式：无历史但有采样数据时，取最近 G=4 条的方差
   *   3. 降级模式：都没有时返回默认 RV=0.5
   *
   * @param taskDescription 任务描述
   * @param rewardHistory 历史 reward 列表（可选）
   */
  estimateRewardVariance(
    taskDescription: string,
    rewardHistory?: Array<{ description: string; reward: number }>,
  ): number {
    try {
      // 1. 历史模式：查找描述完全匹配的历史 reward
      if (rewardHistory && rewardHistory.length > 0) {
        const matched = rewardHistory.filter(h => h.description === taskDescription);
        if (matched.length >= 2) {
          // 至少 2 条匹配才能算方差
          const rewards = matched.map(m => m.reward);
          const variance = this.computeVariance(rewards);
          if (variance > 0) {
            return variance;
          }
        }

        // 2. 采样模式：取最近 G=4 条（不区分描述）的方差
        const recent = rewardHistory.slice(-SAMPLE_WINDOW);
        if (recent.length >= 2) {
          const rewards = recent.map(r => r.reward);
          const variance = this.computeVariance(rewards);
          if (variance > 0) {
            return variance;
          }
        }
      }

      // 3. 降级模式：默认 RV=0.5
      return FALLBACK_RV;
    } catch (err) {
      // fail-open：异常时返回默认 RV
      logger.warn('SNRAwareFilter: estimateRewardVariance 异常，降级为默认 RV', {
        error: err instanceof Error ? err.message : String(err),
      });
      return FALLBACK_RV;
    }
  }

  /**
   * 计算方差（总体方差，除以 N）
   *
   * var(X) = sum((x_i - mean)^2) / N
   * 空数组或单元素数组返回 0
   */
  computeVariance(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sumSq = values.reduce((acc, x) => acc + (x - mean) ** 2, 0);
    return sumSq / values.length;
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /** 构造"全部保留"结果（用于 fail-open 或配置关闭） */
  private allRetained(tasks: WorkerTaskWithRV[]): TopPFilterResult {
    const retained = tasks.map(t => ({ ...t, retained: true }));
    return {
      retainedTasks: retained,
      filteredOutTasks: [],
      batchRejected: false,
      actualRetainRatio: tasks.length > 0 ? 1 : 0,
    };
  }
}

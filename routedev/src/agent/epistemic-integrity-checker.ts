// src/agent/epistemic-integrity-checker.ts
// Phase 67 Task 4：认知完整性检查器
//
// 核心思想（知识库原文）：
//   "跨模型审查或摘要压缩后，原始推理中的 epistemic token 频率可能大幅下降——
//    这通常意味着审查/压缩过程'过度扁平化'了推理的认知轨迹，
//    丢失了模型原本的'不确定性表达'和'备选假设探索'。
//    频率下降比 > 阈值 且 原始 token 数 >= minTokenCount 时触发预警。"
//
// 实现：
//   - originalFrequency = countEpistemicTokens(original) / original.length
//   - reviewedFrequency = countEpistemicTokens(reviewed) / reviewed.length
//   - frequencyDropRatio = (originalFrequency - reviewedFrequency) / originalFrequency
//   - overCompressionWarning = frequencyDropRatio > threshold && originalCount >= minTokenCount
//
// fail-open：所有错误都返回占位结果（overCompressionWarning=false），不抛异常。

import { logger } from '../utils/logger.js';
import type { EpistemicTokenProtector } from './epistemic-token-protector.js';

// ============================================================
// 类型定义
// ============================================================

/** 认知完整性检查结果 */
export interface EpistemicIntegrityResult {
  /** 原始推理中的 epistemic token 频率 */
  originalFrequency: number;
  /** 审查后推理中的 epistemic token 频率 */
  reviewedFrequency: number;
  /** 频率下降比（0-1，负数表示频率上升） */
  frequencyDropRatio: number;
  /** 是否触发过度压缩预警 */
  overCompressionWarning: boolean;
}

/** 配置 */
export interface EpistemicIntegrityCheckerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 过度压缩阈值（频率下降比超过此值时预警） */
  overCompressionThreshold: number;
  /** 最小 token 计数（原始 token 数低于此值时不预警） */
  minTokenCount: number;
}

// ============================================================
// 默认配置
// ============================================================

export const DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG: EpistemicIntegrityCheckerConfig = {
  enabled: false,
  overCompressionThreshold: 0.5,
  minTokenCount: 5,
};

// ============================================================
// EpistemicIntegrityChecker
// ============================================================

/**
 * 认知完整性检查器
 *
 * 依赖注入：通过构造函数接收 EpistemicTokenProtector 实例（复用其 token 计数能力）
 *
 * 使用方式：
 *   const protector = new EpistemicTokenProtector({ enabled: true, ... });
 *   const checker = new EpistemicIntegrityChecker(protector, {
 *     enabled: true,
 *     overCompressionThreshold: 0.5,
 *     minTokenCount: 5,
 *   });
 *   const result = checker.check(originalReasoning, reviewedReasoning);
 *   if (result.overCompressionWarning) {
 *     // 触发过度压缩预警，可能需要保留更多原始推理
 *   }
 */
export class EpistemicIntegrityChecker {
  private protector: EpistemicTokenProtector;
  private config: EpistemicIntegrityCheckerConfig;

  constructor(
    protector: EpistemicTokenProtector,
    config: EpistemicIntegrityCheckerConfig = DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG,
  ) {
    this.protector = protector;
    this.config = { ...config };
  }

  /**
   * 检查认知完整性
   *
   * 算法：
   *   1. originalFrequency = countEpistemicTokens(original) / original.length
   *   2. reviewedFrequency = countEpistemicTokens(reviewed) / reviewed.length
   *   3. frequencyDropRatio = (originalFrequency - reviewedFrequency) / originalFrequency
   *   4. overCompressionWarning = frequencyDropRatio > threshold && originalCount >= minTokenCount
   *
   * 边界处理：
   *   - 原文长度为 0：originalFrequency=0，无法计算 drop ratio，返回 0
   *   - 审查后长度为 0：reviewedFrequency=0，drop ratio=1（完全丢失）
   *   - 频率上升（reviewedFrequency > originalFrequency）：drop ratio<0，不预警
   *
   * fail-open：异常时返回占位结果（overCompressionWarning=false）。
   */
  check(originalReasoning: string, reviewedReasoning: string): EpistemicIntegrityResult {
    // 配置关闭时返回占位结果
    if (!this.config.enabled) {
      return this.placeholderResult();
    }

    try {
      // 1. 计算 token 计数
      const originalCount = this.protector.countEpistemicTokens(originalReasoning);
      const reviewedCount = this.protector.countEpistemicTokens(reviewedReasoning);

      // 2. 计算频率
      const originalLength = originalReasoning.length;
      const reviewedLength = reviewedReasoning.length;

      const originalFrequency = originalLength > 0 ? originalCount / originalLength : 0;
      const reviewedFrequency = reviewedLength > 0 ? reviewedCount / reviewedLength : 0;

      // 3. 计算频率下降比
      let frequencyDropRatio = 0;
      if (originalFrequency > 0) {
        frequencyDropRatio = (originalFrequency - reviewedFrequency) / originalFrequency;
      }

      // 4. 判定过度压缩预警
      // 条件：频率下降比 > 阈值 且 原始 token 计数 >= 最小值
      // 频率上升时 frequencyDropRatio < 0，自然不会 > 阈值（阈值通常 > 0）
      const overCompressionWarning =
        frequencyDropRatio > this.config.overCompressionThreshold &&
        originalCount >= this.config.minTokenCount;

      return {
        originalFrequency,
        reviewedFrequency,
        frequencyDropRatio,
        overCompressionWarning,
      };
    } catch (err) {
      // fail-open：异常时返回占位结果
      logger.warn('EpistemicIntegrityChecker: check 异常，返回占位结果', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.placeholderResult();
    }
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /** 构造占位结果（用于配置关闭或 fail-open） */
  private placeholderResult(): EpistemicIntegrityResult {
    return {
      originalFrequency: 0,
      reviewedFrequency: 0,
      frequencyDropRatio: 0,
      overCompressionWarning: false,
    };
  }
}

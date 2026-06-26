// src/router/cache-optimizer.ts
// Reasonix 六层缓存优化架构
//
// 借鉴来源：Reasonix（DeepSeek 原生终端 Agent）的 Cache-First 架构
// 实战效果：单用户单日 4.35 亿 input cache hit tokens，命中率 99.82%，成本降 40%
//
// 六层架构：
//   1. Cache-Stable Prefix：system prompt 构建后绝不动
//   2. 变异走 user message：模式切换/记忆变更插入 user message
//   3. 三级压缩阈值：50%软通知/80%触发/90%强制，推迟缓存重置
//   4. 前缀 Shape 哈希溯源：system/tools/log 分别 SHA256
//   5. 会话级累计计数器：压缩时不重置
//   6. 绝对计数替代百分比：展示 N cached / M new
//
// 最优解思考：
//   - 不是简单地在 LLM 请求中加 cache_control，而是从架构层面重新组织 prompt
//   - 前缀稳定性是缓存命中的前提，任何对 system prompt 的修改都会使缓存失效
//   - 三级阈值的核心价值：50%→80% 这 30% 窗口是靠缓存换来的

import { logger } from '../utils/logger.js';

// ============================================================
// Layer 3: 三级压缩阈值
// ============================================================

/** 压缩阈值配置 */
export interface CompactionThresholds {
  /** 软通知阈值（0-1，默认 0.5）：仅提醒不操作，缓存完好 */
  softThreshold: number;
  /** 触发阈值（0-1，默认 0.8）：真正执行压缩，缓存重置 */
  triggerThreshold: number;
  /** 强制阈值（0-1，默认 0.9）：强制压缩 */
  forceThreshold: number;
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  softThreshold: 0.5,
  triggerThreshold: 0.8,
  forceThreshold: 0.9,
};

/** 压缩决策结果 */
type CompactionAction = 'none' | 'soft_notify' | 'trigger' | 'force';

/**
 * 根据上下文使用率决定压缩动作
 *
 * 三级阈值的核心价值：
 *   50% → 80% 这 30% 窗口是靠缓存换来的
 *   没有这个设计，每次到 50% 就压缩，命中率直接腰斩
 */
export function decideCompactionAction(
  usagePercent: number,
  thresholds: CompactionThresholds = DEFAULT_COMPACTION_THRESHOLDS,
): { action: CompactionAction; reason: string } {
  if (usagePercent >= thresholds.forceThreshold) {
    return { action: 'force', reason: `使用率 ${(usagePercent * 100).toFixed(1)}% ≥ 强制阈值 ${thresholds.forceThreshold * 100}%` };
  }
  if (usagePercent >= thresholds.triggerThreshold) {
    return { action: 'trigger', reason: `使用率 ${(usagePercent * 100).toFixed(1)}% ≥ 触发阈值 ${thresholds.triggerThreshold * 100}%` };
  }
  if (usagePercent >= thresholds.softThreshold) {
    return { action: 'soft_notify', reason: `使用率 ${(usagePercent * 100).toFixed(1)}% ≥ 软通知阈值 ${thresholds.softThreshold * 100}%` };
  }
  return { action: 'none', reason: '' };
}

// ============================================================
// Layer 5 & 6: 会话级累计计数器 + 绝对计数展示
// ============================================================

/**
 * 缓存统计追踪器
 *
 * Layer 5：会话级累计计数器，压缩时不重置
 * Layer 6：绝对计数替代百分比
 */
export class CacheStatsTracker {
  /** 会话级累计缓存命中 token 数（压缩时不重置） */
  private sessCacheHit = 0;
  /** 会话级累计缓存未命中 token 数 */
  private sessCacheMiss = 0;
  /** 单轮缓存命中 token 数 */
  private turnCacheHit = 0;
  /** 单轮缓存未命中 token 数 */
  private turnCacheMiss = 0;

  /**
   * 记录一次 API 调用的缓存统计
   *
   * 多 Provider 缓存字段归一化：
   *   DeepSeek: prompt_cache_hit_tokens
   *   OpenAI: prompt_tokens_details.cached_tokens
   *   Anthropic: cache_read_input_tokens
   */
  record(
    cacheHitTokens: number,
    cacheMissTokens: number,
    provider: string,
  ): void {
    this.sessCacheHit += cacheHitTokens;
    this.sessCacheMiss += cacheMissTokens;
    this.turnCacheHit += cacheHitTokens;
    this.turnCacheMiss += cacheMissTokens;

    logger.debug('Cache stats recorded', {
      provider,
      turnHit: cacheHitTokens,
      turnMiss: cacheMissTokens,
      sessTotalHit: this.sessCacheHit,
      sessTotalMiss: this.sessCacheMiss,
    });
  }

  /** 重置单轮统计（每轮 LLM 调用后重置，会话级不重置） */
  resetTurn(): void {
    this.turnCacheHit = 0;
    this.turnCacheMiss = 0;
  }

  /**
   * 获取展示格式（Layer 6：绝对计数替代百分比）
   *
   * 展示 `1200 tok · in 1000 (900 cached / 100 new) · out 200`
   * 而非 `Cache hit: 95%`
   *
   * 原因：代码生成轮次返回 2000 token 新内容，分母膨胀 →
   * 百分比从 95% 掉到 60% → 用户以为缓存坏了，但实际前缀完全命中
   */
  getDisplayFormat(inputTokens: number, outputTokens: number): string {
    const cached = this.turnCacheHit;
    const newTokens = Math.max(0, inputTokens - cached);
    return `${inputTokens} tok · in ${inputTokens} (${cached} cached / ${newTokens} new) · out ${outputTokens}`;
  }

  /** 获取会话级缓存命中率（仅用于日志，不用于展示） */
  getSessionHitRate(): number {
    const total = this.sessCacheHit + this.sessCacheMiss;
    if (total === 0) return 0;
    return this.sessCacheHit / total;
  }

  /** 获取单轮缓存命中率 */
  getTurnHitRate(): number {
    const total = this.turnCacheHit + this.turnCacheMiss;
    if (total === 0) return 0;
    return this.turnCacheHit / total;
  }

  /** 获取会话级累计统计 */
  getSessionStats(): { hit: number; miss: number; total: number } {
    return {
      hit: this.sessCacheHit,
      miss: this.sessCacheMiss,
      total: this.sessCacheHit + this.sessCacheMiss,
    };
  }
}

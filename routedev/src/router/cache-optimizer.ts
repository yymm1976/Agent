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

import * as crypto from 'node:crypto';
import type { LLMMessage } from './types.js';
import { logger } from '../utils/logger.js';

// ============================================================
// Layer 4: 前缀 Shape 哈希溯源
// ============================================================

/**
 * 前缀形状指纹
 *
 * 对 system prompt / tools / log_rewrite 分别 SHA256
 * 缓存失效时精准报告原因
 */
export interface PrefixShape {
  /** 系统提示词哈希 */
  systemHash: string;
  /** 工具定义 JSON 哈希 */
  toolsHash: string;
  /** 联合哈希（system + tools） */
  prefixHash: string;
  /** 压缩版本号（每次压缩递增） */
  logRewriteVersion: number;
}

/**
 * 计算前缀形状指纹
 */
export function computePrefixShape(
  systemPrompt: string,
  tools: unknown[],
  logRewriteVersion = 0,
): PrefixShape {
  const systemHash = crypto.createHash('sha256').update(systemPrompt).digest('hex').slice(0, 16);
  const toolsHash = crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16);
  const prefixHash = crypto.createHash('sha256').update(systemHash + toolsHash).digest('hex').slice(0, 16);
  return { systemHash, toolsHash, prefixHash, logRewriteVersion };
}

/**
 * 比较两个前缀形状，报告缓存失效原因
 */
export function diffPrefixShape(
  old: PrefixShape,
  next: PrefixShape,
): { changed: boolean; reason: string } {
  if (old.prefixHash === next.prefixHash && old.logRewriteVersion === next.logRewriteVersion) {
    return { changed: false, reason: 'prefix unchanged' };
  }

  const changes: string[] = [];
  if (old.systemHash !== next.systemHash) changes.push('system');
  if (old.toolsHash !== next.toolsHash) changes.push('tools');
  if (old.logRewriteVersion !== next.logRewriteVersion) changes.push('log_rewrite');

  return {
    changed: true,
    reason: `cache prefix changed: ${changes.join(' + ')}`,
  };
}

// ============================================================
// Layer 1 & 2: Cache-Stable Prefix + 变异走 user message
// ============================================================

/**
 * 缓存友好的提示词组装器
 *
 * 核心原则：
 *   1. system prompt 在会话启动时一次性构建，之后绝不修改
 *   2. 运行时变异信息（工作模式切换、即时记忆、后台通知）走 user message
 *   3. 静态前缀和动态后缀物理分隔，让 API prompt cache 大幅命中
 *
 * 借鉴：Claude Code 的 SYSTEM_PROMPT_DYNAMIC_BOUNDARY + Reasonix 的 ImmutablePrefix
 */
export class CacheAwarePromptBuilder {
  /** 不可变前缀（会话级，构建后不修改） */
  private immutablePrefix: string;
  /** 前缀指纹（构建时计算，用于缓存命中追踪） */
  private prefixShape: PrefixShape;
  /** 工具定义（构建时固定） */
  private tools: unknown[];

  /**
   * 构建缓存友好的提示词
   *
   * @param basePrompt 基础提示词（身份、安全基线）— 最稳定，放最前
   * @param outputStyle 输出风格
   * @param languagePolicy 语言策略
   * @param memory 记忆条目
   * @param skillsIndex 技能索引（只存名字和描述，body 不进前缀）
   * @param tools 工具定义
   */
  constructor(
    basePrompt: string,
    outputStyle: string,
    languagePolicy: string,
    memory: string,
    skillsIndex: string,
    tools: unknown[],
  ) {
    // 构建顺序刻意设计：最稳定的放最前，较易变的放后面
    // Base 最稳定 → Output Style → Language Policy → Memory → Skills Index
    this.immutablePrefix = [
      basePrompt,
      outputStyle,
      languagePolicy,
      memory,
      skillsIndex,
    ].filter(s => s.length > 0).join('\n\n');

    this.tools = tools;
    this.prefixShape = computePrefixShape(this.immutablePrefix, tools);
    logger.debug('CacheAwarePromptBuilder: prefix built', {
      prefixLength: this.immutablePrefix.length,
      prefixHash: this.prefixShape.prefixHash,
    });
  }

  /** 获取不可变前缀（作为 system prompt） */
  getSystemPrompt(): string {
    return this.immutablePrefix;
  }

  /** 获取前缀形状指纹 */
  getPrefixShape(): PrefixShape {
    return this.prefixShape;
  }

  /** 获取工具定义 */
  getTools(): unknown[] {
    return this.tools;
  }

  /**
   * 将运行时变异信息包装为 user message（而非修改 system prompt）
   *
   * 这保证 system prompt 字节级稳定 → 缓存命中
   * 变异信息：工作模式切换、即时记忆变更、后台任务通知
   *
   * @param mutations 运行时变异信息列表
   * @returns 适合作为 user message 注入的字符串
   */
  static formatMutationsAsUserMessage(mutations: string[]): string {
    if (mutations.length === 0) return '';
    return `[系统通知]\n${mutations.map(m => `- ${m}`).join('\n')}`;
  }
}

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
export type CompactionAction = 'none' | 'soft_notify' | 'trigger' | 'force';

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

// ============================================================
// 确定性工具结果写回（Reasonix 技巧）
// ============================================================

/**
 * 对并行执行的工具结果按模型声明顺序写回
 *
 * Reasonix 技巧：并行执行只读工具时，按模型声明顺序写回 log
 * 避免谁先返回谁先进历史导致 transcript 不稳定
 * 不稳定的 transcript 会破坏 prefix cache
 */
export function orderToolResultsByDeclaration<T>(
  toolCalls: Array<{ id: string; name: string }>,
  results: Map<string, T>,
): T[] {
  const ordered: T[] = [];
  for (const tc of toolCalls) {
    const result = results.get(tc.id);
    if (result !== undefined) {
      ordered.push(result);
    }
  }
  return ordered;
}

/**
 * 压缩边界对齐（Reasonix 技巧）
 *
 * 压缩边界向后对齐到非 tool result，避免 recent tail 以孤儿 tool message 开头
 * 孤儿 tool message 会导致 LLM 困惑（没有对应的 tool_use）
 */
export function alignCompactionBoundary(messages: LLMMessage[]): LLMMessage[] {
  if (messages.length === 0) return messages;

  // 从后往前找第一个非 tool_result 的消息作为边界
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (Array.isArray(msg.content)) {
      const hasToolResult = msg.content.some(p => p.type === 'tool_result');
      if (hasToolResult) {
        // 这是一条 tool_result 消息，继续往前找
        boundary = i;
        continue;
      }
    }
    // 找到非 tool_result 消息，停止
    break;
  }

  // 如果尾部有孤儿 tool_result，保留到边界
  if (boundary < messages.length) {
    logger.debug('Compaction boundary aligned', {
      original: messages.length,
      aligned: boundary,
    });
  }

  return messages.slice(0, boundary);
}

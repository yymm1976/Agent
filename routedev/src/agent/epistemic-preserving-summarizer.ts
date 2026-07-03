// src/agent/epistemic-preserving-summarizer.ts
// Phase 67 Task 5：认知保留摘要器
//
// 核心思想（知识库原文）：
//   "传统摘要器倾向于只保留'最终结论'，丢失推理过程中的：
//    - epistemic token（wait/hmm/actually/but/however/perhaps...）
//    - 备选假设（被否决的方案）
//    - 不确定性渐进过程（从'not sure'到'actually'的认知转变）
//    本摘要器通过定制 system prompt 强制 LLM 保留这些认知轨迹。"
//
// 实现：
//   - systemPrompt 包含 5 条关键要求
//   - 输出格式三段式：主结论 / 关键推理分支 / 未解决不确定性
//   - retentionRate = summaryTokenCount / originalTokenCount
//   - lowRetentionWarning = retentionRate < 0.3
//   - LLM 调用失败时降级为简单拼接（取每条消息前 100 字符）
//
// fail-open：所有错误都降级为简单拼接，不抛异常。

import { logger } from '../utils/logger.js';
import type { EpistemicTokenProtector } from './epistemic-token-protector.js';

// ============================================================
// 类型定义
// ============================================================

/** 待摘要的消息 */
export interface SummaryMessage {
  /** 角色（system/user/assistant/tool） */
  role: string;
  /** 内容 */
  content: string;
}

/** 摘要结果 */
export interface SummaryResult {
  /** 摘要文本（三段式格式） */
  summary: string;
  /** 原始 epistemic token 计数 */
  originalTokenCount: number;
  /** 摘要中 epistemic token 计数 */
  summaryTokenCount: number;
  /** 保留率 = summaryTokenCount / originalTokenCount */
  retentionRate: number;
  /** 低保留率预警（retentionRate < 0.3） */
  lowRetentionWarning: boolean;
}

/** 配置 */
export interface EpistemicPreservingSummarizerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 最大 token 数（长度限制） */
  maxTokens: number;
}

/** LLM 调用函数签名 */
export type LLMCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

// ============================================================
// 默认配置
// ============================================================

export const DEFAULT_EPISTEMIC_PRESERVING_SUMMARIZER_CONFIG: EpistemicPreservingSummarizerConfig = {
  enabled: false,
  maxTokens: 500,
};

/** 低保留率阈值 */
const LOW_RETENTION_THRESHOLD = 0.3;

/** 降级拼接时每条消息保留的字符数 */
const FALLBACK_MESSAGE_CHAR_LIMIT = 100;

// ============================================================
// system prompt（5 条关键要求）
// ============================================================

/**
 * 认知保留摘要的 system prompt
 *
 * 5 条关键要求：
 *   1. 保留 epistemic token（wait/hmm/actually/but/however/perhaps/maybe/not sure...）
 *   2. 保留备选假设（被否决的方案、考虑过但放弃的路径）
 *   3. 保留不确定性渐进过程（从'not sure'到'actually'的认知转变）
 *   4. 不只摘最终结论（必须包含推理分支和不确定性）
 *   5. 长度限制（不超过 maxTokens）
 *
 * 输出格式三段式：
 *   ## 主结论
 *   ## 关键推理分支
 *   ## 未解决不确定性
 */
export const EPISTEMIC_PRESERVING_SYSTEM_PROMPT = `你是一个专门保留认知轨迹的摘要器。请严格遵循以下 5 条要求：

1. **保留 epistemic token**：原文中的 wait、hmm、actually、but、however、perhaps、maybe、not sure 等表达不确定性的 token 必须在摘要中保留原貌，不要替换或删除。

2. **保留备选假设**：被否决的方案、考虑过但放弃的路径、替代选项都必须保留，不要只保留最终选定的方案。

3. **保留不确定性渐进过程**：从'not sure'到'actually'的认知转变、从'perhaps'到'but'的转折过程必须保留，体现推理的动态性。

4. **不只摘最终结论**：禁止只输出最终结论，必须包含推理分支和未解决的不确定性。

5. **长度限制**：摘要长度不超过指定 token 数，但优先保证前 4 条要求（即使超过长度限制也要保留 epistemic token）。

输出格式严格遵循以下三段式结构：

## 主结论
（一句话总结最终结论）

## 关键推理分支
（列出所有考虑过的备选方案，包括被否决的）

## 未解决不确定性
（列出仍存在疑问的点、可能的边界情况、需要进一步验证的假设）`;

// ============================================================
// EpistemicPreservingSummarizer
// ============================================================

/**
 * 认知保留摘要器
 *
 * 依赖注入：通过构造函数接收 EpistemicTokenProtector 实例（复用其 token 计数能力）
 *
 * 使用方式：
 *   const protector = new EpistemicTokenProtector({ enabled: true, ... });
 *   const summarizer = new EpistemicPreservingSummarizer(protector, {
 *     enabled: true,
 *     maxTokens: 500,
 *   });
 *   const result = await summarizer.summarize(messages, llmCall);
 *   if (result.lowRetentionWarning) {
 *     // 摘要保留率过低，可能丢失了关键认知轨迹
 *   }
 */
export class EpistemicPreservingSummarizer {
  private protector: EpistemicTokenProtector;
  private config: EpistemicPreservingSummarizerConfig;

  constructor(
    protector: EpistemicTokenProtector,
    config: EpistemicPreservingSummarizerConfig = DEFAULT_EPISTEMIC_PRESERVING_SUMMARIZER_CONFIG,
  ) {
    this.protector = protector;
    this.config = { ...config };
  }

  /**
   * 生成认知保留摘要
   *
   * 算法：
   *   1. 构造 systemPrompt（包含 5 条关键要求）+ userPrompt（拼接消息）
   *   2. 调用 llmCall 生成摘要
   *   3. 统计 originalTokenCount 和 summaryTokenCount
   *   4. retentionRate = summaryTokenCount / originalTokenCount
   *   5. lowRetentionWarning = retentionRate < 0.3
   *
   * 降级：LLM 调用失败时降级为简单拼接（取每条消息前 100 字符）
   *
   * @param messages 待摘要的消息列表
   * @param llmCall LLM 调用函数（依赖注入，便于测试 mock）
   */
  async summarize(
    messages: SummaryMessage[],
    llmCall: LLMCallFn,
  ): Promise<SummaryResult> {
    // 构造原文（用于 token 计数）
    const originalText = messages.map(m => m.content).join('\n');
    const originalTokenCount = this.protector.countEpistemicTokens(originalText);

    // 配置关闭时降级为简单拼接
    if (!this.config.enabled) {
      const fallbackSummary = this.fallbackConcatenate(messages);
      return this.buildResult(fallbackSummary, originalTokenCount);
    }

    try {
      // 构造 userPrompt（拼接消息内容）
      const userPrompt = this.buildUserPrompt(messages);

      // 调用 LLM 生成摘要
      let summary: string;
      try {
        summary = await llmCall(EPISTEMIC_PRESERVING_SYSTEM_PROMPT, userPrompt);
      } catch (err) {
        // LLM 调用失败时降级为简单拼接
        logger.warn('EpistemicPreservingSummarizer: LLM 调用失败，降级为简单拼接', {
          error: err instanceof Error ? err.message : String(err),
        });
        summary = this.fallbackConcatenate(messages);
      }

      return this.buildResult(summary, originalTokenCount);
    } catch (err) {
      // fail-open：异常时降级为简单拼接
      logger.warn('EpistemicPreservingSummarizer: summarize 异常，降级为简单拼接', {
        error: err instanceof Error ? err.message : String(err),
      });
      const fallbackSummary = this.fallbackConcatenate(messages);
      return this.buildResult(fallbackSummary, originalTokenCount);
    }
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /**
   * 构造 userPrompt（拼接消息内容）
   *
   * 格式：
   *   [role]: content
   *   [role]: content
   *   ...
   */
  private buildUserPrompt(messages: SummaryMessage[]): string {
    return messages
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n');
  }

  /**
   * 降级拼接：取每条消息前 100 字符
   *
   * 用于 LLM 调用失败或配置关闭时的降级处理
   */
  private fallbackConcatenate(messages: SummaryMessage[]): string {
    return messages
      .map(m => m.content.slice(0, FALLBACK_MESSAGE_CHAR_LIMIT))
      .join('\n');
  }

  /**
   * 构造摘要结果
   *
   * 统计 summaryTokenCount、retentionRate、lowRetentionWarning
   */
  private buildResult(summary: string, originalTokenCount: number): SummaryResult {
    const summaryTokenCount = this.protector.countEpistemicTokens(summary);
    const retentionRate = originalTokenCount > 0
      ? summaryTokenCount / originalTokenCount
      : 0;
    const lowRetentionWarning = retentionRate < LOW_RETENTION_THRESHOLD;

    return {
      summary,
      originalTokenCount,
      summaryTokenCount,
      retentionRate,
      lowRetentionWarning,
    };
  }
}

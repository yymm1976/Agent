// src/agent/context-compaction.ts
// 渐进上下文压缩管线（借鉴 Claude Code 五阶段模型）
// L1-L4 零 LLM 调用（纯字符串/数组操作），L5 才调用模型摘要
//
// 五阶段说明：
//   L1 Budget Trimming  — 截断大工具输出（>2000 字符 → 500 首 + 500 尾 + 标记）
//   L2 Snipping         — 保留最近 10 条 + 所有 system 消息，删除中间
//   L3 Micro-Compaction — 删除 content 为空或仅含标记的消息
//   L4 Context Collapse — 合并连续相同 role 的消息，去重相同工具结果
//   L5 LLM Summary      — 调用 summarize 函数生成摘要（唯一调用 LLM 的阶段）
//
// Reasonix Layer 3 集成：三级压缩阈值（50%软通知/80%触发/90%强制）
// Claude Code 集成：压缩边界 UUID 标记（headUuid/anchorUuid/tailUuid）

import type { LLMMessage, ContentPart, ToolResultContent } from '../router/types.js';
import { decideCompactionAction, DEFAULT_COMPACTION_THRESHOLDS, type CompactionThresholds } from '../router/cache-optimizer.js';
import { createCompactionBoundary, type CompactionBoundary } from '../tools/trust-gradient.js';
import { logger } from '../utils/logger.js';
import type { CCRCache, CCRMarker } from './ccr-cache.js';

/** 压缩结果 */
export interface CompactionResult {
  /** 压缩前的 token 估算 */
  beforeTokens: number;
  /** 压缩后的 token 估算 */
  afterTokens: number;
  /** 实际执行的最高阶段（1-5） */
  maxStageReached: 1 | 2 | 3 | 4 | 5;
  /** 被移除的消息数（原始条数 - 压缩后条数） */
  removedMessages: number;
  /** L5 生成的摘要（仅当 maxStageReached=5 且提供了 summarize 时存在） */
  summary?: string;
  /** Reasonix Layer 3：压缩动作（none/soft_notify/trigger/force） */
  action?: 'none' | 'soft_notify' | 'trigger' | 'force';
  /** Claude Code：压缩边界 UUID 标记 */
  boundary?: CompactionBoundary;
  /** B12：L5 摘要是否失败（true 表示 summarize 抛错或未提供，已降级到 L4 结果） */
  summaryFailed?: boolean;
  ccr?: CCRMarker;
}

/** 压缩配置 */
interface CompactionConfig {
  /** 目标 token 数：每阶段后检查，达到则停止 */
  targetTokens: number;
  /** token 估算函数 */
  estimateTokens: (text: string) => number;
  /** L5 摘要函数（可选，不提供则跳过 L5） */
  summarize?: (messages: LLMMessage[]) => Promise<string>;
  /** Reasonix Layer 3：三级压缩阈值（默认 50%/80%/90%） */
  thresholds?: CompactionThresholds;
  /** 上下文窗口大小（用于计算使用率，默认 targetTokens * 1.25） */
  contextWindow?: number;
  ccrCache?: CCRCache;
}

// 阈值常量
const TOOL_OUTPUT_TRUNCATE_THRESHOLD = 2000;
const TOOL_OUTPUT_HEAD = 500;
const TOOL_OUTPUT_TAIL = 500;
const TRUNCATE_MARKER = '[...截断...]';
const SNIP_KEEP_RECENT = 10;

export class ContextCompactor {
  /** P8：消息 token 缓存，避免重复计算（key 为 messages 数组的引用） */
  private tokenCache = new WeakMap<LLMMessage, number>();

  constructor(private config: CompactionConfig) {}

  /**
   * 执行渐进压缩
   * 依次执行 L1→L5，每阶段后检查是否达到 targetTokens，达到则停止
   *
   * Reasonix Layer 3 集成：三级压缩阈值决定是否触发压缩
   *   - 50% 软通知：仅记录日志，不压缩（保护缓存）
   *   - 80% 触发：执行压缩
   *   - 90% 强制：必须压缩到目标
   *
   * Claude Code 集成：压缩时记录边界 UUID 标记
   */
  async compact(
    messages: LLMMessage[],
  ): Promise<{ messages: LLMMessage[]; result: CompactionResult }> {
    const beforeTokens = this.totalTokens(messages);
    const thresholds = this.config.thresholds ?? DEFAULT_COMPACTION_THRESHOLDS;
    const contextWindow = this.config.contextWindow ?? Math.floor(this.config.targetTokens * 1.25);
    const usagePercent = beforeTokens / contextWindow;

    // Reasonix Layer 3：三级阈值决策
    const decision = decideCompactionAction(usagePercent, thresholds);

    // 软通知：仅记录日志，不执行压缩（保护缓存前缀）
    if (decision.action === 'soft_notify') {
      logger.info('Context compaction: soft notify (cache protected)', {
        usage: `${(usagePercent * 100).toFixed(1)}%`,
        reason: decision.reason,
      });
    }

    // none 或 soft_notify：不触发压缩
    if (decision.action === 'none' || decision.action === 'soft_notify') {
      return {
        messages,
        result: {
          beforeTokens,
          afterTokens: beforeTokens,
          maxStageReached: 1,
          removedMessages: 0,
          action: decision.action,
        },
      };
    }

    // trigger 或 force：执行压缩
    const ccrRecord = this.config.ccrCache?.store(messages);
    let current = [...messages];
    // L1 始终执行
    let maxStageReached: 1 | 2 | 3 | 4 | 5 = 1;
    let summary: string | undefined;

    // L1: Budget Trimming — 截断大工具输出
    current = this.stage1TrimToolOutputs(current);

    if (this.totalTokens(current) > this.config.targetTokens) {
      // L2: Snipping — 删除旧消息
      maxStageReached = 2;
      current = this.stage2SnipOldMessages(current);

      if (this.totalTokens(current) > this.config.targetTokens) {
        // L3: Micro-Compaction — 清理空消息
        maxStageReached = 3;
        current = this.stage3MicroCompact(current);

        if (this.totalTokens(current) > this.config.targetTokens) {
          // L4: Context Collapse — 合并去重
          maxStageReached = 4;
          current = this.stage4Collapse(current);

          if (this.totalTokens(current) > this.config.targetTokens) {
            // L5: LLM Summary — 调用模型摘要
            maxStageReached = 5;
            if (this.config.summarize) {
              // B12：对 summarize 调用包裹 try/catch，失败时保留 L4 结果
              try {
                summary = await this.config.summarize(current);
                current = [{ role: 'system', content: summary }];
              } catch (err) {
                // L5 摘要失败：降级到 L4 结果，标记 summaryFailed
                logger.warn('ContextCompactor: L5 summarize failed, fallback to L4 result', {
                  error: err instanceof Error ? err.message : String(err),
                });
                summary = undefined;
                // 保留 L4 的 current，不替换为摘要
              }
            }
            // B12：未提供 summarize 时，maxStageReached 仍记为 5 但标记 summaryFailed
            // 调用方可通过 summaryFailed 判断是否真正执行了摘要
          }
        }
      }
    }

    const afterTokens = this.totalTokens(current);
    const ccr = ccrRecord
      ? this.config.ccrCache?.buildMarker(ccrRecord.hash, messages.length, current.length)
      : undefined;

    // B12：判断 summaryFailed（L5 触发但未生成摘要）
    const summaryFailed = maxStageReached === 5 && !summary;

    // Claude Code：记录压缩边界 UUID 标记
    const boundary = createCompactionBoundary(messages, current, maxStageReached);
    logger.info('Context compacted', {
      stage: maxStageReached,
      before: beforeTokens,
      after: afterTokens,
      removed: messages.length - current.length,
      action: decision.action,
      boundary: boundary.headUuid.slice(0, 8),
      summaryFailed,
    });

    return {
      messages: current,
      result: {
        beforeTokens,
        afterTokens,
        maxStageReached,
        removedMessages: Math.max(0, messages.length - current.length),
        summary,
        action: decision.action,
        boundary,
        summaryFailed,
        ccr,
      },
    };
  }

  // L1: Budget Trimming — 截断大工具输出（>2000 字符 → 500 首 + 标记 + 500 尾）
  private stage1TrimToolOutputs(messages: LLMMessage[]): LLMMessage[] {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        // 字符串内容：user 消息中超长的可能是工具输出，截断
        if (msg.role === 'user' && msg.content.length > TOOL_OUTPUT_TRUNCATE_THRESHOLD) {
          return { ...msg, content: this.truncateText(msg.content) };
        }
        return msg;
      }
      // ContentPart[]：查找 ToolResultContent 并截断其 content 字段
      const newParts = msg.content.map((part) => {
        if (
          part.type === 'tool_result' &&
          part.content.length > TOOL_OUTPUT_TRUNCATE_THRESHOLD
        ) {
          return { ...part, content: this.truncateText(part.content) } as ToolResultContent;
        }
        return part;
      });
      return { ...msg, content: newParts };
    });
  }

  /** 截断文本：500 首 + 标记 + 500 尾 */
  private truncateText(text: string): string {
    return (
      text.slice(0, TOOL_OUTPUT_HEAD) +
      TRUNCATE_MARKER +
      text.slice(-TOOL_OUTPUT_TAIL)
    );
  }

  // L2: Snipping — 保留最近 10 条 + 所有 system 消息，删除中间
  private stage2SnipOldMessages(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length <= SNIP_KEEP_RECENT) {
      return messages;
    }
    const recent = messages.slice(-SNIP_KEEP_RECENT);
    // 从前段中提取 system 消息（保持顺序）
    const systemMessages = messages
      .slice(0, messages.length - SNIP_KEEP_RECENT)
      .filter((m) => m.role === 'system');
    return [...systemMessages, ...recent];
  }

  // L3: Micro-Compaction — 删除 content 为空或仅含标记的消息
  private stage3MicroCompact(messages: LLMMessage[]): LLMMessage[] {
    return messages.filter((msg) => {
      if (typeof msg.content === 'string') {
        return msg.content.trim().length > 0;
      }
      // ContentPart[]：保留有内容块的消息
      if (Array.isArray(msg.content)) {
        return msg.content.length > 0;
      }
      return false;
    });
  }

  // L4: Context Collapse — 合并连续相同 role 的消息，去重相同工具结果
  private stage4Collapse(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    // 第一步：合并连续相同 role 的消息
    const merged: LLMMessage[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        merged[merged.length - 1] = this.mergeMessages(last, msg);
      } else {
        merged.push({ ...msg });
      }
    }

    // 第二步：去重相同的工具结果（按 toolUseId + content 判定）
    const seenToolResults = new Set<string>();
    const deduped: LLMMessage[] = [];
    for (const msg of merged) {
      if (Array.isArray(msg.content)) {
        const newParts = msg.content.filter((part) => {
          if (part.type === 'tool_result') {
            const key = `${part.toolUseId}:${part.content}`;
            if (seenToolResults.has(key)) return false;
            seenToolResults.add(key);
          }
          return true;
        });
        if (newParts.length > 0) {
          deduped.push({ ...msg, content: newParts });
        }
      } else {
        deduped.push(msg);
      }
    }

    return deduped;
  }

  /** 合并两条同 role 消息 */
  private mergeMessages(a: LLMMessage, b: LLMMessage): LLMMessage {
    if (typeof a.content === 'string' && typeof b.content === 'string') {
      return { role: a.role, content: a.content + '\n' + b.content };
    }
    // ContentPart[] 情况：合并数组
    const aParts = Array.isArray(a.content) ? a.content : [];
    const bParts = Array.isArray(b.content) ? b.content : [];
    return { role: a.role, content: [...aParts, ...bParts] };
  }

  /** 计算消息列表的总 token 数（P8：使用 WeakMap 缓存，避免重复计算） */
  private totalTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // P8：同一消息引用复用缓存结果（stage 产生新对象时不命中缓存，自动重算）
      const cached = this.tokenCache.get(msg);
      if (cached !== undefined) {
        total += cached;
      } else {
        const t = this.messageTokens(msg);
        this.tokenCache.set(msg, t);
        total += t;
      }
    }
    return total;
  }

  /** 计算单条消息的 token 数 */
  private messageTokens(msg: LLMMessage): number {
    if (typeof msg.content === 'string') {
      return this.config.estimateTokens(msg.content);
    }
    if (Array.isArray(msg.content)) {
      return msg.content.reduce((sum, part) => sum + this.partTokens(part), 0);
    }
    return 0;
  }

  /** 计算 ContentPart 的 token 数 */
  private partTokens(part: ContentPart): number {
    switch (part.type) {
      case 'text':
        return this.config.estimateTokens(part.text);
      case 'tool_result':
        return this.config.estimateTokens(part.content);
      case 'tool_use':
        return this.config.estimateTokens(part.name + JSON.stringify(part.arguments));
      case 'image':
        // B5：图片 token 估算（Anthropic 公式：基于 base64 数据量粗估）
        // 公式：Math.ceil(base64Length / 750)，近似 (width*height/750) + 1500 的平均值
        // 对于无尺寸信息的 base64，按数据量估算：每 750 字节 ≈ 1 token（含 overhead）
        if (part.source && typeof part.source === 'object' && 'data' in part.source) {
          const data = (part.source as { data: string }).data ?? '';
          return Math.ceil(data.length / 750) + 85; // +85 为图片固定 overhead
        }
        return 256; // 无数据时给保守估值
      default:
        return 0;
    }
  }
}

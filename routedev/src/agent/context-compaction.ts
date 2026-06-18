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

import type { LLMMessage, ContentPart, ToolResultContent } from '../router/types.js';

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
}

/** 压缩配置 */
export interface CompactionConfig {
  /** 目标 token 数：每阶段后检查，达到则停止 */
  targetTokens: number;
  /** token 估算函数 */
  estimateTokens: (text: string) => number;
  /** L5 摘要函数（可选，不提供则跳过 L5） */
  summarize?: (messages: LLMMessage[]) => Promise<string>;
}

// 阈值常量
const TOOL_OUTPUT_TRUNCATE_THRESHOLD = 2000;
const TOOL_OUTPUT_HEAD = 500;
const TOOL_OUTPUT_TAIL = 500;
const TRUNCATE_MARKER = '[...截断...]';
const SNIP_KEEP_RECENT = 10;

export class ContextCompactor {
  constructor(private config: CompactionConfig) {}

  /**
   * 执行渐进压缩
   * 依次执行 L1→L5，每阶段后检查是否达到 targetTokens，达到则停止
   */
  async compact(
    messages: LLMMessage[],
  ): Promise<{ messages: LLMMessage[]; result: CompactionResult }> {
    const beforeTokens = this.totalTokens(messages);
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
              summary = await this.config.summarize(current);
              current = [{ role: 'system', content: summary }];
            }
          }
        }
      }
    }

    const afterTokens = this.totalTokens(current);
    return {
      messages: current,
      result: {
        beforeTokens,
        afterTokens,
        maxStageReached,
        removedMessages: Math.max(0, messages.length - current.length),
        summary,
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

  /** 计算消息列表的总 token 数 */
  private totalTokens(messages: LLMMessage[]): number {
    return messages.reduce((sum, msg) => sum + this.messageTokens(msg), 0);
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
        return 0; // 图片不按文本估算
      default:
        return 0;
    }
  }
}

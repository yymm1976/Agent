// src/agent/context/token-aware-slicer.ts
// Phase 71 Task B1：tiktoken-aware 上下文截断（学习 Cline）
import { countTokens } from '../../code-map/token-counter.js';
import type { LLMMessage } from '../../router/types.js';

export interface SliceOptions {
  maxTokens: number;
  strategy: 'tail' | 'head' | 'balanced';
  preserveSystemMessages: boolean;
  preserveLastToolPair: boolean; // Cline 风格：保留最后 N 个 tool_use+tool_result 对
}

export interface SliceResult {
  sliced: LLMMessage[];
  truncatedTokens: number;
  originalTokens: number;
}

/** 计算单条消息的 token 数（content 可能是 string 或 ContentPart[]） */
function messageTokens(msg: LLMMessage): number {
  if (typeof msg.content === 'string') return countTokens(msg.content);
  // ContentPart[]：累加每段的 text/JSON
  return countTokens(JSON.stringify(msg.content));
}

export function sliceByTokenBudget(
  messages: LLMMessage[],
  options: SliceOptions,
): SliceResult {
  const originalTokens = messages.reduce((s, m) => s + messageTokens(m), 0);
  if (originalTokens <= options.maxTokens) {
    return { sliced: messages, truncatedTokens: 0, originalTokens };
  }

  // 1. 始终保留 system 消息（若 preserveSystemMessages=true）
  const systemMsgs = options.preserveSystemMessages
    ? messages.filter(m => m.role === 'system')
    : [];
  const systemTokens = systemMsgs.reduce((s, m) => s + messageTokens(m), 0);
  let remainingBudget = options.maxTokens - systemTokens;
  if (remainingBudget < 0) remainingBudget = 0;

  // 2. 保留最后 N 个 tool_use+tool_result 对（Cline 风格）
  //    从消息列表尾部向前扫描，找出最后一段连续的 [assistant(tool_use), user(tool_result)] 对
  //    简化实现：保留尾部所有 role=assistant(含 tool_call) 和紧跟其后的 role=user(含 tool_result)
  const nonSystem = messages.filter(m => m.role !== 'system');
  const preservedTail: LLMMessage[] = [];
  let preservedTailTokens = 0;

  if (options.preserveLastToolPair && nonSystem.length > 0) {
    // 从尾部向前收集 tool_use/tool_result 对，直到遇到非工具消息或预算用完
    let i = nonSystem.length - 1;
    while (i >= 0 && remainingBudget - preservedTailTokens > 0) {
      const msg = nonSystem[i];
      const isToolResult = msg.role === 'user' && Array.isArray(msg.content) &&
        msg.content.some(p => p && typeof p === 'object' && 'type' in p && p.type === 'tool_result');
      const isToolUse = msg.role === 'assistant' && Array.isArray(msg.content) &&
        msg.content.some(p => p && typeof p === 'object' && 'type' in p && p.type === 'tool_use');
      if (isToolResult || isToolUse) {
        const t = messageTokens(msg);
        if (preservedTailTokens + t > remainingBudget) break;
        preservedTail.unshift(msg);
        preservedTailTokens += t;
        i--;
      } else {
        break; // 遇到非工具消息停止
      }
    }
  }
  remainingBudget -= preservedTailTokens;

  // 3. 剩余预算按 strategy 分配给 user/assistant 消息（排除已加入 preservedTail 的尾部工具对）
  //    strategy='tail'：从尾部（不含 preservedTail）向前累加
  //    strategy='head'：从头部向后累加
  //    strategy='balanced'：头尾各占一半
  const tailStartIndex = nonSystem.length - preservedTail.length;
  const bodyMessages = nonSystem.slice(0, tailStartIndex);
  const included: LLMMessage[] = [];
  let usedTokens = 0;

  if (options.strategy === 'tail') {
    for (let i = bodyMessages.length - 1; i >= 0; i--) {
      const msg = bodyMessages[i];
      const t = messageTokens(msg);
      if (usedTokens + t > remainingBudget) break;
      included.unshift(msg);
      usedTokens += t;
    }
  } else if (options.strategy === 'head') {
    for (const msg of bodyMessages) {
      const t = messageTokens(msg);
      if (usedTokens + t > remainingBudget) break;
      included.push(msg);
      usedTokens += t;
    }
  } else {
    // balanced：一半给头部，一半给尾部
    const halfBudget = Math.floor(remainingBudget / 2);
    const headPart: LLMMessage[] = [];
    let headTokens = 0;
    for (const msg of bodyMessages) {
      const t = messageTokens(msg);
      if (headTokens + t > halfBudget) break;
      headPart.push(msg);
      headTokens += t;
    }
    const tailPart: LLMMessage[] = [];
    let tailTokens = 0;
    for (let i = bodyMessages.length - 1; i >= 0; i--) {
      const msg = bodyMessages[i];
      const t = messageTokens(msg);
      if (tailTokens + t > remainingBudget - halfBudget) break;
      tailPart.unshift(msg);
      tailTokens += t;
    }
    included.push(...headPart, ...tailPart);
    usedTokens = headTokens + tailTokens;
  }

  const sliced = [...systemMsgs, ...included, ...preservedTail];
  const usedTotal = systemTokens + usedTokens + preservedTailTokens;
  return {
    sliced,
    truncatedTokens: Math.max(0, originalTokens - usedTotal),
    originalTokens,
  };
}

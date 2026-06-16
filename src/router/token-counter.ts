// src/router/token-counter.ts
// Token 计数器：估算消息的 token 数量
// 注：这是 tiktoken 的轻量替代，精度约 90%。生产环境建议替换为 tiktoken

import type { LLMMessage, ContentPart } from './types.js';

/**
 * 估算字符串的 token 数量
 * 算法：英文约 4 字符/token，中文约 1.5 字符/token
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  let chineseChars = 0;
  let otherChars = 0;

  // 统计中文字符和其他字符
  for (const char of text) {
    // 中文字符范围（基本汉字 + 扩展）
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }

  // 中文字符：约 1.5 字符/token
  tokens += Math.ceil(chineseChars / 1.5);
  // 其他字符：约 4 字符/token
  tokens += Math.ceil(otherChars / 4);

  return tokens;
}

/**
 * 估算单条消息的 token 数量
 * 包含消息格式开销（role + 分隔符约 4 tokens）
 */
export function estimateMessageTokens(message: LLMMessage): number {
  const formatOverhead = 4; // role + 分隔符

  if (typeof message.content === 'string') {
    return formatOverhead + estimateTokenCount(message.content);
  }

  // 多模态内容（ContentPart[]）
  if (Array.isArray(message.content)) {
    let total = formatOverhead;
    for (const part of message.content) {
      total += estimateContentPartTokens(part);
    }
    return total;
  }

  return formatOverhead;
}

/**
 * 估算内容块的 token 数量
 */
function estimateContentPartTokens(part: ContentPart): number {
  switch (part.type) {
    case 'text':
      return estimateTokenCount(part.text);

    case 'tool_use':
      // 工具调用：名称 + 参数序列化
      const argsStr = JSON.stringify(part.arguments);
      return estimateTokenCount(part.name) + estimateTokenCount(argsStr) + 4;

    case 'tool_result':
      return estimateTokenCount(part.content) + 4;

    case 'image':
      // 图片：按分辨率估算（简化为固定值）
      // 实际实现应根据 mediaType 和 data 长度计算
      return 1000; // 假设中等分辨率图片约 1000 tokens

    default:
      return 0;
  }
}

/**
 * 估算消息数组的总 token 数量
 */
export function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * 估算系统 prompt 的 token 数量
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return estimateTokenCount(systemPrompt) + 4; // 格式开销
}

/**
 * 估算工具定义的 token 数量
 * 工具定义包含名称、描述、参数 schema
 */
export function estimateToolDefinitionTokens(tool: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}): number {
  const nameTokens = estimateTokenCount(tool.name);
  const descTokens = estimateTokenCount(tool.description);
  const paramsTokens = estimateTokenCount(JSON.stringify(tool.parameters));
  return nameTokens + descTokens + paramsTokens + 10; // 格式开销
}

/**
 * 检查消息是否超过 token 限制
 */
export function checkTokenLimit(
  messages: LLMMessage[],
  systemPrompt: string | undefined,
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> | undefined,
  maxTokens: number,
): { withinLimit: boolean; estimatedTokens: number } {
  let total = estimateMessagesTokens(messages);

  if (systemPrompt) {
    total += estimateSystemPromptTokens(systemPrompt);
  }

  if (tools) {
    for (const tool of tools) {
      total += estimateToolDefinitionTokens(tool);
    }
  }

  return {
    withinLimit: total <= maxTokens,
    estimatedTokens: total,
  };
}

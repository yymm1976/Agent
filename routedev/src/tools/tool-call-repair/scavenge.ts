// src/tools/tool-call-repair/scavenge.ts
// 工序 1：scavenge — 扫描 reasoning_content / rawText 捞回被吃掉的 tool-call JSON
//
// 触发场景：
//   - DeepSeek R1 类模型把 tool-call JSON 写进 reasoning_content，
//     但 reasoning_content 不参与 tool_calls 解析，导致工具调用丢失
//   - 部分模型在 assistant 文本中嵌入 JSON 但未触发 function calling
//
// 策略：
//   - 在 reasoningContent + rawText 中扫描 tool-call JSON 模式
//   - 模式：{"name": "<toolName>", "arguments": {...}} 或 {"tool": "...", "args": {...}}
//   - 仅当原 toolCalls 为空或与捞回的调用不重复时才追加

import type { ToolCallRequest } from '../../router/types.js';
import type { RepairContext, RepairStepResult } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * 匹配 tool-call JSON 的正则
 * - 支持两种字段命名：name/arguments（OpenAI 风格）和 tool/args（简写）
 * - arguments 段允许任意字符（含嵌套 { }），靠 JSON.parse 校验有效性
 * - 工具名仅允许字母数字下划点连字符
 */
const TOOL_CALL_JSON_PATTERN = /\{\s*"(?:name|tool)"\s*:\s*"([a-zA-Z0-9_.\-]+)"\s*,\s*"(?:arguments|args)"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})\s*\}/g;

/**
 * 工序 1：scavenge — 从推理内容/原始文本中捞回被吃掉的 tool-call JSON
 *
 * @returns RepairStepResult.toolCalls 包含原 toolCalls + 捞回的（去重后）调用
 */
export function scavenge(ctx: RepairContext): RepairStepResult {
  const { toolCalls, reasoningContent, rawText } = ctx;
  const sourceText = [reasoningContent, rawText].filter(Boolean).join('\n');

  if (!sourceText) {
    return { toolCalls, repaired: false, reason: 'no reasoning/rawText to scavenge' };
  }

  const scavenged: ToolCallRequest[] = [];
  let match: RegExpExecArray | null;
  // 重置 lastIndex 避免全局正则多次调用时状态残留
  TOOL_CALL_JSON_PATTERN.lastIndex = 0;

  while ((match = TOOL_CALL_JSON_PATTERN.exec(sourceText)) !== null) {
    const toolName = match[1];
    const argsStr = match[2];
    try {
      const args = JSON.parse(argsStr);
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        continue;
      }
      scavenged.push({
        // 用时间戳 + 随机后缀生成稳定且不冲突的 id
        id: `scavenged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        arguments: args as Record<string, unknown>,
      });
    } catch {
      // JSON.parse 失败说明不是合法 JSON，跳过
      continue;
    }
  }

  if (scavenged.length === 0) {
    return { toolCalls, repaired: false, reason: 'no tool-call JSON found in reasoning/rawText' };
  }

  // 去重：避免捞回的调用与原 toolCalls 重复（按 name + arguments JSON 字符串）
  const existingKeys = new Set(
    toolCalls.map((tc) => `${tc.name}::${JSON.stringify(tc.arguments)}`),
  );
  const unique = scavenged.filter(
    (tc) => !existingKeys.has(`${tc.name}::${JSON.stringify(tc.arguments)}`),
  );

  if (unique.length === 0) {
    return { toolCalls, repaired: false, reason: 'scavenged calls duplicate with existing toolCalls' };
  }

  logger.info('ToolCallRepair.scavenge: recovered tool calls from reasoning', {
    count: unique.length,
    toolNames: unique.map((tc) => tc.name),
  });

  return {
    toolCalls: [...toolCalls, ...unique],
    repaired: true,
    reason: `recovered ${unique.length} tool call(s) from reasoning/rawText`,
  };
}

// src/tools/tool-call-repair/truncation.ts
// 工序 4：truncation — 检测不完整的工具调用 JSON 并尝试补全
//
// 触发场景：
//   - LLM 输出被 max_tokens 截断，tool_calls 的 arguments JSON 不完整
//   - 流式解析时 tool_call_delta 拼接出错，括号不匹配
//   - 部分模型在 arguments 中嵌入未转义的特殊字符导致 JSON 提前终止
//
// 策略：
//   - 检测：toolCall.arguments 字段为字符串（未解析的 JSON 片段）或解析失败
//   - 补全括号：统计未匹配的 { [ " 字符，补全尾部
//   - 截断修复：若 arguments 字符串以 " 开头但未闭合，补全 "\}
//   - 失败兜底：补全仍无法解析时，将 arguments 替换为空对象 {} 并标记 isError
//
// 注意：本工序不调用 LLM 续写（避免引入额外延迟与费用），仅做本地括号补全。
//       完整续写机制由 loop.ts 的 max_tokens 重试逻辑处理（finishReason === 'length' 时）。

import type { ToolCallRequest } from '../../router/types.js';
import type { RepairContext, RepairStepResult } from './types.js';
import { logger } from '../../utils/logger.js';

/** 单次补全尝试的最大修补字符数 */
const MAX_PATCH_CHARS = 64;

/**
 * 统计 JSON 字符串中未匹配的括号数量
 * - 跳过字符串内的括号（被双引号包裹的）
 * - 处理转义字符（\" \\ 等）
 * - 返回需要补全的尾部分隔符
 */
function findUnmatchedBrackets(jsonStr: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}') {
      if (stack.length > 0 && stack[stack.length - 1] === '{') {
        stack.pop();
      }
    } else if (ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === '[') {
        stack.pop();
      }
    }
  }

  // 字符串未闭合：补一个 "
  let patch = '';
  if (inString) patch += '"';

  // 按 stack 倒序补全
  for (let i = stack.length - 1; i >= 0; i--) {
    const open = stack[i];
    patch += open === '{' ? '}' : ']';
    if (patch.length >= MAX_PATCH_CHARS) break;
  }
  return patch;
}

/**
 * 尝试把任意值规范化为合法的 arguments 对象
 * - 已是对象：原样返回
 * - 字符串：先尝试 JSON.parse，失败则尝试括号补全
 * - 其他类型：返回空对象（无法修复）
 */
function tryParseArgs(raw: unknown): {
  args: Record<string, unknown>;
  repaired: boolean;
  reason: string;
} {
  // 已是合法对象：无需修复
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, repaired: false, reason: '' };
  }

  // 非字符串类型：无法修复，替换为空对象
  if (typeof raw !== 'string') {
    return { args: {}, repaired: true, reason: `non-object args (${typeof raw}) replaced with {}` };
  }

  const str = raw.trim();
  if (str === '') {
    return { args: {}, repaired: true, reason: 'empty args string replaced with {}' };
  }

  // 字符串类型：尝试解析为对象。解析成功也是修复（类型从 string → object）
  try {
    const parsed = JSON.parse(str);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed, repaired: true, reason: 'string args parsed to object' };
    }
    return { args: {}, repaired: true, reason: 'parsed value is not object, replaced with {}' };
  } catch {
    // 解析失败，继续尝试补全
  }

  // 尝试补全括号
  const patch = findUnmatchedBrackets(str);
  if (patch === '') {
    // 无可补全的括号，但解析失败 → 视为 JSON 语法错误，无法修复
    return { args: {}, repaired: true, reason: 'JSON syntax error, cannot auto-repair' };
  }

  const patchedStr = str + patch;
  try {
    const parsed = JSON.parse(patchedStr);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return {
        args: parsed,
        repaired: true,
        reason: `incomplete JSON patched with ${JSON.stringify(patch)}`,
      };
    }
  } catch {
    // 补全后仍无法解析
  }

  return { args: {}, repaired: true, reason: 'bracket patching failed, replaced with {}' };
}

/**
 * 工序 4：truncation — 修复不完整的工具调用 JSON
 *
 * 触发条件：
 *   - toolCall.arguments 不是对象（如字符串、被截断的 JSON 片段）
 *   - toolCall.arguments 为对象但 JSON.stringify 后无法回解析（罕见，但可能因循环引用）
 *
 * 修复策略：见 tryParseArgs
 */
export function truncation(ctx: RepairContext): RepairStepResult {
  const { toolCalls } = ctx;
  let anyRepaired = false;
  const reasons: string[] = [];

  const repaired = toolCalls.map((tc) => {
    const { args, repaired: didRepair, reason } = tryParseArgs(tc.arguments);
    if (!didRepair) return tc;

    anyRepaired = true;
    reasons.push(`${tc.name}: ${reason}`);
    logger.info('ToolCallRepair.truncation: repaired tool args', {
      toolName: tc.name,
      reason,
      originalType: typeof tc.arguments,
    });
    return { ...tc, arguments: args };
  });

  if (!anyRepaired) {
    return { toolCalls, repaired: false, reason: 'all tool args are valid objects' };
  }

  return {
    toolCalls: repaired,
    repaired: true,
    reason: reasons.join('; '),
  };
}

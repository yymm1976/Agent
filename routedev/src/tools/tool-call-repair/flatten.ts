// src/tools/tool-call-repair/flatten.ts
// 工序 2：flatten — 检测过深嵌套参数并打平为 dot-notation
//
// 触发场景：
//   - LLM 生成的工具参数嵌套层级过深（>2 层），导致工具 schema 校验失败
//   - 部分工具（file_edit 等）的 schema 不支持嵌套对象，但 LLM 仍输出嵌套结构
//   - 字段数过多（>10）通常是 LLM 把所有可能参数都填上了，打平后更易被工具接受
//
// 策略：
//   - 深度阈值：嵌套对象超过 MAX_DEPTH（默认 2）层时打平
//   - 字段数阈值：顶层字段数超过 MAX_FIELDS（默认 10）时打平
//   - 打平规则：{a: {b: {c: 1}}} → {"a.b.c": 1}
//   - 数组与原始类型不打平（保留原样）
//   - 满足任一阈值才打平，避免对正常参数无意义改动
//
// 注意：本工序只做参数结构打平，不改工具名或调用 id。
//       dispatch 时工具仍按打平后的 key 接收参数，调用方需保证工具支持 dot-notation key。

import type { ToolCallRequest } from '../../router/types.js';
import type { RepairContext, RepairStepResult } from './types.js';
import { logger } from '../../utils/logger.js';

/** 嵌套深度阈值：超过此深度则触发打平 */
const MAX_DEPTH = 2;
/** 顶层字段数阈值：超过此数量则触发打平 */
const MAX_FIELDS = 10;

/**
 * 计算对象的最大嵌套深度
 * - 原始类型深度为 0
 * - {a: 1} 深度为 1
 * - {a: {b: 1}} 深度为 2
 */
function maxDepth(obj: unknown, seen: WeakSet<object> = new WeakSet()): number {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return 0;
  if (seen.has(obj)) return 0; // 循环引用保护
  seen.add(obj);
  let depth = 1;
  for (const v of Object.values(obj as Record<string, unknown>)) {
    depth = Math.max(depth, 1 + maxDepth(v, seen));
  }
  return depth;
}

/**
 * 递归打平对象为 dot-notation
 * - {a: {b: 1, c: 2}} → {"a.b": 1, "a.c": 2}
 * - 数组保留原样，不打平
 * - 空对象 {} 打平后丢弃（无字段可打平）
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix: string = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      // 非空对象：递归打平
      flattenObject(value as Record<string, unknown>, newKey, out);
    } else {
      // 原始类型、数组、null、空对象：直接保留
      out[newKey] = value;
    }
  }
  return out;
}

/**
 * 工序 2：flatten — 检测过深嵌套参数并打平为 dot-notation
 *
 * 触发条件：toolCall.arguments 满足以下任一条件
 *   - 最大嵌套深度 > MAX_DEPTH
 *   - 顶层字段数 > MAX_FIELDS
 */
export function flatten(ctx: RepairContext): RepairStepResult {
  const { toolCalls } = ctx;
  let anyRepaired = false;
  const reasons: string[] = [];

  const repaired = toolCalls.map((tc) => {
    const args = tc.arguments;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return tc;
    }
    const depth = maxDepth(args);
    const fieldCount = Object.keys(args).length;

    if (depth <= MAX_DEPTH && fieldCount <= MAX_FIELDS) {
      return tc;
    }

    const flattened = flattenObject(args);
    anyRepaired = true;
    const reason = `${tc.name}: depth ${depth}/${MAX_DEPTH}, fields ${fieldCount}/${MAX_FIELDS} → flattened ${Object.keys(flattened).length} keys`;
    reasons.push(reason);
    logger.info('ToolCallRepair.flatten: flattened tool args', {
      toolName: tc.name,
      originalDepth: depth,
      originalFields: fieldCount,
      flattenedKeys: Object.keys(flattened).length,
    });

    return { ...tc, arguments: flattened };
  });

  if (!anyRepaired) {
    return { toolCalls, repaired: false, reason: 'no tool args exceed depth/field thresholds' };
  }

  return {
    toolCalls: repaired,
    repaired: true,
    reason: reasons.join('; '),
  };
}

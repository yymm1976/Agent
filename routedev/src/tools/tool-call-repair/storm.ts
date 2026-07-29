// src/tools/tool-call-repair/storm.ts
// 工序 3：storm — 滑动窗口检测相同 (tool, args) 组合，抑制重复并注入反思轮次
//
// 触发场景：
//   - LLM 在同一轮中重复调用同一工具同一参数（典型死循环）
//   - 跨轮重复：最近 N 轮已执行的工具调用与本轮重复
//   - LLM 陷入"试错-试错"循环但没意识到
//
// 策略：
//   - 滑动窗口：WINDOW_SIZE（默认 5）轮内的工具调用历史
//   - 重复阈值：相同 (tool, args) 组合在窗口内出现 ≥ REPEAT_THRESHOLD（默认 3）次时触发
//   - 抑制：删除本轮中重复的工具调用（保留第一次）
//   - 反思：注入一条 user 消息提示 LLM 换方法（pipeline 调用方负责 push 到 messages）
//
// 注意：仅检测完全相同的 (tool, args) 组合，相似但不完全相同的参数不触发。

import type { ToolCallRequest } from '../../router/types.js';
import type { RepairContext, RepairStepResult } from './types.js';
import { logger } from '../../utils/logger.js';

/** 滑动窗口大小：最近多少轮的工具调用参与重复检测 */
const WINDOW_SIZE = 5;
/** 重复阈值：相同 (tool, args) 在窗口内出现多少次才触发抑制 */
const REPEAT_THRESHOLD = 3;

/**
 * 生成工具调用的去重 key
 * - tool name + arguments JSON 字符串
 * - JSON.stringify 保证 key 稳定（字段顺序由 LLM 输出决定，相同调用通常顺序一致）
 */
function toolCallKey(tc: ToolCallRequest): string {
  return `${tc.name}::${JSON.stringify(tc.arguments)}`;
}

/**
 * 工序 3：storm — 检测重复工具调用并注入反思提示
 *
 * @returns RepairStepResult
 *   - toolCalls：删除重复调用后的列表（保留首次出现）
 *   - injectedReflection：若触发抑制，包含应注入 LLM 上下文的反思提示
 */
export function storm(ctx: RepairContext): RepairStepResult {
  const { toolCalls, recentToolCalls } = ctx;

  if (toolCalls.length === 0) {
    return { toolCalls, repaired: false, reason: 'no toolCalls to inspect' };
  }

  // 构建滑动窗口：recentToolCalls（最近 N 轮）+ 当前 toolCalls
  // recentToolCalls 按时间倒序，取最近 WINDOW_SIZE 条
  const recentWindow = recentToolCalls.slice(0, WINDOW_SIZE);

  // 统计每个 (tool, args) 组合在窗口内的出现次数
  const counts = new Map<string, number>();
  for (const tc of recentWindow) {
    const key = toolCallKey(tc);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // 检测本轮重复并去重
  const seen = new Set<string>();
  const deduped: ToolCallRequest[] = [];
  const suppressedKeys: string[] = [];

  for (const tc of toolCalls) {
    const key = toolCallKey(tc);
    const totalCount = (counts.get(key) ?? 0) + (seen.has(key) ? 1 : 0);

    // 窗口内 + 本轮累计已达阈值，且当前不是首次出现 → 抑制
    if (totalCount >= REPEAT_THRESHOLD && seen.has(key)) {
      suppressedKeys.push(key);
      continue;
    }

    seen.add(key);
    deduped.push(tc);
    // 更新本轮计数
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (suppressedKeys.length === 0) {
    return { toolCalls, repaired: false, reason: 'no repeated tool calls detected' };
  }

  const reflection = [
    '[系统提示] 检测到工具调用循环：以下工具调用在最近几轮中重复出现，但参数未变，可能无法推进任务。',
    '请换一种方法：',
    '1. 检查参数是否正确（路径/搜索词/正则等）',
    '2. 尝试用不同的工具或组合（如 file_read → file_search）',
    '3. 重新审视任务目标，确认当前思路是否可行',
    '4. 若确实需要重复调用，请修改至少一个参数',
    `重复的工具调用：${suppressedKeys.map((k) => k.split('::')[0]).join(', ')}`,
  ].join('\n');

  logger.info('ToolCallRepair.storm: suppressed repeated tool calls', {
    suppressedCount: suppressedKeys.length,
    suppressedTools: suppressedKeys.map((k) => k.split('::')[0]),
    windowSize: recentWindow.length,
  });

  return {
    toolCalls: deduped,
    repaired: true,
    reason: `suppressed ${suppressedKeys.length} repeated tool call(s)`,
    injectedReflection: reflection,
  };
}

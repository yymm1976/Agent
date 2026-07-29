// src/tools/tool-call-repair/types.ts
// 工具调用修复 pipeline 共享类型
//
// 借鉴来源：Reasonix（DeepSeek 原生终端 Agent）的四道修复工序
// 设计目标：在 LLM 输出 toolCalls 送入执行前，自动修复四类常见问题：
//   1. scavenge — 推理内容里被吃掉的 tool-call JSON
//   2. flatten  — 过深嵌套参数打平为 dot-notation
//   3. storm    — 滑动窗口检测重复 (tool, args) 组合
//   4. truncation — 不完整 JSON 补全或请求续写
//
// 接入点：loop.ts 在 `if (result.toolCalls.length > 0)` 之前调用 repairPipeline.run()

import type { ToolCallRequest } from '../../router/types.js';

/**
 * 修复工序的输入上下文
 * - toolCalls：当前轮从 LLM 输出解析出的工具调用列表
 * - reasoningContent：本轮 LLM 的推理内容（DeepSeek R1 类模型的 reasoning_content 字段）
 * - rawText：本轮 LLM 的完整原始文本（含 reasoning + assistant 文本，用于 scavenge 兜底扫描）
 * - recentToolCalls：最近 N 轮已执行的工具调用（storm 重复检测用），按时间倒序
 */
export interface RepairContext {
  toolCalls: ToolCallRequest[];
  reasoningContent?: string;
  rawText?: string;
  recentToolCalls: ToolCallRequest[];
}

/**
 * 单道工序的处理结果
 * - toolCalls：经此工序修复后的工具调用列表（可能新增/修改/删除条目）
 * - repaired：是否实际发生了修复
 * - reason：修复原因（用于日志与可观测性）
 * - injectedReflection：storm 工序可能返回的反思提示，调用方应作为 user 消息注入 LLM 上下文
 */
export interface RepairStepResult {
  toolCalls: ToolCallRequest[];
  repaired: boolean;
  reason: string;
  /** storm 工序专用：注入 LLM 上下文的反思提示，调用方应作为 user 消息 push 到 messages */
  injectedReflection?: string;
}

/**
 * Pipeline 整体运行结果
 */
export interface PipelineResult {
  /** 修复后的工具调用列表（已合并所有工序的输出） */
  toolCalls: ToolCallRequest[];
  /** 各工序的修复摘要（用于日志） */
  summary: Array<{ step: string; repaired: boolean; reason: string }>;
  /** 待注入 LLM 上下文的反思提示（来自 storm 工序） */
  reflections: string[];
}

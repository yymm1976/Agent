// src/agent/loop-config.ts
// ReAct Agent Loop 的配置和事件类型
// agent/types.ts 已定义 AgentEvent 等通用类型，这里补充循环专用配置和事件

import type { LLMToolDefinition, TokenUsageInfo } from '../router/types.js';

/** ReAct 循环配置 */
export interface ReActConfig {
  /** 最大迭代次数（防止死循环，默认 10） */
  maxIterations: number;
  /** 单次 LLM 调用的超时时间（毫秒，默认 120000） */
  llmTimeout: number;
  /** 是否启用工具调用（Phase 5 默认 false，Phase 6 改为 true） */
  toolsEnabled: boolean;
  /** 最大连续错误次数，超过则终止循环（默认 3） */
  maxConsecutiveErrors: number;
}

/** 默认循环配置 */
export const DEFAULT_REACT_CONFIG: ReActConfig = {
  maxIterations: 10,
  llmTimeout: 120000,
  toolsEnabled: false,
  maxConsecutiveErrors: 3,
};

/**
 * ReAct 循环事件类型
 * 这些事件由 ReActAgentLoop.run() yield 出来，供 CLI 层消费
 */
export type ReActEvent =
  /** 开始思考（每次 LLM 调用前） */
  | { type: 'thinking'; message: string }
  /** 文本增量（流式输出） */
  | { type: 'text_delta'; text: string }
  /** 工具调用开始 */
  | { type: 'tool_call_start'; toolName: string; toolCallId: string }
  /** 工具调用结果 */
  | { type: 'tool_call_result'; toolName: string; toolCallId: string; result: string; isError: boolean }
  /** 工具调用需要用户确认（Phase 9 自主模式） */
  | { type: 'approval_required'; toolName: string; toolCallId: string; args: Record<string, unknown>; reason: string }
  /** 错误（循环可能还在继续重试） */
  | { type: 'error'; error: string; usage?: TokenUsageInfo }
  /** 循环结束 */
  | { type: 'done'; content: string; usage: TokenUsageInfo };

/** 工具确认回调
 *  Phase 9：返回 Promise<boolean>，由 CLI 层的 handleSubmit 路由用户输入
 *  - true → 工具执行
 *  - false → 工具跳过，注入拒绝信息
 */
export type ConfirmToolCallback = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<boolean>;

/** 工具执行适配器接口
 *  Phase 5 使用最小桩实现，Phase 6 替换为完整的 ToolRegistry + ToolExecutor
 */
export interface ToolExecutorAdapter {
  /** 获取当前可用的工具定义（给 LLM 的 function calling schema） */
  getToolDefinitions(): LLMToolDefinition[];

  /** 执行一个工具调用，返回结果文本
   *  如果工具不存在或执行失败，返回错误描述（不抛异常）
   */
  executeTool(toolName: string, toolCallId: string, args: Record<string, unknown>): Promise<string>;

  /** 检查指定工具是否存在 */
  hasTool(toolName: string): boolean;
}

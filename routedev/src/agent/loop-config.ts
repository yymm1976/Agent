// src/agent/loop-config.ts
// ReAct Agent Loop 的配置和事件类型
// agent/types.ts 已定义 AgentEvent 等通用类型，这里补充循环专用配置和事件

import type { LLMMessage, LLMToolDefinition, TokenUsageInfo } from '../router/types.js';
import type { AgentMessage } from './message-types.js';

/** ReAct 循环配置 */
export interface ReActConfig {
  /** 最大迭代次数（防止死循环，默认 50） */
  maxIterations: number;
  /** 单次 LLM 调用的超时时间（毫秒，默认 120000） */
  llmTimeout: number;
  /** 是否启用工具调用（Phase 5 默认 false，Phase 6 改为 true） */
  toolsEnabled: boolean;
  /** 最大连续错误次数，超过则终止循环（默认 3） */
  maxConsecutiveErrors: number;
  /** P2-12：是否并行执行工具调用（默认 false，与 Codex/Claude Code 对齐） */
  parallelToolExecution: boolean;
  /** 自动批准的工具名模式列表（支持精确匹配和通配符 *）
   * 匹配的工具调用跳过用户确认，直接执行
   * 默认包含只读安全工具：file_read、list_directory、code_search 等
   */
  autoApprovePatterns: string[];
  /** Phase 73 Part A：LLM 调用边界消息转换钩子（可选）
   *  循环内部可承载自定义 AgentMessage（如 plan 状态、memory 片段），
   *  调用 LLM 前通过此钩子过滤为 LLM 能理解的 LLMMessage。
   *  未配置时回退到 defaultConvertToLlm（仅保留 user/assistant/tool/system）。
   */
  convertToLlm?: (messages: AgentMessage[]) => LLMMessage[];
}

/** 默认循环配置 */
export const DEFAULT_REACT_CONFIG: ReActConfig = {
  // P2-13：从 10 提升到 50，与 Codex/Claude Code 对齐
  // 10 次迭代对于复杂任务（多文件修改+测试验证）不够，容易中途终止
  maxIterations: 50,
  llmTimeout: 120000,
  toolsEnabled: false,
  maxConsecutiveErrors: 3,
  // P2-12：默认开启并行工具执行，提升多工具调用场景的效率
  parallelToolExecution: true,
  // 默认自动批准只读安全工具，避免频繁打断用户
  // 写入/执行类工具（file_write、file_edit、shell_exec、git_op、spawn_agent）仍需确认
  autoApprovePatterns: [
    'file_read',
    'file_search',
    'code_search',
    'list_directory',
    'repo_map',
    'web_search',
    'web_fetch',
    'notes',
    'todo_write',
  ],
};

/**
 * ReAct 循环事件类型
 * 这些事件由 ReActAgentLoop.run() yield 出来，供 CLI 层消费
 */
export type ReActEvent =
  /** 开始思考（每次 LLM 调用前） */
  | { type: 'thinking'; message: string }
  /** 推理过程增量（reasoning 模型返回的思考过程） */
  | { type: 'reasoning_delta'; text: string }
  /** 文本增量（流式输出） */
  | { type: 'text_delta'; text: string }
  /** 工具调用开始（Phase 34：携带 args 用于动词体系展示） */
  | { type: 'tool_call_start'; toolName: string; toolCallId: string; args?: Record<string, unknown> }
  /** 工具调用结果 */
  | { type: 'tool_call_result'; toolName: string; toolCallId: string; result: string; isError: boolean }
  /** 工具调用需要用户确认（Phase 9 自主模式） */
  | { type: 'approval_required'; toolName: string; toolCallId: string; args: Record<string, unknown>; reason: string }
  /** 错误（循环可能还在继续重试） */
  | { type: 'error'; error: string; usage?: TokenUsageInfo }
  /** 循环结束 */
  | { type: 'done'; content: string; usage: TokenUsageInfo }
  /** Phase 30：Token Profile 快照（每次 LLM 调用前） */
  | { type: 'token_profile'; snapshot: import('./token-profiler.js').TokenProfileSnapshot };

/** 工具确认回调
 *  Phase 9：返回 Promise<boolean>，由 CLI 层的 handleSubmit 路由用户输入
 *  - true → 工具执行
 *  - false → 工具跳过，注入拒绝信息
 */
export type ConfirmToolCallback = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<boolean | { approved: boolean; payload?: unknown }>;

/** 工具执行适配器接口
 *  Phase 5 使用最小桩实现，Phase 6 替换为完整的 ToolRegistry + ToolExecutor
 *  P1-5 修复：新增 executeToolStructured 方法，返回结构化结果（isError 由工具声明）
 */
export interface ToolExecutorAdapter {
  /** 获取当前可用的工具定义（给 LLM 的 function calling schema） */
  getToolDefinitions(): LLMToolDefinition[];

  /** 执行一个工具调用，返回结果文本
   *  如果工具不存在或执行失败，返回错误描述（不抛异常）
   */
  executeTool(toolName: string, toolCallId: string, args: Record<string, unknown>): Promise<string>;

  /**
   * 结构化执行（P1-5 修复）
   * 返回 { output, isError }，isError 由工具的 success 字段决定
   * 替代正则匹配字符串判断 isError 的方式
   */
  executeToolStructured?(toolName: string, toolCallId: string, args: Record<string, unknown>): Promise<{ output: string; isError: boolean }>;

  /** 检查指定工具是否存在 */
  hasTool(toolName: string): boolean;

  /**
   * Phase 73 Part B：查询工具的执行模式
   * @returns 'sequential' 表示该工具需串行执行；'parallel' 或未实现表示可并行
   *
   * 设为可选方法以保持向后兼容：未实现的适配器默认返回 'parallel'，
   * loop.ts 调用方需对 undefined 做容错处理。
   */
  getToolExecutionMode?(toolName: string): 'sequential' | 'parallel' | undefined;
}

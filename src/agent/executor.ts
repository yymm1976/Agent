// src/agent/executor.ts
// Phase 5 最小工具执行器
// 所有工具调用都返回"暂不可用"提示
// Phase 6 会替换为真实的 ToolRegistry + ToolExecutor

import type { LLMToolDefinition } from '../router/types.js';
import type { ToolExecutorAdapter } from './loop-config.js';
import { logger } from '../utils/logger.js';

/**
 * 无工具执行器（Phase 5 桩实现）
 * 当 LLM 尝试调用工具时，返回提示信息让 LLM 用文本回答
 */
export class NoOpToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions(): LLMToolDefinition[] {
    // Phase 5 没有可用工具
    return [];
  }

  async executeTool(toolName: string, toolCallId: string, _args: Record<string, unknown>): Promise<string> {
    logger.warn('Tool call rejected (tools not available)', { toolName, toolCallId });
    return `[系统提示] 工具 "${toolName}" 当前不可用。请用文本直接回答用户的问题，不要尝试调用工具。`;
  }

  hasTool(_toolName: string): boolean {
    return false;
  }
}

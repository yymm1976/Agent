// src/tools/adapter.ts
// 桥梁适配器：连接 ReActAgentLoop 的 ToolExecutorAdapter 和工具框架的 IToolRegistry + IToolExecutor

import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import type { LLMToolDefinition } from '../router/types.js';
import type { IToolRegistry, IToolExecutor, ToolExecutionContext } from './types.js';
import { logger } from '../utils/logger.js';

export class ToolRegistryAdapter implements ToolExecutorAdapter {
  private registry: IToolRegistry;
  private executor: IToolExecutor;
  private context: ToolExecutionContext;

  constructor(
    registry: IToolRegistry,
    executor: IToolExecutor,
    context: ToolExecutionContext,
  ) {
    this.registry = registry;
    this.executor = executor;
    this.context = context;
  }

  getToolDefinitions(): LLMToolDefinition[] {
    return this.registry.list().map(tool => ({
      name: tool.definition.name,
      description: tool.definition.description,
      parameters: tool.definition.parameters as unknown as Record<string, unknown>,
    }));
  }

  async executeTool(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    logger.debug('ToolRegistryAdapter.executeTool', { toolName, toolCallId, args });

    const result = await this.executor.execute(toolName, args, this.context);

    if (result.success) {
      return result.output;
    }

    return `[工具错误] ${toolName}: ${result.error ?? '未知错误'}`;
  }

  hasTool(toolName: string): boolean {
    return this.registry.has(toolName);
  }

  updateContext(context: Partial<ToolExecutionContext>): void {
    this.context = { ...this.context, ...context };
  }
}

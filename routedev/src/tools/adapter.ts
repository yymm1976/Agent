// src/tools/adapter.ts
// 桥梁适配器：连接 ReActAgentLoop 的 ToolExecutorAdapter 和工具框架的 IToolRegistry + IToolExecutor
// P1-5 修复：executeTool 返回结构化结果，避免正则匹配字符串判断 isError

import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import type { LLMToolDefinition } from '../router/types.js';
import type { IToolRegistry, IToolExecutor, ToolExecutionContext } from './types.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import { logger } from '../utils/logger.js';

/** 结构化工具执行结果（P1-5 修复） */
export interface StructuredToolResult {
  /** 输出内容 */
  output: string;
  /** 是否为错误（由工具显式声明，而非字符串推断） */
  isError: boolean;
}

export class ToolRegistryAdapter implements ToolExecutorAdapter {
  private registry: IToolRegistry;
  private executor: IToolExecutor;
  private context: ToolExecutionContext;
  /** Phase 34：可选 TraceCollector，用于记录工具调用 span */
  private trace: TraceCollector | null = null;

  constructor(
    registry: IToolRegistry,
    executor: IToolExecutor,
    context: ToolExecutionContext,
  ) {
    this.registry = registry;
    this.executor = executor;
    this.context = context;
  }

  /** Phase 34：注入 TraceCollector */
  setTraceCollector(trace: TraceCollector | null): void {
    this.trace = trace;
  }

  /**
   * 注入用户确认回调。
   * App.tsx 在创建 commandBridge 后调用，使需要确认的工具（写操作/网络等）能弹出确认对话框。
   */
  setRequestConfirmation(callback: (reason: string) => Promise<boolean>): void {
    this.context = { ...this.context, requestConfirmation: callback };
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

    const span = this.trace?.recordToolCall(toolName, args, toolCallId, false);
    const result = await this.executor.execute(toolName, args, this.context);
    const isError = !result.success;
    const output = result.success ? result.output : `[工具错误] ${toolName}: ${result.error ?? '未知错误'}`;
    if (span && this.trace) {
      this.trace.recordToolResult(toolName, toolCallId, output, isError, true);
    }

    return output;
  }

  /**
   * 结构化执行（P1-5 修复）
   *
   * 返回 { output, isError }，isError 由工具的 success 字段决定
   * 替代 loop.ts 中用正则匹配字符串判断 isError 的方式
   */
  async executeToolStructured(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<StructuredToolResult> {
    logger.debug('ToolRegistryAdapter.executeToolStructured', { toolName, toolCallId, args });

    const span = this.trace?.recordToolCall(toolName, args, toolCallId, false);
    const result = await this.executor.execute(toolName, args, this.context);
    const isError = !result.success;
    const output = result.success ? result.output : `[工具错误] ${toolName}: ${result.error ?? '未知错误'}`;
    if (span && this.trace) {
      this.trace.recordToolResult(toolName, toolCallId, output, isError, true);
    }

    return { output, isError };
  }

  hasTool(toolName: string): boolean {
    return this.registry.has(toolName);
  }

  updateContext(context: Partial<ToolExecutionContext>): void {
    this.context = { ...this.context, ...context };
  }
}

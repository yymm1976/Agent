// src/tools/adapter.ts
// 桥梁适配器：连接 ReActAgentLoop 的 ToolExecutorAdapter 和工具框架的 IToolRegistry + IToolExecutor
// P1-5 修复：executeTool 返回结构化结果，避免正则匹配字符串判断 isError
// Phase 96 P1-1：executeTool/executeToolStructured 接收 callOptions，把 signal/onUpdate 合并到 context

import type { ToolExecutorAdapter, ToolExecCallOptions } from '../agent/loop-config.js';
import type { LLMToolDefinition } from '../router/types.js';
import type { IToolRegistry, IToolExecutor, ToolExecutionContext } from './types.js';
import { resolveVisibleTools } from './tool-surface-resolver.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import type { TurnToolBoost } from './tool-search.js';
import { logger } from '../utils/logger.js';

/** 结构化工具执行结果（P1-5 修复） */
interface StructuredToolResult {
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
  /** B-01B：回合级工具提升（tool_search 写入，getToolDefinitions 读取） */
  private boost: TurnToolBoost | null = null;

  constructor(
    registry: IToolRegistry,
    executor: IToolExecutor,
    context: ToolExecutionContext,
  ) {
    this.registry = registry;
    this.executor = executor;
    this.context = context;
  }

  /** B-01B：注入回合级工具提升（app-init 与 tool_search 共享同一实例） */
  setToolBoost(boost: TurnToolBoost | null): void {
    this.boost = boost;
  }

  /** P2（turn 隔离）：run 开始时清空提升池——防跨 run 泄漏 */
  resetBoost(): void {
    this.boost?.names.clear();
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

  /**
   * 生成给 LLM 的 function calling schema。
   * P2（单一真相源）：过滤收敛到 resolveVisibleTools——adapter 不再维护
   * 第二套 hidden/mode/deferred 判定，与 chat-bridge 渲染共用同一规则
   * （boost 提升的 deferred 工具经 boostedTools 参数进入可见面）。
   * P1 修复（复审）：mode 由调用方传入（QA 回合不含写工具），不再硬编码
   * 'coding'——否则 qa 请求的 schema 仍含 file_write/shell_exec。
   */
  getToolDefinitions(context?: import('./tool-surface-resolver.js').ToolSurfaceContext): LLMToolDefinition[] {
    // P2 修复（复审）：完整转发 ToolSurfaceContext（deniedTools/maxCoreTools
    // 此前遗漏——接口承诺与实现不一致；boostedTools 缺省回退到本 adapter 的 boost）
    return resolveVisibleTools(this.registry.list(), {
      ...context,
      mode: context?.mode ?? 'coding',
      boostedTools: context?.boostedTools ?? this.boost?.names,
    })
      .map(tool => ({
      name: tool.definition.name,
      description: tool.definition.description,
      // 保留双断言：ToolParameterSchema 含字面量 type:'object'，与 Record<string, unknown>
      // 不充分重叠；LLMToolDefinition 在 router/types.ts（EXCLUDED），无法改 parameters 类型
      parameters: tool.definition.parameters as unknown as Record<string, unknown>,
      // Phase 96 P1-6：透传 strict 字段（仅在工具显式声明时才赋值，避免 undefined 覆盖 client 默认）
      ...(tool.definition.strict !== undefined ? { strict: tool.definition.strict } : {}),
    }));
  }

  /**
   * Phase 96 P1-1：合并 per-call options 到 context
   *
   * - signal/onUpdate 仅作用于本次调用，不污染共享 context
   * - 未传入 callOptions 时返回原 context（无拷贝开销）
   */
  private mergeCallOptions(callOptions?: ToolExecCallOptions): ToolExecutionContext {
    if (!callOptions) return this.context;
    const merged: ToolExecutionContext = { ...this.context };
    if (callOptions.signal) merged.signal = callOptions.signal;
    if (callOptions.onUpdate) merged.onUpdate = callOptions.onUpdate;
    if (callOptions.autonomyMode) merged.autonomyMode = callOptions.autonomyMode;
    // B-16（审查 I2 修复）：隔离工作区覆盖——worktree 实验时工具按 worktree 路径读写，
    // 目录边界同步切换（不切换 allowedDirectories 会导致工具在工作区边界内操作 worktree 路径而被拒）
    if (callOptions.workspace) {
      merged.workingDirectory = callOptions.workspace.workingDirectory;
      merged.allowedDirectories = callOptions.workspace.allowedDirectories;
    }
    return merged;
  }

  /**
   * B-01B：被提升的 deferred 工具成功执行后从 boost 收回（消费即收回），
   * 避免低频工具在被选中调用后仍常驻暴露。
   */
  private retireBoostedTool(toolName: string, isError: boolean): void {
    if (!isError) this.boost?.names.delete(toolName);
  }

  async executeTool(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
    callOptions?: ToolExecCallOptions,
  ): Promise<string> {
    logger.debug('ToolRegistryAdapter.executeTool', { toolName, toolCallId, args });

    const span = this.trace?.recordToolCall(toolName, args, toolCallId, false);
    const ctx = this.mergeCallOptions(callOptions);
    const result = await this.executor.execute(toolName, args, ctx);
    const isError = !result.success;
    const output = result.success ? result.output : `[工具错误] ${toolName}: ${result.error ?? '未知错误'}`;
    this.retireBoostedTool(toolName, isError);
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
   *
   * Phase 96 P1-1：新增 callOptions 参数
   */
  async executeToolStructured(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
    callOptions?: ToolExecCallOptions,
  ): Promise<{ output: string; isError: boolean; images?: Array<{ mediaType: string; data: string }> }> {
    logger.debug('ToolRegistryAdapter.executeToolStructured', { toolName, toolCallId, args });

    const span = this.trace?.recordToolCall(toolName, args, toolCallId, false);
    const ctx = this.mergeCallOptions(callOptions);
    const result = await this.executor.execute(toolName, args, ctx);
    const isError = !result.success;
    const output = result.success ? result.output : `[工具错误] ${toolName}: ${result.error ?? '未知错误'}`;
    this.retireBoostedTool(toolName, isError);
    if (span && this.trace) {
      this.trace.recordToolResult(toolName, toolCallId, output, isError, true);
    }

    return { output, isError, images: result.images };
  }

  hasTool(toolName: string): boolean {
    return this.registry.has(toolName);
  }

  /**
   * Phase 73 Part B：查询工具的执行模式
   * 从 registry 查工具定义，返回 executionMode；未声明时返回 undefined（调用方默认 parallel）
   */
  getToolExecutionMode(toolName: string): 'sequential' | 'parallel' | undefined {
    return this.registry.get(toolName)?.definition.executionMode;
  }

  updateContext(context: Partial<ToolExecutionContext>): void {
    this.context = { ...this.context, ...context };
  }
}

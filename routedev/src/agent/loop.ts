// src/agent/loop.ts
// ReAct Agent Loop — RouteDev 的核心引擎
//
// 设计原则：
// 1. Loop 不做路由和分类（由调用方预先计算）
// 2. 流式优先（每次 LLM 调用都用 stream）
// 3. 错误注入上下文（工具失败不中断循环，而是让 LLM 自主处理）
// 4. 防御性设计（maxIterations + AbortSignal）
//
// 事件流：
//   run() → yield thinking → yield text_delta* → yield done
//         → yield thinking → yield tool_call_start → yield tool_call_result → (循环)
//         → yield error → yield done

import type {
  ILLMClient,
  LLMMessage,
  LLMToolDefinition,
  LLMStreamEvent,
  LLMRequestOptions,
  RoutingResult,
  TokenUsageInfo,
  ToolCallRequest,
  ContentPart,
} from '../router/types.js';
import type { ReActConfig, ReActEvent, ToolExecutorAdapter, ConfirmToolCallback } from './loop-config.js';
import { DEFAULT_REACT_CONFIG } from './loop-config.js';
import { logger } from '../utils/logger.js';
import type { AgentMiddlewarePipeline, MiddlewareContext } from './middleware.js';

/** ReAct 循环运行参数 */
export interface ReActRunParams {
  /** 用户原始消息 */
  userMessage: string;
  /** LLM 客户端（已选定的 provider 对应的客户端） */
  llmClient: ILLMClient;
  /** 路由决策（包含 model 和 providerId） */
  routeDecision: RoutingResult;
  /** 对话历史（不包含当前消息） */
  conversationHistory: LLMMessage[];
  /** 系统提示（可选，不传则不加系统消息） */
  systemPrompt?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 工具调用确认回调（Phase 9 自主模式） */
  onConfirmTool?: ConfirmToolCallback;
}

/** LLM 流式调用的内部结果 */
interface LLMStreamResult {
  content: string;
  toolCalls: ToolCallRequest[];
  usage: TokenUsageInfo;
}

/**
 * ReAct Agent Loop
 *
 * 核心循环：think → act → observe → think → ... → final answer
 * 使用 AsyncGenerator 流式输出事件
 */
export class ReActAgentLoop {
  private config: ReActConfig;
  private toolExecutor: ToolExecutorAdapter;
  /** 中间件管线（Phase 22：Hook 插件接入点） */
  private middleware: AgentMiddlewarePipeline | null = null;

  constructor(
    toolExecutor: ToolExecutorAdapter,
    config?: Partial<ReActConfig>,
  ) {
    this.config = { ...DEFAULT_REACT_CONFIG, ...config };
    this.toolExecutor = toolExecutor;
  }

  /** 注入中间件管线（Phase 22：让 Hook 插件能在工具执行前拦截） */
  setMiddlewarePipeline(pipeline: AgentMiddlewarePipeline): void {
    this.middleware = pipeline;
  }

  /**
   * 运行 ReAct 循环
   * yield 出 ReActEvent 事件流
   */
  async *run(params: ReActRunParams): AsyncGenerator<ReActEvent> {
    const {
      userMessage,
      llmClient,
      routeDecision,
      conversationHistory,
      systemPrompt,
      signal,
      onConfirmTool,
    } = params;

    // 构建初始消息列表
    const messages: LLMMessage[] = [];

    // 对话历史（不包含 system prompt，system prompt 通过 options 传入）
    messages.push(...conversationHistory);

    // 当前用户消息
    messages.push({ role: 'user', content: userMessage });

    // 获取可用工具定义
    const toolDefs = this.config.toolsEnabled
      ? this.toolExecutor.getToolDefinitions()
      : [];

    let iteration = 0;
    let consecutiveErrors = 0;
    let totalUsage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finalContent = '';

    while (iteration < this.config.maxIterations) {
      // 检查取消信号
      if (signal?.aborted) {
        yield { type: 'error', error: '用户取消了执行' };
        yield { type: 'done', content: finalContent, usage: totalUsage };
        return;
      }

      iteration++;

      logger.debug('ReAct iteration', {
        iteration,
        maxIterations: this.config.maxIterations,
        messageCount: messages.length,
      });

      // yield thinking 事件
      yield {
        type: 'thinking',
        message: `模型思考中... (${routeDecision.model.id}, 迭代 ${iteration})`,
      };

      try {
        // ===== LLM 流式调用 =====
        const result = yield* this.callLLMStream(
          llmClient,
          routeDecision.model.id,
          messages,
          systemPrompt,
          toolDefs,
          signal,
        );

        // 累加 usage
        totalUsage.inputTokens += result.usage.inputTokens;
        totalUsage.outputTokens += result.usage.outputTokens;
        totalUsage.totalTokens += result.usage.totalTokens;

        consecutiveErrors = 0; // 成功，重置错误计数
        finalContent = result.content;

        // ===== 判断：文本回复 or 工具调用？ =====

        if (result.toolCalls.length > 0) {
          // ----- 有工具调用 -----

          // 将 assistant 消息（含 tool_calls）加入上下文
          // 使用 ContentPart 格式
          const assistantContent: ContentPart[] = result.content
            ? [{ type: 'text', text: result.content }]
            : [];
          for (const tc of result.toolCalls) {
            assistantContent.push({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            });
          }
          messages.push({
            role: 'assistant',
            content: assistantContent,
          });

          // 执行每个工具调用
          for (const toolCall of result.toolCalls) {
            yield {
              type: 'tool_call_start',
              toolName: toolCall.name,
              toolCallId: toolCall.id,
            };

            // Phase 9：自主模式下，如果提供了 onConfirmTool，暂停等待用户确认
            let approved = true;
            if (onConfirmTool) {
              yield {
                type: 'approval_required',
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                args: toolCall.arguments,
                reason: '需要确认工具调用',
              };
              approved = await onConfirmTool(toolCall.name, toolCall.arguments);
            }

            if (!approved) {
              // 用户拒绝：注入拒绝信息作为工具结果
              const toolResult = `[用户拒绝了此工具调用] ${toolCall.name}`;
              yield {
                type: 'tool_call_result',
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                result: toolResult,
                isError: true,
              };
              messages.push({
                role: 'user',
                content: [{
                  type: 'tool_result' as const,
                  toolUseId: toolCall.id,
                  content: toolResult,
                  isError: true,
                }],
              });
              continue;
            }

            // Phase 22：工具执行前调用 onActing 中间件（Hook 插件接入点）
            // 中间件可在 ctx.metadata.permissionDenied 设置拒绝标志来阻止执行
            if (this.middleware) {
              const mwCtx: MiddlewareContext = {
                phase: 'onActing',
                toolName: toolCall.name,
                toolArgs: toolCall.arguments,
                metadata: {},
              };
              try {
                await this.middleware.execute('onActing', mwCtx);
              } catch (mwErr) {
                logger.warn('Middleware onActing threw', { error: String(mwErr) });
              }
              // 中间件设置了 permissionDenied → 不执行工具，返回错误结果
              if (mwCtx.metadata.permissionDenied) {
                const denyReason = String(mwCtx.metadata.permissionDenied);
                yield {
                  type: 'tool_call_result',
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  result: `[被拦截] ${denyReason}`,
                  isError: true,
                };
                messages.push({
                  role: 'user',
                  content: [{
                    type: 'tool_result' as const,
                    toolUseId: toolCall.id,
                    content: `[被拦截] ${denyReason}`,
                    isError: true,
                  }],
                });
                continue;
              }
            }

            const toolResult = await this.toolExecutor.executeTool(
              toolCall.name,
              toolCall.id,
              toolCall.arguments,
            );

            // Phase 29 Task 5：isError 结构化判断（修复 B1）
            // 原逻辑用 includes('错误') 判断，正常输出含"错误"二字（如"修复了3个错误"）会被误判
            // 新逻辑：优先识别结构化错误标记（[工具错误]、[被拦截]），降低误判率
            const isError = /\[工具错误\]|\[被拦截\]|\[error\]|Error:|failed to|无法|失败/.test(toolResult);

            yield {
              type: 'tool_call_result',
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              result: toolResult,
              isError,
            };

            // 将工具结果注入上下文（使用 ContentPart 格式）
            messages.push({
              role: 'user',
              content: [{
                type: 'tool_result' as const,
                toolUseId: toolCall.id,
                content: toolResult,
                isError,
              }],
            });
          }

          // 继续循环——LLM 会根据工具结果生成下一轮回复
          continue;
        }

        // ----- 无工具调用，文本回复 → 循环结束 -----
        yield {
          type: 'done',
          content: result.content,
          usage: totalUsage,
        };
        return;

      } catch (error) {
        consecutiveErrors++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error('ReAct iteration error', {
          iteration,
          consecutiveErrors,
          error: errorMessage,
        });

        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          yield {
            type: 'error',
            error: `连续 ${consecutiveErrors} 次错误，终止执行。最后错误: ${errorMessage}`,
            usage: totalUsage,
          };
          yield { type: 'done', content: finalContent, usage: totalUsage };
          return;
        }

        // 将错误注入上下文，让 LLM 知道发生了什么
        const errorContext = `[系统错误] 上一次调用出错: ${errorMessage}。请直接用文本回复用户，不要尝试调用工具。`;
        messages.push({ role: 'user', content: errorContext });

        yield {
          type: 'error',
          error: `迭代 ${iteration} 出错: ${errorMessage}，正在重试...`,
        };
      }
    }

    // 达到最大迭代次数
    yield {
      type: 'error',
      error: `达到最大迭代次数 (${this.config.maxIterations})，终止执行`,
      usage: totalUsage,
    };
    yield { type: 'done', content: finalContent, usage: totalUsage };
  }

  /**
   * 执行一次 LLM 流式调用
   * yield text_delta 事件，返回完整的工具调用和 usage（通过 AsyncGenerator return value）
   */
  private async *callLLMStream(
    client: ILLMClient,
    modelId: string,
    messages: LLMMessage[],
    systemPrompt: string | undefined,
    toolDefs: LLMToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<ReActEvent, LLMStreamResult> {
    let fullContent = '';
    const toolCalls: ToolCallRequest[] = [];
    let usage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const options: LLMRequestOptions = {
      model: modelId,
      messages,
      systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: 4096,
      timeoutMs: this.config.llmTimeout,
      stream: true,
    };

    const stream = client.stream(options);

    // 工具调用参数累积缓冲
    const toolCallBuffers = new Map<string, { id: string; name: string; arguments: Record<string, unknown> }>();
    // 用于按顺序追踪当前的工具调用
    const toolCallOrder: string[] = [];

    for await (const event of stream) {
      // 检查取消
      if (signal?.aborted) break;

      switch (event.type) {
        case 'text_delta':
          fullContent += event.text;
          yield { type: 'text_delta', text: event.text };
          break;

        case 'tool_call_start': {
          const tcId = event.toolCall.id;
          const tcName = event.toolCall.name;
          toolCallBuffers.set(tcId, { id: tcId, name: tcName, arguments: {} });
          toolCallOrder.push(tcId);
          break;
        }

        case 'tool_call_delta': {
          // 累积工具调用参数
          const buffer = toolCallBuffers.get(event.toolCallId);
          if (buffer) {
            // argumentsDelta 是 JSON 字符串片段，需要累积后在 end 时解析
            // 这里先存储为字符串，end 时统一解析
            const existing = (buffer as Record<string, unknown>).__argsBuffer;
            const argsBuffer = (typeof existing === 'string' ? existing : '') + event.argumentsDelta;
            (buffer as Record<string, unknown>).__argsBuffer = argsBuffer;
          }
          break;
        }

        case 'tool_call_end': {
          const buffer = toolCallBuffers.get(event.toolCallId);
          if (buffer) {
            // 解析累积的参数 JSON
            const argsBuffer = (buffer as Record<string, unknown>).__argsBuffer;
            if (typeof argsBuffer === 'string' && argsBuffer.trim()) {
              try {
                buffer.arguments = JSON.parse(argsBuffer);
              } catch {
                logger.warn('Failed to parse tool call arguments', { argsBuffer });
                buffer.arguments = {};
              }
            }
            // 清理临时字段
            delete (buffer as Record<string, unknown>).__argsBuffer;
            // 加入最终列表
            toolCalls.push({
              id: buffer.id,
              name: buffer.name,
              arguments: buffer.arguments,
            });
          }
          break;
        }

        case 'usage':
          usage = event.usage;
          break;

        case 'done':
          // 流结束
          // 如果有未结束的 tool_call（某些 provider 可能不发 end），从 buffer 中取
          if (toolCalls.length === 0 && toolCallBuffers.size > 0) {
            for (const [, buffer] of toolCallBuffers) {
              const argsBuffer = (buffer as Record<string, unknown>).__argsBuffer;
              if (typeof argsBuffer === 'string' && argsBuffer.trim()) {
                try {
                  buffer.arguments = JSON.parse(argsBuffer);
                } catch {
                  buffer.arguments = {};
                }
              }
              toolCalls.push({
                id: buffer.id,
                name: buffer.name,
                arguments: buffer.arguments,
              });
            }
          }
          break;
      }
    }

    // 返回（AsyncGenerator return value）
    return { content: fullContent, toolCalls, usage };
  }

  /** 更新工具执行器（Phase 6 替换为真实实现时调用） */
  updateToolExecutor(executor: ToolExecutorAdapter): void {
    this.toolExecutor = executor;
  }

  /** 更新配置 */
  updateConfig(config: Partial<ReActConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

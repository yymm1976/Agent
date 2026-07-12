// src/agent/loop.ts
// ReAct Agent Loop — RouteDev 的核心引擎
//
// 设计原则：
// 1. Loop 不做路由和分类（由调用方预先计算）
// 2. 流式优先（每次 LLM 调用都用 stream）
// 3. 错误注入上下文（工具失败不中断循环，而是让 LLM 自主处理）
// 4. 防御性设计（maxIterations + AbortSignal）
//
// TD-10 拆分：上下文管理 → LoopContextManager，中间件调度 → MiddlewareRunner，
//             记忆维护 → MemoryIntegration。本类通过组合/委托方式使用三个模块。
//
// 事件流：
//   run() → yield thinking → yield text_delta* → yield done
//         → yield thinking → yield tool_call_start → yield tool_call_result → (循环)
//         → yield error → yield done

import type {
  ILLMClient,
  LLMMessage,
  LLMToolDefinition,
  LLMRequestOptions,
  RoutingResult,
  TokenUsageInfo,
  ContentPart,
} from '../router/types.js';
import type { ReActConfig, ReActEvent, ToolExecutorAdapter, ConfirmToolCallback } from './loop-config.js';
import { DEFAULT_REACT_CONFIG } from './loop-config.js';
import { logger } from '../utils/logger.js';
import type { AgentMessage } from './message-types.js';
import { defaultConvertToLlm } from './message-types.js';
import type { ToolResult } from '../tools/types.js';
// TD-10 委托模块（组合模式）
import { LoopContextManager } from './context-manager.js';
import type { LLMStreamResult } from './context-manager.js';
import { MiddlewareRunner } from './middleware-runner.js';
import { MemoryIntegration } from './memory-integration.js';
// DualLoop 编排器（type-only import，避免运行时循环依赖）
import type { DualLoopOrchestrator } from './dual-loop-orchestrator.js';
// VFS（运行时 import：构造函数中需默认实例化）
import { VirtualFS, createVFS } from './context/virtual-fs.js';
// PlanState（type-only import）
import type { PlanState } from './context/plan-state.js';

/**
 * F-102：消息窗口截断阈值（保留最近 N 条，保证 tool_use/tool_result 成对）
 */
const MESSAGE_WINDOW_THRESHOLD = 40;

/**
 * V3-018 修复：followUpLoop 全局迭代次数上限
 * 防止 follow-up 队列持续注入导致外层循环无限执行
 */
const MAX_FOLLOWUP_ITERATIONS = 100;

/**
 * Phase 55：结构化 system block（支持 Anthropic cache_control: ephemeral）
 * agent 层单一数据源：worker-executor.ts 从此处 import 使用
 * 注意：src/router/types.ts 因避免 router→agent 反向依赖，使用结构等价的 inline 类型
 * 字段结构与 Anthropic SDK 的 TextBlockParam 兼容（type/text/cache_control）
 */
export interface SystemBlock {
  type: 'text';
  text: string;
  /** Anthropic prompt cache 标记；不打则该 block 不参与缓存 */
  cache_control?: { type: 'ephemeral' };
}

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
  /**
   * Phase 55：结构化 system blocks（支持 cache_control），未传时回退到 systemPrompt 字符串
   * 用于 WorkerExecutor 把固定前缀（baseSystemPrompt）+ 可变后缀（role/blackboard）拆分为多个 block，
   * 固定前缀打 cache_control: ephemeral，跨 Worker 命中 Anthropic prompt cache
   */
  systemBlocks?: SystemBlock[];
  /** 取消信号 */
  signal?: AbortSignal;
  /** 工具调用确认回调（Phase 9 自主模式） */
  onConfirmTool?: ConfirmToolCallback;
  /** 模型调用成功回调 */
  onModelSuccess?: (modelId: string) => void;
  /** 模型调用失败回调 */
  onModelFailure?: (modelId: string, error: unknown) => void;
}

/**
 * ReAct Agent Loop
 *
 * 核心循环：think → act → observe → think → ... → final answer
 * 使用 AsyncGenerator 流式输出事件
 *
 * TD-10 拆分后，上下文管理/中间件调度/记忆维护分别委托给：
 *   LoopContextManager / MiddlewareRunner / MemoryIntegration
 */
export class ReActAgentLoop {
  private config: ReActConfig;
  private toolExecutor: ToolExecutorAdapter;
  /** Phase 55 Task 7：DualLoop 编排器（可选），注入后 run() 转交控制权 */
  private dualLoopOrchestrator: DualLoopOrchestrator | null = null;
  /** Phase 71 Task E1：进程内 VFS（Agent 工作内存统一抽象） */
  private virtualFS: VirtualFS = createVFS();
  /** Phase 71 Task E2：显式 plan 状态（可选） */
  private planState: PlanState | null = null;
  // TD-10 委托模块
  private ctxMgr = new LoopContextManager();
  private mwRunner = new MiddlewareRunner();
  private memIntegration = new MemoryIntegration();
  /**
   * Phase 79 Task 5：当前 run() 期间的确认回调（run 开始时设置，结束清理）
   * 子 Agent 通过 getCurrentConfirmTool() 获取父会话的确认通道，实现委托确认
   */
  private currentConfirmTool: ConfirmToolCallback | null = null;

  constructor(toolExecutor: ToolExecutorAdapter, config?: Partial<ReActConfig>) {
    this.config = { ...DEFAULT_REACT_CONFIG, ...config };
    this.toolExecutor = toolExecutor;
  }

  // ===== Setters（转发到委托模块）=====

  /** 注入中间件管线（Phase 22：Hook 插件接入点） */
  setMiddlewarePipeline(pipeline: import('./middleware.js').AgentMiddlewarePipeline): void {
    this.mwRunner.setPipeline(pipeline);
  }

  /**
   * Phase 79 Task 5：获取当前 run() 期间的确认回调（供子 Agent 委托确认）
   * run() 开始时设置，结束清理；非 run 期间返回 null
   * 子 Agent 创建时调用此方法获取父会话的确认通道，实现工具确认委托父会话
   */
  getCurrentConfirmTool(): ConfirmToolCallback | null {
    return this.currentConfirmTool;
  }

  /** 注入 Token Profiler（Phase 30：可观测性，可选） */
  setProfiler(profiler: import('./token-profiler.js').TokenProfiler | null): void {
    this.ctxMgr.setProfiler(profiler);
  }

  /** Phase 32 Task 1.2：注入工具结果净化器（可选） */
  setSanitizer(sanitizer: import('../tools/result-sanitizer.js').ToolResultSanitizer | null): void {
    this.ctxMgr.setSanitizer(sanitizer);
  }

  /** Phase 71 Task D3：注入工具输出统一处理 pipeline（可选） */
  setToolOutputPipeline(pipeline: import('./context/tool-output-pipeline.js').ToolOutputPipeline | null): void {
    this.ctxMgr.setToolOutputPipeline(pipeline);
  }

  /** Phase 34：注入 TraceCollector */
  setTraceCollector(trace: import('../harness/trace-collector.js').TraceCollector | null): void {
    this.ctxMgr.setTraceCollector(trace);
  }

  /** C5 修复：注入 Steering Queue 消费者 */
  setSteeringConsumer(consumer: (() => { content: string; mode: string }[] | null) | null): void {
    this.ctxMgr.setSteeringConsumer(consumer);
  }

  /** Phase 73 Part C：排队 follow-up 消息 */
  followUp(content: string): void {
    this.ctxMgr.followUp(content);
  }

  /** Phase 73 Part C：设置 follow-up 出队模式 */
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): void {
    this.ctxMgr.setFollowUpMode(mode);
  }

  /** Phase 73 Part C：查询 follow-up 队列内容（只读快照） */
  getFollowUpQueue(): import('./message-types.js').FollowUpMessage[] {
    return this.ctxMgr.getFollowUpQueue();
  }

  /** Phase 73 Part C：删除指定索引的 follow-up 消息 */
  removeFollowUp(index: number): boolean {
    return this.ctxMgr.removeFollowUp(index);
  }

  /** Phase 73 Part C：清空所有队列 */
  clearAllQueues(): void {
    this.ctxMgr.clearAllQueues();
  }

  /** Phase 73 Part C：查询队列状态 */
  getQueueStatus(): { followUp: number } {
    return this.ctxMgr.getQueueStatus();
  }

  /** C6 修复：注入 HookRunner */
  setHookRunner(runner: import('./hooks.js').HookRunner | null): void {
    this.mwRunner.setHookRunner(runner);
  }

  /** 任务1：注入 ComposePipeline（可选） */
  setComposePipeline(pipeline: import('./compose-pipeline.js').ComposePipeline | null): void {
    this.memIntegration.setComposePipeline(pipeline);
  }

  /** 任务3：设置简洁思考约束开关 */
  setConciseThinking(enabled: boolean): void {
    this.ctxMgr.setConciseThinking(enabled);
  }

  /** Phase 53 Task 2：注入策略引擎（可选） */
  setPolicyEngine(engine: import('../policies/policy-engine.js').PolicyEngine | null): void {
    this.mwRunner.setPolicyEngine(engine);
  }

  /** Phase 53 Task 2：注入引用管理器（可选） */
  setCiteManager(manager: import('../cite/manager.js').CiteManager | null): void {
    this.memIntegration.setCiteManager(manager);
  }

  /** Phase 53 Task 2 E5：注入引用解析器（可选） */
  setCiteResolver(resolver: import('../cite/resolver.js').CiteResolver | null): void {
    this.memIntegration.setCiteResolver(resolver);
  }

  /** Phase 53 Task 2：注入宏管理器（可选） */
  setMacroManager(manager: import('../macros/manager.js').MacroManager | null): void {
    this.memIntegration.setMacroManager(manager);
  }

  /** Phase 53 Task 9：注入预算监控器（可选） */
  setBudgetMonitor(monitor: import('./budget-monitor.js').BudgetMonitor | null): void {
    this.ctxMgr.setBudgetMonitor(monitor);
  }

  /** Phase 55 Task 7：注入 DualLoop 编排器（可选） */
  setDualLoopOrchestrator(orchestrator: DualLoopOrchestrator | null): void {
    this.dualLoopOrchestrator = orchestrator;
  }

  /** Phase 71 Task B3：注入记忆召回注入器（可选） */
  setRecallInjector(injector: import('./memory/recall-injector.js').MemoryRecallInjector | null): void {
    this.memIntegration.setRecallInjector(injector);
  }

  /** Phase 71 Task E1：注入进程内 VFS */
  setVirtualFS(vfs: VirtualFS | null): void {
    this.virtualFS = vfs ?? createVFS();
  }

  /** Phase 71 Task E2：注入显式 plan 状态 */
  setPlanState(planState: PlanState | null): void {
    this.planState = planState;
  }

  /**
   * 运行 ReAct 循环
   * yield 出 ReActEvent 事件流
   */
  async *run(params: ReActRunParams): AsyncGenerator<ReActEvent> {
    // Phase 55 Task 7：DualLoop 编排器注入时转交控制权
    if (this.dualLoopOrchestrator) {
      yield* this.dualLoopOrchestrator.run(params);
      return;
    }

    const {
      userMessage, llmClient, routeDecision, conversationHistory,
      signal, onConfirmTool, onModelSuccess, onModelFailure,
    } = params;
    let systemPrompt = params.systemPrompt;
    let systemBlocks = params.systemBlocks;
    const trace = this.ctxMgr.traceCollector;

    // Phase 79 Task 5：保存当前确认回调，供子 Agent 通过 getCurrentConfirmTool() 委托确认
    this.currentConfirmTool = onConfirmTool ?? null;

    // C6 修复：触发 on-session-start 钩子
    await this.mwRunner.fireHookSafe('on-session-start', {});

    try {
      // Phase 38 Task 1：onSystemPrompt 中间件（systemBlocks 模式下跳过）
      if (!systemBlocks) {
        systemPrompt = await this.mwRunner.runOnSystemPrompt(systemPrompt);
      }

      // 任务3：简洁思考约束注入
      ({ systemPrompt, systemBlocks } = this.ctxMgr.injectConciseThinking(systemPrompt, systemBlocks, userMessage));

      // Phase 71 Task B3：记忆召回注入（首轮一次，effectiveSystemPrompt 每轮继承）
      ({ systemPrompt, systemBlocks } = this.memIntegration.injectRecall(systemPrompt, systemBlocks, userMessage));

      // 构建初始消息列表
      const messages: LLMMessage[] = [];
      messages.push(...conversationHistory);
      // 进入循环前清理历史消息中可能存在的孤立 tool_use/tool_result
      this.ctxMgr.sanitizeToolMessages(messages);

      // 宏展开 + onUserMessage 中间件
      const effectiveUserMessage = this.memIntegration.expandMacros(userMessage);
      const finalUserMessage = await this.mwRunner.runOnUserMessage(effectiveUserMessage);
      messages.push({ role: 'user', content: finalUserMessage });

      // 获取可用工具定义
      const rawToolDefs = this.config.toolsEnabled ? this.toolExecutor.getToolDefinitions() : [];
      const toolDefs = rawToolDefs;

      let iteration = 0;
      let consecutiveErrors = 0;
      let totalUsage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalContent = '';

      // Phase 73 Part C：双层循环——外层 follow-up 驱动，内层 ReAct 循环
      // V3-018 修复：添加全局迭代次数上限，防止 follow-up 队列持续注入导致无限循环
      let followupIteration = 0;
      followUpLoop: while (true) {
        followupIteration++;
        if (followupIteration > MAX_FOLLOWUP_ITERATIONS) {
          logger.warn('FollowUp loop reached max iterations, breaking', {
            iteration: followupIteration,
          });
          const overflowError: ReActEvent = {
            type: 'error',
            error: `FollowUp 循环达到最大迭代次数 (${MAX_FOLLOWUP_ITERATIONS})，终止执行`,
            usage: totalUsage,
          };
          yield overflowError; trace?.recordEvent(overflowError);
          const overflowDone: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
          yield overflowDone; trace?.recordEvent(overflowDone);
          break followUpLoop;
        }
        while (iteration < this.config.maxIterations) {
          // 检查取消信号
          if (signal?.aborted) {
            const cancelError: ReActEvent = { type: 'error', error: '用户取消了执行' };
            yield cancelError; trace?.recordEvent(cancelError);
            const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
            yield doneEvent; trace?.recordEvent(doneEvent);
            return;
          }

          // C5 修复：迭代开始前取出 next_iteration 模式的转向消息
          this.ctxMgr.drainSteeringIntoMessages(messages, 'next_iteration');
          iteration++;

          logger.debug('ReAct iteration', { iteration, maxIterations: this.config.maxIterations, messageCount: messages.length });

          // yield thinking 事件
          const thinkingEvent: ReActEvent = {
            type: 'thinking',
            message: `模型思考中... (${routeDecision.model.id}, 迭代 ${iteration})`,
          };
          yield thinkingEvent; trace?.recordEvent(thinkingEvent);

          // 任务1：每次迭代重新注入 Compose 阶段提示词（阶段可能在上一轮工具执行后已流转）
          let effectiveSystemPrompt = systemPrompt;
          let effectiveSystemBlocks = systemBlocks;
          const phasePrompt = this.memIntegration.getPhasePrompt();
          if (phasePrompt) {
            if (effectiveSystemBlocks) {
              effectiveSystemBlocks = [...effectiveSystemBlocks, { type: 'text', text: phasePrompt }];
            } else {
              effectiveSystemPrompt = (effectiveSystemPrompt ?? '') + '\n\n' + phasePrompt;
            }
          }

          // Phase 30：Token Profiling（在 LLM 调用前生成快照）
          const snapshot = this.ctxMgr.profile({
            systemPrompt: effectiveSystemPrompt, messages, tools: toolDefs,
            userMessage, iterationIndex: iteration - 1,
            modelId: routeDecision.model.id, routeDecision: routeDecision.originalTier,
          });
          if (snapshot) yield { type: 'token_profile', snapshot };

          try {
            // ===== LLM 流式调用 =====
            let result: LLMStreamResult;
            try {
              result = yield* this.callLLMStream(
                llmClient, routeDecision.model.id, messages,
                effectiveSystemPrompt, effectiveSystemBlocks, toolDefs,
                signal, routeDecision.enableCache,
              );
            } catch (error) {
              onModelFailure?.(routeDecision.model.id, error);
              throw error;
            }
            onModelSuccess?.(routeDecision.model.id);

            // C7 修复：流返回后立即检查取消信号
            if (signal?.aborted) {
              const cancelError: ReActEvent = { type: 'error', error: '用户取消了执行（流返回后）' };
              yield cancelError; trace?.recordEvent(cancelError);
              const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
              yield doneEvent; trace?.recordEvent(doneEvent);
              return;
            }

            // 累加 usage
            totalUsage.inputTokens += result.usage.inputTokens;
            totalUsage.outputTokens += result.usage.outputTokens;
            totalUsage.totalTokens += result.usage.totalTokens;

            trace?.recordLLMCall(routeDecision.model.id, result.usage, result.content.length, result.toolCalls.length);

            consecutiveErrors = 0;
            finalContent = result.content;

            // Phase 38 Task 1：onReasoning 中间件——循环检测
            const reasoningResult = await this.mwRunner.runOnReasoning(messages, result.toolCalls, iteration, result.content);
            if (reasoningResult.loopDetected) {
              messages.push({ role: 'user', content: `[系统提示] ${reasoningResult.suggestion ?? '检测到工具调用循环，请换一种方法。'}` });
            }

            // C5 修复：LLM 流返回后、工具执行前，取出 immediate 模式的转向消息
            this.ctxMgr.drainSteeringIntoMessages(messages, 'immediate');

            // ===== 判断：文本回复 or 工具调用？ =====
            if (result.toolCalls.length > 0) {
              // ----- 有工具调用 -----
              // 将 assistant 消息（含 tool_calls）加入上下文
              const assistantContent: ContentPart[] = result.content
                ? [{ type: 'text', text: result.content }]
                : [];
              for (const tc of result.toolCalls) {
                assistantContent.push({ type: 'tool_use' as const, id: tc.id, name: tc.name, arguments: tc.arguments });
              }
              messages.push({ role: 'assistant', content: assistantContent });

              // Phase 73 Part B：batch 级 sequential 检测
              const hasSequential = result.toolCalls.some(tc => {
                const mode = this.toolExecutor.getToolExecutionMode?.(tc.name);
                return mode === 'sequential';
              });

              if (this.config.parallelToolExecution && !hasSequential && result.toolCalls.length > 1) {
                // ===== 并行模式 =====
                // 阶段1：串行权限校验 + 确认 + 中间件检查
                const approvedCalls: typeof result.toolCalls = [];
                for (const toolCall of result.toolCalls) {
                  yield { type: 'tool_call_start', toolName: toolCall.name, toolCallId: toolCall.id, args: toolCall.arguments };

                  // Phase 79 Task 3：onActing 中间件 + 策略引擎前置（fail-closed）
                  const actingResult = await this.mwRunner.runOnActing(toolCall.name, toolCall.arguments);
                  if (actingResult.denied) {
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[被拦截] ${actingResult.reason ?? '未知原因'}`);
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                    continue;
                  }

                  // Phase 79 Task 3/5：根据权限决策确定是否需要用户确认
                  const permDecision = actingResult.permissionDecision;
                  const permMatchedRule = actingResult.permissionMatchedRule;
                  let needsConfirmation: boolean;
                  if (permDecision === 'confirm' || actingResult.requiresConfirmation) {
                    needsConfirmation = true;
                  } else if (permDecision === 'auto' && permMatchedRule) {
                    needsConfirmation = false;
                  } else if (permDecision === 'auto' && !permMatchedRule) {
                    needsConfirmation = !this.mwRunner.isAutoApproved(toolCall.name, this.config.autoApprovePatterns ?? []);
                  } else {
                    needsConfirmation = onConfirmTool
                      ? !this.mwRunner.isAutoApproved(toolCall.name, this.config.autoApprovePatterns ?? [])
                      : false;
                  }

                  let approved = true;
                  if (needsConfirmation) {
                    if (!onConfirmTool) {
                      // fail-closed: 需要确认但无确认通道 → 拒绝执行
                      const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[fail-closed: 需要确认但无确认通道] ${toolCall.name}`);
                      yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                      messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                      continue;
                    }
                    yield { type: 'approval_required', toolName: toolCall.name, toolCallId: toolCall.id, args: toolCall.arguments, reason: '需要确认工具调用' };
                    const confirmResult = await onConfirmTool(toolCall.name, toolCall.arguments);
                    if (typeof confirmResult === 'boolean') { approved = confirmResult; }
                    else { approved = confirmResult.approved; }
                  }

                  if (!approved) {
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[用户拒绝了此工具调用] ${toolCall.name}`);
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                    continue;
                  }

                  // pre-tool-call 钩子
                  const preToolHookResult = await this.mwRunner.fireHookSafe('pre-tool-call', { stepId: toolCall.id, toolName: toolCall.name, toolArgs: toolCall.arguments });
                  if (preToolHookResult.action === 'deny') {
                    const denyReason = preToolHookResult.reason ?? '工具调用被钩子拒绝';
                    logger.info('Pre-tool-call hook denied tool execution (parallel)', { toolName: toolCall.name, stepId: toolCall.id, reason: denyReason });
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[工具被拒绝] ${denyReason}`);
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                    continue;
                  }

                  approvedCalls.push(toolCall);
                }

                // 阶段2：并行执行所有已批准的工具
                if (approvedCalls.length > 0) {
                  const useStructured = typeof this.toolExecutor.executeToolStructured === 'function';
                  const toolStartTimes = approvedCalls.map(() => Date.now());
                  // C8 修复：用 allSettled 隔离单个工具异常
                  const settled = await Promise.allSettled(
                    approvedCalls.map(tc =>
                      useStructured
                        ? this.toolExecutor.executeToolStructured!(tc.name, tc.id, tc.arguments)
                        : this.toolExecutor.executeTool(tc.name, tc.id, tc.arguments)
                            .then(output => ({ output, isError: /\[工具错误\]|\[被拦截\]/.test(output) })),
                    ),
                  );
                  const execResults = settled.map((s, i) => {
                    if (s.status === 'fulfilled') return s.value as { output: string; isError: boolean };
                    const tc = approvedCalls[i];
                    logger.error('Tool execution threw (isolated)', { toolName: tc.name, error: String(s.reason) });
                    return { output: `[工具异常] ${tc.name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`, isError: true };
                  });

                  // 阶段3：按顺序 yield 结果并注入上下文
                  for (let i = 0; i < approvedCalls.length; i++) {
                    const tc = approvedCalls[i];
                    const execResult = execResults[i] as { output: string; isError: boolean };
                    const toolResult = await this.ctxMgr.sanitizeToolResult(tc.name, execResult.output, tc.arguments);
                    const isError = execResult.isError;
                    const toolDuration = Date.now() - toolStartTimes[i];

                    // I16 修复：并行模式下触发 post-tool-call 钩子
                    await this.mwRunner.fireHookSafe('post-tool-call', { stepId: tc.id, toolName: tc.name, toolArgs: tc.arguments, toolResult, toolDuration });

                    yield { type: 'tool_call_result', toolName: tc.name, toolCallId: tc.id, result: toolResult, isError };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: tc.id, content: toolResult, isError }] });

                    // Compose 管线自动流转评估
                    const toolResultForAdvance: ToolResult = { success: !isError, output: toolResult, durationMs: toolDuration, error: isError ? toolResult : undefined };
                    this.memIntegration.evaluateAdvance(toolResultForAdvance);
                  }
                }
              } else {
                // ===== 串行模式 =====
                for (const toolCall of result.toolCalls) {
                  yield { type: 'tool_call_start', toolName: toolCall.name, toolCallId: toolCall.id, args: toolCall.arguments };

                  // Phase 79 Task 3：onActing 中间件 + 策略引擎前置（fail-closed）
                  // PermissionEngine.check() 在此被调用，deny 拦截、confirm 驱动用户确认、auto 放行
                  const actingResult = await this.mwRunner.runOnActing(toolCall.name, toolCall.arguments);
                  if (actingResult.denied) {
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[被拦截] ${actingResult.reason ?? '未知原因'}`);
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                    continue;
                  }

                  // Phase 79 Task 3/5：根据权限决策确定是否需要用户确认
                  // - confirm 决策 → 走 onConfirmTool 确认通道
                  // - auto 决策且命中显式规则 → 放行
                  // - auto 决策但来自 fallback（无匹配规则）→ Task 5: 仅 autoApprovePatterns 白名单工具放行
                  // - 无 permissionDecision（PermissionMiddleware 未注册）→ 回退到 autoApprovePatterns
                  const permDecision = actingResult.permissionDecision;
                  const permMatchedRule = actingResult.permissionMatchedRule;
                  let needsConfirmation: boolean;
                  if (permDecision === 'confirm' || actingResult.requiresConfirmation) {
                    needsConfirmation = true;
                  } else if (permDecision === 'auto' && permMatchedRule) {
                    needsConfirmation = false;
                  } else if (permDecision === 'auto' && !permMatchedRule) {
                    // Task 5: auto 模式 fallback 仅白名单工具自动放行，其余需确认
                    needsConfirmation = !this.mwRunner.isAutoApproved(toolCall.name, this.config.autoApprovePatterns ?? []);
                  } else {
                    // 无 PermissionMiddleware → 回退到 autoApprovePatterns 逻辑
                    needsConfirmation = onConfirmTool
                      ? !this.mwRunner.isAutoApproved(toolCall.name, this.config.autoApprovePatterns ?? [])
                      : false;
                  }

                  let approved = true;
                  let confirmPayload: unknown;
                  if (needsConfirmation) {
                    if (!onConfirmTool) {
                      // fail-closed: 需要确认但无确认通道 → 拒绝执行
                      const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[fail-closed: 需要确认但无确认通道] ${toolCall.name}`);
                      yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                      messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                      continue;
                    }
                    yield { type: 'approval_required', toolName: toolCall.name, toolCallId: toolCall.id, args: toolCall.arguments, reason: '需要确认工具调用' };
                    const confirmResult = await onConfirmTool(toolCall.name, toolCall.arguments);
                    if (typeof confirmResult === 'boolean') { approved = confirmResult; }
                    else { approved = confirmResult.approved; confirmPayload = confirmResult.payload; }
                  }

                  if (!approved) {
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[用户拒绝了此工具调用] ${toolCall.name}`);
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                    continue;
                  }

                  if (toolCall.name === 'ask_user') {
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, JSON.stringify(confirmPayload ?? {}, null, 2));
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: false };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: false }] });
                    continue;
                  }

                  // pre-tool-call 钩子
                  const preToolHookResult = await this.mwRunner.fireHookSafe('pre-tool-call', { stepId: toolCall.id, toolName: toolCall.name, toolArgs: toolCall.arguments });
                  if (preToolHookResult.action === 'deny') {
                    const denyReason = preToolHookResult.reason ?? '工具调用被钩子拒绝';
                    logger.info('Pre-tool-call hook denied tool execution', { toolName: toolCall.name, stepId: toolCall.id, reason: denyReason });
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[工具被拒绝] ${denyReason}`);
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                    continue;
                  }

                  // 工具执行（P1-5 修复：优先使用结构化执行）
                  const useStructured = typeof this.toolExecutor.executeToolStructured === 'function';
                  let toolResult: string;
                  let isError: boolean;
                  const toolStartTime = Date.now();
                  if (useStructured) {
                    const structured = await this.toolExecutor.executeToolStructured!(toolCall.name, toolCall.id, toolCall.arguments);
                    toolResult = structured.output;
                    isError = structured.isError;
                  } else {
                    toolResult = await this.toolExecutor.executeTool(toolCall.name, toolCall.id, toolCall.arguments);
                    isError = /\[工具错误\]|\[被拦截\]/.test(toolResult);
                  }
                  const toolDuration = Date.now() - toolStartTime;

                  // 净化工具结果
                  toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, toolResult, toolCall.arguments);

                  // post-tool-call 钩子
                  await this.mwRunner.fireHookSafe('post-tool-call', { stepId: toolCall.id, toolName: toolCall.name, toolArgs: toolCall.arguments, toolResult, toolDuration });

                  yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError };
                  messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError }] });

                  // Compose 管线自动流转评估
                  const toolResultForAdvance: ToolResult = { success: !isError, output: toolResult, durationMs: toolDuration, error: isError ? toolResult : undefined };
                  this.memIntegration.evaluateAdvance(toolResultForAdvance);
                }
              }

              // C7 修复：messages 窗口截断（保留最近 MESSAGE_WINDOW_THRESHOLD 条，保证 tool_use/tool_result 成对）
              this.ctxMgr.trimMessagesWindow(messages, MESSAGE_WINDOW_THRESHOLD);

              // Phase 53 Task 9：预算监控（fail-open）
              this.ctxMgr.checkBudget(result.usage, result.toolCalls);

              // Phase 38 Task 1：onAgent 中间件——每次迭代结束后调用
              await this.mwRunner.runOnAgent(messages, iteration, totalUsage, result.toolCalls.length);

              // 继续循环——LLM 会根据工具结果生成下一轮回复
              continue;
            }

            // ----- 无工具调用，文本回复 → 循环结束 -----
            // 任务1：Compose 模式下，检查 LLM 文本回复是否触发阶段自动流转
            const llmResultForAdvance: ToolResult = { success: true, output: result.content, durationMs: 0 };
            if (this.memIntegration.evaluateAdvance(llmResultForAdvance)) {
              messages.push({ role: 'assistant', content: result.content });
              continue;
            }

            // Phase 73 Part C：内层 ReAct 循环自然退出，检查 follow-up 队列
            const followUps = this.ctxMgr.drainFollowUpQueue();
            if (followUps.length > 0) {
              messages.push({ role: 'assistant', content: result.content });
              for (const fu of followUps) {
                messages.push({ role: 'user', content: `[后续任务] ${fu.content}` });
                logger.debug('Follow-up message injected into messages', { content: fu.content, remaining: this.ctxMgr.followUpQueueLength });
              }
              // 重置迭代计数器，让外层循环重新计数
              iteration = 0;
              consecutiveErrors = 0;
              continue followUpLoop;
            }

            const finalDone: ReActEvent = { type: 'done', content: result.content, usage: totalUsage };
            yield finalDone; trace?.recordEvent(finalDone);
            return;

          } catch (error) {
            consecutiveErrors++;
            const errorMessage = error instanceof Error ? error.message : String(error);

            logger.error('ReAct iteration error', { iteration, consecutiveErrors, error: errorMessage });

            if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
              const errorEvent: ReActEvent = {
                type: 'error',
                error: `连续 ${consecutiveErrors} 次错误，终止执行。最后错误: ${errorMessage}`,
                usage: totalUsage,
              };
              yield errorEvent; trace?.recordEvent(errorEvent);
              const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
              yield doneEvent; trace?.recordEvent(doneEvent);
              return;
            }

            // I17 修复：错误重试消息膨胀——只保留最后一条错误消息
            const ERROR_CONTEXT_PREFIX = '[系统错误]';
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith(ERROR_CONTEXT_PREFIX)) {
                messages.splice(i, 1);
                break;
              }
            }
            // 将错误注入上下文，让 LLM 知道发生了什么
            messages.push({ role: 'user', content: `[系统错误] 上一次调用出错: ${errorMessage}。请直接用文本回复用户，不要尝试调用工具。` });

            const retryError: ReActEvent = { type: 'error', error: `迭代 ${iteration} 出错: ${errorMessage}，正在重试...` };
            yield retryError; trace?.recordEvent(retryError);
          }
        }

        // 达到最大迭代次数
        const maxIterError: ReActEvent = {
          type: 'error',
          error: `达到最大迭代次数 (${this.config.maxIterations})，终止执行`,
          usage: totalUsage,
        };
        yield maxIterError; trace?.recordEvent(maxIterError);
        const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
        yield doneEvent; trace?.recordEvent(doneEvent);
        // maxIterations 退出不处理 follow-up（避免无限循环）
        break followUpLoop;
      } // end followUpLoop
    } finally {
      // C6 修复：确保 session 结束时触发 on-session-end
      await this.mwRunner.fireHookSafe('on-session-end', {});
      // Phase 79 Task 5：清理当前确认回调，避免 run 结束后残留
      this.currentConfirmTool = null;
    }
  }

  /**
   * 执行一次 LLM 流式调用
   * yield text_delta/reasoning_delta 事件，返回完整的工具调用和 usage（通过 AsyncGenerator return value）
   * TD-10：流解析委托给 ctxMgr.processLLMStream，引用解析委托给 memIntegration
   */
  private async *callLLMStream(
    client: ILLMClient,
    modelId: string,
    messages: LLMMessage[],
    systemPrompt: string | undefined,
    systemBlocks: SystemBlock[] | undefined,
    toolDefs: LLMToolDefinition[],
    signal?: AbortSignal,
    enableCache?: boolean,
  ): AsyncGenerator<ReActEvent, LLMStreamResult> {
    // 修复：最终防线——发送给 LLM 前再次确保 tool_use/tool_result 成对
    this.ctxMgr.sanitizeToolMessages(messages);

    // Phase 53 Task 2 E5：引用解析——把 citeManager 收集的引用交给 resolver 解析
    const citeResolution = await this.memIntegration.resolveCitations();
    if (citeResolution) {
      ({ messages, systemPrompt } = this.memIntegration.applyCiteResolution(messages, systemPrompt, citeResolution));
    }

    // Phase 73 Part A：在 LLM 调用边界插入 convertToLlm 过滤层
    const convertFn = this.config.convertToLlm ?? defaultConvertToLlm;
    // FIXME: as 断言，messages 实际为 LLMMessage[]，需显式适配函数
    const llmMessages = convertFn(messages as AgentMessage[]);

    const options: LLMRequestOptions = {
      model: modelId,
      messages: llmMessages,
      systemPrompt,
      // Phase 55：透传 systemBlocks，LLM 客户端优先使用，未传时回退 systemPrompt
      systemBlocks,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: 4096,
      timeoutMs: this.config.llmTimeout,
      stream: true,
      // Phase 32 Task 2：透传 enableCache
      enableCache,
      // V2-021 修复：透传 AbortSignal 到 LLM 客户端，支持流式取消
      signal,
    };

    // Phase 38 Task 1：onModelCall 中间件——LLM API 调用前（fail-open）
    await this.mwRunner.runOnModelCall(messages, systemPrompt, toolDefs, modelId, options);

    // 流式调用——委托 ctxMgr 解析流事件
    const stream = client.stream(options);
    const result = yield* this.ctxMgr.processLLMStream(stream, signal);

    // Phase 53 Task 2 P2-4：从 LLM 输出文本中提取 [cite:type:source] 标记
    this.memIntegration.extractCitationsFromText(result.content);

    return result;
  }
}

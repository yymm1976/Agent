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
  ToolCallRequest,
} from '../router/types.js';
import type { ReActConfig, ReActEvent, ToolExecutorAdapter, ConfirmToolCallback } from './loop-config.js';
import { DEFAULT_REACT_CONFIG } from './loop-config.js';
import { logger } from '../utils/logger.js';
import { resolveCapabilities } from '../router/capability-resolver.js';
import type { AgentMessage } from './message-types.js';
import { defaultConvertToLlm } from './message-types.js';
// Phase 97 Part A：统一事件协议与执行上下文
import type { EngineEventV1, EngineEventBase } from '../harness/event-types.js';
import { SequenceCounter } from '../harness/event-types.js';
import type { AgentExecutionContext } from './execution-context.js';
import { createDefaultExecutionContext } from './execution-context.js';
import type { ToolResult } from '../tools/types.js';
// 工具调用修复 pipeline（Phase 96+：借鉴 Reasonix 四道工序）
import { run as runRepairPipeline } from '../tools/tool-call-repair/pipeline.js';
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
// token 估算（用于 ReAct 循环内压缩阈值判断）
import { estimateTokens } from '../utils/token-estimate.js';

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
 * P0（复审）：统一 usage 聚合——累加全部字段，避免新增字段（缓存 hit/miss、
 * reasoning tokens 等）在 loop 汇总时再次遗漏。
 * 未知字段用 ?? 0 归一，缺失侧不污染累计值。
 */
/** 可选字段相加：两边都缺失才保持 undefined（不生成 0——0 会遮蔽 ChatBridge 的 ?? 回退链） */
function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

export function accumulateUsage(total: TokenUsageInfo, current: TokenUsageInfo): void {
  total.inputTokens += current.inputTokens;
  total.outputTokens += current.outputTokens;
  total.totalTokens += current.totalTokens;
  // P1 修复（复审）：缺失字段保持 undefined——Anthropic 只有 cacheReadInputTokens
  // 时不得生成 cacheHitTokens:0（否则 ChatBridge 的 ?? 回退被 0 短路）
  total.cacheHitTokens = addOptional(total.cacheHitTokens, current.cacheHitTokens);
  total.cacheMissTokens = addOptional(total.cacheMissTokens, current.cacheMissTokens);
  total.cacheReadInputTokens = addOptional(total.cacheReadInputTokens, current.cacheReadInputTokens);
  total.cacheCreationInputTokens = addOptional(total.cacheCreationInputTokens, current.cacheCreationInputTokens);
}

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

/**
 * 压缩器接口（type-only，避免循环依赖）
 * 供 ReActAgentLoop 在 ReAct 循环中按 token 阈值压缩 messages
 */
export interface CompactorLike {
  shouldCompressEnhanced(
    messageCount: number,
    estimatedTokens: number,
  ): { should: boolean; action?: string };
  compressEnhanced(
    messages: LLMMessage[],
    options?: { force?: boolean; maxTokens?: number },
  ): Promise<{
    compressed: LLMMessage[];
    // B-07：压缩统计（ContextCompactor 的 CompactionResult 与 ContextManager 的 CompressionEvent
    // 字段名不同，统一为可选兼容形状）
    result?: {
      beforeTokens?: number;
      afterTokens?: number;
      maxStageReached?: number;
      removedMessages?: number;
      recovery?: import('./context-compaction.js').CompactionRecovery;
      tokensBefore?: number;
      tokensAfter?: number;
      messagesCompressed?: number;
    };
  }>;
}

/** ReAct 循环运行参数 */
export interface ReActRunParams {
  /** 外层请求/turn 标识，用于精确 abort，不改变事件 sessionId。 */
  requestId?: string;
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
  /**
   * B-16：隔离工作区（worktree 实验时注入——工具执行的工作目录与目录边界切换到
   * worktree 路径，主工作区不被读写；缺省 = 工具层默认上下文）
   */
  workspace?: { workingDirectory: string; allowedDirectories: string[] };
  /**
   * 修复 8（复审）：DeepSeek 思考强度确定性映射（taskShape → effort），
   * 由调用方（chat-bridge）按任务形状传入；未传时适配器默认 high
   */
  reasoningEffort?: 'low' | 'high' | 'max';
  /** 修复 8：单次 LLM 调用最大输出 token（未传时保持 loop 默认 4096） */
  maxTokens?: number;
  /**
   * P1 修复（复审）：回合级工具面上下文（mode/taskShape/mcpRequested）——
   * 每轮 getToolDefinitions 透传，QA 回合的写工具不进 schema；
   * 缺省按 coding 面解析
   */
  toolSurface?: import('../tools/tool-surface-resolver.js').ToolSurfaceContext;
  /** 工具调用确认回调（Phase 9 自主模式） */
  onConfirmTool?: ConfirmToolCallback;
  /** 模型调用成功回调 */
  onModelSuccess?: (modelId: string) => void;
  /** 模型调用失败回调 */
  onModelFailure?: (modelId: string, error: unknown) => void;
  /** 自主度模式（传递给权限中间件） */
  autonomyMode?: 'manual' | 'semi' | 'auto';
  /** Phase 97 Part A：统一执行上下文（触发来源/sessionId/工作区等），缺失时以 user 兜底 */
  context?: AgentExecutionContext;
  /**
   * 本轮暴露给模型的工具白名单。
   * 未传入表示使用全部已注册工具；执行器的安全检查仍然是最终边界。
   */
  allowedToolNames?: readonly string[];
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
  /** Phase 79 Task 5：当前 run() 期间的确认回调（run 开始时设置，结束清理）
   * 子 Agent 通过 getCurrentConfirmTool() 获取父会话的确认通道，实现委托确认
   */
  private currentConfirmTool: ConfirmToolCallback | null = null;
  /** 当前 run() 期间的自主度模式（传递给权限中间件） */
  private currentAutonomyMode: 'manual' | 'semi' | 'auto' = 'manual';
  /** Phase 97 Part A：当前 run() 期间的执行上下文（run 开始时设置） */
  private currentContext: AgentExecutionContext | null = null;
  /** Phase 97 Part A：EngineEventV1 事件接收器（可选注入，不注入则不影响现有行为） */
  private engineSink: ((e: EngineEventV1) => void) | null = null;
  /** Phase 97 Part A：turn 内 sequence 计数器 */
  private engineSeq: SequenceCounter | null = null;
  /** Phase 97 Part A：当前 turn 是否已发结束事件（防重复） */
  private engineTurnEnded = false;
  /** Phase 97 Part A：当前 turn id */
  private currentTurnId: string | null = null;
  /** B-12：外层请求/turn 标识（run 开始时保存；turnId 优先复用，保证 Kernel/桌面/SSE 跨层一致） */
  private engineTurnRequestId: string | null = null;
  /** Phase 97 Part A：当前 message id */
  private currentMessageId: string | null = null;
  /** Phase 97 Part A：agent 结束原因（finally 发射 agent_end 用） */
  private engineEndReason: 'completed' | 'error' | 'cancelled' | 'max_iterations' = 'completed';
  /** B-14：当前 run 的模型能力决策（run 开始时解析一次，run 期间生效） */
  private currentCapability: import('../router/capability-resolver.js').CapabilityDecision | null = null;
  /** B-16（审查 I2 修复）：当前 run 的隔离工作区（worktree 实验时切换工具的 workingDirectory 与边界） */
  private currentWorkspace: { workingDirectory: string; allowedDirectories: string[] } | undefined;
  /** 修复 8（复审）：当前 run 的思考强度与输出预算（taskShape 映射，run 期间生效） */
  private currentReasoningEffort: 'low' | 'high' | 'max' | undefined;
  private currentMaxTokens: number = 4096;
  /** P1 修复（复审）：当前 run 的工具面上下文（每轮 schema 解析透传） */
  private currentToolSurface: import('../tools/tool-surface-resolver.js').ToolSurfaceContext | undefined;
  /**
   * 压缩器（可选）：注入后在 ReAct 循环每轮迭代前检查 messages 的 token 数，
   * 超过阈值时调用 compressEnhanced 压缩，防止 messages 膨胀超出模型窗口
   */
  private compactor: CompactorLike | null = null;

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

  /** Phase 97 Part A：注入 EngineEventV1 接收器（桌面/远程/历史存储共用的事件协议） */
  setEngineEventSink(sink: ((e: EngineEventV1) => void) | null): void {
    this.engineSink = sink;
  }

  /** Phase 97 Part A：注入当前执行上下文（也可经 run params 传入，二选一） */
  setExecutionContext(ctx: AgentExecutionContext | null): void {
    this.currentContext = ctx;
  }

  /** Phase 97 Part A：生成事件公共字段（id/sessionId/sequence/timestamp） */
  private engineBase(seq: number): Pick<EngineEventV1, 'id' | 'sessionId' | 'sequence' | 'timestamp' | 'triggerSource'> {
    const sessionId = this.currentContext?.sessionId ?? this.ctxMgr.traceCollector?.getSessionId() ?? 'session-unknown';
    return {
      id: `${sessionId}-${seq}-${Date.now().toString(36)}`,
      sessionId,
      sequence: seq,
      timestamp: Date.now(),
      triggerSource: this.currentContext?.triggerSource,
    };
  }

  /** Phase 97 Part A：发射 EngineEventV1，未注入 sink 时静默跳过 */
  private emitEngineEvent(ev: Omit<EngineEventV1, 'id' | 'sessionId' | 'sequence' | 'timestamp' | 'triggerSource'>): void {
    const sink = this.engineSink;
    if (!sink || !this.engineSeq) return;
    sink({ ...this.engineBase(this.engineSeq.next()), ...ev } as EngineEventV1);
  }

  /** Phase 97 Part A：开始一个新 turn（turn_start + message_start），防重复 */
  private beginEngineTurn(input: string): void {
    if (!this.engineSink || !this.engineSeq) return;
    if (!this.engineTurnEnded) {
      // B-12：外层 requestId 存在时复用为 turnId——Kernel EngineEventV1 与桌面/SSE
      // timeline 的 turn 标识同源；本地无 requestId 时退回时间戳生成
      this.currentTurnId = this.engineTurnRequestId
        ?? `turn-${Date.now().toString(36)}-${this.engineSeq.next()}`;
      this.emitEngineEvent({ type: 'turn_start', turnId: this.currentTurnId, payload: { input } });
    }
    this.currentMessageId = `msg-${Date.now().toString(36)}-${this.engineSeq.next()}`;
    this.emitEngineEvent({ type: 'message_start', turnId: this.currentTurnId ?? undefined, messageId: this.currentMessageId, payload: { role: 'assistant' } });
  }

  /** Phase 97 Part A：结束当前 turn（message_end + turn_end），防重复 */
  private finishEngineTurn(): void {
    if (this.engineTurnEnded || !this.engineSink || !this.engineSeq) return;
    this.engineTurnEnded = true;
    this.emitEngineEvent({ type: 'message_end', turnId: this.currentTurnId ?? undefined, messageId: this.currentMessageId ?? undefined, payload: { contentLength: 0 } });
    this.emitEngineEvent({ type: 'turn_end', turnId: this.currentTurnId ?? undefined, payload: { outputLength: 0 } });
    this.currentTurnId = null;
    this.currentMessageId = null;
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

  /**
   * 注入压缩器（可选）：注入后在 ReAct 循环每轮迭代前检查并压缩 messages
   * 传 null 可显式卸载
   */
  setCompactor(compactor: CompactorLike | null): void {
    this.compactor = compactor;
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
    // 保存当前自主度模式，供权限中间件使用
      this.currentAutonomyMode = params.autonomyMode ?? 'manual';

    // C6 修复：触发 on-session-start 钩子
    await this.mwRunner.fireHookSafe('on-session-start', {});

    try {
      // Phase 97 Part A：设置执行上下文、初始化事件序列，发射 agent_start
      this.currentContext = params.context ?? this.currentContext ?? createDefaultExecutionContext(this.ctxMgr.traceCollector?.getSessionId() ?? 'session-unknown');
      // B-12：保存外层请求标识，turnId 优先复用（桌面/SSE timeline 与 Kernel/Trace 同源）
      this.engineTurnRequestId = params.requestId ?? null;
      // P2（turn 隔离）：run 开始重置 tool_search 提升池——每个 run 从干净工具面开始
      this.toolExecutor.resetBoost?.();
      // B-16（审查 I2 修复）：保存隔离工作区——worktree 实验时工具读写切换到 worktree
      this.currentWorkspace = params.workspace;
      // 修复 8（复审）：保存任务形状映射的思考强度与输出预算
      this.currentReasoningEffort = params.reasoningEffort;
      this.currentMaxTokens = params.maxTokens ?? 4096;
      // P1 修复（复审）：保存回合级工具面上下文（QA 回合写工具不进 schema）
      this.currentToolSurface = params.toolSurface;
      // B-14：解析模型运行时能力——缺失能力显式降级（无工具/串行/禁图像），run 期间生效
      this.currentCapability = resolveCapabilities(
        routeDecision.model.capabilities,
        routeDecision.model.maxSchemaTokens,
        { wantsTools: true, wantsImages: true, wantsParallelTools: true },
      );
      if (this.currentCapability.degradations.length > 0) {
        logger.warn('Model capability degradation (explicit)', {
          model: routeDecision.model.id,
          degradations: this.currentCapability.degradations,
        });
      }
      this.engineSeq = new SequenceCounter();
      this.engineTurnEnded = false;
      this.engineEndReason = 'completed';
      this.emitEngineEvent({ type: 'agent_start', payload: { kernel: 'routedev-native', model: routeDecision.model.id } });

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
      const userMsgResult = await this.mwRunner.runOnUserMessage(effectiveUserMessage);
      const finalUserMessage = userMsgResult.userMessage;
      messages.push({ role: 'user', content: finalUserMessage });

      // Phase 94：Skill 流程提及提示注入到首条 user 消息之后
      if (userMsgResult.skillFlowHint) {
        messages.push({ role: 'user', content: userMsgResult.skillFlowHint });
      }

      // B-01B：工具定义改为每轮迭代重新获取（原在 run 开头取一次）。
      // tool_search 在同一回合内提升 deferred 工具后，下一轮模型即可看到并调用；
      // 每轮 list+map 开销可忽略。
      const allowedToolNamesSet = params.allowedToolNames ? new Set(params.allowedToolNames) : null;

      let iteration = 0;
      let consecutiveErrors = 0;
      let totalUsage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalContent = '';
      /** 上一轮 LLM 返回的真实 inputTokens（含 system/tools），压缩决策优先用它 */
      let lastRoundInputTokens = 0;
      /**
       * 工具调用修复 pipeline 用：最近 N 轮已执行的工具调用（按时间倒序）
       * 每轮工具执行后追加到队首，超过 WINDOW_SIZE 自动淘汰尾部
       */
      const recentToolCalls: ToolCallRequest[] = [];

      // Phase 73 Part C：双层循环——外层 follow-up 驱动，内层 ReAct 循环
      // V3-018 修复：添加全局迭代次数上限，防止 follow-up 队列持续注入导致无限循环
      let followupIteration = 0;
      followUpLoop: while (true) {
        // Phase 97 Part A：每个 turn 开始（含 follow-up 续接的新 turn）
        this.beginEngineTurn(userMessage);
        followupIteration++;
        if (followupIteration > MAX_FOLLOWUP_ITERATIONS) {
          logger.warn('FollowUp loop reached max iterations, breaking', {
            iteration: followupIteration,
          });
          // Phase 94：FollowUp 上限也升级人工
          const overflowEscalation: ReActEvent = {
            type: 'escalation',
            reason: `FollowUp 循环达到最大迭代次数 (${MAX_FOLLOWUP_ITERATIONS})，Agent 持续追问但未收敛。请用户介入：直接给出答案或调整任务。`,
            iterations: MAX_FOLLOWUP_ITERATIONS,
            usage: totalUsage,
          };
          yield overflowEscalation; trace?.recordEvent(overflowEscalation);
          const overflowDone: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
          yield overflowDone; trace?.recordEvent(overflowDone);
          this.engineEndReason = 'max_iterations';
          this.finishEngineTurn();
          break followUpLoop;
        }
        while (iteration < this.config.maxIterations) {
          // 检查取消信号
          if (signal?.aborted) {
            const cancelError: ReActEvent = { type: 'error', error: '用户取消了执行' };
            yield cancelError; trace?.recordEvent(cancelError);
            const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
            yield doneEvent; trace?.recordEvent(doneEvent);
            this.engineEndReason = 'cancelled';
            this.finishEngineTurn();
            return;
          }

          // C5 修复：迭代开始前取出 next_iteration 模式的转向消息
          this.ctxMgr.drainSteeringIntoMessages(messages, 'next_iteration');
          iteration++;

          // B-01B：每轮重新获取工具定义（拾取 tool_search 提升的 deferred 工具）
          const rawToolDefs = this.config.toolsEnabled ? this.toolExecutor.getToolDefinitions(this.currentToolSurface) : [];
          const toolDefs = allowedToolNamesSet
            ? rawToolDefs.filter((tool) => allowedToolNamesSet!.has(tool.name))
            : rawToolDefs;

          // 压缩检查：优先用上一轮 API 真实 inputTokens（含 system/tools），
          // 估算值会严重偏低，导致 552k/500k 仍不触发。
          if (this.compactor) {
            try {
              const estimatedTokens = messages.reduce((acc, msg) => {
                const t = typeof msg.content === 'string'
                  ? msg.content
                  : JSON.stringify(msg.content);
                return acc + estimateTokens(t);
              }, 0);
              // lastRoundInputTokens 在 LLM 返回后更新；首轮为 0 则用估算
              const tokensForDecision = Math.max(lastRoundInputTokens, estimatedTokens);
              const decision = this.compactor.shouldCompressEnhanced(messages.length, tokensForDecision);
              if (decision.should || decision.action === 'warn') {
                // warn 也尝试压缩：接近上限时主动减负，避免下一轮直接超窗
                if (decision.should || tokensForDecision >= estimatedTokens) {
                  const { compressed, result } = await this.compactor.compressEnhanced(messages);
                  if (compressed.length < messages.length || compressed !== messages) {
                    messages.length = 0;
                    messages.push(...compressed);
                    // 压缩后重置真实 token 计数，下一轮以新 usage 为准
                    lastRoundInputTokens = 0;
                    logger.info('ReAct loop: messages compacted', {
                      tokensBefore: tokensForDecision,
                      action: decision.action,
                      messagesAfter: compressed.length,
                    });
                    // B-07：压缩事件进 EngineEventV1（前后 token、删减类型、恢复项数、耗时）
                    // 兼容两种压缩器字段命名（CompactionResult / CompressionEvent）
                    const recovery = result?.recovery;
                    // B-07：压缩后注入紧凑恢复清单（最近读取/修改文件、未完成 Todo），
                    // 不恢复完整工具输出；路径由模型重新经过 workspace boundary 后再读取
                    if (recovery && (recovery.readFiles.length > 0 || recovery.modifiedFiles.length > 0 || recovery.todoItems.length > 0)) {
                      const lines: string[] = [];
                      if (recovery.readFiles.length > 0) lines.push(`最近读取文件：${recovery.readFiles.join(', ')}`);
                      if (recovery.modifiedFiles.length > 0) lines.push(`最近修改文件：${recovery.modifiedFiles.join(', ')}`);
                      if (recovery.todoItems.length > 0) lines.push(`未完成待办：${recovery.todoItems.join('; ')}`);
                      messages.push({
                        role: 'system',
                        content: `[压缩后恢复清单] ${lines.join('；')}（继续工作前用工具复核这些路径，路径需通过工作区边界校验）`,
                      });
                    }
                    const recoveryItems = recovery
                      ? recovery.readFiles.length + recovery.modifiedFiles.length + recovery.todoItems.length + recovery.imageCount
                      : 0;
                    this.emitEngineEvent({
                      type: 'context_compacted',
                      payload: {
                        beforeTokens: result?.beforeTokens ?? result?.tokensBefore ?? tokensForDecision,
                        afterTokens: result?.afterTokens ?? result?.tokensAfter ?? 0,
                        stage: result?.maxStageReached ?? 0,
                        removedMessages: result?.removedMessages ?? result?.messagesCompressed ?? 0,
                        recoveryItems,
                        elapsedMs: recovery?.elapsedMs ?? 0,
                      },
                    });
                  }
                }
              }
            } catch (err) {
              logger.warn('ReAct loop: compact failed, continue with original messages', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          logger.debug('ReAct iteration', { iteration, maxIterations: this.config.maxIterations, messageCount: messages.length });

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
              this.engineEndReason = 'cancelled';
              this.finishEngineTurn();
              return;
            }

            // 累加 usage——统一聚合所有字段（含 DeepSeek 原生缓存 hit/miss 与
            // Anthropic cacheRead/cacheCreation；P0 修复：此前只累加 3 个基础字段，
            // 缓存统计链路在 loop 汇总时丢失，ChatBridge 收到 undefined 记成 0 命中）
            accumulateUsage(totalUsage, result.usage);

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
              // Phase 96+：工具调用修复 pipeline（借鉴 Reasonix 四道工序）
              //   1. scavenge — 从 reasoning_content 捞回被吃掉的 tool-call JSON
              //   2. truncation — 修复不完整的 arguments JSON
              //   3. flatten — 打平过深嵌套参数
              //   4. storm — 检测重复调用并注入反思提示
              // pipeline 不抛异常（内部 try/catch 兜底），失败时原样返回
              const repairResult = runRepairPipeline({
                toolCalls: result.toolCalls,
                reasoningContent: result.reasoning,
                rawText: result.content,
                recentToolCalls,
              });
              result.toolCalls = repairResult.toolCalls;
              // storm 工序可能注入反思提示，作为 user 消息 push 到 messages
              for (const reflection of repairResult.reflections) {
                messages.push({ role: 'user', content: reflection });
              }
              if (repairResult.summary.some((s) => s.repaired)) {
                logger.info('ToolCallRepair.pipeline: repairs applied', {
                  steps: repairResult.summary.filter((s) => s.repaired).map((s) => `${s.step}(${s.reason})`),
                });
              }
              // 修复后可能为空（storm 全部抑制），按无工具调用处理
              if (result.toolCalls.length === 0) {
                // 跳过工具执行，继续下一轮迭代让 LLM 重新思考
                continue;
              }

              // 将 assistant 消息（含 tool_calls）加入上下文
              const assistantContent: ContentPart[] = result.content
                ? [{ type: 'text', text: result.content }]
                : [];
              for (const tc of result.toolCalls) {
                assistantContent.push({ type: 'tool_use' as const, id: tc.id, name: tc.name, arguments: tc.arguments });
              }
              // P0 协议修复：工具轮次 reasoning 必须随 assistant 消息回传
              // （DeepSeek V4 thinking 模式缺省则 API 400；无推理模型为空字符串，不带字段）
              messages.push({
                role: 'assistant',
                // DeepSeek V4 要求工具调用 assistant 消息 content 非 null——空数组兜底为空文本
                content: assistantContent.length > 0
                  ? assistantContent
                  : [{ type: 'text' as const, text: '' }],
                ...(result.reasoning ? { reasoningContent: result.reasoning } : {}),
              });

              // Phase 73 Part B：batch 级 sequential 检测
              const hasSequential = result.toolCalls.some(tc => {
                const mode = this.toolExecutor.getToolExecutionMode?.(tc.name);
                return mode === 'sequential';
              });

              // B-14：模型未声明 parallel_tool_calls 时显式降级为串行执行
              if ((this.currentCapability?.parallelToolsEnabled ?? true)
                && this.config.parallelToolExecution && !hasSequential && result.toolCalls.length > 1) {
                // ===== 并行模式 =====
                // 阶段1：串行权限校验 + 确认 + 中间件检查
                const approvedCalls: typeof result.toolCalls = [];
                // Phase 94：并行模式下收集最后一个 actingResult 的 explorationSuggestion（中间件对每次 onActing 都设置，最后一个最有意义）
                let lastExplorationSuggestion: string | undefined;
                for (const toolCall of result.toolCalls) {
                  yield { type: 'tool_call_start', toolName: toolCall.name, toolCallId: toolCall.id, args: toolCall.arguments };

                  // Phase 79 Task 3：onActing 中间件 + 策略引擎前置（fail-closed）
                  const actingResult = await this.mwRunner.runOnActing(toolCall.name, toolCall.arguments, this.currentAutonomyMode);
                  if (actingResult.denied) {
                    const toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, `[被拦截] ${actingResult.reason ?? '未知原因'}`);
                    yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError: true };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError: true }] });
                    continue;
                  }

                  // Phase 79 Task 3/5：根据权限决策确定是否需要用户确认
                  // 修复：auto 模式下所有工具直接放行（与串行模式逻辑一致）
                  const permDecision = actingResult.permissionDecision;
                  const permMatchedRule = actingResult.permissionMatchedRule;
                  let needsConfirmation: boolean;
                  if (this.currentAutonomyMode === 'auto') {
                    needsConfirmation = false;
                  } else if (permDecision === 'confirm' || actingResult.requiresConfirmation) {
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
                  // Phase 94：收集 explorationSuggestion（覆盖式，保留最后一个）
                  if (actingResult.explorationSuggestion) {
                    lastExplorationSuggestion = actingResult.explorationSuggestion;
                  }
                }

                // 阶段2：并行执行所有已批准的工具
                if (approvedCalls.length > 0) {
                  const useStructured = typeof this.toolExecutor.executeToolStructured === 'function';
                  const toolStartTimes = approvedCalls.map(() => Date.now());
                  // Phase 96 P1-1：每个工具一个 delta buffer，并行执行时收集增量输出
                  // allSettled 完成后按顺序 drain，避免多工具输出交错
                  const deltaBuffers: ReActEvent[][] = approvedCalls.map(tc => []);
                  // C8 修复：用 allSettled 隔离单个工具异常
                  const settled = await Promise.allSettled(
                    approvedCalls.map((tc, idx) => {
                      const onUpdate = (chunk: string) => {
                        deltaBuffers[idx].push({ type: 'tool_call_delta', toolName: tc.name, toolCallId: tc.id, chunk });
                      };
                      return useStructured
                        ? this.toolExecutor.executeToolStructured!(tc.name, tc.id, tc.arguments, { signal, onUpdate, autonomyMode: this.currentAutonomyMode, workspace: this.currentWorkspace })
                        : this.toolExecutor.executeTool(tc.name, tc.id, tc.arguments, { signal, onUpdate, autonomyMode: this.currentAutonomyMode, workspace: this.currentWorkspace })
                            .then(output => ({ output, isError: /\[工具错误\]|\[被拦截\]/.test(output) }));
                    }),
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
                    // Phase 96 P1-1：先 yield 该工具的所有增量输出
                    for (const delta of deltaBuffers[i]) {
                      yield delta;
                    }
                    const toolResult = await this.ctxMgr.sanitizeToolResult(tc.name, execResult.output, tc.arguments);
                    const isError = execResult.isError;
                    const toolDuration = Date.now() - toolStartTimes[i];

                    // I16 修复：并行模式下触发 post-tool-call 钩子
                    await this.mwRunner.fireHookSafe('post-tool-call', { stepId: tc.id, toolName: tc.name, toolArgs: tc.arguments, toolResult, toolDuration });

                    yield { type: 'tool_call_result', toolName: tc.name, toolCallId: tc.id, result: toolResult, isError };
                    messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: tc.id, content: toolResult, isError }] });

                    // Phase 94：探索预算超限提示注入 LLM 上下文（并行模式：用最后一个 actingResult 的 suggestion）
                    if (lastExplorationSuggestion && i === approvedCalls.length - 1) {
                      messages.push({ role: 'user', content: [{ type: 'text' as const, text: `[系统提示] ${lastExplorationSuggestion}` }] });
                    }

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
                  const actingResult = await this.mwRunner.runOnActing(toolCall.name, toolCall.arguments, this.currentAutonomyMode);
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
                  //
                  // 修复：auto 模式下，所有工具直接放行（needsConfirmation = false）
                  // 理由：用户选择了 auto 模式 = 明确信任 Agent，不应再弹确认框。
                  // 真正的危险操作已被 PermissionEngine DEFAULT_DENY_RULES 硬拦截（deny 不受 autonomyMode 影响）。
                  const permDecision = actingResult.permissionDecision;
                  const permMatchedRule = actingResult.permissionMatchedRule;
                  let needsConfirmation: boolean;
                  if (this.currentAutonomyMode === 'auto') {
                    needsConfirmation = false;
                  } else if (permDecision === 'confirm' || actingResult.requiresConfirmation) {
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
                  // Phase 96 P1-1：透传 signal + onUpdate 支持流式输出与取消
                  const useStructured = typeof this.toolExecutor.executeToolStructured === 'function';
                  let toolResult: string;
                  let isError: boolean;
                  const toolStartTime = Date.now();
                  if (useStructured) {
                    const stream = this.createToolStream<{ output: string; isError: boolean; images?: Array<{ mediaType: string; data: string }> }>(toolCall.name, toolCall.id);
                    const toolPromise = this.toolExecutor.executeToolStructured!(
                      toolCall.name, toolCall.id, toolCall.arguments,
                      { signal, onUpdate: stream.onUpdate, autonomyMode: this.currentAutonomyMode },
                    );
                    const structured = yield* stream.drain(toolPromise);
                    toolResult = structured.output;
                    isError = structured.isError;
                    // Phase 96 P2-10：图片结果作为独立 user 消息注入 ContentPart.image
                    // 放在 tool_result 之后，让 LLM 同时看到工具文本结果和图片
                    // B-14：模型未声明 multimodal 时显式降级——图片不注入（避免协议不支持报错）
                    if (structured.images && structured.images.length > 0) {
                      if (this.currentCapability?.imageInputEnabled ?? true) {
                        const imageParts: ContentPart[] = structured.images.map(img => ({
                          type: 'image' as const,
                          source: { type: 'base64' as const, mediaType: img.mediaType, data: img.data },
                        }));
                        messages.push({ role: 'user', content: imageParts });
                      } else {
                        logger.warn('B-14 image degradation: image result suppressed for non-multimodal model', {
                          toolName: toolCall.name,
                        });
                      }
                    }
                  } else {
                    const stream = this.createToolStream<string>(toolCall.name, toolCall.id);
                    const toolPromise = this.toolExecutor.executeTool(
                      toolCall.name, toolCall.id, toolCall.arguments,
                      { signal, onUpdate: stream.onUpdate, autonomyMode: this.currentAutonomyMode, workspace: this.currentWorkspace },
                    );
                    toolResult = yield* stream.drain(toolPromise);
                    isError = /\[工具错误\]|\[被拦截\]/.test(toolResult);
                  }
                  const toolDuration = Date.now() - toolStartTime;

                  // 净化工具结果
                  toolResult = await this.ctxMgr.sanitizeToolResult(toolCall.name, toolResult, toolCall.arguments);

                  // post-tool-call 钩子
                  await this.mwRunner.fireHookSafe('post-tool-call', { stepId: toolCall.id, toolName: toolCall.name, toolArgs: toolCall.arguments, toolResult, toolDuration });

                  yield { type: 'tool_call_result', toolName: toolCall.name, toolCallId: toolCall.id, result: toolResult, isError };
                  messages.push({ role: 'user', content: [{ type: 'tool_result' as const, toolUseId: toolCall.id, content: toolResult, isError }] });

                  // Phase 94：探索预算超限提示注入 LLM 上下文
                  if (actingResult.explorationSuggestion) {
                    messages.push({ role: 'user', content: [{ type: 'text' as const, text: `[系统提示] ${actingResult.explorationSuggestion}` }] });
                  }

                  // Compose 管线自动流转评估
                  const toolResultForAdvance: ToolResult = { success: !isError, output: toolResult, durationMs: toolDuration, error: isError ? toolResult : undefined };
                  this.memIntegration.evaluateAdvance(toolResultForAdvance);
                }
              }

              // Phase 96+：更新 recentToolCalls 供下轮修复 pipeline 使用
              //   按 time 倒序维护，超过 storm.WINDOW_SIZE（5）条自动淘汰尾部
              //   并行与串行两条路径在此汇合，统一更新
              recentToolCalls.unshift(...result.toolCalls);
              if (recentToolCalls.length > 5) {
                recentToolCalls.length = 5;
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
            this.finishEngineTurn();
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
              this.engineEndReason = 'error';
              this.finishEngineTurn();
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

        // 达到最大迭代次数 → Phase 94：升级人工介入而非裸终止
        const escalationEvent: ReActEvent = {
          type: 'escalation',
          reason: `达到最大迭代次数 (${this.config.maxIterations})，Agent 未能在预算内完成任务。可能原因：预探索过载、子 Agent 未分发、任务拆分不足。请用户介入：检查任务定义、提高迭代上限或手动接管。`,
          iterations: this.config.maxIterations,
          usage: totalUsage,
        };
        yield escalationEvent; trace?.recordEvent(escalationEvent);
        const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
        yield doneEvent; trace?.recordEvent(doneEvent);
        this.engineEndReason = 'max_iterations';
        this.finishEngineTurn();
        // maxIterations 退出不处理 follow-up（避免无限循环）
        break followUpLoop;
      } // end followUpLoop
    } finally {
      // Phase 97 Part A：任何退出路径都发射 agent_end 并清理事件状态
      this.emitEngineEvent({ type: 'agent_end', payload: { reason: this.engineEndReason } });
      this.engineSeq = null;
      this.currentContext = null;
      this.engineTurnEnded = false;
      this.currentTurnId = null;
      this.currentMessageId = null;
      // C6 修复：确保 session 结束时触发 on-session-end
      await this.mwRunner.fireHookSafe('on-session-end', {});
      // Phase 79 Task 5：清理当前确认回调，避免 run 结束后残留
      this.currentConfirmTool = null;
      // Phase 96 I-2 修复：session 结束时反馈 useful，强化召回记忆的 validatedCount
      // 避免知识图谱只增不减、computeConfidence 的时间衰减使记忆逐渐失去召回价值
      this.memIntegration.commitMemoryFeedback();
      // P2（turn 隔离）：run 结束时清理当前 run 的隔离工作区与能力决策，
      // 防止跨 run 泄漏（worktree 路径/降级决策不得影响下一次 run）
      this.currentWorkspace = undefined;
      this.currentCapability = null;
      this.currentToolSurface = undefined;
      this.engineTurnRequestId = null;
      // B1（PHASE B）：清理 run 级参数残留——Run A 传 effort=max 后，
      // Run B 不传时不得沿用 max（currentAutonomyMode 同理）
      this.currentReasoningEffort = undefined;
      this.currentAutonomyMode = 'manual';
      // P1 修复（复审）：finally 清理 boost——Run A 提升但未调用的工具不得
      // 残留在 boost 池，否则 Run B 的 ChatBridge 在进入 loop 前读取旧 boost
      // 渲染 Prompt 摘要（与 loop 开始后 resetBoost 的真实 schema 不一致）
      this.toolExecutor.resetBoost?.();
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

    // B-14：模型未声明 tool_use 时显式降级——不传工具 schema（纯文本 run）
    const toolsEnabled = this.currentCapability?.toolsEnabled ?? true;
    let effectiveToolDefs = toolsEnabled ? toolDefs : [];
    if (!toolsEnabled && toolDefs.length > 0) {
      logger.warn('B-14 tool degradation: tools suppressed for model without tool_use', { modelId });
    }
    // B-14（审查 I3 修复）：streaming 能力缺失时显式记录——本循环唯一出口是流式调用，
    // 无法切非流式；显式提示让调用方/日志可见，避免静默失败
    if (!(this.currentCapability?.streamingEnabled ?? true)) {
      logger.warn('B-14 streaming degradation: model 未声明 streaming，流式调用可能不被支持', { modelId });
    }
    // B-14：工具 schema 超过模型 maxSchemaTokens 预算时显式提示（数量裁剪由 ToolSurfaceBudget 负责）
    const schemaBudget = this.currentCapability?.maxSchemaTokens ?? 4096;
    if (effectiveToolDefs.length > 0) {
      const schemaChars = JSON.stringify(effectiveToolDefs).length;
      // 1 token ≈ 4 chars 的粗略换算
      if (schemaChars > schemaBudget * 4) {
        logger.warn('B-14 schema budget: tool schema exceeds model maxSchemaTokens', {
          modelId,
          schemaTokensEstimate: Math.ceil(schemaChars / 4),
          budget: schemaBudget,
          toolCount: effectiveToolDefs.length,
        });
      }
    }

    const options: LLMRequestOptions = {
      model: modelId,
      messages: llmMessages,
      systemPrompt,
      // Phase 55：透传 systemBlocks，LLM 客户端优先使用，未传时回退 systemPrompt
      systemBlocks,
      tools: effectiveToolDefs.length > 0 ? effectiveToolDefs : undefined,
      maxTokens: this.currentMaxTokens,
      // 修复 8（复审）：任务形状映射的思考强度透传给适配器（DeepSeek 支持 max）
      reasoningEffort: this.currentReasoningEffort,
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

  /**
   * Phase 96 P1-1：工具流式执行辅助
   *
   * 创建一个 onUpdate 回调和一个 drain async generator。
   * 调用方把 onUpdate 传给 toolExecutor 的 callOptions，把 toolPromise 传给 drain。
   * drain 会实时 yield 出 tool_call_delta 事件（来自 onUpdate），最终返回 tool 的结果。
   *
   * 设计：
   * - 工具执行（生产者）通过 onUpdate 把 stdout/stderr 增量推入 buffer
   * - drain（消费者）与 toolPromise 竞争：buffer 有数据则 yield，无数据则等待
   * - toolPromise resolve/reject 时唤醒 drain，drain 清空 buffer 后 return/throw
   *
   * 用于串行模式下的实时流式输出。并行模式不使用此方法（避免多工具输出交错）。
   */
  private createToolStream<T>(
    toolName: string,
    toolCallId: string,
  ): {
    onUpdate: (chunk: string) => void;
    drain: (toolPromise: Promise<T>) => AsyncGenerator<ReActEvent, T>;
  } {
    const buffer: ReActEvent[] = [];
    let resolveNext: (() => void) | null = null;

    const wake = () => {
      const r = resolveNext;
      resolveNext = null;
      r?.();
    };

    const onUpdate = (chunk: string) => {
      buffer.push({ type: 'tool_call_delta', toolName, toolCallId, chunk });
      wake();
    };

    async function* drain(toolPromise: Promise<T>): AsyncGenerator<ReActEvent, T> {
      // 用对象包装避免 TypeScript CFA 把 resolved 收窄为 null（闭包内赋值后外部读取需用属性访问）
      // resolved 三态：null=未完成，{ok:true,value}={已成功}，{ok:false,error}={已失败}
      const state: { resolved: { ok: true; value: T } | { ok: false; error: unknown } | null } = {
        resolved: null,
      };
      toolPromise.then(
        v => { state.resolved = { ok: true, value: v }; wake(); },
        e => { state.resolved = { ok: false, error: e }; wake(); },
      );

      while (true) {
        // 先把 buffer 里所有事件 yield 出去
        while (buffer.length > 0) {
          yield buffer.shift()!;
        }
        // 检查工具是否已完成
        if (state.resolved) {
          if (state.resolved.ok) return state.resolved.value;
          throw state.resolved.error;
        }
        // 等待下一次唤醒（onUpdate 或 toolPromise 完成）
        await new Promise<void>(r => { resolveNext = r; });
      }
    }

    return { onUpdate, drain };
  }
}

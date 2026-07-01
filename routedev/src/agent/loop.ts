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
import type { TokenProfiler, TokenProfileSnapshot } from './token-profiler.js';
import type { TraceCollector } from '../harness/trace-collector.js';
// Phase 32 Task 1.2：接入 ToolResultSanitizer（注入检测 + 智能截断 + 敏感字段脱敏）
import type { ToolResultSanitizer } from '../tools/result-sanitizer.js';
// C6 修复：接入 HookRunner，触发工具级/会话级钩子
import type { HookRunner, HookContext, HookResult } from './hooks.js';
// 任务1：接入 ComposePipeline，在 Compose 模式下注入阶段提示词并自动流转
import type { ComposePipeline } from './compose-pipeline.js';
// 任务3：接入简洁思考约束（系统提示词注入 + 工具结果裁剪 + 跳过检测）
import { CONCISE_THINKING_BLOCK, trimToolResult, shouldSkipConcise } from './concise-thinking.js';
// 任务1：evaluateAdvance 需要 ToolResult 类型
import type { ToolResult } from '../tools/types.js';
// Phase 53 Task 2：装配验证与 setter 注入
// 使用 type-only import 避免运行时循环依赖（PolicyEngine/CiteManager/MacroManager 不在 Loop 运行时路径上）
import type { PolicyEngine } from '../policies/policy-engine.js';
import type { CiteManager } from '../cite/manager.js';
import type { CiteResolver } from '../cite/resolver.js';
import type { CiteItem, CiteType, CiteResolution } from '../cite/types.js';
import type { MacroManager } from '../macros/manager.js';
// Phase 53 Task 9：预算监控器（type-only import，避免运行时循环依赖）
import type { BudgetMonitor } from './budget-monitor.js';
// Phase 55 Task 7：DualLoop 编排器（type-only import，避免运行时循环依赖）
// 注入后 run() 会把控制权转交给 orchestrator.run()
import type { DualLoopOrchestrator } from './dual-loop-orchestrator.js';

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
  /** Token Profiler（Phase 30：可观测性，可选） */
  private profiler: TokenProfiler | null = null;
  /** Phase 32 Task 1.2：工具结果净化器（注入检测 + 智能截断 + 敏感字段脱敏，可选） */
  private sanitizer: ToolResultSanitizer | null = null;
  /** Phase 34：Trace 收集器（可选，用于记录 LLM 调用与循环事件） */
  private trace: TraceCollector | null = null;
  /**
   * C5 修复：Steering Queue 消费者（可选）
   * 接入后，run() 每次迭代前后会取出排队的用户转向消息并注入 messages
   */
  private steeringConsumer: (() => { content: string; mode: string }[] | null) | null = null;
  /**
   * C6 修复：HookRunner（可选）
   * 接入后，run() 会在工具调用前后/session 起止触发对应钩子
   */
  private hookRunner: HookRunner | null = null;
  /**
   * 任务1：Compose 管线（可选）
   * 接入后，run() 会在 Compose 模式下注入当前阶段的系统提示词，
   * 并在工具执行后调用 evaluateAdvance() 检查是否应自动流转
   */
  private composePipeline: ComposePipeline | null = null;
  /**
   * 任务3：简洁思考约束开关
   * 开启后追加输出纪律到系统提示词、裁剪过长工具返回、检测用户"详细"关键词临时跳过
   */
  private conciseThinkingEnabled = false;
  /**
   * Phase 53 Task 2：策略引擎（可选）
   * 接入后，onActing 中间件会调用 evaluateAction 做 fail-closed 检查
   */
  private policyEngine: PolicyEngine | null = null;
  /**
   * Phase 53 Task 2：引用管理器（可选）
   * 接入后，工具返回中的引用标记会被规范化解析与渲染
   */
  private citeManager: CiteManager | null = null;
  /**
   * Phase 53 Task 2 E5：引用解析器（可选）
   * 接入后，每次调用 LLM 前会把 citeManager 收集的引用交给 resolver 解析
   * resolver 产出 injectedContext（拼到 user message 前）+ skillPrompts/macroPrompts（追加 system prompt）
   * 缺少 resolver 时 citeManager 收集的引用是死数据
   */
  private citeResolver: CiteResolver | null = null;
  /**
   * Phase 53 Task 2：宏管理器（可选）
   * 接入后，用户输入中的 `!` 触发器会被宏系统展开
   */
  private macroManager: MacroManager | null = null;
  /**
   * Phase 53 Task 9：预算监控器（可选）
   * 接入后，每次迭代结束会记录 token 消耗与工具调用，并输出告警（fail-open）
   */
  private budgetMonitor: BudgetMonitor | null = null;
  /**
   * Phase 55 Task 7：DualLoop 编排器（可选）
   * 注入后 run() 会把控制权转交给 orchestrator.run()，由双循环编排器接管
   */
  private dualLoopOrchestrator: DualLoopOrchestrator | null = null;

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

  /** 注入 Token Profiler（Phase 30：可观测性，可选，不传则零开销） */
  setProfiler(profiler: TokenProfiler | null): void {
    this.profiler = profiler;
  }

  /**
   * Phase 32 Task 1.2：注入工具结果净化器
   * 接入后，所有工具返回内容在注入 LLM 上下文前都会经过净化：
   *   1. 智能截断（超过 maxOutputChars 时优先保留错误区域）
   *   2. 注入检测（检测到 Prompt Injection 模式时添加警告前缀，不删除内容）
   *   3. 敏感字段脱敏（由 Sanitizer 内部调用 filterSensitiveFields）
   * 不传则跳过净化（向后兼容）
   */
  setSanitizer(sanitizer: ToolResultSanitizer | null): void {
    this.sanitizer = sanitizer;
  }

  /** Phase 34：注入 TraceCollector */
  setTraceCollector(trace: TraceCollector | null): void {
    this.trace = trace;
  }

  /**
   * C5 修复：注入 Steering Queue 消费者
   * 消费者回调应返回当前待交付的转向消息列表（取出后清空队列），无消息时返回 null/空数组
   * 接入后，run() 会在每次迭代开始前取出 next_iteration 模式的消息，
   * 并在 LLM 流返回后、工具执行前取出 immediate 模式的消息
   */
  setSteeringConsumer(consumer: (() => { content: string; mode: string }[] | null) | null): void {
    this.steeringConsumer = consumer;
  }

  /**
   * C6 修复：注入 HookRunner
   * 接入后，run() 会在以下时机触发钩子：
   *   - on-session-start：run() 开始时
   *   - pre-tool-call / post-tool-call：每个工具调用前后
   *   - on-session-end：run() 结束时（正常完成或取消）
   */
  setHookRunner(runner: HookRunner | null): void {
    this.hookRunner = runner;
  }

  /**
   * 任务1：注入 ComposePipeline
   * 接入后，run() 会在 Compose 模式下：
   *   1. 每次迭代注入当前阶段的 systemPromptOverride（通过 getPhasePrompt()）
   *   2. 工具执行后调用 evaluateAdvance() 检查是否应自动流转
   */
  setComposePipeline(pipeline: ComposePipeline | null): void {
    this.composePipeline = pipeline;
  }

  /**
   * 任务3：设置简洁思考约束开关
   * 开启后：追加输出纪律到系统提示词、裁剪过长工具返回、检测用户"详细"关键词临时跳过
   */
  setConciseThinking(enabled: boolean): void {
    this.conciseThinkingEnabled = enabled;
  }

  /**
   * Phase 53 Task 2：注入策略引擎
   * 接入后，onActing 中间件会调用 evaluateAction 做 fail-closed 检查
   * 传入 null 可显式卸载（用于配置热重载场景）
   */
  setPolicyEngine(engine: PolicyEngine | null): void {
    this.policyEngine = engine;
  }

  /**
   * Phase 53 Task 2：注入引用管理器
   *
   * 接入点：callLLMStream 末尾调用 extractCitationsFromText(fullContent)
   * 标记协议：LLM 在文本中输出 [cite:type:source] 标记（如 [cite:file:src/foo.ts]），
   * Loop 自动解析并 add 到 CiteManager。重复/超限/解析失败均 fail-open，不阻塞主流程。
   * 现阶段 setter 完成持有 + 自动标记提取；system prompt 引导 LLM 输出标记由调用方负责。
   */
  setCiteManager(manager: CiteManager | null): void {
    this.citeManager = manager;
  }

  /**
   * Phase 53 Task 2 E5：注入引用解析器
   *
   * 接入点：callLLMStream 开头调用 resolveCitations
   * resolver 把 citeManager 收集的引用解析为 injectedContext + skillPrompts + allowedTools
   * 缺少 resolver 时 citeManager 收集的引用是死数据
   */
  setCiteResolver(resolver: CiteResolver | null): void {
    this.citeResolver = resolver;
  }

  /**
   * Phase 53 Task 2 E5：解析 citeManager 中的引用，返回要注入的上下文
   *
   * 在 callLLMStream 开头调用，把 resolver 产出的：
   *   - injectedContext 拼到 user message 前
   *   - skillPrompts/macroPrompts 追加到 systemPrompt
   *   - allowedTools 暂不消费（预留）
   * fail-open：resolver 不可用或异常时不影响主流程
   */
  private async resolveCitations(): Promise<CiteResolution | null> {
    if (!this.citeResolver || !this.citeManager) return null;
    try {
      const items = this.citeManager.list();
      if (items.length === 0) return null;
      const resolution = await this.citeResolver.resolve({ items });
      return resolution;
    } catch (err) {
      logger.debug('resolveCitations failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Phase 53 Task 2 P2-4：从 LLM 输出文本中提取 [cite:type:source] 标记并 add 到 citeManager
   *
   * 标记格式：[cite:<type>:<source>]，type ∈ file|folder|text|skill|tool|macro|url|message
   * source 为非空字符串（不含 ] 与空白）
   * 失败处理：重复（DuplicateCiteError）/超限（CiteLimitExceededError）/格式不符 均跳过，不抛出
   */
  private extractCitationsFromText(text: string): void {
    if (!this.citeManager) return;
    // 全局正则：[cite:type:source]，type 限定为 8 种合法类型，source 不含 ] 与空白
    const CITE_PATTERN = /\[cite:(file|folder|text|skill|tool|macro|url|message):([^\]\s]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = CITE_PATTERN.exec(text)) !== null) {
      const type = match[1] as CiteType;
      const source = match[2];
      try {
        const item: CiteItem = {
          id: `cite-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          type,
          source,
          label: source,
          createdAt: Date.now(),
          origin: 'trigger',
        };
        this.citeManager.add(item);
      } catch (err) {
        // 重复/超限/格式问题：fail-open，记 debug 日志后继续
        logger.debug('CiteManager.add skipped (fail-open)', {
          type, source, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Phase 53 Task 2：注入宏管理器
   * 接入后，用户输入中的 `!` 触发器会被宏系统展开
   */
  setMacroManager(manager: MacroManager | null): void {
    this.macroManager = manager;
  }

  /**
   * Phase 53 接线修复：展开用户输入中的 !macro 触发器
   * 匹配 `!name` 形式的 token，若 MacroManager 中存在同名宏则替换为宏内容；
   * 不存在的宏保持原样（避免误吞用户输入的感叹号）。
   */
  private expandMacros(input: string): string {
    if (!this.macroManager) return input;
    // 拆分为 token，对 !xxx 形式的 token 尝试展开
    return input.replace(/!(\w+)/g, (full, name: string) => {
      const macro = this.macroManager!.getMacro(name);
      return macro ? macro.content : full;
    });
  }

  /**
   * Phase 53 Task 9：注入预算监控器
   * 接入后，每次迭代结束会记录 token 消耗与工具调用，并检查告警（fail-open）
   * 传入 null 可显式卸载（用于配置热重载场景）
   */
  setBudgetMonitor(monitor: BudgetMonitor | null): void {
    this.budgetMonitor = monitor;
  }

  /**
   * Phase 55 Task 7：注入 DualLoop 编排器
   * 接入后，run() 会把控制权转交给 orchestrator.run()（双循环接管）
   * 传入 null 可显式卸载（用于配置热重载场景）
   */
  setDualLoopOrchestrator(orchestrator: DualLoopOrchestrator | null): void {
    this.dualLoopOrchestrator = orchestrator;
  }

  /**
   * C6 修复：触发钩子（工具级/会话级）
   * 失败时记录日志但不中断主流程（钩子失败不应影响 Agent 执行）
   * @returns 钩子合并后的结果（无 hookRunner 或异常时返回 continue）
   */
  private async fireHookSafe(
    event: 'pre-tool-call' | 'post-tool-call' | 'on-session-start' | 'on-session-end',
    context: Partial<HookContext>,
  ): Promise<HookResult> {
    if (!this.hookRunner) return { action: 'continue' };
    try {
      const fullContext: HookContext = {
        stepId: context.stepId ?? `iter-${Date.now()}`,
        agentId: context.agentId ?? 'react-loop',
        projectPath: context.projectPath ?? '',
        stepResult: context.stepResult,
        error: context.error,
        toolName: context.toolName,
        toolArgs: context.toolArgs,
        toolResult: context.toolResult,
        toolDuration: context.toolDuration,
      };
      return await this.hookRunner.fire(event, fullContext);
    } catch (e) {
      logger.error('Hook execution failed, continuing', { event, error: String(e) });
      return { action: 'continue' };
    }
  }

  /**
   * C5 修复：从 Steering Queue 取出消息并注入 messages
   * @param modeFilter 筛选模式（'next_iteration' / 'immediate' / 'after_current_step'）；不传则取出全部
   * @returns 是否注入了消息
   */
  private drainSteeringIntoMessages(
    messages: LLMMessage[],
    modeFilter?: string,
  ): boolean {
    if (!this.steeringConsumer) return false;
    const drained = this.steeringConsumer();
    if (!drained || drained.length === 0) return false;
    const filtered = modeFilter
      ? drained.filter((m) => m.mode === modeFilter)
      : drained;
    if (filtered.length === 0) return false;
    for (const msg of filtered) {
      messages.push({ role: 'user', content: `[用户转向指令] ${msg.content}` });
      logger.debug('Steering message injected into messages', { mode: msg.mode });
    }
    return true;
  }

  /**
   * 修复：安全地截断 messages 窗口，保证 assistant tool_use 与对应 tool_result 成对出现。
   * 简单 splice 会在工具调用轮次中间切断，导致 OpenAI/DeepSeek 报
   * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
   */
  private trimMessagesWindow(messages: LLMMessage[], maxMessages: number): void {
    if (messages.length <= maxMessages) return;

    let removeCount = messages.length - maxMessages;

    // 1. 安全边界：截断后第一条保留消息不能是孤立的 tool_result user 消息
    // （即其对应的 assistant tool_use 已被截掉），否则继续往前删
    while (removeCount < messages.length) {
      const msg = messages[removeCount];
      if (
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        msg.content.every((p) => p.type === 'tool_result')
      ) {
        removeCount++;
        continue;
      }
      break;
    }

    messages.splice(0, removeCount);

    // 2. 截断后必须双向清理：tool_use 和 tool_result 必须成对出现
    this.sanitizeToolMessages(messages);
  }

  /**
   * 修复：双向清理 tool_use / tool_result 对偶关系。
   * OpenAI/DeepSeek 要求：
   *   - assistant 消息中的 tool_use 必须有后续对应的 tool_result
   *   - user 消息中的 tool_result 必须有前面对应的 tool_use
   * 任一方向出现孤立都会导致 400 错误。
   */
  private sanitizeToolMessages(messages: LLMMessage[]): void {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_use') toolUseIds.add(part.id);
        }
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_result') toolResultIds.add(part.toolUseId);
        }
      }
    }

    const toDelete = new Set<number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const hadToolUse = msg.content.some((p) => p.type === 'tool_use');
        msg.content = msg.content.filter((part) => {
          if (part.type !== 'tool_use') return true;
          if (toolResultIds.has(part.id)) return true;
          logger.warn('Removing orphaned tool_use without matching tool_result', { toolUseId: part.id });
          return false;
        });
        // 如果 assistant 消息原本只包含 tool_use 且全部被移除，删除整条消息
        if (hadToolUse && msg.content.length === 0) {
          toDelete.add(i);
        }
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content = msg.content.filter((part) => {
          if (part.type !== 'tool_result') return true;
          if (toolUseIds.has(part.toolUseId)) return true;
          logger.warn('Removing orphaned tool_result without matching tool_use', { toolUseId: part.toolUseId });
          return false;
        });
      }
    }

    // 倒序删除被标记的 assistant 空消息
    for (let i = messages.length - 1; i >= 0; i--) {
      if (toDelete.has(i)) {
        messages.splice(i, 1);
      }
    }
  }

  /**
   * 检查工具是否在自动批准列表中
   * 支持精确匹配和通配符 *（如 "file_*" 匹配 "file_read"、"file_search"）
   * 匹配的工具跳过用户确认，直接执行（适用于只读安全工具）
   *
   * 兜底逻辑：如果 autoApprovePatterns 为空数组（用户配置覆盖了默认值），
   * 使用 DEFAULT_REACT_CONFIG.autoApprovePatterns 作为回退，确保只读安全工具仍能自动批准
   */
  private isAutoApproved(toolName: string): boolean {
    let patterns = this.config.autoApprovePatterns ?? [];
    // 兜底：空数组时使用默认值（避免用户配置中的空数组覆盖默认值）
    if (patterns.length === 0) {
      patterns = DEFAULT_REACT_CONFIG.autoApprovePatterns;
    }
    return patterns.some((pattern) => {
      if (pattern === toolName) return true;
      // 支持通配符 *：将 * 转为正则 .*，其他字符转义
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return regex.test(toolName);
      }
      return false;
    });
  }

  /**
   * 净化工具结果——如果设置了 sanitizer 则调用，否则原样返回
   * 在 4 个工具结果注入点（并行/串行 × 结果/拒绝）统一调用
   * 任务3：简洁思考约束启用时，额外调用 trimToolResult 裁剪过长工具返回
   */
  private sanitizeToolResult(toolName: string, result: string): string {
    let processed = result;
    if (this.sanitizer) {
      try {
        const sanitized = this.sanitizer.sanitize(toolName, processed);
        if (sanitized.injectionDetected) {
          logger.warn('Injection detected in tool result, warning prefix added', {
            toolName,
            patterns: sanitized.patterns,
          });
        }
        processed = sanitized.content;
      } catch (err) {
        // 净化失败不阻断工具执行，返回原始结果
        logger.warn('ToolResultSanitizer failed, returning raw result', { toolName, error: String(err) });
      }
    }
    // 任务3：简洁思考约束——裁剪过长的工具返回（> 2000 字符时 800 首 + 标记 + 800 尾）
    // 未启用时原样返回，与 ContextCompactor L1 取两者较小裁剪结果
    processed = trimToolResult(processed, this.conciseThinkingEnabled);
    return processed;
  }

  /**
   * 运行 ReAct 循环
   * yield 出 ReActEvent 事件流
   */
  async *run(params: ReActRunParams): AsyncGenerator<ReActEvent> {
    // Phase 55 Task 7：DualLoop 编排器注入时转交控制权
    // 编排器内部负责完整的 ReAct 循环（innerAgent 执行 + outerAgent 验证）
    if (this.dualLoopOrchestrator) {
      yield* this.dualLoopOrchestrator.run(params);
      return;
    }

    const {
      userMessage,
      llmClient,
      routeDecision,
      conversationHistory,
      signal,
      onConfirmTool,
      onModelSuccess,
      onModelFailure,
    } = params;
    // Phase 38 Task 1：systemPrompt 改为 let，允许 onSystemPrompt 中间件修改
    let systemPrompt = params.systemPrompt;
    // Phase 55：systemBlocks（结构化 blocks，支持 per-block cache_control）
    // 传入时优先使用，透传到 LLM 客户端；未传时回退到 systemPrompt 字符串（向后兼容）
    let systemBlocks = params.systemBlocks;

    // C6 修复：触发 on-session-start 钩子
    await this.fireHookSafe('on-session-start', {});

    // C6 修复：确保 session 结束时触发 on-session-end（无论正常完成、取消还是错误）
    // 使用 try-finally，finally 块在 async generator return 时执行
    try {
    // Phase 38 Task 1：onSystemPrompt 中间件——允许中间件修改 systemPrompt（fail-open）
    // Phase 55：systemBlocks 模式下跳过中间件（结构化 blocks 不易在中间件中无歧义修改）
    if (this.middleware && !systemBlocks) {
      const mwCtx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt,
        metadata: {},
      };
      try {
        await this.middleware.execute('onSystemPrompt', mwCtx);
        if (typeof mwCtx.systemPrompt === 'string') {
          systemPrompt = mwCtx.systemPrompt;
        }
      } catch (mwErr) {
        logger.warn('Middleware onSystemPrompt threw, continuing (fail-open)', { error: String(mwErr) });
      }
    }

    // 任务3：简洁思考约束——用户未请求详细输出时，追加输出纪律到系统提示词
    // Phase 55：systemBlocks 模式下追加为独立 block（不缓存，每次都可能变化）
    if (this.conciseThinkingEnabled && !shouldSkipConcise(userMessage)) {
      if (systemBlocks) {
        systemBlocks = [...systemBlocks, { type: 'text', text: CONCISE_THINKING_BLOCK }];
      } else {
        systemPrompt = (systemPrompt ?? '') + '\n\n' + CONCISE_THINKING_BLOCK;
      }
    }

    // 构建初始消息列表
    const messages: LLMMessage[] = [];

    // 对话历史（不包含 system prompt，system prompt 通过 options 传入）
    messages.push(...conversationHistory);

    // 修复：进入循环前清理历史消息中可能存在的孤立 tool_use/tool_result，
    // 避免上游传入的 conversationHistory 已破坏对偶关系
    this.sanitizeToolMessages(messages);

    // 当前用户消息
    // Phase 53 接线修复：原 setMacroManager 注入但 run() 从不消费，导致 !macro 触发器失效。
    // 现在展开用户输入中的 !macroname 触发器为对应宏内容（macroname 取首个空白前的 token）。
    const effectiveUserMessage = this.macroManager
      ? this.expandMacros(userMessage)
      : userMessage;
    messages.push({ role: 'user', content: effectiveUserMessage });

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
        const cancelError: ReActEvent = { type: 'error', error: '用户取消了执行' };
        yield cancelError;
        this.trace?.recordEvent(cancelError);
        const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
        yield doneEvent;
        this.trace?.recordEvent(doneEvent);
        return;
      }

      // C5 修复：迭代开始前取出 next_iteration 模式的转向消息
      this.drainSteeringIntoMessages(messages, 'next_iteration');

      iteration++;

      logger.debug('ReAct iteration', {
        iteration,
        maxIterations: this.config.maxIterations,
        messageCount: messages.length,
      });

      // yield thinking 事件
      const thinkingEvent: ReActEvent = {
        type: 'thinking',
        message: `模型思考中... (${routeDecision.model.id}, 迭代 ${iteration})`,
      };
      yield thinkingEvent;
      this.trace?.recordEvent(thinkingEvent);

      // 任务1：每次迭代重新注入 Compose 阶段提示词（阶段可能在上一轮工具执行后已流转）
      // Phase 55：systemBlocks 模式下追加为独立 block（不缓存）
      let effectiveSystemPrompt = systemPrompt;
      let effectiveSystemBlocks = systemBlocks;
      if (this.composePipeline) {
        const phasePrompt = this.composePipeline.getPhasePrompt();
        if (phasePrompt) {
          if (effectiveSystemBlocks) {
            effectiveSystemBlocks = [...effectiveSystemBlocks, { type: 'text', text: phasePrompt }];
          } else {
            effectiveSystemPrompt = (effectiveSystemPrompt ?? '') + '\n\n' + phasePrompt;
          }
        }
      }

      // Phase 30：Token Profiling（在 LLM 调用前生成快照）
      if (this.profiler) {
        const snapshot = this.profiler.profile({
          systemPrompt: effectiveSystemPrompt,
          messages,
          tools: toolDefs,
          userMessage,
          iterationIndex: iteration - 1,
          modelId: routeDecision.model.id,
          routeDecision: routeDecision.originalTier,
        });
        yield { type: 'token_profile', snapshot };
      }

      try {
        // ===== LLM 流式调用 =====
        // Phase 32 Task 2：透传 enableCache（由 ModelRouter 全局启用）
        // Phase 55：透传 effectiveSystemBlocks（若有），LLM 客户端优先使用 blocks 否则回退 systemPrompt
        let result: LLMStreamResult;
        try {
          result = yield* this.callLLMStream(
            llmClient,
            routeDecision.model.id,
            messages,
            effectiveSystemPrompt,
            effectiveSystemBlocks,
            toolDefs,
            signal,
            routeDecision.enableCache,
          );
        } catch (error) {
          onModelFailure?.(routeDecision.model.id, error);
          throw error;
        }
        onModelSuccess?.(routeDecision.model.id);

        // C7 修复：流返回后立即检查取消信号
        // callLLMStream 在 signal.aborted 时会 break 并返回已累积的 toolCalls，
        // 若不在此处再次检查，run() 会继续执行这些本不应执行的工具调用
        if (signal?.aborted) {
          const cancelError: ReActEvent = { type: 'error', error: '用户取消了执行（流返回后）' };
          yield cancelError;
          this.trace?.recordEvent(cancelError);
          const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
          yield doneEvent;
          this.trace?.recordEvent(doneEvent);
          return;
        }

        // 累加 usage
        totalUsage.inputTokens += result.usage.inputTokens;
        totalUsage.outputTokens += result.usage.outputTokens;
        totalUsage.totalTokens += result.usage.totalTokens;

        // Phase 34：记录 LLM 调用 span
        this.trace?.recordLLMCall(
          routeDecision.model.id,
          result.usage,
          result.content.length,
          result.toolCalls.length,
        );

        consecutiveErrors = 0; // 成功，重置错误计数
        finalContent = result.content;

        // Phase 38 Task 1：onReasoning 中间件——LLM 返回后检查（循环检测、reasoning 过滤，fail-open）
        if (this.middleware) {
          const mwCtx: MiddlewareContext = {
            phase: 'onReasoning',
            messages,
            metadata: {
              // 把本轮工具调用传给中间件（LoopDetectionMiddleware 据此检测循环）
              toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
              iteration,
              content: result.content,
            },
          };
          try {
            await this.middleware.execute('onReasoning', mwCtx);
            // 循环检测：若中间件设置 loopDetected，向 messages 注入提示
            if (mwCtx.metadata.loopDetected) {
              const suggestion = String(mwCtx.metadata.loopBreakSuggestion ?? '检测到工具调用循环，请换一种方法。');
              messages.push({ role: 'user', content: `[系统提示] ${suggestion}` });
              logger.warn('Loop detected by middleware, injecting break suggestion', { iteration, suggestion });
            }
          } catch (mwErr) {
            logger.warn('Middleware onReasoning threw, continuing (fail-open)', { error: String(mwErr) });
          }
        }

        // C5 修复：LLM 流返回后、工具执行前，取出 immediate 模式的转向消息
        // immediate 消息会作为新的 user 消息加入上下文，但不阻止当前工具调用
        // （工具调用已由 LLM 决定，转向消息影响下一轮迭代）
        this.drainSteeringIntoMessages(messages, 'immediate');

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
          // P2-12：支持并行工具执行（parallelToolExecution 配置项）
          if (this.config.parallelToolExecution && result.toolCalls.length > 1) {
            // ===== 并行模式 =====
            // 阶段1：串行确认 + 中间件检查 + ask_user 串行处理（需要 yield 事件，必须串行）
            const approvedCalls: typeof result.toolCalls = [];
            for (const toolCall of result.toolCalls) {
              yield {
                type: 'tool_call_start',
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                args: toolCall.arguments,
              };

              // 确认：先检查 autoApprovePatterns，匹配则跳过用户确认
              let approved = true;
              let confirmPayload: unknown;
              if (onConfirmTool && !this.isAutoApproved(toolCall.name)) {
                yield {
                  type: 'approval_required',
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  args: toolCall.arguments,
                  reason: '需要确认工具调用',
                };
                const confirmResult = await onConfirmTool(toolCall.name, toolCall.arguments);
                if (typeof confirmResult === 'boolean') {
                  approved = confirmResult;
                } else {
                  approved = confirmResult.approved;
                  confirmPayload = confirmResult.payload;
                }
              }

              if (!approved) {
                const toolResult = this.sanitizeToolResult(toolCall.name, `[用户拒绝了此工具调用] ${toolCall.name}`);
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

              // I18 修复：ask_user 工具需要用户交互，必须在并行模式下串行处理
              // ask_user 依赖 confirmPayload（来自 onConfirmTool 回调），并行执行会导致用户交互混乱
              if (toolCall.name === 'ask_user') {
                // C6 修复/I16 修复：并行模式下 ask_user 也触发 pre-tool-call 钩子
                const askUserPreHook = await this.fireHookSafe('pre-tool-call', {
                  stepId: toolCall.id,
                  toolName: toolCall.name,
                  toolArgs: toolCall.arguments,
                });
                let askUserResult: string;
                let askUserIsError: boolean;
                if (askUserPreHook.action === 'deny') {
                  const denyReason = askUserPreHook.reason ?? '工具调用被钩子拒绝';
                  askUserResult = this.sanitizeToolResult(toolCall.name, `[工具被拒绝] ${denyReason}`);
                  askUserIsError = true;
                } else {
                  askUserResult = this.sanitizeToolResult(toolCall.name, JSON.stringify(confirmPayload ?? {}, null, 2));
                  askUserIsError = false;
                }
                // I16 修复：触发 post-tool-call 钩子
                await this.fireHookSafe('post-tool-call', {
                  stepId: toolCall.id,
                  toolName: toolCall.name,
                  toolArgs: toolCall.arguments,
                  toolResult: askUserResult,
                  toolDuration: 0,
                });
                yield {
                  type: 'tool_call_result',
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  result: askUserResult,
                  isError: askUserIsError,
                };
                messages.push({
                  role: 'user',
                  content: [{
                    type: 'tool_result' as const,
                    toolUseId: toolCall.id,
                    content: askUserResult,
                    isError: askUserIsError,
                  }],
                });
                continue;
              }

              // 中间件检查
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
                  // 安全修复：中间件异常时 fail-closed，拒绝工具执行
                  // 原行为仅 warn 后继续执行工具，权限检查被静默跳过
                  logger.warn('Middleware onActing threw, denying tool execution (fail-closed)', { error: String(mwErr) });
                  mwCtx.metadata.permissionDenied = `中间件异常: ${String(mwErr)}`;
                }
                // Phase 53 Task 3：策略引擎检查（动作级 fail-closed）
                // 与中间件叠加：中间件已 deny 则跳过策略引擎；否则策略引擎再评估
                if (!mwCtx.metadata.permissionDenied && this.policyEngine) {
                  try {
                    const policyDecision = this.policyEngine.evaluateAction({
                      toolName: toolCall.name,
                      description: toolCall.name,
                      args: toolCall.arguments,
                    });
                    if (policyDecision.denied) {
                      mwCtx.metadata.permissionDenied = policyDecision.reason ?? '策略引擎拒绝';
                    }
                  } catch (policyErr) {
                    // 策略引擎异常时 fail-closed（借鉴 AGT）
                    logger.warn('PolicyEngine evaluateAction threw, denying (fail-closed)', { error: String(policyErr) });
                    mwCtx.metadata.permissionDenied = `策略引擎异常: ${String(policyErr)}`;
                  }
                }
                if (mwCtx.metadata.permissionDenied) {
                  const denyReason = String(mwCtx.metadata.permissionDenied);
                  const toolResult = this.sanitizeToolResult(toolCall.name, `[被拦截] ${denyReason}`);
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
              }

              // I16 修复：并行模式下触发 pre-tool-call 钩子（与串行模式一致）
              const preToolHookResult = await this.fireHookSafe('pre-tool-call', {
                stepId: toolCall.id,
                toolName: toolCall.name,
                toolArgs: toolCall.arguments,
              });
              // deny 语义：钩子拒绝该工具调用，不加入并行执行队列
              if (preToolHookResult.action === 'deny') {
                const denyReason = preToolHookResult.reason ?? '工具调用被钩子拒绝';
                logger.info('Pre-tool-call hook denied tool execution (parallel)', {
                  toolName: toolCall.name,
                  stepId: toolCall.id,
                  reason: denyReason,
                });
                const toolResult = this.sanitizeToolResult(toolCall.name, `[工具被拒绝] ${denyReason}`);
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

              approvedCalls.push(toolCall);
            }

            // 阶段2：并行执行所有已批准的工具
            if (approvedCalls.length > 0) {
              // P1-5 修复：优先使用结构化执行，避免正则匹配判断 isError
              const useStructured = typeof this.toolExecutor.executeToolStructured === 'function';
              // C8 修复：用 allSettled 隔离单个工具异常，避免丢失全部结果
              const toolStartTimes = approvedCalls.map(() => Date.now());
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
                // Phase 32 Task 1.2：净化工具结果（注入检测 + 智能截断 + 敏感字段脱敏）
                const toolResult = this.sanitizeToolResult(tc.name, execResult.output);
                const isError = execResult.isError;
                const toolDuration = Date.now() - toolStartTimes[i];

                // I16 修复：并行模式下触发 post-tool-call 钩子（与串行模式一致）
                await this.fireHookSafe('post-tool-call', {
                  stepId: tc.id,
                  toolName: tc.name,
                  toolArgs: tc.arguments,
                  toolResult,
                  toolDuration,
                });

                yield {
                  type: 'tool_call_result',
                  toolName: tc.name,
                  toolCallId: tc.id,
                  result: toolResult,
                  isError,
                };

                messages.push({
                  role: 'user',
                  content: [{
                    type: 'tool_result' as const,
                    toolUseId: tc.id,
                    content: toolResult,
                    isError,
                  }],
                });

                // 任务1：Compose 管线自动流转评估（并行模式下每个工具结果后调用）
                if (this.composePipeline) {
                  const toolResultForAdvance: ToolResult = {
                    success: !isError,
                    output: toolResult,
                    durationMs: toolDuration,
                    error: isError ? toolResult : undefined,
                  };
                  this.composePipeline.evaluateAdvance(toolResultForAdvance);
                }
              }
            }
          } else {
            // ===== 串行模式（保持原有逻辑） =====
            for (const toolCall of result.toolCalls) {
              yield {
                type: 'tool_call_start',
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                args: toolCall.arguments,
              };

              // Phase 9：自主模式下，如果提供了 onConfirmTool，暂停等待用户确认
              // 但 autoApprovePatterns 匹配的工具跳过确认
              let approved = true;
              let confirmPayload: unknown;
              if (onConfirmTool && !this.isAutoApproved(toolCall.name)) {
                yield {
                  type: 'approval_required',
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  args: toolCall.arguments,
                  reason: '需要确认工具调用',
                };
                const confirmResult = await onConfirmTool(toolCall.name, toolCall.arguments);
                if (typeof confirmResult === 'boolean') {
                  approved = confirmResult;
                } else {
                  approved = confirmResult.approved;
                  confirmPayload = confirmResult.payload;
                }
              }

              if (!approved) {
                // 用户拒绝：注入拒绝信息作为工具结果
                const toolResult = this.sanitizeToolResult(toolCall.name, `[用户拒绝了此工具调用] ${toolCall.name}`);
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

              if (toolCall.name === 'ask_user') {
                const toolResult = this.sanitizeToolResult(toolCall.name, JSON.stringify(confirmPayload ?? {}, null, 2));
                yield {
                  type: 'tool_call_result',
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  result: toolResult,
                  isError: false,
                };
                messages.push({
                  role: 'user',
                  content: [{
                    type: 'tool_result' as const,
                    toolUseId: toolCall.id,
                    content: toolResult,
                    isError: false,
                  }],
                });
                continue;
              }

              // Phase 22：工具执行前调用 onActing 中间件（Hook 插件接入点）
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
                  // 安全修复：中间件异常时 fail-closed，拒绝工具执行
                  logger.warn('Middleware onActing threw, denying tool execution (fail-closed)', { error: String(mwErr) });
                  mwCtx.metadata.permissionDenied = `中间件异常: ${String(mwErr)}`;
                }
                // 中间件设置了 permissionDenied → 不执行工具，返回错误结果
                if (mwCtx.metadata.permissionDenied) {
                  const denyReason = String(mwCtx.metadata.permissionDenied);
                  const toolResult = this.sanitizeToolResult(toolCall.name, `[被拦截] ${denyReason}`);
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
              }

              // P1-5 修复：优先使用结构化执行，避免正则匹配判断 isError
              const useStructured = typeof this.toolExecutor.executeToolStructured === 'function';
              let toolResult: string;
              let isError: boolean;

              // C6 修复：触发 pre-tool-call 钩子
              const preToolHookResult = await this.fireHookSafe('pre-tool-call', {
                stepId: toolCall.id,
                toolName: toolCall.name,
                toolArgs: toolCall.arguments,
              });

              // deny 语义（借鉴 Open Interpreter）：钩子拒绝单次工具调用，跳过执行
              // 将拒绝原因作为工具结果返回给 LLM，LLM 可自主调整策略
              if (preToolHookResult.action === 'deny') {
                const denyReason = preToolHookResult.reason ?? '工具调用被钩子拒绝';
                logger.info('Pre-tool-call hook denied tool execution', {
                  toolName: toolCall.name,
                  stepId: toolCall.id,
                  reason: denyReason,
                });
                toolResult = this.sanitizeToolResult(toolCall.name, `[工具被拒绝] ${denyReason}`);
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

              const toolStartTime = Date.now();
              if (useStructured) {
                const structured = await this.toolExecutor.executeToolStructured!(
                  toolCall.name,
                  toolCall.id,
                  toolCall.arguments,
                );
                toolResult = structured.output;
                isError = structured.isError;
              } else {
                toolResult = await this.toolExecutor.executeTool(
                  toolCall.name,
                  toolCall.id,
                  toolCall.arguments,
                );
                // 降级：仅匹配结构化错误标记，不匹配正常输出中的关键词
                isError = /\[工具错误\]|\[被拦截\]/.test(toolResult);
              }
              const toolDuration = Date.now() - toolStartTime;

              // Phase 32 Task 1.2：净化工具结果（注入检测 + 智能截断 + 敏感字段脱敏）
              toolResult = this.sanitizeToolResult(toolCall.name, toolResult);

              // C6 修复：触发 post-tool-call 钩子
              await this.fireHookSafe('post-tool-call', {
                stepId: toolCall.id,
                toolName: toolCall.name,
                toolArgs: toolCall.arguments,
                toolResult,
                toolDuration,
              });

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

              // 任务1：Compose 管线自动流转评估（每次工具执行后调用）
              if (this.composePipeline) {
                const toolResultForAdvance: ToolResult = {
                  success: !isError,
                  output: toolResult,
                  durationMs: toolDuration,
                  error: isError ? toolResult : undefined,
                };
                this.composePipeline.evaluateAdvance(toolResultForAdvance);
              }
            }
          }

          // C7 修复：messages 窗口策略——保留最近 N 条消息，避免无界增长
          // 保留策略：保留 system + 最近 40 条消息（约 20 轮对话）
          // 修复：截断时必须保证 assistant tool_use 与对应 tool_result 成对出现，
          // 否则 OpenAI/DeepSeek 会报 "Messages with role 'tool' must be a response..."
          const MAX_MESSAGES = 40;
          this.trimMessagesWindow(messages, MAX_MESSAGES);

          // Phase 53 Task 9：预算监控（每次迭代结束后检查本轮工具调用与 token 消耗，fail-open）
          // 记录本轮 token 消耗 + 所有工具调用，然后检查告警（同 alertId 不重复返回）
          if (this.budgetMonitor) {
            try {
              // 记录本轮 token 消耗
              this.budgetMonitor.recordToken(result.usage.totalTokens);
              // 记录本轮所有工具调用（用于循环检测与 scope_creep 检测）
              for (const tc of result.toolCalls) {
                this.budgetMonitor.recordToolCall(tc.name);
              }
              // 检查并输出告警
              const alerts = this.budgetMonitor.check();
              for (const a of alerts) {
                logger.warn('BudgetMonitor alert', {
                  type: a.type,
                  severity: a.severity,
                  message: a.message,
                  current: a.current,
                  threshold: a.threshold,
                });
              }
            } catch (budgetErr) {
              // fail-open：监控异常不影响主流程
              logger.warn('BudgetMonitor check failed, continuing (fail-open)', {
                error: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
              });
            }
          }

          // Phase 38 Task 1：onAgent 中间件——每次迭代结束后调用（会话级 Token 累计、进度报告，fail-open）
          if (this.middleware) {
            const mwCtx: MiddlewareContext = {
              phase: 'onAgent',
              messages,
              metadata: {
                iteration,
                totalUsage,
                toolCallCount: result.toolCalls.length,
              },
            };
            try {
              await this.middleware.execute('onAgent', mwCtx);
            } catch (mwErr) {
              logger.warn('Middleware onAgent threw, continuing (fail-open)', { error: String(mwErr) });
            }
          }

          // 继续循环——LLM 会根据工具结果生成下一轮回复
          continue;
        }

        // ----- 无工具调用，文本回复 → 循环结束 -----
        // 任务1：Compose 模式下，检查 LLM 文本回复是否触发阶段自动流转
        // 阶段提示词要求 LLM "完成后用文本回复'XX完成'"，此时 evaluateAdvance 会推进阶段
        if (this.composePipeline) {
          const llmResultForAdvance: ToolResult = {
            success: true,
            output: result.content,
            durationMs: 0,
          };
          const advanced = this.composePipeline.evaluateAdvance(llmResultForAdvance);
          if (advanced) {
            // 阶段已推进，将 LLM 回复加入上下文后继续循环（下一阶段提示词在下次迭代注入）
            messages.push({ role: 'assistant', content: result.content });
            continue;
          }
        }

        const finalDone: ReActEvent = {
          type: 'done',
          content: result.content,
          usage: totalUsage,
        };
        yield finalDone;
        this.trace?.recordEvent(finalDone);
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
          const errorEvent: ReActEvent = {
            type: 'error',
            error: `连续 ${consecutiveErrors} 次错误，终止执行。最后错误: ${errorMessage}`,
            usage: totalUsage,
          };
          yield errorEvent;
          this.trace?.recordEvent(errorEvent);
          const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
          yield doneEvent;
          this.trace?.recordEvent(doneEvent);
          return;
        }

        // I17 修复：错误重试消息膨胀——只保留最后一条错误消息
        // 原行为：每次出错都 push 一条 [系统错误] 消息，连续重试时上下文中累积大量错误消息
        // 修复：push 新错误前，移除上一条错误上下文消息，避免消息膨胀
        const ERROR_CONTEXT_PREFIX = '[系统错误]';
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith(ERROR_CONTEXT_PREFIX)) {
            messages.splice(i, 1);
            break; // 只移除最近一条，避免误删
          }
        }
        // 将错误注入上下文，让 LLM 知道发生了什么
        const errorContext = `[系统错误] 上一次调用出错: ${errorMessage}。请直接用文本回复用户，不要尝试调用工具。`;
        messages.push({ role: 'user', content: errorContext });

        const retryError: ReActEvent = {
          type: 'error',
          error: `迭代 ${iteration} 出错: ${errorMessage}，正在重试...`,
        };
        yield retryError;
        this.trace?.recordEvent(retryError);
      }
    }

    // 达到最大迭代次数
    const maxIterError: ReActEvent = {
      type: 'error',
      error: `达到最大迭代次数 (${this.config.maxIterations})，终止执行`,
      usage: totalUsage,
    };
    yield maxIterError;
    this.trace?.recordEvent(maxIterError);
    const doneEvent: ReActEvent = { type: 'done', content: finalContent, usage: totalUsage };
    yield doneEvent;
    this.trace?.recordEvent(doneEvent);
    } finally {
      // C6 修复：确保 session 结束时触发 on-session-end
      await this.fireHookSafe('on-session-end', {});
    }
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
    systemBlocks: SystemBlock[] | undefined,
    toolDefs: LLMToolDefinition[],
    signal?: AbortSignal,
    enableCache?: boolean,
  ): AsyncGenerator<ReActEvent, LLMStreamResult> {
    let fullContent = '';
    const toolCalls: ToolCallRequest[] = [];
    let usage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // 修复：最终防线——发送给 LLM 前再次确保 tool_use/tool_result 成对
    this.sanitizeToolMessages(messages);

    // Phase 53 Task 2 E5：引用解析——把 citeManager 收集的引用交给 resolver 解析
    // resolver 产出 injectedContext（拼到 user message 前）+ skillPrompts/macroPrompts（追加 system prompt）
    // fail-open，resolver 不可用或异常时不影响主流程
    const citeResolution = await this.resolveCitations();
    if (citeResolution) {
      // 拼接 injectedContext 到最后一条 user message 前
      if (citeResolution.injectedContext) {
        const lastUserIdx = messages.length - 1;
        if (lastUserIdx >= 0 && messages[lastUserIdx].role === 'user') {
          messages = [...messages];
          messages[lastUserIdx] = {
            ...messages[lastUserIdx],
            content: `${citeResolution.injectedContext}\n\n${messages[lastUserIdx].content}`,
          };
        }
      }
      // 追加 skill/macro prompts 到 systemPrompt
      const extraPrompts = [
        ...citeResolution.skillPrompts,
        ...citeResolution.macroPrompts,
      ].filter(Boolean);
      if (extraPrompts.length > 0) {
        const extraStr = extraPrompts.join('\n\n');
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n---\n${extraStr}` : extraStr;
      }
    }

    const options: LLMRequestOptions = {
      model: modelId,
      messages,
      systemPrompt,
      // Phase 55：透传 systemBlocks（结构化 blocks），LLM 客户端优先使用，未传时回退 systemPrompt
      systemBlocks,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: 4096,
      timeoutMs: this.config.llmTimeout,
      stream: true,
      // Phase 32 Task 2：透传 enableCache（Anthropic 用 cache_control，OpenAI 用 prompt_cache_key）
      enableCache,
    };

    // Phase 38 Task 1：onModelCall 中间件——LLM API 调用前（缓存/日志/预算检查，fail-open）
    if (this.middleware) {
      const mwCtx: MiddlewareContext = {
        phase: 'onModelCall',
        messages,
        systemPrompt,
        toolDefinitions: toolDefs,
        metadata: { modelId, options },
      };
      try {
        await this.middleware.execute('onModelCall', mwCtx);
      } catch (mwErr) {
        logger.warn('Middleware onModelCall threw, continuing (fail-open)', { error: String(mwErr) });
      }
    }

    const stream = client.stream(options);

    // 工具调用参数累积缓冲
    // M3：__argsBuffer 为临时字段，用于累积 JSON 片段，end/done 时解析后删除
    const toolCallBuffers = new Map<string, { id: string; name: string; arguments: Record<string, unknown>; __argsBuffer?: string }>();
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

        case 'reasoning_delta':
          yield { type: 'reasoning_delta', text: event.text };
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
          // flush 所有未收到 tool_call_end 的 buffer，避免静默丢失工具调用
          this.flushToolCallBuffers(toolCallBuffers, toolCalls);
          break;
      }
    }

    // M1 修复：取消信号中断流时，flush 所有未收到 tool_call_end 的 buffer
    // 原行为：signal.aborted break 后直接 return，已收到 tool_call_start 但未收到
    // tool_call_end 的工具调用参数被丢弃，导致返回的 toolCalls 缺失或不完整
    // 修复：与 done 事件一样 flush buffers，保证已接收的参数片段不丢失
    if (signal?.aborted) {
      this.flushToolCallBuffers(toolCallBuffers, toolCalls);
    }

    // Phase 53 Task 2 P2-4：单轮 LLM 回复完成后，从 fullContent 中提取 [cite:type:source] 标记
    // 注入 citeManager。标记协议让 LLM 主动声明引用源，UI 层可显示"本次回复引用了哪些来源"
    if (this.citeManager) {
      try {
        this.extractCitationsFromText(fullContent);
      } catch (err) {
        // fail-open：标记提取失败不影响主流程
        logger.debug('extractCitationsFromText failed (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 返回（AsyncGenerator return value）
    return { content: fullContent, toolCalls, usage };
  }

  /**
   * M1 修复：flush 工具调用缓冲区，将未收到 tool_call_end 的 buffer 解析并加入 toolCalls
   * 被 done 事件和 abort 中断后共用，保证工具参数完整性
   */
  private flushToolCallBuffers(
    toolCallBuffers: Map<string, { id: string; name: string; arguments: Record<string, unknown>; __argsBuffer?: string }>,
    toolCalls: ToolCallRequest[],
  ): void {
    for (const [id, buffer] of toolCallBuffers) {
      if (!toolCalls.some((tc) => tc.id === id)) {
        const argsBuffer = (buffer as Record<string, unknown>).__argsBuffer;
        if (typeof argsBuffer === 'string' && argsBuffer.trim()) {
          try {
            buffer.arguments = JSON.parse(argsBuffer);
          } catch {
            buffer.arguments = {};
          }
        }
        delete (buffer as Record<string, unknown>).__argsBuffer;
        toolCalls.push({ id: buffer.id, name: buffer.name, arguments: buffer.arguments });
      }
    }
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

// src/agent/middleware-runner.ts
// 中间件调度器——从 loop.ts 抽取的中间件/钩子/策略引擎相关职责
// 负责：中间件注册与执行、Hook 触发、策略引擎检查、工具自动批准检查

import type { LLMMessage, LLMToolDefinition, LLMRequestOptions, ToolCallRequest } from '../router/types.js';
import type { ReActConfig } from './loop-config.js';
import { DEFAULT_REACT_CONFIG } from './loop-config.js';
import { logger } from '../utils/logger.js';
import type { AgentMiddlewarePipeline, MiddlewareContext } from './middleware.js';
import type { HookRunner, HookContext, HookResult } from './hooks.js';
import type { PolicyEngine } from '../policies/policy-engine.js';

/** onReasoning 中间件执行结果 */
export interface ReasoningResult {
  loopDetected: boolean;
  suggestion?: string;
}

/** onActing 中间件执行结果 */
export interface ActingResult {
  denied: boolean;
  reason?: string;
}

/**
 * 中间件调度器
 *
 * 从 ReActAgentLoop 抽取的中间件调度职责：
 * - 六阶段中间件执行（onSystemPrompt / onUserMessage / onReasoning / onActing / onAgent / onModelCall）
 * - Hook 生命周期触发（pre/post-tool-call / on-session-start/end）
 * - 策略引擎动作评估（fail-closed）
 * - 工具自动批准模式匹配
 *
 * 所有中间件执行均 fail-open（异常不中断主流程），
 * 但 onActing 阶段的中间件异常和策略引擎异常为 fail-closed（拒绝工具执行）。
 */
export class MiddlewareRunner {
  private middleware: AgentMiddlewarePipeline | null = null;
  private policyEngine: PolicyEngine | null = null;
  private hookRunner: HookRunner | null = null;

  // ===== Setters =====

  /** 注入中间件管线 */
  setPipeline(pipeline: AgentMiddlewarePipeline): void {
    this.middleware = pipeline;
  }

  /** 注入策略引擎 */
  setPolicyEngine(engine: PolicyEngine | null): void {
    this.policyEngine = engine;
  }

  /** 注入 HookRunner */
  setHookRunner(runner: HookRunner | null): void {
    this.hookRunner = runner;
  }

  // ===== Getters =====

  get hasMiddleware(): boolean {
    return this.middleware !== null;
  }

  // ===== 工具自动批准检查 =====

  /**
   * 检查工具是否在自动批准列表中
   * 支持精确匹配和通配符 *（如 "file_*" 匹配 "file_read"、"file_search"）
   * 匹配的工具跳过用户确认，直接执行（适用于只读安全工具）
   *
   * 兜底逻辑：如果 autoApprovePatterns 为空数组（用户配置覆盖了默认值），
   * 使用 DEFAULT_REACT_CONFIG.autoApprovePatterns 作为回退，确保只读安全工具仍能自动批准
   */
  isAutoApproved(toolName: string, autoApprovePatterns: string[]): boolean {
    let patterns = autoApprovePatterns;
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

  // ===== Hook 触发 =====

  /**
   * 触发钩子（工具级/会话级）
   * 失败时记录日志但不中断主流程（钩子失败不应影响 Agent 执行）
   * @returns 钩子合并后的结果（无 hookRunner 或异常时返回 continue）
   */
  async fireHookSafe(
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

  // ===== 六阶段中间件执行 =====

  /**
   * onSystemPrompt 中间件——允许中间件修改 systemPrompt（fail-open）
   * Phase 55：systemBlocks 模式下跳过中间件（结构化 blocks 不易在中间件中无歧义修改）
   * @returns 中间件可能修改后的 systemPrompt
   */
  async runOnSystemPrompt(systemPrompt: string | undefined): Promise<string | undefined> {
    if (!this.middleware) return systemPrompt;
    const mwCtx: MiddlewareContext = {
      phase: 'onSystemPrompt',
      systemPrompt,
      metadata: {},
    };
    try {
      await this.middleware.execute('onSystemPrompt', mwCtx);
      if (typeof mwCtx.systemPrompt === 'string') {
        return mwCtx.systemPrompt;
      }
    } catch (mwErr) {
      logger.warn('Middleware onSystemPrompt threw, continuing (fail-open)', { error: String(mwErr) });
    }
    return systemPrompt;
  }

  /**
   * onUserMessage 中间件——@-mention 解析等用户消息预处理（fail-open）
   * 中间件可读取 ctx.metadata.userMessage，解析 @-mention 后写回标准化消息
   * @returns 中间件可能修改后的用户消息
   */
  async runOnUserMessage(userMessage: string): Promise<string> {
    if (!this.middleware) return userMessage;
    const mwCtx: MiddlewareContext = {
      phase: 'onUserMessage',
      metadata: { userMessage },
    };
    try {
      await this.middleware.execute('onUserMessage', mwCtx);
      if (typeof mwCtx.metadata.userMessage === 'string') {
        return mwCtx.metadata.userMessage;
      }
    } catch (mwErr) {
      logger.warn('Middleware onUserMessage threw, continuing (fail-open)', { error: String(mwErr) });
    }
    return userMessage;
  }

  /**
   * onReasoning 中间件——LLM 返回后检查（循环检测、reasoning 过滤，fail-open）
   * 循环检测：若中间件设置 loopDetected，返回 { loopDetected: true, suggestion }
   * @returns 循环检测结果（未检测到时 loopDetected 为 false）
   */
  async runOnReasoning(
    messages: LLMMessage[],
    toolCalls: ToolCallRequest[],
    iteration: number,
    content: string,
  ): Promise<ReasoningResult> {
    if (!this.middleware) return { loopDetected: false };
    const mwCtx: MiddlewareContext = {
      phase: 'onReasoning',
      messages,
      metadata: {
        toolCalls: toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
        iteration,
        content,
      },
    };
    try {
      await this.middleware.execute('onReasoning', mwCtx);
      if (mwCtx.metadata.loopDetected) {
        const suggestion = String(mwCtx.metadata.loopBreakSuggestion ?? '检测到工具调用循环，请换一种方法。');
        logger.warn('Loop detected by middleware, injecting break suggestion', { iteration, suggestion });
        return { loopDetected: true, suggestion };
      }
    } catch (mwErr) {
      logger.warn('Middleware onReasoning threw, continuing (fail-open)', { error: String(mwErr) });
    }
    return { loopDetected: false };
  }

  /**
   * onActing 中间件 + 策略引擎检查——工具执行前的权限校验（fail-closed）
   *
   * 安全修复：中间件异常时 fail-closed，拒绝工具执行
   * Phase 53 Task 3：策略引擎检查（动作级 fail-closed）
   * 与中间件叠加：中间件已 deny 则跳过策略引擎；否则策略引擎再评估
   *
   * @returns { denied: true, reason } 表示拒绝执行；{ denied: false } 表示允许
   */
  async runOnActing(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<ActingResult> {
    if (!this.middleware) return { denied: false };
    const mwCtx: MiddlewareContext = {
      phase: 'onActing',
      toolName,
      toolArgs,
      metadata: {},
    };
    try {
      await this.middleware.execute('onActing', mwCtx);
    } catch (mwErr) {
      // 安全修复：中间件异常时 fail-closed，拒绝工具执行
      logger.warn('Middleware onActing threw, denying tool execution (fail-closed)', { error: String(mwErr) });
      mwCtx.metadata.permissionDenied = `中间件异常: ${String(mwErr)}`;
    }
    // Phase 53 Task 3：策略引擎检查（动作级 fail-closed）
    // 与中间件叠加：中间件已 deny 则跳过策略引擎；否则策略引擎再评估
    if (!mwCtx.metadata.permissionDenied && this.policyEngine) {
      try {
        const policyDecision = this.policyEngine.evaluateAction({
          toolName,
          description: toolName,
          args: toolArgs,
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
      return { denied: true, reason: String(mwCtx.metadata.permissionDenied) };
    }
    return { denied: false };
  }

  /**
   * onAgent 中间件——每次迭代结束后调用（会话级 Token 累计、进度报告，fail-open）
   */
  async runOnAgent(
    messages: LLMMessage[],
    iteration: number,
    totalUsage: import('../router/types.js').TokenUsageInfo,
    toolCallCount: number,
  ): Promise<void> {
    if (!this.middleware) return;
    const mwCtx: MiddlewareContext = {
      phase: 'onAgent',
      messages,
      metadata: { iteration, totalUsage, toolCallCount },
    };
    try {
      await this.middleware.execute('onAgent', mwCtx);
    } catch (mwErr) {
      logger.warn('Middleware onAgent threw, continuing (fail-open)', { error: String(mwErr) });
    }
  }

  /**
   * onModelCall 中间件——LLM API 调用前（缓存/日志/预算检查，fail-open）
   */
  async runOnModelCall(
    messages: LLMMessage[],
    systemPrompt: string | undefined,
    toolDefinitions: LLMToolDefinition[],
    modelId: string,
    options: LLMRequestOptions,
  ): Promise<void> {
    if (!this.middleware) return;
    const mwCtx: MiddlewareContext = {
      phase: 'onModelCall',
      messages,
      systemPrompt,
      toolDefinitions,
      metadata: { modelId, options },
    };
    try {
      await this.middleware.execute('onModelCall', mwCtx);
    } catch (mwErr) {
      logger.warn('Middleware onModelCall threw, continuing (fail-open)', { error: String(mwErr) });
    }
  }
}

// src/agent/middleware/quality-signal.ts
// Phase 40 Task 3：质量信号采集中间件
// 注册到 onActing 阶段，在工具调用前后采集质量信号：
//   1. 工具成功/失败信号（基于 ctx.metadata.toolError）
//   2. 错误模式检测（编译错误、类型错误、运行时异常）
//   3. 同一工具短期内重复调用检测（5 秒内）
//
// 注：onActing 中间件在工具执行前触发，工具结果通过 ctx.metadata.toolResult / toolError
//     由外部（hook 或显式调用 recordToolResult）注入。重复调用检测基于 toolName 时间戳。

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { getGlobalQualityAggregator } from '../quality-aggregator.js';

/**
 * 判断信号是否为负面（用于聚合器统计）
 * 接线修复：原中间件只把信号存在 this.signals，从不调用全局聚合器的 recordSignal，
 * 导致 /quality 仪表盘永远显示"暂无质量数据"。
 * 现在每次 pushSignal 时同步调用聚合器，让仪表盘有真实数据来源。
 */
function isNegativeSignal(signal: QualitySignal): boolean {
  switch (signal.signalType) {
    case 'tool_failure':
    case 'error_pattern':
    case 'repeated_call':
      return true;
    case 'tool_success':
      return false;
    default:
      return false;
  }
}

/** 质量信号 */
export interface QualitySignal {
  source: 'implicit' | 'explicit';
  signalType: 'tool_success' | 'tool_failure' | 'error_pattern' | 'repeated_call';
  severity: 'low' | 'medium' | 'high';
  toolName?: string;
  modelId?: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

/** 错误模式匹配规则 */
interface ErrorPatternRule {
  pattern: RegExp;
  name: string;
  severity: 'low' | 'medium' | 'high';
}

/** 内置错误模式列表 */
const ERROR_PATTERNS: ErrorPatternRule[] = [
  { pattern: /error TS\d+:/i, name: 'typescript_error', severity: 'high' },
  { pattern: /compile error|compilation failed/i, name: 'compile_error', severity: 'high' },
  { pattern: /runtime error|uncaught exception|stack trace/i, name: 'runtime_error', severity: 'high' },
  { pattern: /syntax error/i, name: 'syntax_error', severity: 'medium' },
  { pattern: /\[工具错误\]|\[被拦截\]/i, name: 'tool_error_marker', severity: 'medium' },
  { pattern: /ENOENT|permission denied|no such file/i, name: 'filesystem_error', severity: 'medium' },
];

/** 重复调用检测窗口（毫秒） */
const REPEAT_WINDOW_MS = 5000;

export class QualitySignalMiddleware {
  private signals: QualitySignal[] = [];
  private recentToolCalls: Map<string, number[]> = new Map();
  private repeatWindowMs: number;

  constructor(repeatWindowMs: number = REPEAT_WINDOW_MS) {
    this.repeatWindowMs = repeatWindowMs;
  }

  /**
   * 采集信号：先存入本地列表（供 /trace audit 时间线展示），
   * 再同步转发到全局聚合器（供 /quality 仪表盘统计）。
   * 接线修复：原实现只调用 this.signals.push，全局聚合器永远收不到数据。
   */
  private pushSignal(signal: QualitySignal): void {
    this.signals.push(signal);
    if (signal.modelId) {
      try {
        getGlobalQualityAggregator().recordSignal(signal.modelId, isNegativeSignal(signal));
      } catch {
        // 聚合器失败不影响中间件主流程
      }
    }
  }

  /** 返回符合 MiddlewareHandler 签名的处理器（注册到 onActing 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      // 工具调用前：记录时间戳并检测重复调用
      if (ctx.phase === 'onActing' && ctx.toolName) {
        this.trackToolCall(ctx.toolName);
        this.checkRepeatedCall(ctx);
      }

      await next();

      // next() 完成后：基于 metadata 采集结果信号
      if (ctx.phase === 'onActing' && ctx.toolName) {
        this.collectSignal(ctx);
      }
    };
  }

  /**
   * 外部显式记录工具结果（供 hook 或 loop 调用）
   * 由于 onActing 中间件在工具执行前触发，工具结果需通过此方法或 ctx.metadata 注入
   */
  recordToolResult(
    toolName: string,
    success: boolean,
    result: string,
    modelId?: string,
  ): void {
    const timestamp = Date.now();
    if (success) {
      this.pushSignal({
        source: 'implicit',
        signalType: 'tool_success',
        severity: 'low',
        toolName,
        modelId,
        timestamp,
        context: { resultLength: result.length },
      });
    } else {
      this.pushSignal({
        source: 'implicit',
        signalType: 'tool_failure',
        severity: 'high',
        toolName,
        modelId,
        timestamp,
        context: { error: result.slice(0, 200) },
      });
    }
    // 检测错误模式
    const pattern = this.detectErrorPattern(result);
    if (pattern) {
      this.pushSignal({
        source: 'implicit',
        signalType: 'error_pattern',
        severity: pattern.severity,
        toolName,
        modelId,
        timestamp,
        context: { pattern: pattern.name, resultSnippet: result.slice(0, 200) },
      });
    }
  }

  /** 记录工具调用时间戳 */
  private trackToolCall(toolName: string): void {
    const now = Date.now();
    const timestamps = this.recentToolCalls.get(toolName) ?? [];
    // 清理过期时间戳
    const filtered = timestamps.filter(t => now - t <= this.repeatWindowMs);
    filtered.push(now);
    this.recentToolCalls.set(toolName, filtered);
  }

  /** 检测同一工具短期内是否被重复调用 */
  private checkRepeatedCall(ctx: MiddlewareContext): void {
    const toolName = ctx.toolName!;
    const timestamps = this.recentToolCalls.get(toolName) ?? [];
    // 窗口内 >= 2 次调用算重复
    if (timestamps.length >= 2) {
      const modelId = ctx.metadata.modelId as string | undefined;
      this.pushSignal({
        source: 'implicit',
        signalType: 'repeated_call',
        severity: 'medium',
        toolName,
        modelId,
        timestamp: Date.now(),
        context: {
          callCount: timestamps.length,
          windowMs: this.repeatWindowMs,
          firstCallAt: timestamps[0],
          lastCallAt: timestamps[timestamps.length - 1],
        },
      });
    }
  }

  /** 工具调用完成后采集信号（基于 ctx.metadata） */
  private collectSignal(ctx: MiddlewareContext): void {
    const toolName = ctx.toolName!;
    const modelId = ctx.metadata.modelId as string | undefined;
    const toolResult = ctx.metadata.toolResult as string | undefined;
    const toolError = ctx.metadata.toolError as boolean | undefined;

    // 1. 检测工具是否成功
    if (toolError === true) {
      this.pushSignal({
        source: 'implicit',
        signalType: 'tool_failure',
        severity: 'high',
        toolName,
        modelId,
        timestamp: Date.now(),
        context: { error: typeof toolResult === 'string' ? toolResult.slice(0, 200) : undefined },
      });
    } else if (toolError === false) {
      this.pushSignal({
        source: 'implicit',
        signalType: 'tool_success',
        severity: 'low',
        toolName,
        modelId,
        timestamp: Date.now(),
        context: { resultLength: typeof toolResult === 'string' ? toolResult.length : 0 },
      });
    }

    // 2. 检测结果是否包含错误模式
    if (typeof toolResult === 'string' && toolResult.length > 0) {
      const pattern = this.detectErrorPattern(toolResult);
      if (pattern) {
        this.pushSignal({
          source: 'implicit',
          signalType: 'error_pattern',
          severity: pattern.severity,
          toolName,
          modelId,
          timestamp: Date.now(),
          context: { pattern: pattern.name, resultSnippet: toolResult.slice(0, 200) },
        });
      }
    }
  }

  /** 检测字符串中的错误模式 */
  private detectErrorPattern(result: string): ErrorPatternRule | null {
    for (const rule of ERROR_PATTERNS) {
      if (rule.pattern.test(result)) {
        return rule;
      }
    }
    return null;
  }

  /** 获取已采集的信号 */
  getSignals(): QualitySignal[] {
    return this.signals;
  }

  /** 清空信号列表 */
  clearSignals(): void {
    this.signals = [];
    this.recentToolCalls.clear();
  }
}

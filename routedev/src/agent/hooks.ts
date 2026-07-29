// src/agent/hooks.ts
// HookRunner 生命周期钩子系统（Phase 24 Task 4）
// 蓝图 Section 9.3：四种生命周期钩子（pre-step / post-step / on-error / on-complete）
// Phase 31 Task 6.7：扩展工具级钩子（pre-tool-call / post-tool-call / on-session-start / on-session-end）
//
// 与 AgentMiddlewarePipeline 的区别：
//   - Middleware 关注 Agent Loop 内部（LLM 调用、工具执行）
//   - Hook 关注步骤层（任务步骤的开始/结束/出错）+ 工具层（工具调用前后）
//   - 调用者不同：Middleware 由 ReActAgentLoop 调用，Hook 由 Orchestrator/Loop 调用

import { logger } from '../utils/logger.js';
import type { TraceCollector } from '../harness/trace-collector.js';
// P0-15：集成新事件分类法（27 种事件 + legacyToNewEvent 映射）
// 触发旧事件时同步触发新事件，让新事件处理器也能接收生命周期信号
import {
  legacyToNewEvent,
  type HookEventType,
  type HookPayload,
  type HookHandler as NewHookHandler,
  type HookResult as NewHookResult,
} from '../hooks/hook-events.js';

// ============================================================
// P2-7：observe/on/emit 三段式模型
// ============================================================

/**
 * P2-7：基于 HookPayload 的同步监听器（可影响事件流）
 *
 * 与 NewHookDefinition.handler 同签名，但通过 on() 注册时返回 unsubscribe 函数。
 * 语义：注册到某事件，按 priority 升序执行，任一返回 cancel 时短路。
 */
export type HookEventListener = (payload: HookPayload) => Promise<NewHookResult> | NewHookResult;

/**
 * P2-7：纯观察者（fire-and-forget，不影响事件流）
 *
 * 语义：
 *   - 在所有 on() 监听器执行完毕后并行触发，返回值被忽略
 *   - 单个 observer 抛错不影响其他 observer 和主流程（fail-open）
 *   - 适用于日志、遥测、UI 通知等只读场景
 */
export type HookObserver = (payload: HookPayload) => void | Promise<void>;

// ============================================================
// 类型定义
// ============================================================

/**
 * 钩子事件类型
 *
 * 步骤级事件（Phase 24）：
 *   - pre-step：步骤执行前触发
 *   - post-step：步骤成功完成后触发
 *   - on-error：步骤执行出错时触发
 *   - on-complete：所有步骤完成后触发一次
 *
 * 工具级事件（Phase 31 Task 6.7，学习 pi-mono）：
 *   - pre-tool-call：工具调用前触发，可 skip/abort
 *   - post-tool-call：工具调用后触发，可 retry/modifiedResult
 *
 * 会话级事件（Phase 31 Task 6.7）：
 *   - on-session-start：会话开始时触发
 *   - on-session-end：会话结束时触发
 */
export type HookEvent =
  | 'pre-step'
  | 'post-step'
  | 'on-error'
  | 'on-complete'
  | 'pre-tool-call'
  | 'post-tool-call'
  | 'on-session-start'
  | 'on-session-end'
  | 'on-model-call';

/** 钩子上下文 */
export interface HookContext {
  /** 步骤 ID */
  stepId: string;
  /** Agent ID */
  agentId: string;
  /** 步骤结果（post-step / on-complete 时有值） */
  stepResult?: StepResult;
  /** 错误信息（on-error 时有值） */
  error?: StepError;
  /** 项目路径 */
  projectPath: string;
  /** Phase 31 Task 6.7：工具名（pre-tool-call / post-tool-call 时有值） */
  toolName?: string;
  /** Phase 31 Task 6.7：工具参数（pre-tool-call 时有值） */
  toolArgs?: Record<string, unknown>;
  /** Phase 31 Task 6.7：工具执行结果（post-tool-call 时有值） */
  toolResult?: string;
  /** Phase 31 Task 6.7：工具执行耗时毫秒（post-tool-call 时有值） */
  toolDuration?: number;
}

/** 步骤结果（简化版） */
export interface StepResult {
  success: boolean;
  output: string;
  durationMs: number;
}

/** 步骤错误 */
interface StepError {
  message: string;
  code?: string;
  stack?: string;
}

/**
 * 钩子返回结果
 *
 * Phase 31 Task 6.7 扩展：
 *   - pre-tool-call 返回 skip：跳过此工具调用，返回预设结果（modifiedResult 作为预设结果）
 *   - pre-tool-call 返回 abort：中止整个任务（不只是跳过该工具）
 *   - post-tool-call 返回 retry：重新执行工具（会再次触发 pre-tool-call——注意避免无限递归）
 *   - post-tool-call 返回 modifiedResult：替换工具结果（用于后处理，如脱敏、格式化）
 *
 * deny 语义（借鉴 Open Interpreter）：
 *   - pre-tool-call 返回 deny：拒绝单次工具调用，但不中止整个任务
 *   - deny 时通过 reason 字段说明拒绝原因，该原因会作为工具结果返回给 LLM
 *   - 与 skip 的区别：skip 用 modifiedToolResult 作为预设结果，deny 用 reason 作为拒绝原因
 *   - LLM 收到拒绝原因后可以自主调整策略（换工具或换参数）
 */
export interface HookResult {
  /** 动作：继续 / 中止 / 重试 / 跳过 / 拒绝 / 警告 */
  action: 'continue' | 'abort' | 'retry' | 'skip' | 'deny' | 'warn';
  /** 附加消息（用于日志） */
  message?: string;
  /** 修改后的步骤结果（post-step 时可修改） */
  modifiedResult?: StepResult;
  /**
   * Phase 31 Task 6.7：工具调用的预设结果
   * - pre-tool-call 返回 skip 时，作为工具的返回值
   * - post-tool-call 返回时，替换原始工具结果
   */
  modifiedToolResult?: string;
  /**
   * deny 语义的拒绝原因（借鉴 Open Interpreter）
   * - pre-tool-call 返回 deny 时，此字段作为工具结果返回给 LLM
   * - LLM 收到拒绝原因后可以自主调整策略
   */
  reason?: string;
}

/** 钩子处理器 */
type HookHandler = (context: HookContext) => Promise<HookResult>;

/** 钩子定义 */
export interface HookDefinition {
  /** 事件类型 */
  event: HookEvent;
  /** 处理器 */
  handler: HookHandler;
  /** 优先级（数值越小越先执行，默认 100） */
  priority?: number;
  /** 可读名称（用于日志和注销） */
  name?: string;
}

/**
 * P0-15：新事件分类法的钩子定义
 *
 * 与 HookDefinition 区别：
 *   - event 使用 HookEventType（27 种新事件）而非 HookEvent（9 种旧事件）
 *   - handler 使用 HookHandler（接收 HookPayload）而非 (context: HookContext)
 *   - 通过 registerNew 注册，由 fire() 在触发旧事件时自动桥接触发
 */
export interface NewHookDefinition {
  /** 新事件类型（27 种之一） */
  event: HookEventType;
  /** 处理器（接收结构化 HookPayload） */
  handler: NewHookHandler;
  /** 优先级（数值越小越先执行，默认 100） */
  priority?: number;
  /** 可读名称（用于日志和注销） */
  name?: string;
}

// ============================================================
// HookRunner
// ============================================================

/**
 * 生命周期钩子运行器
 *
 * 执行语义：
 *   - pre-step：步骤执行前触发。返回 abort 跳过此步骤；返回 skip 标记为跳过并继续下一步
 *   - post-step：步骤成功完成后触发。返回 retry 重新执行此步骤
 *   - on-error：步骤执行出错时触发。返回 retry 重试、skip 跳过、abort 终止
 *   - on-complete：所有步骤完成后触发一次。返回值仅 message 字段有效
 *
 * 同一事件的多个钩子按 priority 升序执行。如果某个钩子返回 abort，后续钩子不再执行。
 */
export class HookRunner {
  /** 按事件分组的钩子列表 */
  private hooks: Map<HookEvent, HookDefinition[]> = new Map();
  /** P0-15：新事件分类法的钩子列表（按 HookEventType 分组） */
  private newHooks: Map<HookEventType, NewHookDefinition[]> = new Map();
  /** P2-7：纯观察者列表（按 HookEventType 分组，不参与结果合并） */
  private observers: Map<HookEventType, Array<{ name: string; handler: HookObserver }>> = new Map();
  /** 可选的 TraceCollector，用于记录钩子执行 span */
  private trace: TraceCollector | null = null;

  /**
   * 设置 TraceCollector（可选）
   * 设置后，每个钩子执行时会记录 Trace span
   */
  setTraceCollector(trace: TraceCollector): void {
    this.trace = trace;
  }

  /**
   * 注册钩子
   * @param hook 钩子定义
   */
  register(hook: HookDefinition): void {
    const event = hook.event;
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    const list = this.hooks.get(event)!;
    list.push(hook);
    // 按 priority 升序排序（默认 100）
    list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /**
   * P0-15：注册新事件分类法的钩子
   *
   * 新钩子接收结构化 HookPayload，返回 { action: 'continue' | 'cancel' | 'modify' }。
   * 触发时机：当 fire() 被调用且 legacyToNewEvent(legacyEvent) 命中时，
   * 旧钩子执行完毕后，自动将 HookContext 转换为 HookPayload 并触发对应新钩子。
   *
   * @param hook 新事件钩子定义
   */
  registerNew(hook: NewHookDefinition): void {
    const event = hook.event;
    if (!this.newHooks.has(event)) {
      this.newHooks.set(event, []);
    }
    const list = this.newHooks.get(event)!;
    list.push(hook);
    list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /**
   * 注销钩子（按 name 匹配）
   * @param name 钩子名称
   * @returns 注销的钩子数量
   */
  unregister(name: string): number {
    let count = 0;
    for (const [event, list] of this.hooks) {
      const filtered = list.filter(h => {
        if (h.name === name) {
          count++;
          return false;
        }
        return true;
      });
      this.hooks.set(event, filtered);
    }
    // P0-15：同时在新事件钩子列表中注销
    for (const [event, list] of this.newHooks) {
      const filtered = list.filter(h => {
        if (h.name === name) {
          count++;
          return false;
        }
        return true;
      });
      this.newHooks.set(event, filtered);
    }
    return count;
  }

  /**
   * 触发某事件的所有钩子，按 priority 排序
   *
   * 执行规则：
   *   - 钩子按 priority 升序执行
   *   - 任一钩子返回 abort → 短路，最终结果为 abort
   *   - 钩子崩溃不影响其他钩子（try-catch 隔离）
   *   - 最终返回"最严格"结果：abort > retry > skip > continue
   *
   * @param event 事件类型
   * @param context 钩子上下文
   * @returns 合并后的最终结果
   */
  async fire(event: HookEvent, context: HookContext): Promise<HookResult> {
    const list = this.hooks.get(event) ?? [];

    if (list.length === 0) {
      return { action: 'continue' };
    }

    // 动作严格度排序：abort > retry > skip/deny > warn > continue
    // deny 与 skip 同级：两者都跳过当前工具调用但不中止任务
    // warn 与 continue 同级：只记录警告，不中止任务
    const severity: Record<HookResult['action'], number> = {
      abort: 3,
      retry: 2,
      skip: 1,
      deny: 1,
      warn: 0,
      continue: 0,
    };

    let finalResult: HookResult = { action: 'continue' };
    let lastModifiedResult: StepResult | undefined;
    let lastModifiedToolResult: string | undefined;
    let lastDenyReason: string | undefined;

    for (const hook of list) {
      // 记录钩子执行 span
      const hookName = hook.name ?? '(anonymous)';
      const spanId = this.trace?.startSpan({
        name: `hook:${event}:${hookName}`,
        type: 'hook',
      }) ?? -1;

      try {
        const result = await hook.handler(context);

        // 结束钩子 span
        if (spanId >= 0) {
          this.trace?.endSpan(spanId);
        }

        // 收集 modifiedResult（post-step 可修改结果）
        if (result.modifiedResult) {
          lastModifiedResult = result.modifiedResult;
        }

        // Phase 31 Task 6.7：收集 modifiedToolResult（pre/post-tool-call 可修改工具结果）
        if (result.modifiedToolResult !== undefined) {
          lastModifiedToolResult = result.modifiedToolResult;
        }

        // 收集 deny 的拒绝原因（最后一个 deny 钩子的 reason 胜出）
        if (result.action === 'deny' && result.reason) {
          lastDenyReason = result.reason;
        }

        // 合并结果：取最严格的动作
        if (severity[result.action] > severity[finalResult.action]) {
          finalResult = {
            action: result.action,
            message: result.message,
          };
        } else if (result.action === finalResult.action && result.message) {
          // 同等严格度时，保留非空 message（on-complete 等事件依赖此行为）
          finalResult.message = result.message;
        }

        // abort 短路：不再执行后续钩子
        if (result.action === 'abort') {
          logger.info('Hook aborted, skipping remaining hooks', {
            event,
            hookName: hook.name,
            stepId: context.stepId,
          });
          break;
        }
      } catch (err) {
        // 结束钩子 span（出错时也结束）
        if (spanId >= 0) {
          this.trace?.endSpan(spanId);
        }
        // 钩子崩溃不影响其他钩子和主流程
        logger.warn('Hook handler threw error, continuing', {
          event,
          hookName: hook.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 附加修改后的结果
    if (lastModifiedResult) {
      finalResult.modifiedResult = lastModifiedResult;
    }
    // Phase 31 Task 6.7：附加修改后的工具结果
    if (lastModifiedToolResult !== undefined) {
      finalResult.modifiedToolResult = lastModifiedToolResult;
    }
    // 附加 deny 的拒绝原因
    if (lastDenyReason !== undefined) {
      finalResult.reason = lastDenyReason;
    }

    // P0-15：新事件分类法桥接——触发旧事件后，同步触发映射的新事件
    // 让注册到新 27 种事件类型的处理器也能接收生命周期信号
    // 映射关系由 legacyToNewEvent 实现（如 'pre-tool-call' → 'PreToolUse'）
    const newEventType = legacyToNewEvent(event);
    if (newEventType) {
      const newResult = await this.fireNew(newEventType, context);
      // 新事件返回 cancel 时，将最终结果升级为 abort（取消事件 = 中止动作）
      if (newResult.action === 'cancel' && severity['abort'] > severity[finalResult.action]) {
        finalResult = {
          action: 'abort',
          message: newResult.reason ?? `被新事件 ${newEventType} 取消`,
        };
      }
    }

    return finalResult;
  }

  /**
   * P0-15：触发新事件分类法的钩子
   *
   * 将 HookContext 转换为 HookPayload，按 priority 升序执行所有注册到该新事件的钩子。
   * 新钩子返回 { action: 'continue' | 'cancel' | 'modify' }：
   *   - continue：继续事件流（默认）
   *   - cancel：取消事件（仅 cancelable 事件有效，由 fire() 转换为 abort）
   *   - modify：修改事件数据（仅 mutable 事件有效，当前实现暂不回写到 context）
   *
   * fail-open：单个新钩子崩溃不阻塞后续钩子。
   */
  private async fireNew(event: HookEventType, context: HookContext): Promise<NewHookResult> {
    const list = this.newHooks.get(event) ?? [];
    if (list.length === 0) {
      return { action: 'continue' };
    }

    // 将旧 HookContext 转换为新 HookPayload
    const payload: HookPayload = {
      type: event,
      timestamp: Date.now(),
      data: {
        stepId: context.stepId,
        projectPath: context.projectPath,
        toolName: context.toolName,
        toolArgs: context.toolArgs,
        toolResult: context.toolResult,
        toolDuration: context.toolDuration,
        error: context.error,
        stepResult: context.stepResult,
      },
      agentId: context.agentId,
    };

    let finalResult: NewHookResult = { action: 'continue' };

    for (const hook of list) {
      const hookName = hook.name ?? '(anonymous)';
      const spanId = this.trace?.startSpan({
        name: `hook:${event}:${hookName}`,
        type: 'hook',
      }) ?? -1;

      try {
        const result = await hook.handler(payload);
        if (spanId >= 0) {
          this.trace?.endSpan(spanId);
        }

        // cancel 短路：不再执行后续新钩子
        if (result.action === 'cancel') {
          logger.info('New hook cancelled event, skipping remaining new hooks', {
            event,
            hookName,
            reason: result.reason,
          });
          finalResult = result;
          break;
        }

        // modify：记录最新修改（当前实现不回写到 context，仅保留日志）
        if (result.action === 'modify') {
          payload.data = { ...payload.data, ...result.newData };
          logger.debug('New hook modified event data', {
            event,
            hookName,
            modifiedKeys: Object.keys(result.newData),
          });
        }
      } catch (err) {
        if (spanId >= 0) {
          this.trace?.endSpan(spanId);
        }
        // fail-open：新钩子崩溃不影响其他钩子和主流程
        logger.warn('New hook handler threw error, continuing', {
          event,
          hookName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return finalResult;
  }

  /**
   * 列出已注册的钩子
   */
  list(): Array<{ event: HookEvent; name: string; priority: number }> {
    const result: Array<{ event: HookEvent; name: string; priority: number }> = [];
    for (const [event, list] of this.hooks) {
      for (const hook of list) {
        result.push({
          event,
          name: hook.name ?? '(anonymous)',
          priority: hook.priority ?? 100,
        });
      }
    }
    return result;
  }

  /**
   * 清除所有钩子（含 P0-15 新事件钩子和 P2-7 观察者）
   */
  clear(): void {
    this.hooks.clear();
    this.newHooks.clear();
    this.observers.clear();
  }

  /**
   * 获取某事件的钩子数量
   */
  count(event: HookEvent): number {
    return this.hooks.get(event)?.length ?? 0;
  }

  /**
   * P0-15：获取某新事件的钩子数量
   */
  countNew(event: HookEventType): number {
    return this.newHooks.get(event)?.length ?? 0;
  }

  // ============================================================
  // P2-7：observe/on/emit 三段式模型
  // ============================================================

  /**
   * P2-7：注册同步监听器（可影响事件流）
   *
   * 与 registerNew 区别：
   *   - 返回 unsubscribe 函数，便于局部订阅的清理
   *   - 自动生成 name（用于注销），便于调试
   *   - 优先级默认 100，与 registerNew 一致
   *
   * 语义：
   *   - 按 priority 升序执行
   *   - 任一监听器返回 cancel 时短路（不执行后续监听器，但 observe 仍执行）
   *   - 监听器抛错不阻塞其他监听器（fail-open）
   *
   * @param event 新事件类型（27 种之一）
   * @param listener 监听器（接收 HookPayload，返回 HookResult）
   * @param priority 优先级（数值越小越先执行，默认 100）
   * @returns unsubscribe 函数，调用后注销此监听器
   */
  on(
    event: HookEventType,
    listener: HookEventListener,
    priority: number = 100,
  ): () => void {
    const name = `on:${event}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.registerNew({ event, handler: listener, priority, name });
    return () => {
      this.unregister(name);
    };
  }

  /**
   * P2-7：注册纯观察者（fire-and-forget，不影响事件流）
   *
   * 与 on 区别：
   *   - 返回值被忽略
   *   - 在所有 on 监听器执行完毕后并行触发
   *   - 单个 observer 抛错不影响其他 observer 和主流程
   *   - 无 priority 概念，全部并行执行
   *
   * 适用场景：日志、遥测、UI 通知、性能监控等只读副作用
   *
   * @param event 新事件类型
   * @param observer 观察者（返回值被忽略）
   * @returns unsubscribe 函数
   */
  observe(event: HookEventType, observer: HookObserver): () => void {
    if (!this.observers.has(event)) {
      this.observers.set(event, []);
    }
    const name = `observe:${event}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const list = this.observers.get(event)!;
    list.push({ name, handler: observer });
    return () => {
      const current = this.observers.get(event);
      if (!current) return;
      this.observers.set(
        event,
        current.filter((o) => o.name !== name),
      );
    };
  }

  /**
   * P2-7：发射事件（三段式入口）
   *
   * 执行顺序：
   *   1. 构建 HookPayload（含 type/timestamp/data/agentId/sessionId）
   *   2. 按 priority 升序执行 on() 注册的监听器（任一 cancel 短路）
   *   3. 并行触发 observe() 注册的所有观察者（返回值忽略，fail-open）
   *
   * 与 fire 区别：
   *   - fire 接收旧 HookEvent + HookContext，向后兼容
   *   - emit 接收新 HookEventType + payload data，推荐新代码使用
   *   - emit 同时触发 on 监听器和 observe 观察者
   *   - emit 不触发旧 hooks（如需桥接，调用方自行调用 fire）
   *
   * @param event 新事件类型
   * @param data 事件数据（结构因事件类型而异）
   * @param agentId 可选 Agent ID
   * @param sessionId 可选会话 ID
   * @returns 合并后的最终 HookResult（cancel 优先于 continue/modify）
   */
  async emit(
    event: HookEventType,
    data: Record<string, unknown>,
    agentId?: string,
    sessionId?: string,
  ): Promise<NewHookResult> {
    const payload: HookPayload = {
      type: event,
      timestamp: Date.now(),
      data,
      agentId,
      sessionId,
    };

    // 阶段 1：按 priority 升序执行 on() 监听器
    const list = this.newHooks.get(event) ?? [];
    let finalResult: NewHookResult = { action: 'continue' };

    for (const hook of list) {
      const hookName = hook.name ?? '(anonymous)';
      const spanId = this.trace?.startSpan({
        name: `emit:${event}:${hookName}`,
        type: 'hook',
      }) ?? -1;

      try {
        const result = await hook.handler(payload);
        if (spanId >= 0) {
          this.trace?.endSpan(spanId);
        }

        // cancel 短路：不再执行后续 on 监听器
        if (result.action === 'cancel') {
          logger.info('emit: listener cancelled, skipping remaining listeners', {
            event,
            hookName,
            reason: result.reason,
          });
          finalResult = result;
          break;
        }

        // modify：合并修改到 payload，让后续监听器看到更新后的数据
        if (result.action === 'modify') {
          payload.data = { ...payload.data, ...result.newData };
          logger.debug('emit: listener modified event data', {
            event,
            hookName,
            modifiedKeys: Object.keys(result.newData),
          });
        }
      } catch (err) {
        if (spanId >= 0) {
          this.trace?.endSpan(spanId);
        }
        // fail-open：监听器崩溃不阻塞其他监听器
        logger.warn('emit: listener threw error, continuing', {
          event,
          hookName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 阶段 2：并行触发 observe() 观察者（fail-open，返回值忽略）
    const observerList = this.observers.get(event) ?? [];
    if (observerList.length > 0) {
      // 使用修改后的 payload 副本，避免 observer 误改
      const observedPayload: HookPayload = { ...payload, data: { ...payload.data } };
      await Promise.allSettled(
        observerList.map(async (o) => {
          const spanId = this.trace?.startSpan({
            name: `emit-observe:${event}:${o.name}`,
            type: 'hook',
          }) ?? -1;
          try {
            await o.handler(observedPayload);
          } catch (err) {
            logger.warn('emit: observer threw error, continuing', {
              event,
              observerName: o.name,
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            if (spanId >= 0) {
              this.trace?.endSpan(spanId);
            }
          }
        }),
      );
    }

    return finalResult;
  }

  /**
   * P2-7：获取某事件的观察者数量
   */
  countObservers(event: HookEventType): number {
    return this.observers.get(event)?.length ?? 0;
  }
}

/**
 * 创建 HookRunner 实例
 */
export function createHookRunner(): HookRunner {
  return new HookRunner();
}

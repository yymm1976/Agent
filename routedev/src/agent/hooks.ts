// src/agent/hooks.ts
// HookRunner 生命周期钩子系统（Phase 24 Task 4）
// 蓝图 Section 9.3：四种生命周期钩子（pre-step / post-step / on-error / on-complete）
//
// 与 AgentMiddlewarePipeline 的区别：
//   - Middleware 关注 Agent Loop 内部（LLM 调用、工具执行）
//   - Hook 关注步骤层（任务步骤的开始/结束/出错）
//   - 调用者不同：Middleware 由 ReActAgentLoop 调用，Hook 由 Orchestrator/DurableExecutor 调用

import { logger } from '../utils/logger.js';
import type { TraceCollector } from '../harness/trace-collector.js';

// ============================================================
// 类型定义
// ============================================================

/** 钩子事件类型 */
export type HookEvent = 'pre-step' | 'post-step' | 'on-error' | 'on-complete';

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
}

/** 步骤结果（简化版，与 DurableExecutor 共享） */
export interface StepResult {
  success: boolean;
  output: string;
  durationMs: number;
}

/** 步骤错误 */
export interface StepError {
  message: string;
  code?: string;
  stack?: string;
}

/** 钩子返回结果 */
export interface HookResult {
  /** 动作：继续 / 中止 / 重试 / 跳过 */
  action: 'continue' | 'abort' | 'retry' | 'skip';
  /** 附加消息（用于日志） */
  message?: string;
  /** 修改后的步骤结果（post-step 时可修改） */
  modifiedResult?: StepResult;
}

/** 钩子处理器 */
export type HookHandler = (context: HookContext) => Promise<HookResult>;

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

    // 动作严格度排序：abort > retry > skip > continue
    const severity: Record<HookResult['action'], number> = {
      abort: 3,
      retry: 2,
      skip: 1,
      continue: 0,
    };

    let finalResult: HookResult = { action: 'continue' };
    let lastModifiedResult: StepResult | undefined;

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
   * 清除所有钩子
   */
  clear(): void {
    this.hooks.clear();
  }

  /**
   * 获取某事件的钩子数量
   */
  count(event: HookEvent): number {
    return this.hooks.get(event)?.length ?? 0;
  }
}

/**
 * 创建 HookRunner 实例
 */
export function createHookRunner(): HookRunner {
  return new HookRunner();
}

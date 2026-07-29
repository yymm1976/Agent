// src/agent/middleware/exploration-budget-middleware.ts
// Phase 94：预探索预算中间件
//
// 解决问题：主 Agent 在多步实现任务中陷入"预探索过载"——连续读 N 个文件
// 却不调用 spawn_agent 分发，最终撞 maxIterations 上限。
//
// 机制：在 onActing 阶段统计只读工具调用次数，超过阈值时向 metadata 注入
//   explorationOverload 提示，loop.ts 在 LLM 上下文中追加建议消息：
//   "你已连续读 N 个文件，建议用 spawn_agent(researcher) 分发探索"
//
// 设计原则：
//   1. 不阻断工具执行（只读工具仍放行，避免 fail-closed 卡死）
//   2. 阈值可配置（默认 5 次，通过 ctx.metadata.explorationBudget 覆盖）
//   3. spawn_agent 调用后计数器重置（动作分发后探索预算恢复）

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { logger } from '../../utils/logger.js';

/** 只读/探索类工具集合——这些工具连续调用会被计入预探索预算 */
const EXPLORATION_TOOLS = new Set<string>([
  'file_read',
  'file_search',
  'file_glob',
  'glob',
  'code_search',
  'search_code',
  'search_graph',
  'trace_path',
  'get_code_snippet',
  'get_architecture',
  'ls',
  'grep',
  'web_search',
  'web_fetch',
]);

/** 默认预探索预算：连续 5 次只读工具调用后触发提示 */
const DEFAULT_EXPLORATION_BUDGET = 5;

/**
 * 预探索预算中间件
 *
 * 注册到 onActing 阶段，统计连续只读工具调用次数。
 * 超过阈值时通过 metadata 注入提示，不阻断执行。
 */
export class ExplorationBudgetMiddleware {
  /** 当前连续探索计数 */
  private explorationCount = 0;
  /** 触发阈值 */
  private budget: number;

  constructor(budget: number = DEFAULT_EXPLORATION_BUDGET) {
    this.budget = budget;
  }

  /** 重置计数（spawn_agent 调用后由 loop.ts 触发） */
  reset(): void {
    this.explorationCount = 0;
  }

  /** 获取中间件处理器（注册到 onActing 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      if (ctx.phase !== 'onActing' || !ctx.toolName) {
        await next();
        return;
      }

      const toolName = ctx.toolName;

      // spawn_agent 调用 → 重置计数（动作分发，探索预算恢复）
      if (toolName === 'spawn_agent') {
        this.explorationCount = 0;
        await next();
        return;
      }

      // 写类工具调用 → 重置计数（已开始动手，不再是纯探索）
      if (!EXPLORATION_TOOLS.has(toolName)) {
        this.explorationCount = 0;
        await next();
        return;
      }

      // 只读工具 → 累加计数
      this.explorationCount++;
      const currentBudget =
        (ctx.metadata.explorationBudget as number | undefined) ?? this.budget;

      if (this.explorationCount >= currentBudget) {
        // 注入探索过载提示，供 loop.ts 追加到 LLM 上下文
        ctx.metadata.explorationOverload = true;
        ctx.metadata.explorationCount = this.explorationCount;
        ctx.metadata.explorationSuggestion =
          `你已连续调用 ${this.explorationCount} 次只读工具（${toolName} 等），` +
          `未分发子任务。建议：1) 用 spawn_agent(researcher) 把探索交给子 Agent；` +
          `2) 若已有足够信息，直接动手实现而非继续探索。`;
        logger.warn('Exploration budget exceeded, suggesting spawn_agent', {
          count: this.explorationCount,
          budget: currentBudget,
          lastTool: toolName,
        });
      }

      await next();
    };
  }
}

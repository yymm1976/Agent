// src/plugins/packs/goal-advanced-pack.ts
// Phase 82 Task 2：Extended Pack —— Goal 高级编排能力包
//
// 对应 docs/CAPABILITY_LAYERS.md 的 E-12 ~ E-16, E-21, E-23, E-24：
//   - GoalRunner（src/runtime/goal-runner*.ts）
//   - GoalParser / GoalGates / GoalVerifier（src/agent/goal-*.ts）
//   - DagEngine（src/agent/workflow/dag-engine.ts）
//   - DualLoopOrchestrator（src/agent/dual-loop-orchestrator.ts）
//   - boundedRecovery / BudgetMonitor / PrefixAwareCache
//
// Pack 职责：
//   1. 记录 usage counter（pack:goal-advanced:load）
//   2. 确认 /goal 命令可达
//   3. 不重复注册命令——Phase 81 门控已负责条件装配
//
// 注意：Phase 81 已在 app-init-agent.ts 中用 config.packs.goalAdvanced.enabled 门控装配
//   DagEngine / DualLoopOrchestrator / BoundedRecovery / BudgetMonitor 等模块。
//   本 Pack 的 register 主要起"标记"作用——记录 Pack 已加载，usage-counter 计数。

import type { CapabilityPack, PackContext } from '../capability-pack.js';

/**
 * Goal 高级编排能力包
 *
 * /goal 执行器和 DAG 引擎在 full profile 下已由 app-init-agent 注册，
 * Pack 的 register 主要做 usage 标记和可达性确认。
 */
export const goalAdvancedPack: CapabilityPack = {
  id: 'pack.goal-advanced',
  configKey: 'goalAdvanced',
  layer: 'extended',
  description: 'Goal 高级编排：DAG 引擎 + 双循环 + 有界恢复 + 预算监控',
  // Phase 83：修正 costHint——原 "~2000 token/次" 严重偏低
  //   /goal 默认 token 预算 50000（config.goal.tokenBudget），涉及分解+多步执行+验证多轮 LLM
  costHint: '启用后 /goal 命令可用，每次调用涉及多轮 LLM（默认预算 50000 token）',
  defaultEnabled: false,

  /**
   * 注册 Pack 资源
   * 1. 记录 usage counter
   * 2. 不检查命令可达性——/goal 由 chat-bridge 注册，与 Pack 的 CommandRegistry 独立
   */
  async register(ctx: PackContext): Promise<void> {
    // 记录 Pack 加载事件
    ctx.usage.increment({ kind: 'pack', name: 'goal-advanced', action: 'load' });

    ctx.logger.debug('[pack.goal-advanced] 注册完成');
  },

  /**
   * 卸载 Pack：记录 unload 事件
   * 不注销命令——命令由 chat-bridge 统一管理
   */
  async unregister(ctx: PackContext): Promise<void> {
    ctx.usage.increment({ kind: 'pack', name: 'goal-advanced', action: 'skip' });
    ctx.logger.debug('[pack.goal-advanced] 卸载完成');
  },
};

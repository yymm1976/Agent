// src/plugins/packs/multi-agent-pack.ts
// Phase 82 Task 2：Extended Pack —— Multi-Agent 编排能力包
//
// 对应 docs/CAPABILITY_LAYERS.md 的 E-01 ~ E-11：
//   - spawn-agent（src/tools/builtin/spawn-agent.ts）
//   - OrchestratorIntegration / WorkerExecutor / ConflictDetector
//   - SkillLifecycleManager / AgentProfileManager / SubAgentLifecycle
//   - ContextPacker / DelegationGate / DelegationEnforcer / DelegationPolicy
//
// Pack 职责：
//   1. 记录 usage counter（pack:multi-agent:load）
//   2. 确认 spawn_agent 工具可达
//   3. 不重复注册工具——Phase 81 门控已负责条件装配
//
// 注意：Phase 81 已在 app-init-agent.ts 中用 config.packs.multiAgent.enabled 门控装配
//   SpawnAgentTool / OrchestratorIntegration / DelegationSystem 等模块。
//   本 Pack 的 register 主要起"标记"作用——记录 Pack 已加载，usage-counter 计数。

import type { CapabilityPack, PackContext } from '../capability-pack.js';

/**
 * Multi-Agent 编排能力包
 *
 * spawn_agent 工具和编排器在 full profile 下已由 app-init-agent 注册，
 * Pack 的 register 主要做 usage 标记和可达性确认。
 */
export const multiAgentPack: CapabilityPack = {
  id: 'pack.multi-agent',
  configKey: 'multiAgent',
  layer: 'extended',
  description: 'Multi-Agent 编排：spawn-agent + orchestrator + worker + 冲突检测',
  costHint: '多 Agent 场景 token 消耗 ×3-10（每次 spawn 独立上下文 + 子 Agent 迭代）',
  defaultEnabled: false,

  /**
   * 注册 Pack 资源
   * 1. 记录 usage counter
   * 2. 确认 spawn_agent 工具可达
   * 3. 不修改 Phase 81 门控逻辑
   */
  async register(ctx: PackContext): Promise<void> {
    // 记录 Pack 加载事件
    ctx.usage.increment({ kind: 'pack', name: 'multi-agent', action: 'load' });

    // 确认 spawn_agent 工具可达（已由 app-init-agent 在 full profile 下注册）
    if (!ctx.tools.has('spawn_agent')) {
      ctx.logger.warn(
        '[pack.multi-agent] 工具 spawn_agent 未注册，multi-agent Pack 可能无法正常工作',
        { toolName: 'spawn_agent' },
      );
    }

    ctx.logger.debug('[pack.multi-agent] 注册完成');
  },

  /**
   * 卸载 Pack：记录 unload 事件
   * 不注销工具——工具由 app-init-agent 统一管理
   */
  async unregister(ctx: PackContext): Promise<void> {
    ctx.usage.increment({ kind: 'pack', name: 'multi-agent', action: 'skip' });
    ctx.logger.debug('[pack.multi-agent] 卸载完成');
  },
};

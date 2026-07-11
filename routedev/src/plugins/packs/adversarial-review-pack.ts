// src/plugins/packs/adversarial-review-pack.ts
// Phase 82 Task 2：Extended Pack —— 对抗审查能力包
//
// 对应 docs/CAPABILITY_LAYERS.md 的 E-18 ~ E-20：
//   - UnifiedReviewer（src/agent/unified-reviewer.ts）
//   - cross-model-reviewer（src/agent/cross-model-reviewer.ts）
//   - ReviewerPolicy / tieredReview（config.reviewerPolicy）
//
// Pack 职责：
//   1. 记录 usage counter（pack:adversarial-review:load）
//   2. 确认审查相关模块可达（通过配置检查）
//   3. 不重复注册——Phase 81 门控已负责条件装配
//
// 注意：三层审查的装配边界（Phase 83 审计确认）：
//   - UnifiedReviewer：Core 默认装配（app-init-agent.ts:904），不属于本 Pack 门控
//   - CrossModelReviewer：由 packs.adversarial.enabled 门控注入（goal-runner-recovery.ts:507），
//     未启用时不注入 crossModelReviewer，dual-loop 自动跳过跨模型审查
//   - ReviewerPolicy 分级策略：Core 默认装配（app-init-agent.ts:1234），不属于本 Pack 门控
//   本 Pack 的 register 主要起"标记"作用——记录 Pack 已加载，usage-counter 计数。

import type { CapabilityPack, PackContext } from '../capability-pack.js';

/**
 * 对抗审查能力包
 *
 * 装配边界（Phase 83 审计确认）：
 *   - UnifiedReviewer 属于 Core 默认装配，不在本 Pack 门控下
 *   - CrossModelReviewer 由 config.packs.adversarial.enabled 门控（goal-runner-recovery.ts），
 *     即本 Pack 启用后才注入到 dual-loop
 * Pack 的 register 主要做 usage 标记和配置可达性确认。
 */
export const adversarialReviewPack: CapabilityPack = {
  id: 'pack.adversarial-review',
  configKey: 'adversarial',
  layer: 'extended',
  description: '对抗审查：cross-model-reviewer + 分级策略',
  // Phase 83：修正 costHint——原引用 "/review 命令" 实际不存在（无 chat-bridge 注册该命令）
  //   cross-model-reviewer.review() 每次执行一次 LLM 调用（见 cross-model-reviewer.ts:122）
  //   故准确成本为"每次审查额外调用一次 LLM"
  costHint: '启用后每次审查额外调用一次 LLM（跨模型对抗审查）',
  defaultEnabled: false,

  /**
   * 注册 Pack 资源
   * 1. 记录 usage counter
   * 2. 确认审查相关配置可达
   * 3. 不修改 Phase 81 门控逻辑
   */
  async register(ctx: PackContext): Promise<void> {
    // 记录 Pack 加载事件
    ctx.usage.increment({ kind: 'pack', name: 'adversarial-review', action: 'load' });

    // 确认 reviewerPolicy 配置存在（审查模块通过配置启用）
    const hasReviewerPolicy = ctx.config.reviewerPolicy !== undefined;
    if (!hasReviewerPolicy) {
      ctx.logger.warn(
        '[pack.adversarial-review] reviewerPolicy 配置未设置，adversarial-review Pack 可能无法正常工作',
      );
    }

    ctx.logger.debug('[pack.adversarial-review] 注册完成', {
      hasReviewerPolicy,
    });
  },

  /**
   * 卸载 Pack：记录 unload 事件
   * 不注销审查模块——审查模块由 app-init-agent 统一管理
   */
  async unregister(ctx: PackContext): Promise<void> {
    ctx.usage.increment({ kind: 'pack', name: 'adversarial-review', action: 'skip' });
    ctx.logger.debug('[pack.adversarial-review] 卸载完成');
  },
};

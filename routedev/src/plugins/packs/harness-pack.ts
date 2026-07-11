// src/plugins/packs/harness-pack.ts
// Phase 82 Task 3：Standard Pack —— Harness 能力包
//
// 对应 docs/CAPABILITY_LAYERS.md 的 S-18, S-20, S-21：
//   - TraceReplayer + Scorecard（src/harness/trace-replayer.ts, scorecard.ts）
//   - IPC: experiment:* / trace:*（preload/index.ts）
//   - Slash: /replay /scorecard（desktop/main/bridges/chat-bridge.ts）
//
// Pack 职责：
//   1. 记录 usage counter（pack:harness:load）
//   2. 确认 harness 相关命令可达
//   3. 不重复注册命令——Phase 81 门控已负责条件装配

import type { CapabilityPack, PackContext } from '../capability-pack.js';

/**
 * Harness 能力包
 *
 * Trace 回放和评分卡命令在 full profile 下已由 chat-bridge 注册，
 * Pack 的 register 主要做 usage 标记和可达性确认。
 */
export const harnessPack: CapabilityPack = {
  id: 'pack.harness',
  configKey: 'harness',
  layer: 'standard',
  description: 'Harness：Trace 回放 + 评分卡 + 并行实验',
  costHint: '启用后 trace 回放和评分卡命令可用',
  defaultEnabled: false,

  /**
   * 注册 Pack 资源
   * 1. 记录 usage counter
   * 2. 不检查命令可达性——/replay /scorecard 由 chat-bridge 注册，与 Pack 的 CommandRegistry 独立
   */
  async register(ctx: PackContext): Promise<void> {
    // 记录 Pack 加载事件
    ctx.usage.increment({ kind: 'pack', name: 'harness', action: 'load' });

    ctx.logger.debug('[pack.harness] 注册完成');
  },

  /**
   * 卸载 Pack：记录 unload 事件
   * 不注销命令——命令由 chat-bridge 统一管理
   */
  async unregister(ctx: PackContext): Promise<void> {
    ctx.usage.increment({ kind: 'pack', name: 'harness', action: 'skip' });
    ctx.logger.debug('[pack.harness] 卸载完成');
  },
};

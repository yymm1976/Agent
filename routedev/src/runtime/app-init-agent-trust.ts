// src/runtime/app-init-agent-trust.ts
// Agent 信任子系统装配：TrustGradientManager + PermissionMiddleware
// 从 app-init-agent.ts 拆分（Phase 92 / TD-08），保持功能完全等价
//
// 职责：
//   1. PermissionMiddleware 注册到 onActing 阶段（TD-04）
//   2. TrustGradientManager 接线（Core：临时授权，Phase 79 静态档位）
//
// 依赖：tools 子系统（permissionEngine）、middleware 子系统（pluginSystem）

import type { InitContext } from './app-init.js';
import type { createPluginSystem } from './plugin-init.js';
// TD-04：PermissionEngine 接入 Agent Loop 的 onActing 中间件
import { PermissionMiddleware } from '../agent/middleware/permission-middleware.js';
import { logger } from '../utils/logger.js';

/**
 * 装配 Agent 信任子系统
 * 包含：PermissionMiddleware 注册 + TrustGradientManager 接线
 *
 * @param ctx 共享装配上下文（读取 config/permissionEngine/trace）
 * @param pluginSystem 插件系统（由 setupAgentMiddleware 创建，用于注册中间件）
 */
export function setupAgentTrust(
  ctx: InitContext,
  pluginSystem: ReturnType<typeof createPluginSystem>,
): void {
  const { config, permissionEngine, trace } = ctx;

  // TD-04：注册 PermissionMiddleware 到 onActing 阶段
  // 让 PermissionEngine.check() 在工具执行前被实际调用，把三层决策（deny/confirm/auto）
  // 转换为 ctx.metadata.permissionDenied / requiresConfirmation 标记，
  // loop.ts 已有 fail-closed 分支消费 permissionDenied。
  // 注册顺序：在 QualitySignalMiddleware 之前（同步注册，避免动态 import 导致的延迟挂载），
  // 保证权限拦截优先于质量信号采集。
  if (permissionEngine) {
    const autonomyMode = config.autonomy?.defaultMode ?? 'manual';
    const permissionMiddleware = new PermissionMiddleware(permissionEngine, autonomyMode);
    pluginSystem.middlewarePipeline.register('onActing', permissionMiddleware.getHandler());
    logger.info('PermissionMiddleware registered', {
      autonomyMode,
      sandboxLevel: permissionEngine.getSandboxLevel(),
    });
  } else {
    logger.warn('PermissionMiddleware skipped: permissionEngine not available');
  }

  // ===== Phase 40：渐进式信任 / 质量监测 / 用户经验 接线（全部 fail-open 动态 import） =====
  // TD-27：TrustGradient pack 拆分——F-01 临时授权提升为 Core
  //   用户显式临时授权（hasTemporaryGrant）是权限系统基础能力，不再受 pack 门控
  //   F-02（QualitySignal）/ F-06（ExpertisePrompt）仍由 packs.trustGradient.enabled 门控

  // 4.1 TrustGradientManager 接线（Core：临时授权）
  // Phase 79: 仅静态档位配置 + 用户显式临时授权，不做会话内动态升级
  //   setLevel(baseLevel) 一次设定后不再动态调整；PermissionEngine.check() 已旁路 level-based 动态决策
  // TD-27：移除 packs.trustGradient.enabled 门控，临时授权作为 Core 无条件装配
  const trustCfg = config.trust;
  if (trustCfg) {
    const trustModulePath = '../tools/trust-gradient.js';
    import(trustModulePath)
      .then((mod: { TrustGradientManager: new (sessionId: string, level?: string) => import('../tools/trust-gradient.js').TrustGradientManager }) => {
        const sessionId = trace!.getSessionId() ?? `app-${Date.now()}`;
        const trustManager = new mod.TrustGradientManager(sessionId, trustCfg.baseLevel);
        trustManager.setLevel(trustCfg.baseLevel);
        // setTrustGradientManager 已在 PermissionEngine 声明；保留 typeof 守卫兼容装配顺序
        if (typeof permissionEngine!.setTrustGradientManager === 'function') {
          permissionEngine!.setTrustGradientManager(trustManager);
        }
        logger.info('TrustGradientManager registered', {
          baseLevel: trustCfg.baseLevel,
          enableTemporaryGrants: trustCfg.enableTemporaryGrants,
          grantTTLMinutes: trustCfg.grantTTLMinutes,
        });
      })
      .catch((err: unknown) => {
        logger.debug('TrustGradientManager not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

// src/agent/middleware/permission-middleware.ts
// TD-04：PermissionEngine 接入 Agent Loop 的 onActing 中间件
//
// 设计目标：
//   1. 让 PermissionEngine.check() 在工具执行前被实际调用（原为零调用点）
//   2. 把 PermissionEngine 的三层决策（deny / confirm / auto）转换为 Loop 可识别的 metadata 标记：
//      - deny    → ctx.metadata.permissionDenied（loop.ts 已有 fail-closed 分支）
//      - confirm → ctx.metadata.requiresConfirmation（loop.ts 通过 onConfirmTool 走确认流程）
//      - auto    → 直接放行
//   3. fail-closed：中间件或 PermissionEngine 异常时设置 permissionDenied，拒绝工具执行
//
// 与现有 onActing 中间件叠加关系：
//   - QualitySignalMiddleware：采集工具调用质量信号（不拦截）
//   - PermissionMiddleware（本中间件）：PermissionEngine 三层决策
//   - Loop.ts 在所有 onActing 中间件执行完后，再调 PolicyEngine.evaluateAction
//     （若本中间件已设 permissionDenied，PolicyEngine 会被跳过）
//
// 注册顺序：注册到 onActing 阶段，调用 next() 让后续中间件继续执行

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import type { PermissionEngine } from '../../tools/permission-engine.js';
import type { AutonomyMode } from '../../config/schema.js';
import { logger } from '../../utils/logger.js';

/**
 * 权限决策中间件
 *
 * 把 PermissionEngine 接入 Agent Loop 的 onActing 阶段。
 * Loop 在每次工具调用前会调用所有 onActing 中间件，本中间件调用
 * PermissionEngine.check() 做三层权限决策，结果写入 ctx.metadata。
 *
 * 上下文约定（loop.ts 在调用 onActing 前设置）：
 *   - ctx.toolName：工具名
 *   - ctx.toolArgs：工具参数
 *   - ctx.metadata.autonomyMode：当前自主度模式（'manual' | 'semi' | 'auto'）
 *     未设置时默认 'semi'（保守策略）
 */
export class PermissionMiddleware {
  private permissionEngine: PermissionEngine;
  /** 默认自主度模式（ctx.metadata.autonomyMode 缺失时使用） */
  private defaultMode: AutonomyMode;

  constructor(permissionEngine: PermissionEngine, defaultMode: AutonomyMode = 'semi') {
    this.permissionEngine = permissionEngine;
    this.defaultMode = defaultMode;
  }

  /** 获取中间件处理器（注册到 onActing 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      // 仅处理 onActing 阶段且有 toolName 的情况
      if (ctx.phase !== 'onActing' || !ctx.toolName) {
        await next();
        return;
      }

      const toolName = ctx.toolName;
      const args = ctx.toolArgs ?? {};
      // 从 metadata 读取自主度模式，缺失时用构造函数默认值
      const mode = (ctx.metadata.autonomyMode as AutonomyMode | undefined) ?? this.defaultMode;

      try {
        const decision = this.permissionEngine.check(toolName, args, mode);

        // 把决策结果写入 metadata，供 Loop / 后续中间件 / 审计读取
        ctx.metadata.permissionDecision = decision.decision;
        if (decision.matchedRuleId) {
          ctx.metadata.permissionMatchedRule = decision.matchedRuleId;
        }
        if (decision.reason) {
          ctx.metadata.permissionReason = decision.reason;
        }

        if (decision.decision === 'deny') {
          // deny → 设置 permissionDenied，loop.ts 会 fail-closed 拒绝执行
          // reason 拼接为字符串（loop.ts 把 permissionDenied 当作拒绝原因字符串读取）
          ctx.metadata.permissionDenied = `PermissionEngine 拒绝: ${decision.reason}`;
          logger.info('PermissionMiddleware denied tool call', {
            toolName,
            matchedRule: decision.matchedRuleId,
            reason: decision.reason,
          });
        } else if (decision.decision === 'confirm') {
          // confirm → 标记需要确认，loop.ts 通过 onConfirmTool 流程处理
          ctx.metadata.requiresConfirmation = true;
          logger.debug('PermissionMiddleware requires confirmation', {
            toolName,
            matchedRule: decision.matchedRuleId,
            reason: decision.reason,
          });
        }
        // 'auto' → 直接放行，不设置任何拦截标记
      } catch (err) {
        // fail-closed：PermissionEngine 异常时拒绝工具执行
        // 避免权限检查被静默跳过导致安全风险
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.metadata.permissionDenied = `PermissionEngine 异常 (fail-closed): ${errMsg}`;
        logger.warn('PermissionEngine.check threw, denying tool (fail-closed)', {
          toolName,
          error: errMsg,
        });
      }

      // 继续执行后续 onActing 中间件（如 QualitySignalMiddleware）
      // permissionDenied 已设置时，loop.ts 会在中间件链结束后拒绝工具
      await next();
    };
  }
}

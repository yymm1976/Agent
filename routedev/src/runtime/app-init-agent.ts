// src/runtime/app-init-agent.ts
// Agent 子系统装配：Spawn Agent、Plugin、Hook、Goal、Experiment
// 从 app-init.ts 拆分（TD-02），保持功能完全等价
//
// Phase 92（TD-08）进一步拆分为 3 个职责子文件：
//   - app-init-agent-trust.ts：TrustGradient + PermissionMiddleware 创建装配
//   - app-init-agent-middleware.ts：插件系统 + 各类中间件 + Hooks 创建注册
//   - app-init-agent-loop.ts：ReActAgentLoop + DualLoop + CompletionGate + SubAgent 创建
//
// 本文件为 dispatcher，仅保留 createAgentSubsystem 主函数调用 3 个 setup 函数。
//
// 依赖：tools 子系统（registry/agentLoop/toolExecutor/...）、memory 子系统（contextManager/recallInjector/...）、
//       observability 子系统（trace/audit）、router 子系统（primaryClient/clientManager/classifier/modelRouter/tracker）

import type { InitContext, AppDependencies } from './app-init.js';
import { setupAgentMiddleware } from './app-init-agent-middleware.js';
import { setupAgentTrust } from './app-init-agent-trust.js';
import { setupAgentLoop } from './app-init-agent-loop.js';
// Phase 94 Task 4 修复：agentLoop 实例在 middleware 之前创建，供 setupAgentMiddleware 注入中间件管线
import { ReActAgentLoop } from '../agent/loop.js';

/**
 * 创建 Agent 子系统
 * 包含：Spawn Agent、Plugin、Hook、Goal、Experiment 全部接线
 *
 * 装配顺序：createAgentLoop（创建实例写入 ctx）→ middleware（插件系统 + 中间件 + Hooks）→ trust（PermissionMiddleware + TrustGradient）→ loop（其余全部）
 *
 * Phase 94 Task 4 修复：agentLoop 必须先创建，setupAgentMiddleware 需要它来注入 middlewarePipeline。
 * 原迁移将 agentLoop 创建放在 setupAgentLoop 开头，导致 setupAgentMiddleware 访问 ctx.agentLoop 时为 undefined。
 *
 * @param ctx 共享装配上下文（读取 tools/memory/observability/router 子系统的产出，写入 hookRunner/unifiedReviewer/...）
 * @returns Agent 子系统依赖片段
 */
export function createAgentSubsystem(ctx: InitContext): Partial<AppDependencies> {
  // 0. 先创建 agentLoop 实例并写入 ctx，供 setupAgentMiddleware / setupAgentLoop 共享
  //    guardedAdapter 由 tools 子系统写入 ctx，此处非空
  ctx.agentLoop = new ReActAgentLoop(ctx.guardedAdapter!, {
    maxIterations: 50,
    toolsEnabled: true,
    autoApprovePatterns: ctx.config.autonomy?.autoApprovePatterns ?? [],
  });

  // 1. 中间件子系统：创建插件系统 + 注册各类中间件 + Hook 系统
  //    返回 pluginSystem（供 trust/loop 复用）+ hookRunner（最终依赖片段）
  const { pluginSystem, hookRunner } = setupAgentMiddleware(ctx);

  // 2. 信任子系统：注册 PermissionMiddleware + TrustGradientManager
  //    需注入 pluginSystem（注册 onActing 中间件）
  setupAgentTrust(ctx, pluginSystem);

  // 3. 循环子系统：SubAgent + Goal + TaskOrchestrator + UnifiedReviewer + CompletionGate +
  //    CodeMap 引擎 + Phase 48/49/52/53/77 全部接线
  //    需注入 pluginSystem（createSpawnAgentFn 中子 Agent Loop 复用中间件管线）
  const loopDeps = setupAgentLoop(ctx, pluginSystem);

  return {
    hookRunner,
    ...loopDeps,
  };
}

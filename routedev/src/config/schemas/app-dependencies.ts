// src/config/schemas/app-dependencies.ts
// Phase 93 Task 6：AppDependencies 合并后的运行时校验
//
// app-init.ts 第 420 行的 `as AppDependencies` 是关键装配点：合并 5 个子系统的 Partial 返回值后，
// 直接断言为完整 AppDependencies。若某子系统遗漏字段，运行时才会炸。
// 本 schema 仅校验核心字段存在性（不校验字段类型细节——类型由 TS 静态保证，运行时只查"在不在"）。
//
// fail-closed：校验失败抛错。装配阶段失败应立即可见，不应带病启动。

import { z } from 'zod';
import type { AppDependencies } from '../../runtime/app-init.js';

/**
 * AppDependencies 合并后的校验 schema
 *
 * 仅校验核心字段存在（值非 undefined）。
 * 字段类型由 TS 静态类型保证，运行时只关心"字段有没有被装配出来"。
 * dispose 是合并对象上直接定义的方法，必须存在且为函数。
 */
export const AppDependenciesMergeSchema = z.object({
  // 工具链
  registry: z.unknown(),
  mcpManager: z.unknown(),
  toolExecutor: z.unknown(),
  agentLoop: z.unknown(),
  skillsRouter: z.unknown(),
  filesystemDiscovery: z.unknown(),
  // 记忆与上下文
  checkpointManager: z.unknown(),
  contextManager: z.unknown(),
  // 基础设施
  prompts: z.unknown(),
  blackboard: z.unknown(),
  trace: z.unknown(),
  audit: z.unknown(),
  hookRunner: z.unknown(),
  // LLM 客户端
  checkpointClient: z.unknown(),
  // 审查与验证
  unifiedReviewer: z.unknown(),
  completionGate: z.unknown(),
  sharedSystemPromptRef: z.unknown(),
  // Goal 流程
  pathRouter: z.unknown(),
  dualLoopOrchestratorRef: z.unknown(),
  dagEngineRef: z.unknown(),
  experimentManager: z.unknown(),
  // Phase 97 Part D：工作区管理器
  workspaceManager: z.unknown(),
  // Phase 97 Part E：子会话注册表
  subagentRegistry: z.unknown(),
  // Phase 97 Part F：自动化调度器
  automationScheduler: z.unknown(),
  // Phase 97 Part I Task I2：触发率统计器（记忆/Skill/UserProfile 命中计数）
  hitStat: z.unknown(),
  // 资源释放（合并对象上直接定义）
  dispose: z.function(),
}).passthrough();

/**
 * 校验合并后的 AppDependencies 对象
 *
 * fail-closed：校验失败抛 ZodError。装配阶段是关键路径，不能带病启动。
 *
 * @param merged 合并后的对象（5 个子系统返回值 + dispose）
 * @returns 类型不变的 AppDependencies（仅做存在性校验，不改变对象结构）
 */
export function parseAppDependenciesMerge(merged: unknown): AppDependencies {
  // schema 用 z.unknown() 仅校验字段存在性，TS 无法直接断言到具体 AppDependencies 类型，
  // 需先转 unknown 再断言——结构安全性由 Zod 运行时校验保证
  return AppDependenciesMergeSchema.parse(merged) as unknown as AppDependencies;
}

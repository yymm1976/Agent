// src/runtime/goal-runner-types.ts
// Phase 94 Task 1：goal-runner 子模块共享类型与常量
//
// 职责：承载被多个子模块（core/confirm/scheduler/recovery）共享引用的类型与常量，
// 消除 core.ts ↔ 子模块的 ESM 循环依赖。
//
// 循环依赖根源（Phase 94 之前）：
//   core.ts 静态 import 三个子模块的工厂函数（运行期值），
//   子模块反向 import core.ts 的 MAX_CONTEXT_ITEMS 常量（运行期值）。
//   两个方向都是值 import，触发 ESM 循环依赖。
//
// 解决方案：
//   将共享的运行期常量和类型集中到本文件，子模块从本文件 import，
//   core.ts 仍从子模块 import 工厂函数（单向依赖，无循环）。

import type { GoalEvent, GoalPlan, GoalStep } from '../agent/goal-types.js';
import type { AppConfig } from '../config/schema.js';
import type { GoalGateManager } from '../agent/goal-gates.js';
import type { PersistedGoal } from '../agent/goal-persistence.js';
import type { DualLoopOrchestrator } from '../agent/dual-loop-orchestrator.js';
import type { GateResult } from '../agent/completion-gate.js';

/**
 * 上下文文本/诊断片段截断长度上限（step.result / taskSignature / args JSON 等）
 *
 * 原 goal-runner-core.ts 常量，被 scheduler/recovery 子模块引用。
 * Phase 94：移至本文件消除循环依赖。
 */
export const MAX_CONTEXT_ITEMS = 200;

/**
 * 共享上下文：在 createGoalRunner 中创建，传递给各子模块的函数工厂
 *
 * 原 goal-runner-core.ts 类型，被 confirm/scheduler/recovery 子模块引用。
 * Phase 94：移至本文件消除循环依赖。
 *
 * 包含：
 *   - deps：原始依赖注入（各模块按需解构使用）
 *   - 共享状态：emit / gid / gateManager / goalCfg / goalIntegration
 *   - 跨模块函数引用：createGoalRunner 组装后填充，各模块通过 ctx.xxx 调用
 *
 * 设计说明：原 goal-runner.ts 是单个 2000+ 行的闭包，所有函数共享 createGoalRunner
 * 作用域内的变量。拆分为多文件后，用 ctx 对象替代闭包作用域，行为完全等价。
 */
export interface GoalRunnerCtx {
  /** 原始依赖注入 */
  deps: import('./goal-runner-core.js').GoalRunnerDeps;
  /** 结构化事件发射器（安全调用 onGoalEvent，CLI 端未注入时为 no-op） */
  emit: (event: GoalEvent) => void;
  /** Goal 唯一标识（Electron 端由 engine-bridge 注入；CLI 端用 nextId 生成临时 id） */
  gid: string;
  /** 验收门控管理器（Phase 21 Task 2：计划确认后冻结验收门控） */
  gateManager: GoalGateManager;
  /** Goal 配置缓存（config.goal） */
  goalCfg: AppConfig['goal'];
  /** Goal 集成开关缓存（config.goalIntegration） */
  goalIntegration: AppConfig['goalIntegration'];

  // ===== 跨模块函数引用（createGoalRunner 中组装后填充） =====
  /** 保存 plan 修订历史到 JSONL（confirm 模块） */
  savePlanRevision: (beforeSteps: GoalStep[], afterSteps: GoalStep[], reason: string) => Promise<void>;
  /** 处理 /goal 命令：解析目标、分解步骤、请求用户确认（confirm 模块） */
  handleGoalCommand: (text: string) => Promise<void>;
  /** 执行目标计划：逐步骤运行 Agent Loop，支持中断 + 检查点 + 压缩（scheduler 模块） */
  executeGoalPlan: (plan: GoalPlan) => Promise<void>;
  /** 验证目标完成度（LLM 验证）（recovery 模块）；signal 可选（Closure 2：取消时不启动验证） */
  verifyPlan: (plan: GoalPlan, signal?: AbortSignal) => Promise<boolean>;
  /** 运行独立代码验证门（typecheck/lint/tests）（recovery 模块）；signal 可选（GA Hardening 第3项：取消时杀进程树） */
  runCompletionGate: (plan: GoalPlan, signal?: AbortSignal) => Promise<GateResult | undefined>;
  /** 旧迭代闭环 fallback（DualLoop 未启用或异常时使用）（recovery 模块） */
  legacyIterativeLoop: (plan: GoalPlan) => Promise<void>;
  /** DualLoop 双循环恢复（含 BoundedRecovery）（recovery 模块） */
  runDualLoopPlan: (plan: GoalPlan, orchestrator: DualLoopOrchestrator) => Promise<boolean>;
  /** 从持久化的 PersistedGoal 恢复执行（recovery 模块） */
  resumeGoalPlan: (persistedGoal: PersistedGoal) => Promise<void>;
}

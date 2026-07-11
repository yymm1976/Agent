// src/runtime/goal-runner.ts
// 目标分解与执行器：组合入口（re-export）
// Phase 79 Task 2：从原 2000+ 行单文件拆分为多模块，本文件仅做 re-export
// 保持对外 API 不变——外部模块仍从 goal-runner.ts 导入 createGoalRunner / GoalRunnerDeps
//
// 拆分结构：
//   - goal-runner-core.ts       核心类型、依赖接口、共享上下文、主入口工厂
//   - goal-runner-confirm.ts    用户确认、计划编辑交互
//   - goal-runner-scheduler.ts  步骤调度、执行循环
//   - goal-runner-recovery.ts   错误恢复、重试、回滚逻辑
//   - goal-runner.ts            组合入口（本文件，re-export）

export { createGoalRunner } from './goal-runner-core.js';
export type { GoalRunnerDeps } from './goal-runner-core.js';

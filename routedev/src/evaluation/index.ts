// src/evaluation/index.ts
// Phase 49 Task 5：评估模块统一导出
//
// 导出内容：
//   - EvalCase / EvalResult / EvalRunner 等类型与运行器
//   - Smoke 10 / Regression 30 用例集
//   - 默认 heuristicExecutor（供无 LLM 环境使用）

export type { EvalCase } from './cases/smoke.js';
export { SMOKE_CASES } from './cases/smoke.js';
export { REGRESSION_CASES } from './cases/regression.js';
export {
  EvalRunner,
  heuristicExecutor,
  ALL_EVAL_CASES,
  type EvalResult,
  type EvalExecutorResult,
  type EvalExecutor,
  type EvalRunnerOptions,
} from './runner.js';

// 保留对既有评估框架的再导出，便于外部统一从 evaluation/ 入口引用
export {
  EvaluationFramework,
  EVALUATION_SETS,
  type EvaluationCase,
  type EvaluationReport,
  type CaseResult,
  type RubricItem,
  type RubricScore,
  type JudgeResult,
  type ExecuteTargetCallback,
  type JudgeCallback,
  type EvaluationTarget,
  type EvaluationScenario,
} from './evaluation-framework.js';

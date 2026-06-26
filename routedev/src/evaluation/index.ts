// src/evaluation/index.ts
// Phase 49 Task 5：评估集框架与在线监控统一导出
//
// 包含：
//   - 5.2 评估集框架（EvaluationFramework + EVALUATION_SETS）
//   - 5.3 在线监控信号（OnlineMonitor + Alert）

export { EvaluationFramework, EVALUATION_SETS } from './evaluation-framework.js';
export type {
  EvaluationScenario,
  EvaluationTarget,
  RubricItem,
  EvaluationCase,
  RubricScore,
  CaseResult,
  EvaluationReport,
  JudgeResult,
  ExecuteTargetCallback,
  JudgeCallback,
  EvaluationSetConfig,
} from './evaluation-framework.js';

export { OnlineMonitor } from './online-monitor.js';
export type {
  AlertType,
  AlertSeverity,
  Alert,
  MonitorParams,
} from './online-monitor.js';

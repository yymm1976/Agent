// src/skills/index.ts
// Skills 模块统一导出
//
// 对外暴露：
//   - 类型：FlowNode / SkillFlow / FlowEvent / FlowExecutionContext 等（Phase 49 Task 1）
//   - 引擎：SkillFlowEngine + 依赖注入接口
//   - 吸因子引导：AttractorInjector
//   - 中断恢复：SkillFlowCheckpointStore
//   - 粒度检查：NodeGranularityChecker
//   - 解析器：SkillMdParser（已有）
//
// 来源：Phase 49 Task 1 蓝图 1.1-1.9

// ============================================================
// 已有：SKILL.md 解析器
// ============================================================
export { SkillMdParser } from './skill-md-parser.js';
export type { SkillMetadata, ParsedSkill } from './skill-md-parser.js';

// ============================================================
// Phase 49 Task 1：SkillFlow 引擎类型
// ============================================================
export type {
  FlowNodeType,
  Attractor,
  CheckCondition,
  LoopCondition,
  BranchRule,
  FlowNode,
  SkillFlow,
  FlowNodeStatus,
  FlowExecutionContext,
  FlowEvent,
  GranularityLevel,
  GranularityWarning,
  RunReactCallback,
  LlmJudgeCallback,
  EvaluateLoopConditionCallback,
  WaitForUserConfirmationCallback,
  EvaluateBranchCallback,
  SkillFlowRunParams,
} from './skill-flow-types.js';

// ============================================================
// Phase 49 Task 1.3：SkillFlow 引擎
// ============================================================
export { SkillFlowEngine } from './skill-flow-engine.js';

// ============================================================
// Phase 49 Task 1.7：吸因子引导层
// ============================================================
export { AttractorInjector } from './attractor.js';

// ============================================================
// Phase 49 Task 1.8：任务中断恢复
// ============================================================
export { SkillFlowCheckpointStore } from './skill-flow-checkpoint-store.js';

// ============================================================
// Phase 49 Task 1.9：节点粒度检查
// ============================================================
export { NodeGranularityChecker } from './node-granularity-checker.js';

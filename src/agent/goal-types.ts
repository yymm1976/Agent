// src/agent/goal-types.ts
// /goal 命令的目标分解与验证相关类型

/** 单个步骤的状态 */
export type GoalStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/** 目标计划中的单个步骤 */
export interface GoalStep {
  /** 步骤 ID（1, 2, 3...） */
  id: number;
  /** 步骤描述（给 LLM 看的 user message） */
  description: string;
  /** 步骤状态 */
  status: GoalStepStatus;
  /** 步骤执行结果摘要（assistant 回复前 200 字） */
  result?: string;
  /** 失败原因 */
  error?: string;
  /** 依赖的步骤 ID（必须按顺序完成） */
  dependencies: number[];
}

/** 目标计划的状态 */
export type GoalPlanStatus = 'parsing' | 'pending' | 'executing' | 'verifying' | 'completed' | 'failed';

/** 目标计划 */
export interface GoalPlan {
  /** 用户输入的目标描述 */
  description: string;
  /** 用户提供的验证条件（可空） */
  verificationCriteria?: string;
  /** 分解后的步骤 */
  steps: GoalStep[];
  /** 计划状态 */
  status: GoalPlanStatus;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 验证结果 */
  verificationResult?: VerificationResult;
}

/** 验证结果 */
export interface VerificationResult {
  /** 是否通过 */
  passed: boolean;
  /** 置信度 (0-1) */
  confidence: number;
  /** 验证推理过程 */
  reasoning: string;
  /** 缺失项（未完成的部分） */
  missingItems: string[];
  /** 改进建议 */
  suggestions: string[];
}

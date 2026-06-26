// src/agent/goal-types.ts
// /goal 命令的目标分解与验证相关类型

/** 单个步骤的状态 */
type GoalStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/** 步骤状态别名（蓝图称 StepStatus，与 GoalStepStatus 等价） */
export type StepStatus = GoalStepStatus;

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
  /** 步骤开始执行时间戳（毫秒） */
  startedAt?: number;
  /** 步骤结束（完成/失败/跳过）时间戳（毫秒） */
  completedAt?: number;
  /** 步骤执行过程中修改的文件列表（Phase 32 Task 1.4：供 CompletionGate 验证使用） */
  modifiedFiles?: string[];
}

/** 计划步骤别名（蓝图称 PlanStep，与 GoalStep 等价） */
export type PlanStep = GoalStep;

/** 目标计划的状态 */
export type GoalPlanStatus = 'parsing' | 'pending' | 'executing' | 'verifying' | 'completed' | 'failed';

/** 目标计划 */
export interface GoalPlan {
  /** 唯一 ID（UUID 短格式） */
  id: string;
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
  /**
   * 对抗性验证质疑（Phase 21 Task 4 新增，可选）
   * 由独立 LLM 审查员尝试推翻结论时产生，不影响 passed 字段
   */
  challenges?: Challenge[];
}

/**
 * 对抗性验证质疑（Phase 21 Task 4）
 * 由独立 LLM 审查员尝试推翻结论时产生
 */
export interface Challenge {
  /** 严重度 0-1（1 最严重） */
  severity: number;
  /** 质疑描述 */
  description: string;
  /** 改进建议（可选） */
  suggestion?: string;
}

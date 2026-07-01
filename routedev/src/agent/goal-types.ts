// src/agent/goal-types.ts
// /goal 命令的目标分解与验证相关类型

/** 单个步骤的状态 */
import type { DifficultyAssessment } from './difficulty-assessor.js';

type GoalStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/** 步骤所属领域（小写枚举，大小写不敏感比较时统一转 lowercase） */
export type Domain = 'frontend' | 'backend' | 'config' | 'docs' | 'database' | 'infra' | 'test' | 'general';

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
  /**
   * 验收标准（Phase 54 Task 3：供 GoalAuditor 三层验收与协作剧场面板展示使用）
   * 由 GoalParser.generateAcceptanceCriteria 生成，要求具体可验证
   */
  acceptanceCriteria?: string;
  /**
   * Phase 54：建议的子 Agent 角色（供 Orchestrator 分配 Worker 时使用）
   * 由 GoalParser 拆分时 LLM 输出，未输出时由 orchestrator.heuristicPlan 按关键词推断
   * 取值：'researcher' | 'executor' | 'reviewer'（对应 builtin-templates 三模板）
   */
  suggestedRole?: 'researcher' | 'executor' | 'reviewer';
  /**
   * 步骤所属领域（Phase 55：供 ExecutionRouter 判定路径用）
   * 由 GoalParser 拆分时 LLM 输出，缺失时由 sanitizeSteps 兜底为 'general'
   */
  domain: Domain;
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
  /** Phase 55：去重后的领域列表（ExecutionRouter 判定用，由 GoalParser 填充） */
  uniqueDomains?: Domain[];
  /** Phase 55：是否存在依赖关系（ExecutionRouter 判定用，由 GoalParser 填充） */
  hasDependencies?: boolean;
  /** 计划状态 */
  status: GoalPlanStatus;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 验证结果 */
  verificationResult?: VerificationResult;
  attestation?: PlanAttestation;
  archivedVersions?: ArchivedPlanVersion[];
  difficultyAssessment?: DifficultyAssessment;
}

export interface PlanAttestation {
  hash: string;
  version: number;
  attestedAt: number;
  attestedBy: string;
}

export interface ArchivedPlanVersion {
  attestation: PlanAttestation;
  planSnapshot: Pick<GoalPlan, 'id' | 'description' | 'verificationCriteria' | 'steps' | 'createdAt'>;
  archiveReason: string;
  archivedAt: number;
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

// ============================================================
// Phase 54：Goal 执行结构化事件（供渲染层 GoalExecutionCard 消费）
// 数据流：goal-runner.onGoalEvent → engine-bridge → IPC goal:event → store → GoalExecutionCard
// 设计原则：与 addSystemMessage 并存，CLI 端仍用文本输出，Electron 端消费结构化数据
// 类型定义放在 src/ 下（rootDir 内），desktop/shared/ipc-types.ts 从此处 re-import，
// 避免 src/ 反向引用 desktop/ 触发 TS6059 rootDir 错误
// ============================================================

/** Goal 执行步骤状态（渲染层展示用，与 GoalStepStatus 不同——此为运行时状态） */
export type GoalEventStepStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Goal 整体执行状态 */
export type GoalExecutionStatus = 'running' | 'completed' | 'failed';

/** Goal 执行事件联合类型——每个事件携带 goalId 供渲染层聚合 */
export type GoalEvent =
  | {
      type: 'plan_created';
      goalId: string;
      description: string;
      steps: { id: number; description: string }[];
      autonomyMode: string;
      verificationCriteria?: string;
    }
  | { type: 'plan_confirmed'; goalId: string }
  | {
      type: 'step_update';
      goalId: string;
      stepId: number;
      status: GoalEventStepStatus;
      error?: string;
      durationMs?: number;
    }
  | {
      type: 'agent_activity';
      goalId: string;
      stepId: number;
      role: string;
      activity: string;
      timestamp: number;
    }
  | {
      type: 'verification';
      goalId: string;
      passed: boolean;
      confidence: number;
      reasoning: string;
      missingItems: string[];
    }
  | {
      type: 'done';
      goalId: string;
      success: boolean;
      totalDurationMs: number;
      summary: string;
    };

// src/agent/task-orchestrator-types.ts
// Phase 31 Task 1：统一工作流编排的类型定义
// 所有非命令输入先经过 TaskOrchestrator，由它判定 intent 并分发到对应流程

import type { ClassificationResult, RoutingResult, TokenUsageInfo } from '../router/types.js';
import type { GoalPlan, VerificationResult } from './goal-types.js';
import type { ReActEvent } from './loop-config.js';

// --- TaskIntent：任务意图（4 种） ---

/**
 * 任务意图——决定走哪条执行路径
 * - quick_answer: 简单问答、状态查询，直达 ChatRunner
 * - development: 开发任务，走完整流水线
 * - explicit_goal: 用户用了 /goal，走现有 GoalRunner
 * - planning: 用户只想规划不执行
 */
export type TaskIntent = 'quick_answer' | 'development' | 'explicit_goal' | 'planning';

// --- OrchestratorStage：状态机阶段 ---

/**
 * 编排器状态机的阶段
 * idle → understanding → confirming_requirements → planning → executing → reviewing → completed
 */
export type OrchestratorStage =
  | 'idle'
  | 'understanding'
  | 'confirming_requirements'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'completed';

// --- RequirementsSummary：需求摘要（阶段2产出） ---

/**
 * 需求摘要——LLM 生成的结构化需求理解
 */
export interface RequirementsSummary {
  /** 一句话目标描述 */
  goal: string;
  /** 涉及的文件/模块 */
  scope: string[];
  /** 约束条件（如"不修改 API 接口"） */
  constraints: string[];
  /** 验收标准 */
  acceptanceCriteria: string[];
  /** 预估复杂度 */
  estimatedComplexity: 'low' | 'medium' | 'high';
}

// --- StepComplexity：步骤复杂度（阶段3产出） ---

/**
 * 单个步骤的复杂度评估
 */
export interface StepComplexity {
  stepId: number;
  complexity: 'simple' | 'medium' | 'complex';
  /** 预估涉及文件数 */
  estimatedFiles: number;
  /** 是否需要子 Agent */
  needsSubAgent: boolean;
  /** 推荐的 Worker 角色 */
  recommendedRole: WorkerRole;
  /** 是否可以并行 */
  parallelizable: boolean;
  /** 依赖的步骤 ID */
  dependencies: number[];
}

// 复用 multi/types.ts 的 WorkerRole，但为避免循环依赖在此重新声明
export type WorkerRole = 'coder' | 'searcher' | 'tester' | 'reviewer';

// --- ClarifyingQuestion：澄清问题（阶段2主动追问） ---

/**
 * 澄清问题——当需求不明确时 LLM 生成的提问
 */
export interface ClarifyingQuestion {
  id: number;
  question: string;
  /** 可选的选项列表（空表示自由输入） */
  options?: string[];
}

// --- RequirementsEvent：需求确认阶段的事件 ---

/**
 * 需求确认阶段的异步事件
 */
export type RequirementsEvent =
  | { type: 'summary'; summary: RequirementsSummary; needsConfirmation: boolean }
  | { type: 'questions'; questions: ClarifyingQuestion[] }
  | { type: 'confirmed'; summary: RequirementsSummary }
  | { type: 'skipped'; reason: string };

// --- StepExecutionResult：单步骤执行结果 ---

/**
 * 单个步骤的执行结果
 */
export interface StepExecutionResult {
  stepId: number;
  success: boolean;
  /** 步骤结论（Worker 的 conclusion 或单 Agent 的最终输出） */
  conclusion: string;
  /** 修改的文件列表 */
  modifiedFiles: string[];
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** Token 消耗 */
  tokenUsage: TokenUsageInfo;
  /** 失败原因（success=false 时） */
  error?: string;
}

// --- TaskCompletionSummary：任务完成摘要 ---

/**
 * 任务完成时的摘要——用于 UI 显示
 */
export interface TaskCompletionSummary {
  intent: TaskIntent;
  goal: string;
  /** 完成步骤数 / 总步骤数 */
  stepsCompleted: number;
  stepsTotal: number;
  /** 审查是否通过 */
  reviewPassed: boolean;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
  /** 总 Token 消耗 */
  totalTokenUsage: TokenUsageInfo;
  /** 修改的文件列表 */
  modifiedFiles: string[];
  /** 失败的步骤 ID */
  failedStepIds: number[];
  /** 跳过的步骤 ID（如预算耗尽） */
  skippedStepIds: number[];
}

// --- TaskContext：任务上下文（贯穿整个流水线） ---

/**
 * 任务上下文——在流水线各阶段间传递的状态
 */
export interface TaskContext {
  intent: TaskIntent;
  userInput: string;
  classification: ClassificationResult;
  routing: RoutingResult;
  /** 阶段2填充 */
  requirements?: RequirementsSummary;
  /** 阶段3填充 */
  plan?: GoalPlan;
  /** 阶段3填充 */
  complexityMap?: Map<number, StepComplexity>;
  /** 阶段4填充 */
  executionResults?: StepExecutionResult[];
  /** 阶段5填充 */
  reviewResult?: VerificationResult;
  startedAt: number;
  completedAt?: number;
}

// --- OrchestratorAction：handle 的返回值 ---

/**
 * TaskOrchestrator.handle() 的返回值——告诉 App.tsx 接下来该做什么
 */
export type OrchestratorAction =
  | { type: 'direct_chat'; runner: 'chat'; input: string }
  | { type: 'pipeline_start'; intent: TaskIntent; input: string }
  | { type: 'requirements_question'; questions: string[] }
  | { type: 'plan_ready'; plan: GoalPlan; complexityMap: Map<number, StepComplexity> }
  | { type: 'execution_progress'; stepId: number; total: number; event: ReActEvent }
  | { type: 'review_result'; passed: boolean; summary: string }
  | { type: 'completed'; summary: TaskCompletionSummary };

// --- SteeringMessage：转向队列消息 ---

/**
 * 转向队列消息——用户在 Agent 工作时补充的指令
 */
export interface SteeringMessage {
  /** 消息内容 */
  content: string;
  /** 交付时机 */
  mode: 'immediate' | 'next_iteration' | 'after_current_step';
  /** 入队时间戳 */
  enqueuedAt: number;
}

// --- ProjectContext：项目上下文（传给 classifier 和需求确认） ---

/**
 * 项目上下文——传给 classifier 改善分类准确度
 */
export interface ProjectContext {
  projectType?: string;
  recentTools?: string[];
  hasGitChanges?: boolean;
}

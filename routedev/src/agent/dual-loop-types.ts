// src/agent/dual-loop-types.ts
// Phase 49 Task 2：双循环编排器类型定义
//
// 双循环结构：
//   - 内循环（Inner Loop）：ReAct 完成任务（执行 Agent）
//   - 外循环（Outer Loop）：独立验证审核结果（验证 Agent）
//   - 验证不通过 → 打回重跑（形成闭环）
//
// Loop 五模块对应：
//   - 目标来源：goal.plan + goal.gates
//   - 执行 Agent：内循环 ReActAgentLoop
//   - 验证 Agent：GoalVerifier + CompletionGate + 跨模型审查
//   - 记忆：LoopMemory（失败原因沉淀）
//   - 终止条件：外循环通过 OR 达到最大重跑次数

import type { ReActEvent } from './loop-config.js';
import type { ReActRunParams, ReActAgentLoop } from './loop.js';
import type { GoalVerifier, GoalVerifierOptions } from './goal-verifier.js';
import type { CompletionGate, GateResult } from './completion-gate.js';
import type { VerificationResult } from './goal-types.js';
import type { FrozenGates } from './goal-gates.js';
import type { CodeReviewResult, CodeReviewIssue } from './unified-reviewer.js';
import type { TokenUsageInfo } from '../router/types.js';

/** /goal 目标上下文（从 goal-parser 传入） */
export interface DualLoopGoal {
  /** 目标描述 */
  description: string;
  /** 目标计划（含步骤） */
  plan: import('./goal-types.js').GoalPlan;
  /** 项目根路径（供 CompletionGate 使用） */
  projectPath: string;
  /** 冻结的验收门控（可选） */
  gates?: FrozenGates;
}

/** 双循环运行参数 */
export interface DualLoopParams {
  /** 目标上下文 */
  goal: DualLoopGoal;
  /** 内循环 ReAct 运行参数（llmClient/userMessage 等） */
  reactParams: ReActRunParams;
  /** 内循环 ReAct 引擎实例 */
  reactLoop: ReActAgentLoop;
  /** GoalVerifier 实例 */
  goalVerifier: GoalVerifier;
  /** GoalVerifier 选项 */
  verifierOptions: GoalVerifierOptions;
  /** CompletionGate 实例 */
  completionGate: CompletionGate;
  /** 跨模型审查器（可选；不传则跳过跨模型审查） */
  crossModelReviewer?: CrossModelReviewerLike;
  /**
   * 最大重跑次数
   * 陷阱 #141：默认 2 而非 3，避免 Token 爆炸
   */
  maxReruns?: number;
  /**
   * 人工修改检测器（可选）
   * 2.5 节"让 AI 自己改"约束：检测到人工修改则停止自动重跑
   * 返回 true 表示检测到非内循环产出的人工修改
   */
  humanInterventionDetector?: () => Promise<boolean> | boolean;
}

/** 跨模型审查器接口（用于依赖注入） */
export interface CrossModelReviewerLike {
  /** 执行跨模型审查 */
  review(params: CrossModelReviewParams): Promise<CodeReviewResult>;
}

/** 跨模型审查参数 */
export interface CrossModelReviewParams {
  /** 修改的文件列表 */
  modifiedFiles: string[];
  /** 内循环执行摘要 */
  executionSummary: string;
  /** 原始目标描述 */
  goalDescription: string;
}

/** 内循环执行结果 */
export interface InnerLoopResult {
  /** 最终文本输出 */
  content: string;
  /** Token 消耗 */
  usage: TokenUsageInfo;
  /** 修改的文件列表（从工具调用中收集） */
  modifiedFiles: string[];
}

/** 外循环失败时记录的失败原因 */
export interface LoopFailure {
  /** 失败发生的迭代序号（从 1 开始） */
  iteration: number;
  /** 失败原因（人类可读） */
  reason: string;
  /** GoalVerifier 报告的缺失项 */
  missingItems: string[];
  /** CompletionGate 中失败的检查项 */
  gateFailures: import('./completion-gate.js').GateCheck[];
  /** 跨模型审查发现的问题 */
  reviewIssues: CodeReviewIssue[];
}

/** 双循环输出事件联合类型 */
export type DualLoopEvent =
  /** 内循环开始（每次重跑都触发） */
  | { type: 'inner-loop-start'; iteration: number }
  /** 内循环透传事件（ReAct 事件） */
  | { type: 'inner-loop-event'; event: ReActEvent; iteration: number }
  /** 内循环完成，准备进入外循环验证 */
  | { type: 'inner-loop-complete'; iteration: number; result: InnerLoopResult }
  /** 外循环验证开始 */
  | { type: 'outer-loop-start'; iteration: number }
  /** 外循环验证失败，准备打回重跑 */
  | {
      type: 'outer-loop-failed';
      iteration: number;
      reason: string;
      suggestion: string;
      verification: VerificationResult;
      gateResult: GateResult;
      crossModelReview?: CodeReviewResult;
    }
  /** 外循环验证通过，双循环正常完成 */
  | {
      type: 'dual-loop-complete';
      iteration: number;
      verification: VerificationResult;
      gateResult: GateResult;
      crossModelReview?: CodeReviewResult;
      totalUsage: TokenUsageInfo;
    }
  /** 达到最大重跑次数仍失败，终止并报告 */
  | {
      type: 'dual-loop-exhausted';
      maxReruns: number;
      finalMemory: LoopFailure[];
    }
  /**
   * 检测到人工介入（git diff 非内循环产出）
   * 2.5 节"让 AI 自己改"约束：停止自动重跑，提示用户接管
   */
  | { type: 'human-intervention-detected'; iteration: number; message: string }
  /**
   * 连续 maxReruns 次同一原因失败，提示用户接管
   * 2.5 节例外：AI 已陷入死循环，允许用户接管（Pilot 模式）
   */
  | { type: 'pilot-mode-triggered'; iteration: number; repeatedReason: string };

/** 双循环外循环仲裁结果 */
export interface OuterLoopEvaluation {
  passed: boolean;
  reason: string;
}

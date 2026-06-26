// src/skills/skill-flow-types.ts
// SkillFlow 引擎类型定义（Phase 49 Task 1 — Skill 固化阶段 2）
//
// 设计目标（蓝图 1.2 节）：
//   1. 把 Skill 从"提示词层面"升级为"被引擎控制的可执行流水线"
//   2. 每次只发一步，AI 看不到后续步骤，防止跳步
//   3. 步骤间插入 checkpoint / user-gate / loop / branch 节点
//   4. 通过依赖注入接口与 ReActAgentLoop 解耦，便于测试
//
// 与 ReActAgentLoop 的关系：
//   - SkillFlow 不替代 ReAct 循环，而是包裹它
//   - 每个节点的执行 = 一次 ReAct 循环（可能多轮工具调用）
//   - SkillFlow 控制节点间的流转，ReAct 控制节点内的工具调用

import type { ReActRunParams } from '../agent/loop.js';
import type { ReActEvent } from '../agent/loop-config.js';
import type { HandoffArtifact } from '../agent/multi/handoff.js';

// ============================================================
// 节点定义
// ============================================================

/** 流水线节点类型 */
export type FlowNodeType =
  | 'step'           // 普通执行步骤：AI 做事
  | 'checkpoint'     // 检查节点：验证上一步输出是否达标
  | 'user-gate'      // 用户控制节点：暂停等待用户确认
  | 'loop'           // 循环节点：重复执行直到条件满足
  | 'branch';        // 分支节点：根据条件走不同路径

/** 吸因子引导层（蓝图 1.7 节）——引导而非约束 */
export interface Attractor {
  /** 期望产出的画像描述 */
  desiredOutput?: string;
  /** 风格样本路径（打样文件） */
  styleSample?: string;
  /** 明确的完成判定标准（给 AI 看的"做到什么程度算成功"） */
  doneCriteria?: string;
}

/** 检查条件定义（checkpoint 节点专用） */
export interface CheckCondition {
  /** 条件类型 */
  kind: 'llm-judge' | 'regex-match' | 'tool-output-contains';
  /** LLM judge 时的判断 prompt */
  judgePrompt?: string;
  /** regex-match 时的正则 */
  pattern?: string;
  /** tool-output-contains 时的工具名 */
  toolName?: string;
  /** tool-output-contains 时的关键词 */
  keyword?: string;
}

/** 循环条件定义（loop 节点专用） */
export interface LoopCondition {
  /** 何时继续循环 */
  while: string;
  /** 最大循环次数（防止无限循环） */
  maxIterations: number;
}

/** 分支条件定义（branch 节点专用） */
export interface BranchRule {
  /** 条件描述 */
  condition: string;
  /** 目标节点 ID */
  targetNodeId: string;
}

/** 流水线节点定义 */
export interface FlowNode {
  /** 节点 ID（唯一） */
  id: string;
  /** 节点类型 */
  type: FlowNodeType;
  /** 节点标题 */
  title: string;
  /** 节点提示词（注入到 AI 的指令） */
  prompt: string;
  /** 工具白名单（空数组 = 继承 Skill 级别权限；null = 全工具） */
  allowedTools?: string[];
  /** checkpoint 专用：检查条件 */
  checkCondition?: CheckCondition;
  /** user-gate 专用：向用户展示的确认信息 */
  gateMessage?: string;
  /** loop 专用：循环条件 + 最大次数 */
  loopCondition?: LoopCondition;
  /** branch 专用：分支条件 */
  branches?: BranchRule[];
  /** 失败时的动作 */
  onFailure: 'retry' | 'abort' | 'goto';
  /** onFailure=goto 时的目标节点 */
  onFailureGoto?: string;
  /** 最大重试次数（onFailure=retry 时） */
  maxRetries?: number;
  /** 吸因子引导（可选）——引导而非约束 */
  attractor?: Attractor;
}

// ============================================================
// SkillFlow 定义
// ============================================================

/** Skill 的固化流水线定义 */
export interface SkillFlow {
  /** 节点列表（有序） */
  nodes: FlowNode[];
  /** 入口节点 ID */
  entryNodeId: string;
  /** 终止节点 ID（到达即完成） */
  exitNodeId: string;
  /** 全局工具白名单（所有节点继承） */
  globalAllowedTools?: string[];
  /** 全局最大迭代次数（防止失控） */
  maxTotalIterations: number;
}

// ============================================================
// 运行时状态
// ============================================================

/** SkillFlow 运行状态 */
export type FlowNodeStatus =
  | 'pending'        // 未开始
  | 'running'        // 执行中
  | 'passed'         // 已通过
  | 'failed'         // 失败
  | 'skipped'        // 跳过
  | 'user-pending';  // 等待用户确认

/** SkillFlow 执行上下文 */
export interface FlowExecutionContext {
  /** 当前节点 ID */
  currentNodeId: string;
  /** 各节点状态 */
  nodeStates: Map<string, FlowNodeStatus>;
  /** 各节点输出 */
  nodeOutputs: Map<string, string>;
  /** 总迭代次数 */
  totalIterations: number;
  /** 循环节点的当前迭代计数 */
  loopCounters: Map<string, number>;
  /** 交接产物（步骤间传递） */
  handoffArtifacts: Map<string, HandoffArtifact>;
}

// ============================================================
// 事件流
// ============================================================

/** SkillFlow 事件类型 */
export type FlowEvent =
  | { type: 'node-start'; node: FlowNode }
  | { type: 'node-complete'; node: FlowNode; output: string }
  | { type: 'node-failed'; node: FlowNode; error: string }
  | { type: 'node-skipped'; node: FlowNode; reason: string }
  | { type: 'checkpoint-passed'; node: FlowNode }
  | { type: 'checkpoint-failed'; node: FlowNode }
  | { type: 'user-gate'; node: FlowNode; message: string }
  | { type: 'loop-iteration'; node: FlowNode; iteration: number }
  | { type: 'loop-exhausted'; node: FlowNode; maxIterations: number }
  | { type: 'flow-aborted'; reason: string }
  | { type: 'flow-error'; error: string }
  | { type: 'flow-complete' }
  | { type: 'react-event'; node: FlowNode; event: ReActEvent };

// ============================================================
// 粒度检查（蓝图 1.9 节）
// ============================================================

/** 粒度警告级别 */
export type GranularityLevel = 'too-coarse' | 'too-fine';

/** 粒度检查结果 */
export interface GranularityWarning {
  /** 节点 ID */
  nodeId: string;
  /** 警告级别 */
  level: GranularityLevel;
  /** 警告信息 */
  message: string;
}

// ============================================================
// 依赖注入参数（蓝图 1.3 节关键设计）
// ============================================================

/**
 * runReact 回调签名
 *
 * 把 ReActAgentLoop.run(params) 的调用抽象为回调，
 * SkillFlow 不直接依赖 ReActAgentLoop，便于测试时 mock。
 * 接收 ReActRunParams（已注入当前节点 systemPrompt）+ 节点级工具白名单，
 * 返回 ReAct 事件流。
 *
 * allowedTools 由调用方决定如何强制限制（如过滤 ToolExecutor 的工具定义）。
 */
export type RunReactCallback = (
  params: ReActRunParams,
  allowedTools?: string[],
) => AsyncGenerator<ReActEvent>;

/** LLM Judge 回调——用独立 LLM 判断输出是否满足条件 */
export type LlmJudgeCallback = (
  judgePrompt: string,
  output: string,
) => Promise<boolean>;

/** 循环条件评估回调——判断是否继续循环 */
export type EvaluateLoopConditionCallback = (
  whileCondition: string,
  lastOutput: string,
) => Promise<boolean>;

/** 等待用户确认回调——返回 'approve' 或 'reject' */
export type WaitForUserConfirmationCallback = (
  nodeId: string,
  gateMessage: string,
) => Promise<'approve' | 'reject'>;

/** 分支条件评估回调——返回目标节点 ID */
export type EvaluateBranchCallback = (
  branches: BranchRule[],
  lastOutput: string,
) => Promise<string>;

/**
 * SkillFlow 运行参数（依赖注入接口）
 *
 * 关键设计：不直接依赖 ReActAgentLoop，通过回调注入依赖：
 *   - runReact：执行 ReAct 循环（必须）
 *   - llmJudge：checkpoint 的 llm-judge 检查（必须）
 *   - evaluateLoopCondition：loop 节点的条件评估（必须）
 *   - waitForUserConfirmation：user-gate 节点的用户确认（必须）
 *   - evaluateBranch：branch 节点的分支选择（必须）
 *
 * 这些回调让 SkillFlow 与外部 LLM/UI 完全解耦，便于测试 mock。
 */
export interface SkillFlowRunParams {
  /** 基础 ReAct 运行参数（含 userMessage / llmClient / routeDecision / conversationHistory 等） */
  baseParams: ReActRunParams;
  /** 执行 ReAct 循环的回调 */
  runReact: RunReactCallback;
  /** LLM Judge 回调 */
  llmJudge: LlmJudgeCallback;
  /** 循环条件评估回调 */
  evaluateLoopCondition: EvaluateLoopConditionCallback;
  /** 用户确认回调 */
  waitForUserConfirmation: WaitForUserConfirmationCallback;
  /** 分支评估回调 */
  evaluateBranch: EvaluateBranchCallback;
}

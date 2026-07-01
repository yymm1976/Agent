// src/agent/self-evolution/types.ts
// Phase 52 Task 5：自进化统一框架——类型定义
//
// 来自 Self-Evolving AI Agents Survey (arXiv 2508.07407) 的四组件模型：
//   System Inputs → Agent System → Environment → Optimisers → (反馈到 Agent System)
//
// RouteDev 映射：
//   System Inputs  = 用户任务 + 执行反馈 + 环境信号（token/耗时/错误）
//   Agent System   = 基础模型(路由) + Prompt + Memory(LoopMemory/SkillMemory)
//                    + 工具(工具注册) + 工作流(SkillFlow) + 通信(子Agent)
//   Environment    = 执行环境(沙箱/文件系统/终端)
//   Optimisers     = SkillOptimizer + PromptOptimizer + MemoryOptimizer（本框架统一调度）
//
// 本文件定义自进化框架的核心类型，与 src/config/schema.ts 中 SelfEvolutionSchema 对齐。

// ============================================================
// 自进化信号
// ============================================================

/**
 * 自进化信号——从各信号源收集的反馈
 *
 * source 映射：
 *   loop_memory    — 来自 LoopMemory 的失败记录
 *   skill_memory   — 来自 SkillMemory 的失败模式/成功路径
 *   score_card     — 来自 ScoreCard 的质量评分
 *   process_defect — 来自工程验证/审查的缺陷
 *   user_feedback  — 来自用户的拒绝/接受反馈
 *
 * type 映射：
 *   failure         — 执行失败
 *   quality_drop    — 质量下降
 *   success_pattern — 成功模式（可用于强化）
 *   inefficiency    — 低效（耗时/token 超标）
 *   user_rejection  — 用户拒绝结果
 */
export interface EvolutionSignal {
  source: 'loop_memory' | 'skill_memory' | 'score_card' | 'process_defect' | 'user_feedback';
  type: 'failure' | 'quality_drop' | 'success_pattern' | 'inefficiency' | 'user_rejection';
  severity: 'low' | 'medium' | 'high';
  description: string;
  /** 原始数据载荷（结构由 source 决定，调用方按 source 解释） */
  data: unknown;
  /** 时间戳（ms） */
  timestamp: number;
}

// ============================================================
// 优化目标
// ============================================================

/**
 * 优化目标层——Agent System 的可优化组件
 *
 * 映射到 Self-Evolving AI Agents Survey 的 Agent System 组件：
 *   prompt         — system prompt（基础模型的提示）
 *   memory         — 记忆策略（LoopMemory/SkillMemory 的保留/淘汰/注入）
 *   tools          — 工具配置（工具注册/选择）
 *   workflow       — 工作流（SkillFlow 定义）
 *   communication  — 通信（子 Agent 配置/协作）
 */
export type OptimizationTarget = 'prompt' | 'memory' | 'tools' | 'workflow' | 'communication';

// ============================================================
// 优化提案
// ============================================================

/**
 * 单项拟修改内容
 */
export interface ProposedChange {
  type: 'add' | 'modify' | 'remove';
  /** 拟修改的目标标识（如 'system-prompt'、'memory-strategy'） */
  target: string;
  description: string;
}

/**
 * 优化提案——自进化框架产出的优化建议
 *
 * 安全约束（Gödel 安全版思想）：
 *   - 框架仅"产出建议"，不自动应用
 *   - applied=false 的提案需用户/上层审批后才标记 applied=true
 *   - id 由 generateProposalId() 生成，用于跨模块追踪
 */
export interface OptimizationProposal {
  /** 提案 ID（由 generateProposalId 生成） */
  id: string;
  target: OptimizationTarget;
  description: string;
  /** 基于哪些信号（人类可读） */
  rationale: string;
  expectedImpact: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
  proposedChanges: ProposedChange[];
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 是否已被应用（默认 false；markProposalApplied 后置 true） */
  applied: boolean;
}

// ============================================================
// 自进化配置
// ============================================================

/**
 * 自进化配置
 *
 * 陷阱：enabled 默认 false——自进化能力默认关闭，避免误改用户系统
 * 与 src/config/schema.ts 中 SelfEvolutionSchema 的默认值保持一致
 */
export interface SelfEvolutionConfig {
  enabled: boolean;
  /** 优化目标分层开关 */
  targets: {
    prompt: boolean;
    memory: boolean;
    tools: boolean;
    workflow: boolean;
    communication: boolean;
  };
  /** 反馈循环触发条件 */
  trigger: {
    /** 失败次数达到多少触发优化 */
    failureThreshold: number;
    /** 质量下降比例达到多少触发优化（0-1） */
    qualityDropThreshold: number;
    /** 多少次收集循环后触发优化评估 */
    evaluationInterval: number;
  };
}

/**
 * 默认自进化配置
 *
 * 与 Phase 52 设计文档 5.4 节 SelfEvolutionSchema 默认值对齐：
 *   - enabled: false（默认关闭）
 *   - targets: prompt/memory/workflow 默认开，tools/communication 默认关
 *   - trigger: failureThreshold=5, qualityDropThreshold=0.3, evaluationInterval=20
 */
export const DEFAULT_SELF_EVOLUTION_CONFIG: SelfEvolutionConfig = {
  enabled: false,
  targets: {
    prompt: true,
    memory: true,
    tools: false,
    workflow: true,
    communication: false,
  },
  trigger: {
    failureThreshold: 5,
    qualityDropThreshold: 0.3,
    evaluationInterval: 20,
  },
};

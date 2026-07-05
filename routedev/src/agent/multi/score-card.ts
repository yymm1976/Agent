// src/agent/multi/score-card.ts
// 审计层：记录每个步骤的执行质量指标，支撑 /quality 命令
//
// 解决问题：当前多 Agent 编排没有审计层，无法回答「这次执行花了多少 token？
// 测试通过率多少？用户采纳率多少？」等问题。
//
// ScoreCard 记录：
//   - tokenUsage：input/output/total
//   - durationMs：耗时
//   - toolCalls / fileEdits / testsRun / testsPassed
//   - lintErrors / typeErrors
//   - userFeedback：accepted/rejected/edited/pending
//
// ScoreCardCollector 聚合统计：
//   - totalSteps / totalTokens / totalDuration
//   - avgTestsPassed / acceptedRate
//   - formatReport()：格式化为 /quality 命令的展示文本

// Phase 52 Task 2/6 深度接入：过程级缺陷 + 架构感知指标
// ProcessDefect / DefectCategory 原定义于 src/evaluation/process-defect-ontology.ts，
// 该文件已被删除（其余导出无消费方），此处本地保留 ProcessDefect 接口以供 ScoreCard 使用。
import type { ComponentMetrics } from '../../evaluation/architecture-aware-metrics.js';

/**
 * 过程级缺陷分类（来自 ProcBench 论文的缺陷本体，共 10 类）
 */
export type DefectCategory =
  | 'tool_misuse'           // 工具误用（参数错误/选错工具）
  | 'context_loss'          // 上下文丢失（忘记前序信息）
  | 'step_skip'             // 步骤跳过（跳过必要步骤）
  | 'infinite_loop'         // 死循环
  | 'premature_termination' // 过早终止（声称完成但未完成）
  | 'scope_creep'           // 范围蔓延（做了不该做的）
  | 'recovery_failure'      // 恢复失败（出错后未能恢复）
  | 'hallucination'         // 幻觉（虚构工具结果/文件内容）
  | 'permission_violation'  // 权限违反
  | 'resource_exhaustion';  // 资源耗尽（token/时间超限）

/** 单条过程缺陷 */
export interface ProcessDefect {
  category: DefectCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 校准后的风险分（0-1，考虑频率和影响） */
  calibratedRisk: number;
  stepIndex: number;
  description: string;
  /** 日志片段证据 */
  evidence: string;
  /** 是否成功恢复 */
  recoveredFrom?: boolean;
}

/** 用户反馈类型 */
type UserFeedback = 'accepted' | 'rejected' | 'edited' | 'pending';

/** 单步骤的执行质量评分卡 */
export interface ScoreCard {
  stepId: string;
  role: string;
  modelId: string;
  tokenUsage: { input: number; output: number; total: number };
  durationMs: number;
  toolCalls: number;
  fileEdits: number;
  testsRun: number;
  testsPassed: number;
  lintErrors: number;
  typeErrors: number;
  userFeedback: UserFeedback;
  /**
   * Phase 52 Task 2 深度接入：过程级缺陷列表（可选）。
   * 由 buildCalibratedScorecard 等评估器产出，记录该步骤检测到的缺陷。
   * 未填充时为 undefined（向后兼容）。
   */
  processDefects?: ProcessDefect[];
  /**
   * Phase 52 Task 6 深度接入：架构感知指标（可选）。
   * 由 ArchitectureAwareMetricsCollector 产出，记录该步骤涉及的 6 个架构组件的指标。
   * 未填充时为 undefined（向后兼容）。
   */
  componentMetrics?: ComponentMetrics[];
}

/** 聚合统计结果 */
interface AggregateStats {
  totalSteps: number;
  totalTokens: number;
  totalDuration: number;
  avgTestsPassed: number;
  acceptedRate: number;
}

// NOTE: ScoreCardCollector class 已移除（死代码）。
// 生产环境使用 SubAgentScoreCardCollector（src/agents/sub-agent-score-card.ts）。
// 本文件仅保留 ScoreCard interface 供 OnlineMonitor 等模块消费。

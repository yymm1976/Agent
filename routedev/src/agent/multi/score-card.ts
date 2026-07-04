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
import type { ProcessDefect } from '../../evaluation/process-defect-ontology.js';
import type { ComponentMetrics } from '../../evaluation/architecture-aware-metrics.js';

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

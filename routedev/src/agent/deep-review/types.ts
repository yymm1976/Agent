// src/agent/deep-review/types.ts
// Phase 72：Deep Review 并行多 reviewer 类型定义

/** 审查维度（与 config/schema.ts 的 deepReviewFocuses 枚举对齐） */
export type ReviewFocus = 'correctness' | 'security' | 'performance' | 'style';

/** 单个 reviewer 的执行结果 */
export interface ReviewerReport {
  /** 该 reviewer 负责的审查维度 */
  focus: ReviewFocus;
  /** 是否成功完成（fail-open：失败不阻断整体流程） */
  success: boolean;
  /** reviewer 原始 markdown 输出 */
  output: string;
  /** 从 output 中解析出的问题计数 */
  issueCounts: { critical: number; major: number; minor: number; total: number };
  /** 失败时的错误信息（success=false 时填充） */
  error?: string;
  /** token 用量（可选，由 spawn_agent 返回） */
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** 执行耗时（毫秒） */
  durationMs: number;
}

/** 去重后的单个问题 */
export interface ReviewIssue {
  /** 来源 reviewer 的 focus 维度 */
  focus: ReviewFocus;
  /** 严重级别 */
  severity: 'critical' | 'major' | 'minor';
  /** 文件路径（可能为空——reviewer 无法定位时） */
  file?: string;
  /** 行号或行号范围（字符串保留灵活性，如 "12" 或 "12-15"） */
  line?: string;
  /** 问题描述 */
  description: string;
  /** 修复建议（可选） */
  suggestion?: string;
  /** 去重 key：file + line + description 前 80 字符的归一化 hash */
  dedupeKey: string;
}

/** 仲裁决策结果 */
export type ArbitrationDecision = 'approve' | 'request_changes' | 'reject' | 'inconclusive';

/** Deep Review 最终聚合结果 */
export interface DeepReviewResult {
  /** 各 reviewer 的原始报告（含失败报告） */
  reports: ReviewerReport[];
  /** 去重后的所有问题列表 */
  aggregatedIssues: ReviewIssue[];
  /** 仲裁决策 */
  arbitration: ArbitrationDecision;
  /** 汇总摘要（concat 或 LLM 生成） */
  summary: string;
  /** 风险评分（0-100） */
  riskScore: number;
  /** 是否真正触发了并行审查（未达阈值或功能关闭时为 false，调用方据此降级） */
  triggered: boolean;
  /** 总执行耗时（毫秒） */
  durationMs: number;
}

/** 仲裁策略字面量类型 */
export type ArbitrationStrategy =
  | 'critical-veto'
  | 'majority-vote'
  | 'highest-severity'
  | 'all-must-pass';

/** 聚合模式字面量类型 */
export type AggregateMode = 'concat' | 'llm-summary';

/** Deep Review 配置（从 WorkflowConfig 中提取，便于编排器单参数传入） */
export interface DeepReviewConfig {
  /** 总开关 */
  enabled: boolean;
  /** 启用的 focus 列表 */
  focuses: ReviewFocus[];
  /** 并行上限（MVP 串行实现，此字段保留供 P2 优化） */
  parallel: number;
  /** 仲裁策略 */
  arbitration: ArbitrationStrategy;
  /** 聚合模式 */
  aggregateMode: AggregateMode;
  /** 是否跨模型审查 */
  crossModel: boolean;
  /** 风险评分阈值（10-100） */
  riskThreshold: number;
  /** 审查模型 id；'auto' 表示由路由器或可用列表决定 */
  reviewModel: string;
  /** 审查严格度（注入到 prompt 中可调） */
  reviewStrictness: 'low' | 'medium' | 'high';
}

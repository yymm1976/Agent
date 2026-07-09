// src/harness/scorecard.ts
// Phase 77 Task 3：评分卡——对一次会话轨迹生成结构化质量评估
// 借鉴 HomeRail 的 `hr scorecard` 命令：verdict + 指标 + 检查项 + 质量信号

import type { TraceCollector } from './trace-collector.js';
import type { TraceSession, TraceSpan, TrajectorySummary } from './trace-types.js';

/** 单项检查 */
export interface ScorecardCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** 质量信号聚合（按 type+severity 计数） */
export interface ScorecardQualitySignal {
  type: string;
  severity: string;
  count: number;
}

/** 评分卡 */
export interface Scorecard {
  sessionId: string;
  goalId?: string;
  summary: TrajectorySummary;
  qualitySignals: ScorecardQualitySignal[];
  verdict: 'pass' | 'advisory' | 'fail';
  checks: ScorecardCheck[];
  generatedAt: string;
}

/**
 * 生成指定会话的评分卡
 * 从落盘的 session.json（goalId / totalUsage / 耗时）+ spans.json（token / 调用 / 重试统计）重建汇总
 */
export async function generateScorecard(
  traceCollector: TraceCollector,
  sessionId: string,
): Promise<Scorecard> {
  const [session, spans] = await Promise.all([
    traceCollector.readSession(sessionId),
    traceCollector.readSessionSpans(sessionId),
  ]);

  const summary = computeSummary(sessionId, session, spans);
  const checks = buildChecks(summary);
  const qualitySignals = collectQualitySignals(spans);
  const verdict = decideVerdict(summary, qualitySignals);

  const card: Scorecard = {
    sessionId,
    summary,
    qualitySignals,
    verdict,
    checks,
    generatedAt: new Date().toISOString(),
  };
  if (session?.goalId) {
    card.goalId = session.goalId;
  }
  return card;
}

// ===== 内部方法 =====

/** 从落盘 spans + session 重建 TrajectorySummary（与 TraceCollector.summarizeTrajectory 语义一致） */
function computeSummary(
  sessionId: string,
  session: TraceSession | null,
  spans: TraceSpan[],
): TrajectorySummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let llmCallCount = 0;
  let toolCallCount = 0;
  let retryCount = 0;
  let hasError = false;

  for (const span of spans) {
    const p = span.payload;
    if (p.type === 'llm_call') {
      llmCallCount++;
      const input = p.inputTokens ?? 0;
      const output = p.outputTokens ?? 0;
      totalInputTokens += input;
      totalOutputTokens += output;
      totalTokens += input + output;
    } else if (p.type === 'tool_call') {
      toolCallCount++;
      if (span.status === 'error' || p.isError) hasError = true;
    } else if (p.type === 'react_iteration') {
      // 与 summarizeTrajectory 一致：react_iteration 中包含错误观察计为一次重试意图
      if (p.observation?.isError) retryCount++;
    }
  }

  // session.totalUsage 更准确，以其为准
  if (session?.totalUsage) {
    totalInputTokens = session.totalUsage.inputTokens ?? totalInputTokens;
    totalOutputTokens = session.totalUsage.outputTokens ?? totalOutputTokens;
    totalTokens = session.totalUsage.totalTokens ?? totalTokens;
  }

  const startTime = session?.startTime ?? 0;
  const endTime = session?.endTime ?? startTime;
  const durationMs = startTime > 0 ? Math.max(0, endTime - startTime) : 0;
  const success = !hasError;
  const terminationReason: TrajectorySummary['terminationReason'] = success
    ? 'completed'
    : 'error';
  const firstAttemptSuccessRate =
    retryCount === 0 ? 1 : Math.max(0, 1 / (retryCount + 1));

  return {
    taskId: sessionId,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCost: 0,
    toolCallCount,
    llmCallCount,
    retryCount,
    firstAttemptSuccessRate,
    durationMs,
    success,
    terminationReason,
  };
}

/** 构建检查项列表 */
function buildChecks(s: TrajectorySummary): ScorecardCheck[] {
  return [
    {
      name: '首次成功率',
      passed: s.firstAttemptSuccessRate >= 0.8,
      detail: `${Math.round(s.firstAttemptSuccessRate * 100)}%`,
    },
    {
      name: '重试次数',
      passed: s.retryCount <= 2,
      detail: `${s.retryCount} 次`,
    },
    {
      name: '执行成功',
      passed: s.success,
      detail: s.success ? '成功' : '失败',
    },
    {
      name: 'Token 使用',
      passed: s.totalTokens <= 100000,
      detail: `${s.totalTokens} tokens`,
    },
  ];
}

/** 从 spans 派生质量信号：error 状态 span = high，tool_call isError = medium */
function collectQualitySignals(spans: TraceSpan[]): ScorecardQualitySignal[] {
  const map = new Map<string, ScorecardQualitySignal>();
  for (const span of spans) {
    if (span.status === 'error') {
      const key = `error:${span.type}`;
      const existing = map.get(key);
      if (existing) {
        existing.count++;
      } else {
        map.set(key, { type: `${span.type}_error`, severity: 'high', count: 1 });
      }
      continue;
    }
    const p = span.payload;
    if (p.type === 'tool_call' && p.isError) {
      const key = 'tool_call:isError';
      const existing = map.get(key);
      if (existing) {
        existing.count++;
      } else {
        map.set(key, { type: 'tool_call_failed', severity: 'medium', count: 1 });
      }
    }
  }
  return Array.from(map.values());
}

/** verdict 判定：fail > advisory > pass */
function decideVerdict(
  s: TrajectorySummary,
  signals: ScorecardQualitySignal[],
): 'pass' | 'advisory' | 'fail' {
  const hasHigh = signals.some((sig) => sig.severity === 'high');
  if (!s.success || hasHigh) return 'fail';
  if (s.retryCount > 2 || signals.some((sig) => sig.severity === 'medium')) {
    return 'advisory';
  }
  return 'pass';
}

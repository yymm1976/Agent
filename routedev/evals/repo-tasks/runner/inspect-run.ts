// evals/repo-tasks/runner/inspect-run.ts
// GA Infrastructure Sprint TASK 2：RunEventLog Forensic Inspector
//
// read-only forensic CLI：解析单个 eval run report（含 artifact.runEventLog +
// artifact.toolTrajectory），生成结构化 timeline，检测事件流生命周期不变量违规，
// 统计运行指标，并对 trajectory 与 EventLog 做 cross-validation。
//
// 检测项（11 类）：
//   SEQ_NON_CONTIGUOUS        sequence 不连续（append-only 被破坏）
//   DUP_EVENT_ID              事件 id 重复
//   DUP_TOOL_EXEC             同一 toolCallId 执行两次
//   TOOL_NO_TERMINAL          tool_requested 无终态（tool_completed/tool_rejected）
//   TOOL_TERMINAL_NO_REQUEST  tool_completed/tool_rejected 无对应 tool_requested
//   TOOL_AFTER_CANCEL         取消后的工具事件
//   TOOL_AFTER_RUN_END        run 结束后的工具事件
//   LLM_AFTER_RUN_END         run 结束后的 LLM 事件
//   RUN_END_CONTRADICTION     run_completed 与 run_interrupted 同时出现
//   RETRY_INCONSISTENCY       llm_retry/failed/succeeded 与 llm_requested 的 attempt 序列矛盾
//   TRAJECTORY_MISMATCH       toolTrajectory 与 EventLog 工具集合/结果不一致
//
// 用法：
//   pnpm exec tsx evals/repo-tasks/runner/inspect-run.ts <report.json>
// 输出：stdout JSON（findings/stats/timeline/crossValidation）；exit 0=干净 1=warning 2=error

import { readFileSync, existsSync } from 'node:fs';

interface RawEvent {
  id: string;
  runId: string;
  sequence: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
}

interface RawTrajectoryCall {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  denied?: boolean;
  isError?: boolean;
  outputPreview?: string;
  timestamp?: number;
}

export interface ForensicFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  sequence?: number;
}

export interface ForensicStats {
  llmRounds: number;
  llmRequests: number;
  llmFailures: number;
  toolCalls: number;
  failedTools: number;
  retryCount: number;
  durationMs: number;
  terminalReason: string;
  eventCountByType: Record<string, number>;
}

export interface TimelineEntry {
  sequence: number;
  timestamp: number;
  type: string;
  summary: string;
}

export interface InspectResult {
  runId: string;
  report: string;
  findings: ForensicFinding[];
  stats: ForensicStats;
  timeline: TimelineEntry[];
  crossValidation: { trajectoryCalls: number; eventLogToolCalls: number; mismatches: string[]; rejectedOnlyDenials?: string[] } | null;
  valid: boolean;
}

const TERMINAL_TYPES = new Set(['run_completed', 'run_interrupted']);
const TOOL_TERMINAL_TYPES = new Set(['tool_completed', 'tool_rejected']);

function summarizeEvent(e: RawEvent): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'run_started': return `input="${String(p.input ?? '').slice(0, 60)}" model=${String(p.model ?? '')}`;
    case 'llm_requested': return `attempt=${String(p.attempt ?? '')}`;
    case 'llm_retry': return `attempt=${String(p.attempt ?? '')} kind=${String(p.errorKind ?? '')}`;
    case 'llm_succeeded': return `attempt=${String(p.attempt ?? '')} finish=${String(p.finishReason ?? '')} tokens=${String((p.usage as Record<string, unknown> | undefined)?.totalTokens ?? '')}`;
    case 'llm_failed': return `attempt=${String(p.attempt ?? '')} kind=${String(p.errorKind ?? '')}`;
    case 'tool_requested': return `${String(p.toolName ?? '')} ${String(p.toolCallId ?? '')}`;
    case 'tool_completed': return `${String(p.toolName ?? '')} ${String(p.toolCallId ?? '')} isError=${String(p.isError ?? '')}`;
    case 'tool_rejected': return `${String(p.toolName ?? '')} ${String(p.toolCallId ?? '')} reason=${String(p.reason ?? '').slice(0, 40)}`;
    case 'run_completed': return `outputLength=${String(p.outputLength ?? '')} tools=${String(p.toolCallCount ?? '')}`;
    case 'run_interrupted': return `reason=${String(p.reason ?? '').slice(0, 60)}`;
    default: return JSON.stringify(p).slice(0, 80);
  }
}

/** 核心检查：输入事件数组，返回 findings + stats + timeline */
export function inspectEvents(events: RawEvent[], trajectory: RawTrajectoryCall[] | undefined): { findings: ForensicFinding[]; stats: ForensicStats; timeline: TimelineEntry[]; crossValidation: InspectResult['crossValidation'] } {
  const findings: ForensicFinding[] = [];
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const bySeq = new Map(sorted.map((e) => [e.sequence, e]));

  // 1. non-contiguous sequence
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.sequence !== i + 1) {
      findings.push({ code: 'SEQ_NON_CONTIGUOUS', severity: 'error', message: `sequence 不连续：期望 ${i + 1}，实际 ${sorted[i]!.sequence}（append-only 被破坏）`, sequence: sorted[i]!.sequence });
      break;
    }
  }

  // 2. duplicate event IDs
  const idSeen = new Set<string>();
  for (const e of sorted) {
    if (idSeen.has(e.id)) findings.push({ code: 'DUP_EVENT_ID', severity: 'error', message: `事件 id 重复: ${e.id}`, sequence: e.sequence });
    idSeen.add(e.id);
  }

  // 3. duplicate toolCallId execution
  const reqByCall = new Map<string, number>();
  for (const e of sorted) {
    if (e.type !== 'tool_requested') continue;
    const cid = String((e.payload as Record<string, unknown>).toolCallId ?? '');
    const n = (reqByCall.get(cid) ?? 0) + 1;
    reqByCall.set(cid, n);
    if (n > 1) findings.push({ code: 'DUP_TOOL_EXEC', severity: 'error', message: `toolCallId 重复执行: ${cid}（第 ${n} 次）`, sequence: e.sequence });
  }

  // 4/5. tool_requested 无终态 / tool_completed 无 requested
  //   注意：tool_rejected 是 denial lifecycle（Closure 6）——权限 deny 时**故意不记**
  //   tool_requested，因此 tool_rejected 无 requested 是设计行为，不报（L2-06 实证）。
  const requestedIds = new Set<string>();
  const terminalIds = new Set<string>();
  const rejectedOnlyIds = new Set<string>();
  for (const e of sorted) {
    const cid = String((e.payload as Record<string, unknown>).toolCallId ?? '');
    if (e.type === 'tool_requested') requestedIds.add(cid);
    if (e.type === 'tool_completed') terminalIds.add(cid);
    if (e.type === 'tool_rejected') {
      terminalIds.add(cid);
      rejectedOnlyIds.add(cid);
    }
  }
  for (const cid of requestedIds) {
    if (!terminalIds.has(cid)) findings.push({ code: 'TOOL_NO_TERMINAL', severity: 'error', message: `tool_requested 无终态: ${cid}` });
  }
  for (const e of sorted) {
    if (e.type !== 'tool_completed') continue;
    const cid = String((e.payload as Record<string, unknown>).toolCallId ?? '');
    if (!requestedIds.has(cid)) {
      findings.push({ code: 'TOOL_TERMINAL_NO_REQUEST', severity: 'warning', message: `tool_completed 无对应 tool_requested: ${cid}`, sequence: e.sequence });
    }
  }

  // run 结束位置
  let runEndIdx = -1;
  let runEndType: string | undefined;
  let cancelled = false;
  const terminalReasons: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (TERMINAL_TYPES.has(e.type)) {
      runEndIdx = i;
      runEndType = e.type;
      if (e.type === 'run_interrupted') terminalReasons.push(String((e.payload as Record<string, unknown>).reason ?? ''));
    }
  }

  // 9. run_completed + run_interrupted contradiction
  const hasCompleted = sorted.some((e) => e.type === 'run_completed');
  const hasInterrupted = sorted.some((e) => e.type === 'run_interrupted');
  if (hasCompleted && hasInterrupted) {
    findings.push({ code: 'RUN_END_CONTRADICTION', severity: 'error', message: 'run_completed 与 run_interrupted 同时存在（终结矛盾）' });
  }

  // 6. tool after cancellation
  cancelled = terminalReasons.some((r) => /cancel|取消|abort/i.test(r));
  if (cancelled && runEndIdx >= 0) {
    for (let i = runEndIdx + 1; i < sorted.length; i++) {
      const e = sorted[i]!;
      if (e.type.startsWith('tool_')) {
        findings.push({ code: 'TOOL_AFTER_CANCEL', severity: 'error', message: `取消后的工具事件: ${e.type} ${String((e.payload as Record<string, unknown>).toolCallId ?? '')}`, sequence: e.sequence });
      }
    }
  }

  // 7. tool after run end
  // 8. llm after run end
  if (runEndIdx >= 0) {
    for (let i = runEndIdx + 1; i < sorted.length; i++) {
      const e = sorted[i]!;
      if (e.type.startsWith('tool_')) {
        findings.push({ code: 'TOOL_AFTER_RUN_END', severity: 'error', message: `${runEndType} 后的工具事件: ${e.type} ${String((e.payload as Record<string, unknown>).toolCallId ?? '')}`, sequence: e.sequence });
      }
      if (e.type.startsWith('llm_')) {
        findings.push({ code: 'LLM_AFTER_RUN_END', severity: 'error', message: `${runEndType} 后的 LLM 事件: ${e.type}`, sequence: e.sequence });
      }
    }
  }

  // 10. retry lifecycle inconsistency（Observability Closure P1-INFRA-02）：
  //     RouteDev 区分两层重试——**不要混为一谈**：
  //       a) loop logical retry：llm_failed(logical attempt=N) 之后，若 run 继续，
  //          必然出现新的 llm_requested(attempt=N+1)（loop 把错误注入上下文继续迭代）；
  //          若既无新 requested 也无 run_interrupted 却 run_completed → malformed。
  //       b) provider transport retry：llm_retry 来自 provider onRetry(info)，**不产生**
  //          新的 loop-level llm_requested（L2-07 正确契约：llm_requested=1 + llm_retry=1 +
  //          llm_succeeded=1 + run_completed = CLEAN）。唯一不变量：llm_retry 所在
  //          logical request 最终必须有 llm_succeeded 或 llm_failed（重试耗尽）。
  const requestedByAttempt = new Map<number, number>(); // attempt → 事件序号
  const failedAttempts = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.type === 'llm_requested') requestedByAttempt.set(Number((e.payload as Record<string, unknown>).attempt), i);
    if (e.type === 'llm_failed') failedAttempts.add(Number((e.payload as Record<string, unknown>).attempt));
  }
  // a) loop retry：llm_failed 后（到 run 结束）无新 requested 且无 interrupted → malformed
  for (const attempt of failedAttempts) {
    const failIdx = sorted.findIndex((e) => e.type === 'llm_failed' && Number((e.payload as Record<string, unknown>).attempt) === attempt);
    if (failIdx < 0) continue;
    const after = sorted.slice(failIdx + 1);
    const hasNewRequest = after.some((e) => e.type === 'llm_requested');
    const hasInterrupted = after.some((e) => e.type === 'run_interrupted');
    const hasCompleted = after.some((e) => e.type === 'run_completed');
    if (!hasNewRequest && !hasInterrupted && hasCompleted) {
      findings.push({
        code: 'RETRY_INCONSISTENCY',
        severity: 'error',
        message: `llm_failed(attempt=${attempt}) 后既无新的 llm_requested 也无 run_interrupted，却 run_completed（loop retry 缺失）`,
        sequence: failIdx + 1,
      });
    }
  }
  // b) provider retry：llm_retry 所在 logical request 最终必须有 llm_succeeded 或 llm_failed
  const retryEvents: Array<{ seq: number; attempt: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.type === 'llm_retry') retryEvents.push({ seq: i + 1, attempt: Number((e.payload as Record<string, unknown>).attempt ?? 0) });
  }
  for (const r of retryEvents) {
    const after = sorted.slice(r.seq);
    const hasTerminal = after.some((e) => e.type === 'llm_succeeded' || e.type === 'llm_failed');
    const terminalBeforeRunEnd = after.some((e) => e.type === 'run_completed' || e.type === 'run_interrupted');
    if (!hasTerminal && terminalBeforeRunEnd) {
      findings.push({
        code: 'RETRY_INCONSISTENCY',
        severity: 'warning',
        message: `llm_retry(attempt=${r.attempt}) 所在 logical request 无最终 llm_succeeded/llm_failed（provider retry 无终态）`,
        sequence: r.seq,
      });
    }
  }

  // 统计
  const eventCountByType: Record<string, number> = {};
  for (const e of sorted) eventCountByType[e.type] = (eventCountByType[e.type] ?? 0) + 1;
  const stats: ForensicStats = {
    llmRounds: sorted.filter((e) => e.type === 'llm_succeeded').length,
    llmRequests: sorted.filter((e) => e.type === 'llm_requested').length,
    llmFailures: sorted.filter((e) => e.type === 'llm_failed').length,
    toolCalls: sorted.filter((e) => e.type === 'tool_requested').length,
    failedTools: sorted.filter((e) => e.type === 'tool_completed' && e.payload.isError === true).length,
    retryCount: retryEvents.length,
    durationMs: sorted.length >= 2 ? sorted[sorted.length - 1]!.timestamp - sorted[0]!.timestamp : 0,
    terminalReason: hasCompleted ? 'completed' : terminalReasons[0] ?? (sorted.length === 0 ? 'no-events' : 'no-terminal'),
    eventCountByType,
  };

  // timeline
  const timeline: TimelineEntry[] = sorted.map((e) => ({
    sequence: e.sequence,
    timestamp: e.timestamp,
    type: e.type,
    summary: summarizeEvent(e),
  }));

  // 11. trajectory/EventLog cross-validation
  let crossValidation: InspectResult['crossValidation'] = null;
  if (Array.isArray(trajectory) && trajectory.length > 0) {
    const trajIds = new Set(trajectory.map((c) => c.toolCallId).filter(Boolean));
    const logIds = new Set<string>();
    for (const e of sorted) {
      const cid = String((e.payload as Record<string, unknown>).toolCallId ?? '');
      // tool_rejected 豁免：deny 时 executor 未执行（trajectory 无记录）——设计如此
      if (e.type === 'tool_requested' || e.type === 'tool_completed') logIds.add(cid);
    }
    const mismatches: string[] = [];
    for (const cid of trajIds) if (!logIds.has(cid)) mismatches.push(`trajectory 有 ${cid} 但 EventLog 无对应工具事件`);
    for (const cid of logIds) if (!trajIds.has(cid)) mismatches.push(`EventLog 有 ${cid} 但 trajectory 无对应调用`);
    // rejectedOnly（deny）单独统计——不计 mismatch
    const rejectedOnly = [...rejectedOnlyIds].filter((cid) => !trajIds.has(cid) && !logIds.has(cid));
    // isError 一致性（trajectory vs tool_completed）
    const trajErr = new Map(trajectory.filter((c) => c.isError !== undefined).map((c) => [c.toolCallId, c.isError]));
    for (const e of sorted) {
      if (e.type !== 'tool_completed') continue;
      const cid = String((e.payload as Record<string, unknown>).toolCallId ?? '');
      const t = trajErr.get(cid);
      if (t !== undefined && t !== (e.payload as Record<string, unknown>).isError) {
        mismatches.push(`toolCallId ${cid}: trajectory isError=${t} vs EventLog isError=${(e.payload as Record<string, unknown>).isError}`);
      }
    }
    crossValidation = { trajectoryCalls: trajectory.length, eventLogToolCalls: logIds.size, mismatches, rejectedOnlyDenials: rejectedOnly };
    for (const m of mismatches.slice(0, 10)) {
      findings.push({ code: 'TRAJECTORY_MISMATCH', severity: 'error', message: m });
    }
  }

  return { findings, stats, timeline, crossValidation };
}

/** 解析 report JSON（RunResult 格式）并执行检查 */
export function inspectReport(reportPath: string): InspectResult {
  if (!existsSync(reportPath)) throw new Error(`report 文件不存在: ${reportPath}`);
  const raw = JSON.parse(readFileSync(reportPath, 'utf-8')) as Record<string, unknown>;
  const artifact = (raw.artifact ?? {}) as Record<string, unknown>;
  const events = (artifact.runEventLog ?? []) as RawEvent[];
  const trajectory = artifact.toolTrajectory as RawTrajectoryCall[] | undefined;
  if (!Array.isArray(events)) throw new Error(`report 缺少 artifact.runEventLog: ${reportPath}`);
  const { findings, stats, timeline, crossValidation } = inspectEvents(events, trajectory);
  const logFirst = Array.isArray(artifact.runEventLog) ? (artifact.runEventLog as RawEvent[])[0] : undefined;
  const runId = String(raw.taskId ?? logFirst?.runId ?? 'unknown');
  const errors = findings.filter((f) => f.severity === 'error');
  return { runId, report: reportPath, findings, stats, timeline, crossValidation, valid: errors.length === 0 };
}

// ============================================================
// CLI 入口
// ============================================================

if (typeof process.argv[1] === 'string' && process.argv[1].replace(/\\/g, '/').endsWith('inspect-run.ts')) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('usage: pnpm exec tsx evals/repo-tasks/runner/inspect-run.ts <report.json>');
    process.exit(1);
  }
  try {
    const r = inspectReport(reportPath);
    const out = {
      runId: r.runId,
      report: r.report,
      valid: r.valid,
      findings: r.findings,
      stats: r.stats,
      timeline: r.timeline,
      crossValidation: r.crossValidation,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    const errors = r.findings.filter((f) => f.severity === 'error').length;
    const warnings = r.findings.filter((f) => f.severity === 'warning').length;
    console.error(`[inspect] findings: ${r.findings.length} (error=${errors} warning=${warnings}) stats: llmRounds=${r.stats.llmRounds} tools=${r.stats.toolCalls} terminal=${r.stats.terminalReason}`);
    process.exit(errors > 0 ? 2 : warnings > 0 ? 1 : 0);
  } catch (err) {
    console.error('inspect failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// tests/evals/inspect-run.test.ts
// GA Infrastructure Sprint TASK 2：RunEventLog Forensic Inspector——deterministic 测试
//
// 覆盖 11 类检测 + 统计 + cross-validation：
//   SEQ_NON_CONTIGUOUS / DUP_EVENT_ID / DUP_TOOL_EXEC / TOOL_NO_TERMINAL /
//   TOOL_TERMINAL_NO_REQUEST / TOOL_AFTER_CANCEL / TOOL_AFTER_RUN_END /
//   LLM_AFTER_RUN_END / RUN_END_CONTRADICTION / RETRY_INCONSISTENCY / TRAJECTORY_MISMATCH

import { describe, it, expect } from 'vitest';
import { inspectEvents, type RawEvent as _RawEvent } from '../../evals/repo-tasks/runner/inspect-run.js';

interface Ev {
  type: string;
  payload?: Record<string, unknown>;
  id?: string;
  sequence?: number;
  timestamp?: number;
}

function ev(over: Ev, seq: number, ts = 1000 + seq * 10): _RawEvent {
  return {
    id: over.id ?? `ev-${seq}`,
    runId: 'run-test',
    sequence: over.sequence ?? seq,
    timestamp: over.timestamp ?? ts,
    type: over.type,
    payload: over.payload ?? {},
  };
}

/** 干净事件流：run_started → llm×2 → tool 完整周期 → run_completed */
function cleanStream(): _RawEvent[] {
  return [
    ev({ type: 'run_started', payload: { input: 'x', model: 'm' } }, 1),
    ev({ type: 'llm_requested', payload: { model: 'm', attempt: 1 } }, 2),
    ev({ type: 'llm_succeeded', payload: { model: 'm', attempt: 1, usage: { totalTokens: 100 } } }, 3),
    ev({ type: 'tool_requested', payload: { toolName: 'file_read', toolCallId: 'c1' } }, 4),
    ev({ type: 'tool_completed', payload: { toolName: 'file_read', toolCallId: 'c1', isError: false } }, 5),
    ev({ type: 'llm_requested', payload: { model: 'm', attempt: 2 } }, 6),
    ev({ type: 'llm_succeeded', payload: { model: 'm', attempt: 2, finishReason: 'stop' } }, 7),
    ev({ type: 'run_completed', payload: { outputLength: 3, toolCallCount: 1, retryCount: 0 } }, 8),
  ];
}

describe('inspectEvents — 干净流', () => {
  it('无 findings，统计正确', () => {
    const r = inspectEvents(cleanStream(), []);
    expect(r.findings).toHaveLength(0);
    expect(r.stats.llmRounds).toBe(2);
    expect(r.stats.llmRequests).toBe(2);
    expect(r.stats.toolCalls).toBe(1);
    expect(r.stats.failedTools).toBe(0);
    expect(r.stats.retryCount).toBe(0);
    expect(r.stats.terminalReason).toBe('completed');
    expect(r.timeline).toHaveLength(8);
    expect(r.timeline[0]!.sequence).toBe(1);
    expect(r.timeline[7]!.type).toBe('run_completed');
  });
});

describe('inspectEvents — 11 类检测', () => {
  it('SEQ_NON_CONTIGUOUS：sequence 跳号', () => {
    const stream = cleanStream();
    stream[5]!.sequence = 99; // llm_requested attempt=2 的 sequence 从 6 变 99
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'SEQ_NON_CONTIGUOUS' && f.severity === 'error')).toBe(true);
  });

  it('DUP_EVENT_ID：事件 id 重复', () => {
    const stream = cleanStream();
    stream[2]!.id = 'dup';
    stream[3]!.id = 'dup';
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'DUP_EVENT_ID')).toBe(true);
  });

  it('DUP_TOOL_EXEC：同一 toolCallId 执行两次', () => {
    const stream = cleanStream();
    stream.push(ev({ type: 'tool_requested', payload: { toolName: 'file_read', toolCallId: 'c1' } }, 9));
    stream.push(ev({ type: 'tool_completed', payload: { toolName: 'file_read', toolCallId: 'c1', isError: false } }, 10));
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'DUP_TOOL_EXEC')).toBe(true);
  });

  it('TOOL_NO_TERMINAL：tool_requested 无终态', () => {
    const stream = cleanStream();
    stream.push(ev({ type: 'tool_requested', payload: { toolName: 'file_write', toolCallId: 'c9' } }, 9));
    stream.push(ev({ type: 'run_interrupted', payload: { reason: 'max_iterations' } }, 10));
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'TOOL_NO_TERMINAL' && f.message.includes('c9'))).toBe(true);
  });

  it('TOOL_TERMINAL_NO_REQUEST：终态无 requested', () => {
    const stream = cleanStream();
    stream.push(ev({ type: 'tool_completed', payload: { toolName: 'x', toolCallId: 'ghost', isError: true } }, 9));
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'TOOL_TERMINAL_NO_REQUEST' && f.message.includes('ghost'))).toBe(true);
  });

  it('tool_rejected 无 tool_requested 不报错（denial lifecycle：deny 时不记 requested——L2-06 实证）', () => {
    const stream = cleanStream();
    stream.push(ev({ type: 'tool_rejected', payload: { toolName: 'file_write', toolCallId: 'denied-1', reason: '权限拦截' } }, 9));
    const trajectory = [{ toolName: 'file_read', toolCallId: 'c1', isError: false }];
    const r = inspectEvents(stream, trajectory);
    expect(r.findings.some((f) => f.code === 'TOOL_TERMINAL_NO_REQUEST')).toBe(false);
    expect(r.findings.some((f) => f.code === 'TRAJECTORY_MISMATCH')).toBe(false);
    expect(r.crossValidation?.rejectedOnlyDenials).toContain('denied-1');
  });

  it('TOOL_AFTER_CANCEL + TOOL_AFTER_RUN_END：取消后仍有工具事件', () => {
    const stream = cleanStream();
    stream.push(ev({ type: 'run_interrupted', payload: { reason: '用户取消了执行' } }, 9));
    stream.push(ev({ type: 'tool_requested', payload: { toolName: 'file_read', toolCallId: 'c10' } }, 10));
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'TOOL_AFTER_CANCEL')).toBe(true);
    expect(r.findings.some((f) => f.code === 'TOOL_AFTER_RUN_END')).toBe(true);
    // 终结矛盾
    expect(r.findings.some((f) => f.code === 'RUN_END_CONTRADICTION')).toBe(true);
  });

  it('LLM_AFTER_RUN_END：run 结束后仍有 LLM 事件', () => {
    const stream = cleanStream();
    stream.push(ev({ type: 'llm_requested', payload: { model: 'm', attempt: 3 } }, 9));
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'LLM_AFTER_RUN_END')).toBe(true);
  });

  it('RUN_END_CONTRADICTION：completed + interrupted 并存', () => {
    const stream = cleanStream();
    stream.push(ev({ type: 'run_interrupted', payload: { reason: 'x' } }, 9));
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'RUN_END_CONTRADICTION')).toBe(true);
  });

  it('RETRY_INCONSISTENCY：llm_succeeded attempt=2 无对应 llm_requested', () => {
    const stream = [
      ev({ type: 'run_started', payload: { input: 'x', model: 'm' } }, 1),
      ev({ type: 'llm_requested', payload: { model: 'm', attempt: 1 } }, 2),
      ev({ type: 'llm_failed', payload: { model: 'm', attempt: 1, errorKind: 'rate_limit', error: 'e' } }, 3),
      ev({ type: 'llm_succeeded', payload: { model: 'm', attempt: 2 } }, 4), // 无 attempt=2 的 requested
      ev({ type: 'run_completed', payload: {} }, 5),
    ];
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'RETRY_INCONSISTENCY')).toBe(true);
  });

  it('RETRY_INCONSISTENCY：llm_retry 存在但无 attempt>1 请求', () => {
    // 只有 attempt=1 的流 + llm_retry（attempt=1）——重试事件无对应 attempt>1 请求序列
    const stream = [
      ev({ type: 'run_started', payload: { input: 'x', model: 'm' } }, 1),
      ev({ type: 'llm_requested', payload: { model: 'm', attempt: 1 } }, 2),
      ev({ type: 'llm_retry', payload: { model: 'm', attempt: 1, errorKind: 'rate_limit', error: 'e' } }, 3),
      ev({ type: 'llm_succeeded', payload: { model: 'm', attempt: 1 } }, 4),
      ev({ type: 'run_completed', payload: {} }, 5),
    ];
    const r = inspectEvents(stream, []);
    expect(r.findings.some((f) => f.code === 'RETRY_INCONSISTENCY')).toBe(true);
  });

  it('TRAJECTORY_MISMATCH：trajectory 与 EventLog 集合/结果不一致', () => {
    const stream = cleanStream();
    const trajectory = [
      { toolName: 'file_read', toolCallId: 'c1', isError: false },   // 匹配
      { toolName: 'file_write', toolCallId: 'c-missing', isError: false }, // EventLog 无
    ];
    const r = inspectEvents(stream, trajectory);
    expect(r.crossValidation).not.toBeNull();
    expect(r.crossValidation!.trajectoryCalls).toBe(2);
    expect(r.crossValidation!.eventLogToolCalls).toBe(1);
    expect(r.findings.some((f) => f.code === 'TRAJECTORY_MISMATCH' && f.message.includes('c-missing'))).toBe(true);
  });

  it('TRAJECTORY_MISMATCH：isError 不一致', () => {
    const stream = cleanStream();
    const trajectory = [{ toolName: 'file_read', toolCallId: 'c1', isError: true }]; // EventLog 是 false
    const r = inspectEvents(stream, trajectory);
    expect(r.findings.some((f) => f.code === 'TRAJECTORY_MISMATCH' && f.message.includes('isError'))).toBe(true);
  });

  it('正常轨迹 cross-validation 无 mismatch（isError 一致）', () => {
    const stream = cleanStream();
    const trajectory = [{ toolName: 'file_read', toolCallId: 'c1', isError: false }];
    const r = inspectEvents(stream, trajectory);
    expect(r.crossValidation!.mismatches).toHaveLength(0);
    expect(r.findings.some((f) => f.code === 'TRAJECTORY_MISMATCH')).toBe(false);
  });
});

describe('inspectEvents — 统计', () => {
  it('failed tools / retry count / duration / eventCountByType', () => {
    const stream = [
      ev({ type: 'run_started', payload: {} }, 1, 1000),
      ev({ type: 'llm_requested', payload: { attempt: 1 } }, 2, 1010),
      ev({ type: 'llm_failed', payload: { attempt: 1, errorKind: 'x' } }, 3, 1020),
      ev({ type: 'llm_retry', payload: { attempt: 1, errorKind: 'x' } }, 4, 1030),
      ev({ type: 'llm_requested', payload: { attempt: 2 } }, 5, 1040),
      ev({ type: 'llm_succeeded', payload: { attempt: 2 } }, 6, 1050),
      ev({ type: 'tool_requested', payload: { toolCallId: 't1' } }, 7, 1060),
      ev({ type: 'tool_completed', payload: { toolCallId: 't1', isError: true } }, 8, 1070),
      ev({ type: 'run_interrupted', payload: { reason: 'model_output_truncated' } }, 9, 1080),
    ];
    const r = inspectEvents(stream, []);
    expect(r.stats.llmRounds).toBe(1);
    expect(r.stats.llmFailures).toBe(1);
    expect(r.stats.retryCount).toBe(1);
    expect(r.stats.failedTools).toBe(1);
    expect(r.stats.durationMs).toBe(80);
    expect(r.stats.terminalReason).toBe('model_output_truncated');
    expect(r.stats.eventCountByType.llm_requested).toBe(2);
  });
});

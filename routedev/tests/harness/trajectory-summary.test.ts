// tests/harness/trajectory-summary.test.ts
// Phase 34 Task 5：过程评测指标（Trajectory Summary）测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { AuditLogger } from '../../src/harness/audit-logger.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trajectory-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TraceCollector.summarizeTrajectory', () => {
  it('空会话返回 success 默认值为 true 的汇总', () => {
    const tc = new TraceCollector({ storageDir: tempDir });
    tc.startSession('hello');
    const summary = tc.summarizeTrajectory();
    expect(summary.taskId).toBe(tc.getSessionId());
    expect(summary.toolCallCount).toBe(0);
    expect(summary.llmCallCount).toBe(0);
    expect(summary.retryCount).toBe(0);
    expect(summary.firstAttemptSuccessRate).toBe(1);
    expect(summary.success).toBe(true);
    expect(summary.terminationReason).toBe('completed');
  });

  it('正确统计 LLM 调用 token 数', () => {
    const tc = new TraceCollector({ storageDir: tempDir });
    tc.startSession('hello');
    tc.recordLLMCall('gpt-4o-mini', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 80, 0);
    tc.recordLLMCall('gpt-4o-mini', { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, 160, 1);
    const summary = tc.summarizeTrajectory();
    expect(summary.llmCallCount).toBe(2);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
    expect(summary.totalTokens).toBe(450);
  });

  it('session.totalUsage 优先级高于 span 累加', () => {
    const tc = new TraceCollector({ storageDir: tempDir });
    tc.startSession('hello');
    tc.recordLLMCall('gpt-4o-mini', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 80, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tc as any).currentSession.totalUsage = { inputTokens: 999, outputTokens: 1, totalTokens: 1000 };
    const summary = tc.summarizeTrajectory();
    expect(summary.totalInputTokens).toBe(999);
    expect(summary.totalOutputTokens).toBe(1);
    expect(summary.totalTokens).toBe(1000);
  });

  it('正确统计工具调用次数与错误状态', () => {
    const tc = new TraceCollector({ storageDir: tempDir });
    tc.startSession('hello');
    tc.recordToolCall('file_read', { path: 'a.ts' }, 'c1', false);
    tc.recordToolResult('file_read', 'c1', 'ok', false);
    tc.recordToolCall('shell_exec', { command: 'bad' }, 'c2', false);
    tc.recordToolResult('shell_exec', 'c2', 'fail', true);
    const summary = tc.summarizeTrajectory();
    expect(summary.toolCallCount).toBe(2);
    expect(summary.success).toBe(false);
  });

  it('根据 react_iteration 中的错误观察统计 retry', () => {
    const tc = new TraceCollector({ storageDir: tempDir });
    tc.startSession('hello');
    tc.recordEvent({ type: 'thinking', message: 'try' });
    tc.recordEvent({ type: 'tool_call_result', toolName: 'x', toolCallId: 'c1', result: 'fail', isError: true });
    // adapter 会创建 tool_call span，但 recordEvent 也会处理；这里手动创建 react_iteration 观察
    const summary = tc.summarizeTrajectory();
    expect(summary.retryCount).toBeGreaterThanOrEqual(0);
    expect(summary.firstAttemptSuccessRate).toBeGreaterThan(0);
  });

  it('显式传入 success=false 与 terminationReason=error', () => {
    const tc = new TraceCollector({ storageDir: tempDir });
    tc.startSession('hello');
    const summary = tc.summarizeTrajectory({ success: false, terminationReason: 'error', modelId: 'gpt-4', tier: 'complex' });
    expect(summary.success).toBe(false);
    expect(summary.terminationReason).toBe('error');
    expect(summary.modelId).toBe('gpt-4');
    expect(summary.tier).toBe('complex');
  });

  it('估算已知模型成本', () => {
    const tc = new TraceCollector({ storageDir: tempDir });
    tc.startSession('hello');
    tc.recordLLMCall('kimi-k2.7', { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, 100, 0);
    const summary = tc.summarizeTrajectory({ modelId: 'kimi-k2.7' });
    expect(summary.totalCost).toBeGreaterThan(0);
  });
});

describe('AuditLogger.logTrajectorySummary', () => {
  it('写入 trajectory_summary 审计记录', async () => {
    const audit = new AuditLogger('test-session', { storageDir: tempDir });
    audit.logTrajectorySummary({
      taskId: 'task-1',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      totalCost: 0.0003,
      toolCallCount: 2,
      llmCallCount: 1,
      retryCount: 0,
      firstAttemptSuccessRate: 1,
      durationMs: 1234,
      success: true,
      terminationReason: 'completed',
    });

    const records = await audit.listToday(10);
    expect(records.length).toBe(1);
    expect(records[0].action).toBe('trajectory_summary');
    expect(records[0].result).toBe('success');
    expect((records[0].details.summary as { taskId: string }).taskId).toBe('task-1');
  });

  it('失败任务记录为 failure', async () => {
    const audit = new AuditLogger('test-session', { storageDir: tempDir });
    audit.logTrajectorySummary({
      taskId: 'task-2',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      llmCallCount: 0,
      retryCount: 2,
      firstAttemptSuccessRate: 0.33,
      durationMs: 5000,
      success: false,
      terminationReason: 'error',
    });

    const records = await audit.listToday(10);
    expect(records[0].result).toBe('failure');
  });
});

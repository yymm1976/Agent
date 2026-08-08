// tests/harness/run-event-log.test.ts
// TD-21 Phase 1：Authoritative Run Event Log
//
// 覆盖：
// 1. RunEventLog append-only：sequence 单调递增、磁盘 JSONL 追加
// 2. replay 校验：sequence 连续性（缺失/重复/损坏 → null）
// 3. project 投影：事件流 → RunProjection（run_started/llm/tool/completed）
// 4. Replay consistency：Full ReAct Loop 实跑 → live state 与 replay 投影一致
// 5. Provider retry 可观测性：RetryPolicy onRetry → llm_retry 事件

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunEventLog } from '../../src/harness/run-event-log.js';
import { RetryPolicy, QuerySourceAwareRetryPolicy } from '../../src/utils/retry.js';
import { RateLimitError, AuthError } from '../../src/errors/agent-errors.js';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { LLMStreamEvent } from '../../src/router/types.js';

describe('RunEventLog（TD-21 Phase 1）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-runlog-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function logFile(runId: string): string {
    return join(tempDir, 'runs', `${runId}.events.jsonl`);
  }

  it('append-only：sequence 单调递增，JSONL 每行一个事件', () => {
    const log = new RunEventLog('run-1', tempDir);
    log.record('run_started', { input: 'hello', model: 'm' });
    log.record('llm_requested', { model: 'm', attempt: 1 });
    log.record('run_completed', { outputLength: 5, toolCallCount: 0, retryCount: 0 });

    const lines = readFileSync(logFile('run-1'), 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(3);
    const events = lines.map((l) => JSON.parse(l) as { sequence: number; type: string });
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toEqual(['run_started', 'llm_requested', 'run_completed']);
  });

  it('replay：完整事件流 → 投影一致', () => {
    const log = new RunEventLog('run-2', tempDir);
    log.record('run_started', { input: '写文件', model: 'm1' });
    log.record('llm_requested', { model: 'm1', attempt: 1 });
    log.record('llm_succeeded', { model: 'm1', attempt: 1, finishReason: 'tool_use' });
    log.record('tool_requested', { toolName: 'file_write', toolCallId: 'c1' });
    log.record('tool_completed', { toolName: 'file_write', toolCallId: 'c1', isError: false, outputPreview: 'ok' });
    log.record('llm_requested', { model: 'm1', attempt: 2 });
    log.record('llm_succeeded', { model: 'm1', attempt: 2, finishReason: 'stop' });
    log.record('run_completed', { outputLength: 10, toolCallCount: 1, retryCount: 0 });

    const { projection } = RunEventLog.replay(tempDir, 'run-2');
    expect(projection).not.toBeNull();
    expect(projection!.input).toBe('写文件');
    expect(projection!.model).toBe('m1');
    expect(projection!.llmAttempts).toBe(2);
    expect(projection!.toolCalls).toEqual([{ toolName: 'file_write', toolCallId: 'c1', isError: false }]);
    expect(projection!.outputLength).toBe(10);
    expect(projection!.completed).toBe(true);
  });

  it('replay：sequence 断裂（缺失）→ projection null（append-only 不变量被破坏）', () => {
    const log = new RunEventLog('run-3', tempDir);
    log.record('run_started', { input: 'x', model: 'm' });
    log.record('llm_requested', { model: 'm', attempt: 1 });
    // 篡改：把第二条 sequence 改成 9（造成断裂）
    const file = logFile('run-3');
    const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
    const ev = JSON.parse(lines[1]!);
    ev.sequence = 9;
    lines[1] = JSON.stringify(ev);
    // 重写保持 JSONL 结构
    rmSync(file, { force: true });
    writeFileSync(file, lines.join('\n') + '\n', 'utf-8');

    const { projection } = RunEventLog.replay(tempDir, 'run-3');
    expect(projection).toBeNull();
  });

  it('replay：损坏行 → projection null（fail-closed）', () => {
    const log = new RunEventLog('run-4', tempDir);
    log.record('run_started', { input: 'x', model: 'm' });
    const file = logFile('run-4');
    // 追加损坏行
    appendFileSync(file, '{ broken\n', 'utf-8');
    const { projection } = RunEventLog.replay(tempDir, 'run-4');
    expect(projection).toBeNull();
  });

  it('replay：不存在的 run → null（不抛错）', () => {
    const { projection, events } = RunEventLog.replay(tempDir, 'no-such-run');
    expect(projection).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('project：llm_retry 计入 retryCount，llm_failed 记录 lastErrorKind', () => {
    const log = new RunEventLog('run-5', tempDir);
    log.record('run_started', { input: 'x', model: 'm' });
    log.record('llm_requested', { model: 'm', attempt: 1 });
    log.record('llm_failed', { model: 'm', attempt: 1, errorKind: 'rate_limit', error: '429' });
    log.record('llm_retry', { model: 'm', attempt: 2, errorKind: 'rate_limit', error: '429' });
    log.record('llm_requested', { model: 'm', attempt: 2 });
    log.record('llm_succeeded', { model: 'm', attempt: 2, finishReason: 'stop' });
    log.record('run_completed', { outputLength: 1, toolCallCount: 0, retryCount: 1 });

    const { projection } = RunEventLog.replay(tempDir, 'run-5');
    expect(projection!.retryCount).toBe(1);
    expect(projection!.llmAttempts).toBe(2);
    expect(projection!.lastErrorKind).toBe('rate_limit');
  });

  it('Replay consistency：Full ReAct Loop 实跑 → live state 与 replay 投影一致', async () => {
    let executeCalls = 0;
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => { executeCalls += 1; return 'done'; },
      hasTool: () => false,
      executeToolStructured: async () => { executeCalls += 1; return { output: 'done', isError: false }; },
    } as never;
    const client = {
      protocol: 'openai' as const,
      providerId: 'deepseek',
      isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'text_delta', text: 'final answer' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const log = new RunEventLog('run-consistency', tempDir);
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    loop.setRunEventLog(log);

    const events: string[] = [];
    for await (const ev of loop.run({
      userMessage: '回答我',
      llmClient: client as never,
      routeDecision: {
        model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
        providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
      },
      conversationHistory: [],
      onConfirmTool: async () => true,
    })) {
      events.push(ev.type);
    }

    // live state：run 正常完成，工具未执行（纯文本回复）
    expect(events).toContain('done');
    expect(executeCalls).toBe(0);

    // replay：磁盘事件流重建投影，与 live state 一致
    const { projection, events: replayed } = RunEventLog.replay(tempDir, 'run-consistency');
    expect(projection).not.toBeNull();
    expect(projection!.completed).toBe(true);
    expect(projection!.interruptedReason).toBeUndefined();
    expect(projection!.input).toBe('回答我');
    expect(projection!.llmAttempts).toBe(1);
    expect(projection!.toolCalls).toHaveLength(0);
    // 事件序列完整覆盖关键路径：run_started → llm_requested → llm_succeeded → run_completed
    const types = replayed.map((e) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('llm_requested');
    expect(types).toContain('llm_succeeded');
    expect(types[types.length - 1]).toBe('run_completed');
    // 内存态与磁盘重放一致（append-only 权威性）
    expect(log.getEvents().map((e) => e.sequence)).toEqual(replayed.map((e) => e.sequence));
  });

  it('Provider retry 可观测性：RetryPolicy onRetry → llm_retry 事件（attempt 正确）', async () => {
    const log = new RunEventLog('run-retry', tempDir);
    let attempts = 0;
    const policy = new RetryPolicy({ maxRetries: 2, baseDelayMs: 1 });
    await policy.execute(async () => {
      attempts++;
      if (attempts < 3) throw new RateLimitError('429 too many');
      return 'ok';
    }, {
      onRetry: (info) => {
        log.record('llm_retry', {
          model: 'm',
          attempt: info.attempt,
          errorKind: info.error instanceof RateLimitError ? 'rate_limit' : 'unknown',
          error: info.error instanceof Error ? info.error.message : String(info.error),
        });
      },
    });

    expect(attempts).toBe(3);
    const { projection } = RunEventLog.replay(tempDir, 'run-retry');
    expect(projection!.retryCount).toBe(2); // 两次实际重试
  });

  it('Provider retry 可观测性：AuthError 不触发 onRetry（无重试 = 无事件）', async () => {
    let attempts = 0;
    let retryEvents = 0;
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    await expect(policy.execute(async () => {
      attempts++;
      throw new AuthError('401');
    }, {
      onRetry: () => { retryEvents += 1; },
    })).rejects.toBeInstanceOf(AuthError);
    expect(attempts).toBe(1);
    expect(retryEvents).toBe(0);
  });

  it('QuerySourceAwareRetryPolicy 透传 onRetry（foreground）', async () => {
    let attempts = 0;
    const retries: number[] = [];
    const policy = new QuerySourceAwareRetryPolicy({ querySource: 'repl_main_thread', maxRetries: 2, baseDelayMs: 1 });
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) throw new RateLimitError('429');
      return 'ok';
    }, {
      onRetry: (info) => { retries.push(info.attempt); },
    });
    expect(result).toBe('ok');
    expect(retries).toEqual([1]); // 第一次失败后重试（attempt=1 是下一次请求）
  });
});

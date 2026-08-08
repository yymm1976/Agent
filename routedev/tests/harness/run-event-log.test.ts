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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunEventLog, RunEventLogDurabilityError } from '../../src/harness/run-event-log.js';
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

describe('Closure 6：durability / redaction / 集成矩阵', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-runlog6-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('durability：append 失败 → record 抛 RunEventLogDurabilityError，日志失效（fail-closed）', () => {
    // storageDir 指向一个已存在的文件 → mkdirSync 抛错 → append 失败
    const blocker = join(tempDir, 'blocker.txt');
    writeFileSync(blocker, 'i am a file, not a dir', 'utf-8');
    const log = new RunEventLog('run-dur', blocker);
    expect(() => log.record('run_started', { input: 'x', model: 'm' })).toThrow(RunEventLogDurabilityError);
    expect(log.isFailed()).toBe(true);
    // 失效后任何 record 都抛错（不静默写内存/磁盘不一致）
    expect(() => log.record('llm_requested', { model: 'm', attempt: 1 })).toThrow(RunEventLogDurabilityError);
    // 磁盘无该 run 的日志 → replay 返回 null（不产生权威投影）
    const { projection } = RunEventLog.replay(tempDir, 'run-dur');
    expect(projection).toBeNull();
  });

  it('redaction：run_started 原文输入截断（默认 200；可配置）', () => {
    const log = new RunEventLog('run-redact', tempDir, { inputTruncateChars: 10 });
    log.record('run_started', { input: '这是一个非常长的用户输入，超过十个字符的原文不应该完整落盘', model: 'm' });
    const { projection, events } = RunEventLog.replay(tempDir, 'run-redact');
    expect(projection).not.toBeNull();
    const started = events.find((e) => e.type === 'run_started') as { payload: { input: string } };
    expect(started.payload.input.length).toBeLessThanOrEqual(11); // 10 + 省略号
    expect(started.payload.input.endsWith('…')).toBe(true);
    expect(projection!.input).toBe(started.payload.input); // 投影一致（截断后）
  });

  it('集成矩阵：工具成功 —— live 状态与 replay 投影一致（tool_requested/tool_completed）', async () => {
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => { return 'written'; },
      hasTool: () => false,
      executeToolStructured: async () => { return { output: 'written', isError: false }; },
    } as never;
    const client = {
      protocol: 'openai' as const,
      providerId: 'deepseek',
      isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      streamCalls: 0,
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        const calls = ++this.streamCalls;
        if (calls === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_write' } };
          yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":"a.txt"}' };
          yield { type: 'tool_call_end', toolCallId: 'c1' };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const log = new RunEventLog('run-tool-ok', tempDir);
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    loop.setRunEventLog(log);
    const events: string[] = [];
    for await (const ev of loop.run({
      userMessage: '写文件',
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
    expect(events).toContain('done');
    const { projection, events: replayed } = RunEventLog.replay(tempDir, 'run-tool-ok');
    expect(projection!.completed).toBe(true);
    expect(projection!.toolCalls).toEqual([{ toolName: 'file_write', toolCallId: 'c1', isError: false }]);
    const types = replayed.map((e) => e.type);
    expect(types).toContain('tool_requested');
    expect(types).toContain('tool_completed');
    expect(types).not.toContain('tool_rejected');
    expect(log.getEvents().map((e) => e.sequence)).toEqual(replayed.map((e) => e.sequence)); // live == disk
  });

  it('集成矩阵：用户拒绝工具 —— tool_rejected 事件、executeTool=0、投影一致', async () => {
    let executeCalls = 0;
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => { executeCalls += 1; return 'x'; },
      hasTool: () => false,
      executeToolStructured: async () => { executeCalls += 1; return { output: 'x', isError: false }; },
    } as never;
    const client = {
      protocol: 'openai' as const,
      providerId: 'deepseek',
      isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      streamCalls: 0,
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        const calls = ++this.streamCalls;
        if (calls === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_write' } };
          yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":"a.txt"}' };
          yield { type: 'tool_call_end', toolCallId: 'c1' };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const log = new RunEventLog('run-tool-reject', tempDir);
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    loop.setRunEventLog(log);
    for await (const _ev of loop.run({
      userMessage: '写文件',
      llmClient: client as never,
      routeDecision: {
        model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
        providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
      },
      conversationHistory: [],
      onConfirmTool: async () => false, // 用户拒绝
    })) { /* drain */ }
    expect(executeCalls).toBe(0);
    const { events: replayed } = RunEventLog.replay(tempDir, 'run-tool-reject');
    const rejected = replayed.filter((e) => e.type === 'tool_rejected');
    expect(rejected.length).toBe(1);
    expect((rejected[0] as { payload: { toolName: string } }).payload.toolName).toBe('file_write');
    // 拒绝 ≠ 执行：无 tool_requested/tool_completed
    expect(replayed.some((e) => e.type === 'tool_requested')).toBe(false);
  });

  it('集成矩阵：transient provider retry —— llm_retry 事件、投影 retryCount 一致', async () => {
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => 'x',
      hasTool: () => false,
      executeToolStructured: async () => ({ output: 'x', isError: false }),
    } as never;
    let streamCalls = 0;
    // 模拟真实链路：client.stream 内部用 RetryPolicy 包装请求阶段（同 openai.ts 接线）
    const policy = new QuerySourceAwareRetryPolicy({ querySource: 'repl_main_thread', maxRetries: 2, baseDelayMs: 1 });
    const client = {
      protocol: 'openai' as const,
      providerId: 'deepseek',
      isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* (options: { onRetry?: (info: { error: unknown; attempt: number }) => void }): AsyncGenerator<LLMStreamEvent> {
        await policy.execute(async () => {
          streamCalls += 1;
          if (streamCalls === 1) throw new RateLimitError('429 too many');
          return null;
        }, { onRetry: options.onRetry });
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const log = new RunEventLog('run-retry-matrix', tempDir);
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    loop.setRunEventLog(log);
    for await (const _ev of loop.run({
      userMessage: 'hi',
      llmClient: client as never,
      routeDecision: {
        model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
        providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
      },
      conversationHistory: [],
      onConfirmTool: async () => true,
    })) { /* drain */ }
    expect(streamCalls).toBe(2); // 真实重试发生
    const { projection, events: replayed } = RunEventLog.replay(tempDir, 'run-retry-matrix');
    expect(projection!.completed).toBe(true);
    expect(projection!.retryCount).toBe(1);
    expect(replayed.some((e) => e.type === 'llm_retry')).toBe(true);
    // llm_retry 事件携带类型化 errorKind
    const retryEv = replayed.find((e) => e.type === 'llm_retry') as { payload: { errorKind: string } };
    expect(retryEv.payload.errorKind).toBe('rate_limit');
  });

  it('集成矩阵：取消 —— run_interrupted 事件、投影 completed=false、live==disk', async () => {
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => 'x',
      hasTool: () => false,
      executeToolStructured: async () => ({ output: 'x', isError: false }),
    } as never;
    const client = {
      protocol: 'openai' as const,
      providerId: 'deepseek',
      isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* (options: { signal?: AbortSignal }): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'text_delta', text: 'partial' };
        // 模拟真实 client：挂起直到取消信号（abort 后抛错退出流）
        await new Promise((_resolve, reject) => {
          if (options.signal?.aborted) reject(new Error('aborted'));
          else options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    const log = new RunEventLog('run-cancel-matrix', tempDir);
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    loop.setRunEventLog(log);
    const controller = new AbortController();
    const runPromise = (async () => {
      for await (const _ev of loop.run({
        userMessage: 'hi',
        llmClient: client as never,
        routeDecision: {
          model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
          providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
        },
        conversationHistory: [],
        signal: controller.signal,
        onConfirmTool: async () => true,
      })) { /* drain */ }
    })();
    // 等待流开始后取消
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await runPromise;

    const { projection, events: replayed } = RunEventLog.replay(tempDir, 'run-cancel-matrix');
    expect(projection!.completed).toBe(false);
    expect(projection!.interruptedReason).toBe('用户取消了执行');
    expect(replayed.some((e) => e.type === 'run_interrupted')).toBe(true);
    expect(log.getEvents().map((e) => e.sequence)).toEqual(replayed.map((e) => e.sequence));
  });
});

describe('Closure-2：authoritative commit / fault injection / run identity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-cl2-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 故障注入：第 failAt 次 record 前把日志文件替换为目录 → append 必然失败（已 durable 内容先备份） */
  function sabotageAt(log: RunEventLog, failAt: number): { log: RunEventLog; restore: () => void } {
    const origRecord = log.record.bind(log);
    let count = 0;
    let backupPath: string | null = null;
    const file = () => join(tempDir, 'runs', `${log.getRunId()}.events.jsonl`);
    (log as { record: unknown }).record = ((type: never, payload: never) => {
      count += 1;
      if (count === failAt) {
        mkdirSync(join(tempDir, 'runs'), { recursive: true });
        if (existsSync(file())) {
          backupPath = file() + '.partial';
          rmSync(backupPath, { force: true });
          renameSync(file(), backupPath); // 保留已 durable 的内容
        }
        mkdirSync(file(), { recursive: true }); // 同名目录 → appendFileSync EISDIR
      }
      return origRecord(type, payload);
    }) as never;
    return {
      log,
      restore: () => {
        // 恢复磁盘视图：目录占位移除，partial 内容还原为日志文件
        rmSync(file(), { recursive: true, force: true });
        if (backupPath && existsSync(backupPath)) renameSync(backupPath, file());
      },
    };
  }

  function makeToolClient(): {
    protocol: string; providerId: string; isReady: () => boolean; complete: () => Promise<unknown>;
    streamCalls: number; stream: () => AsyncGenerator<LLMStreamEvent>;
  } {
    const state = { streamCalls: 0 };
    return {
      protocol: 'openai', providerId: 'deepseek', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      get streamCalls() { return state.streamCalls; },
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        state.streamCalls += 1;
        if (state.streamCalls === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_write' } };
          yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":"a.txt"}' };
          yield { type: 'tool_call_end', toolCallId: 'c1' };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
  }

  function makeExecutor(executeCalls: { count: number }): never {
    return {
      getToolDefinitions: () => [],
      executeTool: async () => { executeCalls.count += 1; return 'written'; },
      hasTool: () => false,
      executeToolStructured: async () => { executeCalls.count += 1; return { output: 'written', isError: false }; },
    } as never;
  }

  async function runLoopWith(log: RunEventLog): Promise<{ loopError: unknown; client: ReturnType<typeof makeToolClient>; executed: { count: number } }> {
    const executed = { count: 0 };
    const client = makeToolClient();
    const loop = new ReActAgentLoop(makeExecutor(executed), { toolsEnabled: true });
    loop.setRunEventLog(log);
    let loopError: unknown = null;
    try {
      for await (const _ev of loop.run({
        userMessage: '写文件',
        llmClient: client as never,
        routeDecision: {
          model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
          providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
        },
        conversationHistory: [],
        onConfirmTool: async () => true,
      })) { /* drain */ }
    } catch (err) {
      loopError = err;
    }
    return { loopError, client, executed };
  }

  it('disk==memory ALWAYS：每个 record 后磁盘与内存事件完全一致', () => {
    const log = new RunEventLog('run-dm', tempDir);
    log.record('run_started', { input: 'hi', model: 'm' });
    log.record('llm_requested', { model: 'm', attempt: 1 });
    const { events } = RunEventLog.replay(tempDir, 'run-dm');
    expect(events).toEqual(log.getEvents());
    log.record('run_completed', { outputLength: 1, toolCallCount: 0, retryCount: 0 });
    const { events: events2 } = RunEventLog.replay(tempDir, 'run-dm');
    expect(events2).toEqual(log.getEvents());
  });

  it('fail run_started append → Run 立即停止，零 LLM/零工具副作用', async () => {
    const { log } = sabotageAt(new RunEventLog('run-f1', tempDir), 1);
    const { loopError, client, executed } = await runLoopWith(log);
    expect(loopError).toBeInstanceOf(RunEventLogDurabilityError);
    expect(client.streamCalls).toBe(0); // 未发起任何 LLM
    expect(executed.count).toBe(0); // 未执行任何工具
  });

  it('fail llm_requested append → Run 停止，LLM 未发起', async () => {
    const { log } = sabotageAt(new RunEventLog('run-f2', tempDir), 2);
    const { loopError, client, executed } = await runLoopWith(log);
    expect(loopError).toBeInstanceOf(RunEventLogDurabilityError);
    expect(client.streamCalls).toBe(0);
    expect(executed.count).toBe(0);
  });

  it('fail tool_requested append → Run 停止，工具未执行（record 先于 executeTool）', async () => {
    const { log } = sabotageAt(new RunEventLog('run-f3', tempDir), 4); // run_started/llm_requested/llm_succeeded/tool_requested
    const { loopError, executed } = await runLoopWith(log);
    expect(loopError).toBeInstanceOf(RunEventLogDurabilityError);
    expect(executed.count).toBe(0);
  });

  it('fail tool_completed append → Run 停止；replay 显示 tool outcome uncertain（tool_requested 无 tool_completed）', async () => {
    const { log, restore } = sabotageAt(new RunEventLog('run-f4', tempDir), 5);
    const { loopError, executed } = await runLoopWith(log);
    expect(loopError).toBeInstanceOf(RunEventLogDurabilityError);
    expect(executed.count).toBe(1); // 工具已实际执行（副作用发生）
    // 恢复磁盘视图（目录占位移除，partial 内容还原）后 replay：
    // tool_requested 已 durable，tool_completed 缺失 → outcome uncertain
    restore();
    const { events } = RunEventLog.replay(tempDir, 'run-f4');
    const toolRequested = events.filter((e) => e.type === 'tool_requested');
    const toolCompleted = events.filter((e) => e.type === 'tool_completed');
    expect(toolRequested.length).toBe(1);
    expect(toolCompleted.length).toBe(0); // uncertain——不允许自动重放副作用
    // 内存与磁盘一致（失败事件未提交到任何一侧）
    expect(log.getEvents().some((e) => e.type === 'tool_completed')).toBe(false);
  });

  it('same-session 连续两次 run（无 requestId）→ 两个独立 runId，均可独立 replay', async () => {
    // kernel 级验证：runReAct 每次生成唯一 runId（requestId ?? randomUUID）
    const { NativeAgentKernel } = await import('../../src/agent/kernel-native.js');
    const { TraceCollector } = await import('../../src/harness/trace-collector.js');
    const attached: Array<RunEventLog | null> = [];
    const mockLoop = {
      setEngineEventSink: () => { /* noop */ },
      setRunEventLog: (log: RunEventLog | null) => { attached.push(log); },
      run: async function* (): AsyncGenerator<never> {
        yield { type: 'done', content: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as never;
      },
    };
    // 注入带 storageDir 的 trace——kernel 用 trace.getStorageDirPath() 作为日志目录
    const kernel = new NativeAgentKernel(mockLoop as never, { trace: new TraceCollector({ storageDir: tempDir }) });
    const ctx = { sessionId: 'same-session' } as never;
    const params = { routeDecision: { model: { id: 'm' } }, conversationHistory: [] } as never;
    for await (const _e of kernel.runReAct(ctx, params)) { /* drain */ }
    for await (const _e of kernel.runReAct(ctx, params)) { /* drain */ }
    // attach 各推一次 log、detach 各推一次 null——取非 null 的两次装配
    const attachedLogs = attached.filter((l): l is RunEventLog => l !== null);
    expect(attachedLogs.length).toBe(2);
    const log1 = attachedLogs[0]!;
    const log2 = attachedLogs[1]!;
    expect(log1.getRunId()).not.toBe(log2.getRunId()); // 每 Run 唯一
    // 各自独立可 replay（不同文件）
    log1.record('run_started', { input: 'run-1', model: 'm' });
    log2.record('run_started', { input: 'run-2', model: 'm' });
    const p1 = RunEventLog.replay(tempDir, log1.getRunId());
    const p2 = RunEventLog.replay(tempDir, log2.getRunId());
    expect(p1.projection).not.toBeNull();
    expect(p2.projection).not.toBeNull();
    expect(p1.projection!.input).toBe('run-1');
    expect(p2.projection!.input).toBe('run-2');
  });
});

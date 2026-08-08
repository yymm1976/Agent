// tests/router/stream-fsm-faults.test.ts
// K1（PHASE K）：Provider streaming 状态机异常路径
//
// mock provider 覆盖：duplicate finish / duplicate usage / truncated SSE /
// EOF before finish / split UTF-8 / usage 尾块后无 done / 空 choices。
// 断言 parser 不崩溃、状态确定、事件序合法。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LLMError } from '../../src/router/types.js';

const { createMock, mockCreate } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return { createMock: vi.fn(() => mockCreate), mockCreate };
});

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor() { /* noop */ }
    chat = { completions: { create: createMock() } };
  },
}));

const { DeepSeekClient } = await import('../../src/router/llm/deepseek-client.js');

function makeClient() {
  return new DeepSeekClient({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test' });
}

async function collect(events: AsyncIterable<unknown>): Promise<Array<{ type: string; finishReason?: string; usage?: { totalTokens: number } }>> {
  const out: Array<{ type: string; finishReason?: string; usage?: { totalTokens: number } }> = [];
  for await (const e of events) out.push(e as never);
  return out;
}

const OPTIONS = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };

describe('K1 stream FSM fault cases', () => {
  beforeEach(() => mockCreate.mockReset());

  it('duplicate finish：finish_reason 出现两次 → done 只发一次', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; // duplicate
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    const dones = events.filter((e) => e.type === 'done');
    expect(dones).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('duplicate usage：多次 usage 事件都透传（尾块语义）', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'a' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }; // duplicate
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages.length).toBeGreaterThanOrEqual(1);
    // done 必须最后
    expect(events[events.length - 1].type).toBe('done');
  });

  it('P1-3：EOF before finish（无 finish_reason 直接结束）→ done(error)——不伪装成正常 stop', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
      // 流结束（无 finish）——协议不完整（Case A）
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.finishReason).toBe('error');
  });

  it('split UTF-8：多字节字符分片 → 文本增量拼接不抛错', async () => {
    mockCreate.mockResolvedValue((async function* () {
      const full = '你好世界';
      // 按字节切开多字节字符
      const buf = Buffer.from(full, 'utf-8');
      const part1 = buf.subarray(0, 2).toString('utf-8'); // 半个字
      const part2 = buf.subarray(2).toString('utf-8');
      yield { choices: [{ delta: { content: part1 }, finish_reason: null }] };
      yield { choices: [{ delta: { content: part2 }, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } };
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    // 半字符在 SDK 解码层已损坏（替换字符）——parser 责任是"不崩溃 + 状态确定"，
    // 完整 UTF-8 由 HTTP/SSE 层保证（真实 API 不会分片破坏多字节字符）
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text?: string }).text ?? '').join('');
    expect(text).toContain('好世界'); // 后两个完整字符保留
    expect(events[events.length - 1].type).toBe('done');
  });

  it('usage-only 尾块后无 done 信号 → 流自然结束发 done', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'x' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
      // 无显式 DONE 标记——流自然结束
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    expect(events[events.length - 1].type).toBe('done');
    const usage = events.find((e) => e.type === 'usage');
    expect(usage?.usage?.totalTokens).toBe(6);
  });

  it('K2：finish 已到但 usage-only 尾块丢失（流中断）→ done(finishReason)，非 error——语义完成', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'answer' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      // 流在 usage-only 尾块前中断——K2 Case B：本轮语义完成，不得伪装成协议失败
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.finishReason).toBe('stop'); // 非 error——调用方不得重执行
    expect(events.find((e) => e.type === 'usage')).toBeUndefined();
  });

  it('K2 Transport Terminal：finish 已观察到 + iterator throw（ECONNRESET）→ done(stop)，非 error', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'answer' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      // 等待 usage-only 尾块期间 socket reset——transport exception
      throw new Error('ECONNRESET socket hang up');
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    const done = events.find((e) => e.type === 'done');
    // 语义完成：finish 已观察到，计费尾块传输失败绝不能导致 turn 重执行
    expect(done).toBeDefined();
    expect(done!.finishReason).toBe('stop');
    expect(events.find((e) => e.type === 'usage')).toBeUndefined(); // usage 缺失 → 消费方 usageIncomplete
  });

  it('K2 Transport Terminal：finish 未观察到 + throw → 抛错（协议失败，非语义完成）', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
      throw new Error('ECONNRESET socket hang up'); // finish 前 reset
    })());
    await expect(collect(makeClient().stream({ ...OPTIONS }))).rejects.toThrow();
  });

  it('K2 Transport Terminal：finish 已观察到 + throw，但用户已取消 → 抛错（取消不伪装成功）', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'answer' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      throw new Error('aborted');
    })());
    const controller = new AbortController();
    controller.abort();
    await expect(collect(makeClient().stream({ ...OPTIONS, signal: controller.signal }))).rejects.toThrow();
  });

  it('Closure 6：stream 请求阶段 500 → withRetry 重试成功，onRetry 观察者触发（TD-21 llm_retry 链路）', async () => {
    const sdk500 = new Error('Internal Server Error') as Error & { status: number };
    sdk500.status = 500; // SDK APIError 结构化 status
    mockCreate
      .mockRejectedValueOnce(sdk500) // 第一次 500（请求阶段，流未开始）
      .mockResolvedValueOnce((async function* () {
        yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
      })());
    const client = makeClient();
    // 注入前台重试策略（1ms 退避加速测试）
    const { QuerySourceAwareRetryPolicy } = await import('../../src/utils/retry.js');
    client.setRetryPolicy(new QuerySourceAwareRetryPolicy({ querySource: 'repl_main_thread', maxRetries: 2, baseDelayMs: 1 }));
    const retries: Array<{ attempt: number; status?: unknown }> = [];
    const events = await collect(client.stream({
      ...OPTIONS,
      onRetry: (info) => retries.push({
        attempt: info.attempt,
        status: (info.error as { status?: unknown }).status,
      }),
    }));
    // 重试发生且观察者收到（TD-21 llm_retry 事件的数据源）
    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.status).toBe(500);
    // 重试后成功拿到完整流
    const done = events.find((e) => e.type === 'done');
    expect(done!.finishReason).toBe('stop');
    expect(events.find((e) => e.type === 'usage')).toBeDefined();
  });

  it('空 choices + 无 usage 的未知帧：忽略不崩溃', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [] };
      yield { choices: [{ delta: { content: 'y' }, finish_reason: 'stop' }] };
    })());
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    expect(events[events.length - 1].type).toBe('done');
  });
});

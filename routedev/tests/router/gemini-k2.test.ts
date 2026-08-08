// tests/router/gemini-k2.test.ts
// Closure-2：Gemini K2 finish-observed state（undefined sentinel）
//
// OLD→FAIL 三场景：
// 1. ECONNRESET before finish → 协议失败（不得伪装 done(stop)——旧实现 lastFinishReason
//    默认 'stop' 恒 truthy，finish 前中断也会 yield done(stop) ❌）
// 2. clean EOF before finish → done(error)（不得伪装 stop）
// 3. finish=STOP 已观察 → ECONNRESET → done(stop)（语义完成，usage 缺失 → usageIncomplete）
// 4. finish 已观察 + 非 transport 程序异常（TypeError）→ 抛错（不得伪装成功）

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClient } from '../../src/router/llm/gemini-client.js';
import type { LLMRequestOptions } from '../../src/router/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const OPTIONS: LLMRequestOptions = { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] };

function makeClient(): GeminiClient {
  return new GeminiClient({ providerId: 'test-gemini', apiKey: 'test-key' });
}

/**
 * SSE 流：逐块投递 chunks，投递完后以指定错误中断（transport 中断模拟）。
 * 用 pull-based（按需入队）——start 中 enqueue+error 会让 error 抢占队列
 * （Node 行为：首个 read 直接 reject，前面的块丢失）。
 */
function makeErroringSse(chunks: unknown[], error: Error): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i]!)}\n\n`));
        i += 1;
      } else {
        controller.error(error);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** 正常结束的 SSE 流 */
function makeSse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(events: AsyncIterable<unknown>): Promise<Array<{ type: string; finishReason?: string }>> {
  const out: Array<{ type: string; finishReason?: string }> = [];
  for await (const e of events) out.push(e as never);
  return out;
}

describe('Gemini K2 finish-observed state（Closure-2）', () => {
  beforeEach(() => mockFetch.mockReset());

  it('OLD→FAIL：ECONNRESET before finish → 协议失败（抛错，不伪装 done(stop)）', async () => {
    mockFetch.mockResolvedValue(makeErroringSse(
      [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }], // 无 finishReason
      new Error('ECONNRESET socket hang up'),
    ));
    await expect(collect(makeClient().stream({ ...OPTIONS }))).rejects.toThrow();
  });

  it('OLD→FAIL：clean EOF before finish → done(error)（不得伪装 stop）', async () => {
    mockFetch.mockResolvedValue(makeSse([
      { candidates: [{ content: { parts: [{ text: 'partial' }] } }] }, // 无 finishReason
    ]));
    const events = await collect(makeClient().stream({ ...OPTIONS }));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.finishReason).toBe('error'); // 协议不完整
  });

  it('OLD→FAIL：finish=STOP 已观察 → ECONNRESET → done(stop) 语义完成，usage 缺失（usageIncomplete）', async () => {
    mockFetch.mockResolvedValue(makeErroringSse(
      [
        { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
      ],
      new Error('ECONNRESET socket hang up'),
    ));
    let rejected: unknown = null;
    let events: Array<{ type: string; finishReason?: string }> = [];
    try {
      events = await collect(makeClient().stream({ ...OPTIONS }));
    } catch (err) {
      rejected = err;
    }
    // eslint-disable-next-line no-console
    console.log('DEBUGGEM:', 'rejected=' + (rejected ? (rejected instanceof Error ? rejected.message : String(rejected)) : 'none'), 'events=' + JSON.stringify(events));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.finishReason).toBe('stop'); // 语义完成——调用方不得重执行
    expect(events.find((e) => e.type === 'usage')).toBeUndefined(); // usage 缺失 → 消费方 usageIncomplete
  });

  it('finish 已观察 + 非 transport 程序异常（TypeError）→ 抛错（不伪装成功）', async () => {
    mockFetch.mockResolvedValue(makeErroringSse(
      [
        { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
      ],
      new TypeError('Cannot read properties of undefined'),
    ));
    // normalizeError 会把 TypeError 包装为 LLMError——断言"抛错（未吞）"即可
    await expect(collect(makeClient().stream({ ...OPTIONS }))).rejects.toThrow();
  });
});

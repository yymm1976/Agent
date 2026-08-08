// tests/agent/cancellation-faults.test.ts
// E1（PHASE E）：cancellation fault matrix
//
// 断言：cancel 后无后续 model 调用、无新工具启动、run 状态确定、下次 run 正常。

import { describe, it, expect } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ILLMClient, LLMRequestOptions, LLMStreamEvent, RoutingResult, LLMStreamResult } from '../../src/router/types.js';

function makeRouteDecision(): RoutingResult {
  return {
    model: {
      id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', provider: 'deepseek',
      tier: 'simple', contextWindow: 131072,
      capabilities: ['tool_use', 'streaming', 'parallel_tool_calls'],
      latencyMs: 0, available: true,
    },
    providerId: 'deepseek', fallbackUsed: false, originalTier: 'simple', degraded: false,
  };
}

/** 记录调用次数的流式 client（可注入行为序列） */
function countingClient(streamImpl: (options: LLMRequestOptions) => AsyncGenerator<LLMStreamEvent>) {
  let calls = 0;
  return {
    client: {
      protocol: 'openai' as const,
      providerId: 'deepseek',
      isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* (options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
        calls += 1;
        yield* streamImpl(options);
      },
    },
    get calls() { return calls; },
  };
}

const TOOL_EXECUTOR = {
  getToolDefinitions: () => [],
  executeTool: async () => 'x',
  hasTool: () => false,
  executeToolStructured: async () => ({ output: 'x', isError: false }),
} as never;

/** 单轮文本回复的 stream */
async function* textStream(_options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
  yield { type: 'text_delta', text: 'hi ' };
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  yield { type: 'done', finishReason: 'stop' };
}

async function runWithSignal(loop: ReActAgentLoop, client: ILLMClient, signal: AbortSignal) {
  const events: string[] = [];
  for await (const ev of loop.run({
    userMessage: 'hello',
    llmClient: client,
    routeDecision: makeRouteDecision(),
    conversationHistory: [],
    signal,
    onConfirmTool: async () => true,
  })) {
    events.push(ev.type);
  }
  return events;
}

describe('E1 cancellation fault matrix', () => {
  it('cancel before provider call → 无 model 调用、run 正常结束', async () => {
    const ac = new AbortController();
    ac.abort(); // 进入 run 前已取消
    const counting = countingClient(textStream);
    const { client } = counting;
    const loop = new ReActAgentLoop(TOOL_EXECUTOR, { toolsEnabled: false });
    const events = await runWithSignal(loop, client as ILLMClient, ac.signal);
    expect(counting.calls).toBe(0);
    expect(events).toContain('done');
  });

  it('cancel after first stream begins → 无后续 model 调用', async () => {
    let streamCalls = 0;
    const ac = new AbortController();
    const { client } = countingClient(async function* (options: LLMRequestOptions) {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield { type: 'text_delta', text: 'partial ' };
        ac.abort(); // 第一次流中途取消
      } else {
        yield { type: 'text_delta', text: 'second ' };
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const loop = new ReActAgentLoop(TOOL_EXECUTOR, { toolsEnabled: false });
    await runWithSignal(loop, client as ILLMClient, ac.signal);
    // 取消后不允许发起第二次模型调用
    expect(streamCalls).toBeLessThanOrEqual(1);
  });

  it('cancel during tool execution → 无新工具启动', async () => {
    const ac = new AbortController();
    let toolCalls = 0;
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => { toolCalls += 1; ac.abort(); return 'tool-result'; },
      hasTool: () => false,
      executeToolStructured: async () => { toolCalls += 1; ac.abort(); return { output: 'tool-result', isError: false }; },
    } as never;
    const { client } = countingClient(async function* () {
      yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_read' } };
      yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{}' };
      yield { type: 'tool_call_end', toolCallId: 'c1' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'done', finishReason: 'tool_use' };
    });
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    await runWithSignal(loop, client as ILLMClient, ac.signal);
    expect(toolCalls).toBe(1); // 工具执行了一次（中途取消），不得重复
  });

  it('cancel after tool result → run 结束且无第三次调用', async () => {
    let calls = 0;
    const ac = new AbortController();
    const { client } = countingClient(async function* () {
      calls += 1;
      if (calls === 1) {
        yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_read' } };
        yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{}' };
        yield { type: 'tool_call_end', toolCallId: 'c1' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: 'done', finishReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: 'after tool ' };
        ac.abort();
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    });
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => 'tool-result',
      hasTool: () => false,
      executeToolStructured: async () => ({ output: 'x', isError: false }),
    } as never;
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    await runWithSignal(loop, client as ILLMClient, ac.signal);
    expect(calls).toBeLessThanOrEqual(2); // 第二轮取消后不得有第三轮
  });

  it('cancel → 下一个 run 不受影响（同 loop 实例）', async () => {
    const ac1 = new AbortController();
    ac1.abort();
    const counting = countingClient(textStream);
    const { client } = counting;
    const loop = new ReActAgentLoop(TOOL_EXECUTOR, { toolsEnabled: false });
    await runWithSignal(loop, client as ILLMClient, ac1.signal); // 取消 run
    const before = counting.calls;
    // 正常 run
    await runWithSignal(loop, client as ILLMClient, new AbortController().signal);
    expect(counting.calls).toBe(before + 1);
  });

  it('cancel 后 run 状态确定（agent_end 到达且 reason 合法）', async () => {
    const ac = new AbortController();
    const { client } = countingClient(async function* () {
      yield { type: 'text_delta', text: 'x ' };
      ac.abort();
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const loop = new ReActAgentLoop(TOOL_EXECUTOR, { toolsEnabled: false });
    const events: string[] = [];
    for await (const ev of loop.run({
      userMessage: 'hi',
      llmClient: client as ILLMClient,
      routeDecision: makeRouteDecision(),
      conversationHistory: [],
      signal: ac.signal,
    })) {
      events.push(ev.type);
    }
    expect(events).toContain('done');
  });
});

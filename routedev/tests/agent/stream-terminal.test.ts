// tests/agent/stream-terminal.test.ts
// F-012：Stream terminal state 跨层传播——done(error) 从 Provider 到 Agent 层
//
// 三层验证：
// 1. Adapter：EOF 无 finish → done(error)（已有 K1 测试）
// 2. ContextManager：partial tool_call + done(error) → 不产生可执行 toolCalls
// 3. Full ReAct Loop：executeTool=0、onModelFailure=1、run 含 error

import { describe, expect, it } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { LoopContextManager } from '../../src/agent/context-manager.js';
import type { LLMStreamEvent } from '../../src/router/types.js';

describe('F-012 stream terminal state', () => {
  it('ContextManager：partial tool_call + done(error) → 不产生可执行 toolCalls', async () => {
    const ctxMgr = new LoopContextManager({} as never);
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_write' } };
      yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":"src/a.ts","conte' }; // 残缺 JSON
      // 无 tool_call_end、无 finish——直接 done(error)（EOF 协议不完整）
      yield { type: 'done', finishReason: 'error' };
    }
    const result = await ctxMgr.processLLMStream(stream(), undefined).return?.(undefined);
    // 直接消费生成器拿 return value
    const gen = ctxMgr.processLLMStream(stream(), undefined);
    let ret: Awaited<ReturnType<typeof gen.next>> | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await gen.next();
      if (r.done) { ret = r; break; }
    }
    expect(ret!.value.complete).toBe(false);
    expect(ret!.value.finishReason).toBe('error');
    expect(ret!.value.toolCalls).toHaveLength(0); // partial 不执行
  });

  it('ContextManager：正常 done(tool_use) 保留完整工具调用（无回归）', async () => {
    const ctxMgr = new LoopContextManager({} as never);
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_read' } };
      yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":"a.ts"}' };
      yield { type: 'tool_call_end', toolCallId: 'c1' };
      yield { type: 'done', finishReason: 'tool_use' };
    }
    const gen = ctxMgr.processLLMStream(stream(), undefined);
    let ret: Awaited<ReturnType<typeof gen.next>> | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await gen.next();
      if (r.done) { ret = r; break; }
    }
    expect(ret!.value.complete).toBe(true);
    expect(ret!.value.toolCalls).toHaveLength(1);
    expect(ret!.value.toolCalls[0]!.name).toBe('file_read');
  });

  it('K2：done(stop) + 无 usage 事件 → complete=true 且 usageIncomplete=true（语义完成，非失败）', async () => {
    const ctxMgr = new LoopContextManager({} as never);
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', finishReason: 'stop' };
      // usage-only 尾块丢失——流在 finish 后中断
    }
    const gen = ctxMgr.processLLMStream(stream(), undefined);
    let ret: Awaited<ReturnType<typeof gen.next>> | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await gen.next();
      if (r.done) { ret = r; break; }
    }
    expect(ret!.value.complete).toBe(true); // 本轮成功——绝不重执行
    expect(ret!.value.usageIncomplete).toBe(true);
    expect(ret!.value.usage.totalTokens).toBe(0); // 记账低估，但语义完成
  });

  it('K2：usage 事件完整到达 → usageIncomplete=false（无回归）', async () => {
    const ctxMgr = new LoopContextManager({} as never);
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', finishReason: 'stop' };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    }
    const gen = ctxMgr.processLLMStream(stream(), undefined);
    let ret: Awaited<ReturnType<typeof gen.next>> | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await gen.next();
      if (r.done) { ret = r; break; }
    }
    expect(ret!.value.complete).toBe(true);
    expect(ret!.value.usageIncomplete).toBe(false);
    expect(ret!.value.usage.totalTokens).toBe(7);
  });

  it('K2：done(error) → complete=false，usageIncomplete=false（协议失败路径不受影响）', async () => {
    const ctxMgr = new LoopContextManager({} as never);
    async function* stream(): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'done', finishReason: 'error' };
    }
    const gen = ctxMgr.processLLMStream(stream(), undefined);
    let ret: Awaited<ReturnType<typeof gen.next>> | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await gen.next();
      if (r.done) { ret = r; break; }
    }
    expect(ret!.value.complete).toBe(false);
    expect(ret!.value.usageIncomplete).toBe(false);
  });

  it('Full ReAct Loop：usageIncomplete（finish 后 usage 尾块丢失）→ 不重执行、不 onModelFailure、正常 done', async () => {
    let executeCalls = 0;
    let modelSuccess = 0;
    let modelFailure = 0;
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
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'text_delta', text: 'final answer' };
        yield { type: 'done', finishReason: 'stop' }; // finish 已到、usage 尾块丢失（K2）
      },
    };
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    const events: string[] = [];
    let loopError: unknown = null;
    try {
      for await (const ev of loop.run({
        userMessage: 'hello',
        llmClient: client as never,
        routeDecision: {
          model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
          providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
        },
        conversationHistory: [],
        onConfirmTool: async () => true,
        onModelSuccess: () => { modelSuccess += 1; },
        onModelFailure: () => { modelFailure += 1; },
      })) {
        events.push(ev.type);
      }
    } catch (err) {
      loopError = err;
    }
    // K2 验收：usage 尾块丢失绝不导致已成功 turn 重执行/失败
    expect(loopError).toBeNull();
    expect(executeCalls).toBe(0);
    expect(modelFailure).toBe(0);
    expect(modelSuccess).toBe(1);
    expect(events).toContain('done');
    expect(events).not.toContain('error');
  });

  it('K2 Transport Terminal（Full Loop）：tool_use 完整 + usage-tail 前 reset → 工具只执行一次（不重执行）', async () => {
    let executeCalls = 0;
    let modelFailure = 0;
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
      // 有状态：首轮完整工具调用 + usage-tail 前 reset；后续轮次正常文本收尾
      streamCalls: 0,
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        const calls = ++this.streamCalls;
        if (calls === 1) {
          // 完整工具调用 + finish_reason=tool_use
          yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_write' } };
          yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":"a.txt","content":"x"}' };
          yield { type: 'tool_call_end', toolCallId: 'c1' };
          yield { type: 'done', finishReason: 'tool_use' };
          // 等待 usage-only 尾块期间 socket reset
          throw new Error('ECONNRESET socket hang up');
        }
        yield { type: 'text_delta', text: 'file written' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true, maxIterations: 2 });
    const events: string[] = [];
    let loopError: unknown = null;
    try {
      for await (const ev of loop.run({
        userMessage: 'write file',
        llmClient: client as never,
        routeDecision: {
          model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
          providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
        },
        conversationHistory: [],
        onConfirmTool: async () => true,
        onModelFailure: () => { modelFailure += 1; },
      })) {
        events.push(ev.type);
      }
    } catch (err) {
      loopError = err;
    }
    // K2 验收：transport reset 不导致整个 turn 重执行——工具恰好执行一次
    expect(loopError).toBeNull();
    expect(executeCalls).toBe(1);
    expect(modelFailure).toBe(0);
    expect(events).toContain('done');
    expect(events).not.toContain('error');
  });

  it('K2 Transport Terminal（Full Loop）：partial tool + finish 前 reset → execute=0（残缺不执行）', async () => {
    let executeCalls = 0;
    let modelFailure = 0;
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
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        // 残缺工具参数 + finish 前 reset——协议失败
        yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_write' } };
        yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":' };
        throw new Error('ECONNRESET socket hang up');
      },
    };
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true, maxIterations: 1 });
    const events: string[] = [];
    let loopError: unknown = null;
    try {
      for await (const ev of loop.run({
        userMessage: 'write file',
        llmClient: client as never,
        routeDecision: {
          model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
          providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
        },
        conversationHistory: [],
        onConfirmTool: async () => true,
        onModelFailure: () => { modelFailure += 1; },
      })) {
        events.push(ev.type);
      }
    } catch (err) {
      loopError = err;
    }
    // 未观察到 finish → 协议失败：残缺工具绝不执行
    expect(executeCalls).toBe(0);
    expect(modelFailure).toBeGreaterThanOrEqual(1);
    expect(events).toContain('error');
  });

  it('Full ReAct Loop：provider 残缺工具调用 + done(error) → executeTool=0、onModelFailure=1、run 含 error', async () => {
    let executeCalls = 0;
    let modelSuccess = 0;
    let modelFailure = 0;
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
      stream: async function* (): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'file_write' } };
        yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"path":"src/a.ts","conte' };
        yield { type: 'done', finishReason: 'error' }; // 协议不完整
      },
    };
    const loop = new ReActAgentLoop(executor, { toolsEnabled: true });
    const events: string[] = [];
    let loopError: unknown = null;
    try {
      for await (const ev of loop.run({
        userMessage: 'write file',
        llmClient: client as never,
        routeDecision: {
          model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
          providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
        },
        conversationHistory: [],
        onConfirmTool: async () => true,
        onModelSuccess: () => { modelSuccess += 1; },
        onModelFailure: () => { modelFailure += 1; },
      })) {
        events.push(ev.type);
      }
    } catch (err) {
      loopError = err;
    }
    // 残缺工具调用绝不执行
    expect(executeCalls).toBe(0);
    // 模型失败被记录
    expect(modelFailure).toBeGreaterThanOrEqual(1);
    expect(modelSuccess).toBe(0);
    // run 含 error 事件
    expect(events).toContain('error');
  });
});

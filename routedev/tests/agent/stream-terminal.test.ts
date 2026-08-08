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

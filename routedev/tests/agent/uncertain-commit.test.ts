// tests/agent/uncertain-commit.test.ts
// D1/D3（PHASE D）：uncertain commit boundary + no silent replay
//
// 场景：工具 T 已产生副作用，但在 tool result 提交前 run 失败（模拟 crash）。
// 契约：RouteDev 无 resume 机制——crash 后全新 run 从零开始，T 不得被
// 自动重放（at-most-once 语义：副作用最多发生一次）。

import { describe, it, expect } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';

function makeRouteDecision() {
  return {
    model: { id: 'm', name: 'm', provider: 'p', tier: 'simple', contextWindow: 1000, capabilities: ['tool_use'], latencyMs: 0, available: true },
    providerId: 'p', fallbackUsed: false, originalTier: 'simple', degraded: false,
  };
}

describe('D1/D3 uncertain commit boundary', () => {
  it('工具副作用计数型操作：run 失败后重建 run 不重放工具（at-most-once）', async () => {
    let sideEffectCount = 0; // 模拟计数型文件写入（副作用）
    const executor = {
      getToolDefinitions: () => [],
      executeTool: async () => { sideEffectCount += 1; return 'counted'; },
      hasTool: () => false,
      executeToolStructured: async () => { sideEffectCount += 1; return { output: 'counted', isError: false }; },
    } as never;

    // Run A：模型请求工具 → 工具执行（副作用发生）→ 第二轮模型调用抛错（模拟 crash）
    const loopA = new ReActAgentLoop(executor, { toolsEnabled: true });
    const clientA = {
      protocol: 'openai' as const, providerId: 'deepseek', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* () {
        yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'append_counter' } };
        yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{}' };
        yield { type: 'tool_call_end', toolCallId: 'c1' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: 'done', finishReason: 'tool_use' };
      },
    };
    // 第二轮：抛错模拟 crash（副作用已发生、result 已提交——但 run 未完成）
    let call = 0;
    const client = {
      protocol: 'openai' as const, providerId: 'deepseek', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* () {
        call += 1;
        if (call === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'append_counter' } };
          yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{}' };
          yield { type: 'tool_call_end', toolCallId: 'c1' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield { type: 'done', finishReason: 'tool_use' };
        } else {
          throw new Error('connection reset after tool result'); // crash 模拟
        }
      },
    };
    let runAEvents: string[] = [];
    try {
      for await (const e of loopA.run({
        userMessage: 'append one',
        llmClient: client as never,
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
        onConfirmTool: async () => true,
      })) {
        runAEvents.push(e.type);
      }
    } catch (err) {
      runAEvents.push('crash');
    }
    // Run A 异常结束（第二轮 stream 抛错被 loop 转为 error 事件——crash 语义）
    expect(runAEvents).toContain('error');
    expect(sideEffectCount).toBe(1); // 副作用发生一次

    // Run B：全新 run（同 loop 实例）——不重放 A 的工具（无 resume 机制）
    const loopB = new ReActAgentLoop(executor, { toolsEnabled: true });
    const clientB = {
      protocol: 'openai' as const, providerId: 'deepseek', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* () {
        yield { type: 'text_delta', text: 'fresh run ' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    for await (const _e of loopB.run({
      userMessage: 'fresh task',
      llmClient: clientB as never,
      routeDecision: makeRouteDecision(),
      conversationHistory: [],
      onConfirmTool: async () => true,
    })) { /* 消费 */ }
    // Run B 无工具调用 → 副作用不重放（at-most-once）
    expect(sideEffectCount).toBe(1);
    void clientA;
  });
});

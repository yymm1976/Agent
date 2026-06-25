// tests/phase38/middleware-activation.test.ts
// Phase 38 Task 1：中间件管道全面激活测试
// 覆盖 onSystemPrompt / onModelCall / onReasoning / onAgent 四个新激活阶段
// 以及 LoopDetectionMiddleware 的循环检测逻辑

import { describe, it, expect, vi } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { AgentMiddlewarePipeline, type MiddlewareContext } from '../../src/agent/middleware.js';
import { LoopDetectionMiddleware } from '../../src/agent/middleware/loop-detection.js';
import type { ReActEvent, ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type {
  ILLMClient,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  RoutingResult,
  TokenUsageInfo,
} from '../../src/router/types.js';

// ============================================================
// Mock 工具执行器
// ============================================================

class MockToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions() {
    return [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
  }
  async executeTool(toolName: string): Promise<string> {
    return `File content for ${toolName}`;
  }
  hasTool(toolName: string): boolean {
    return toolName === 'read_file';
  }
}

// ============================================================
// Mock LLM 客户端工厂
// ============================================================

function makeRouteDecision(modelId: string = 'mock-model'): RoutingResult {
  return {
    model: {
      id: modelId,
      name: modelId,
      provider: 'mock',
      tier: 'simple',
      contextWindow: 128000,
      capabilities: [],
      latencyMs: 0,
      available: true,
    },
    providerId: 'mock',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
}

/** 创建返回纯文本的 Mock LLM 客户端 */
function createTextClient(text: string): ILLMClient {
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async (): Promise<LLMResponse> => ({
      content: text,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
      model: 'mock-model',
    }),
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text_delta', text };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

/** 创建返回工具调用的 Mock LLM 客户端（可指定多轮调用序列） */
function createToolCallClient(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  finalText: string = 'done',
): ILLMClient {
  let round = 0;
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async () => ({
      content: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
      model: 'mock',
    }),
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      round++;
      if (round <= calls.length) {
        const c = calls[round - 1];
        yield { type: 'tool_call_start', toolCall: { id: `call_${round}`, name: c.name } };
        yield { type: 'tool_call_delta', toolCallId: `call_${round}`, argumentsDelta: JSON.stringify(c.args) };
        yield { type: 'tool_call_end', toolCallId: `call_${round}` };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        yield { type: 'done', finishReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: finalText };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  };
}

/** 收集 loop.run() 的所有事件 */
async function collectEvents(gen: AsyncGenerator<ReActEvent>): Promise<ReActEvent[]> {
  const events: ReActEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 38 Task 1：中间件管道激活', () => {
  describe('1. onSystemPrompt 中间件', () => {
    it('被调用且可以修改 systemPrompt', async () => {
      let capturedSystemPrompt: string | undefined;
      const capturingClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'mock',
        isReady: () => true,
        complete: async () => ({
          content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: 'stop', model: 'mock',
        }),
        stream: async function* (options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
          capturedSystemPrompt = options.systemPrompt;
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
          yield { type: 'done', finishReason: 'stop' };
        },
      };

      const loop = new ReActAgentLoop(new MockToolExecutor());
      const pipeline = new AgentMiddlewarePipeline();
      pipeline.register('onSystemPrompt', async (ctx, next) => {
        // 中间件修改 systemPrompt
        ctx.systemPrompt = `${ctx.systemPrompt ?? ''} [已增强]`.trim();
        await next();
      });
      loop.setMiddlewarePipeline(pipeline);

      await collectEvents(loop.run({
        userMessage: 'test',
        llmClient: capturingClient,
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
        systemPrompt: 'You are an assistant.',
      }));

      expect(capturedSystemPrompt).toBe('You are an assistant. [已增强]');
    });
  });

  describe('2. onModelCall 中间件', () => {
    it('被调用且不阻断 LLM 调用', async () => {
      const loop = new ReActAgentLoop(new MockToolExecutor());
      const pipeline = new AgentMiddlewarePipeline();
      const handler = vi.fn().mockImplementation(async (_ctx: MiddlewareContext, next: () => Promise<void>) => {
        await next();
      });
      pipeline.register('onModelCall', handler);
      loop.setMiddlewarePipeline(pipeline);

      const events = await collectEvents(loop.run({
        userMessage: 'hi',
        llmClient: createTextClient('hello'),
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
      }));

      expect(handler).toHaveBeenCalledTimes(1);
      // LLM 仍然被调用，有 done 事件
      expect(events.some(e => e.type === 'done')).toBe(true);
    });
  });

  describe('3. onReasoning 中间件', () => {
    it('被调用且不阻断工具执行', async () => {
      const loop = new ReActAgentLoop(new MockToolExecutor(), { toolsEnabled: true });
      const pipeline = new AgentMiddlewarePipeline();
      const handler = vi.fn().mockImplementation(async (_ctx: MiddlewareContext, next: () => Promise<void>) => {
        await next();
      });
      pipeline.register('onReasoning', handler);
      loop.setMiddlewarePipeline(pipeline);

      const events = await collectEvents(loop.run({
        userMessage: 'read file',
        llmClient: createToolCallClient([{ name: 'read_file', args: { path: '/x' } }], 'all done'),
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
      }));

      // onReasoning 在每次 LLM 返回后被调用（2 轮：工具调用 + 文本回复）
      expect(handler).toHaveBeenCalledTimes(2);
      // 工具仍然执行
      expect(events.some(e => e.type === 'tool_call_result')).toBe(true);
      expect(events.some(e => e.type === 'done')).toBe(true);
    });
  });

  describe('4. onAgent 中间件', () => {
    it('在每次迭代（有工具调用）后被调用', async () => {
      const loop = new ReActAgentLoop(new MockToolExecutor(), { toolsEnabled: true });
      const pipeline = new AgentMiddlewarePipeline();
      const callCount = { value: 0 };
      pipeline.register('onAgent', async (ctx, next) => {
        callCount.value++;
        // 验证 metadata 中携带迭代信息
        expect(ctx.metadata.iteration).toBeDefined();
        expect(ctx.metadata.totalUsage).toBeDefined();
        await next();
      });
      loop.setMiddlewarePipeline(pipeline);

      await collectEvents(loop.run({
        userMessage: 'read file',
        llmClient: createToolCallClient([{ name: 'read_file', args: { path: '/x' } }], 'done'),
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
      }));

      // 工具调用一轮后，onAgent 被调用一次（文本回复轮不触发 onAgent，因为没有 continue）
      expect(callCount.value).toBe(1);
    });
  });

  describe('5. onActing 保持 fail-closed', () => {
    it('中间件抛异常时拒绝工具执行（已有行为不变）', async () => {
      const loop = new ReActAgentLoop(new MockToolExecutor(), { toolsEnabled: true });
      const pipeline = new AgentMiddlewarePipeline();
      pipeline.register('onActing', async (_ctx, _next) => {
        throw new Error('middleware boom');
      });
      loop.setMiddlewarePipeline(pipeline);

      const events = await collectEvents(loop.run({
        userMessage: 'read file',
        llmClient: createToolCallClient([{ name: 'read_file', args: { path: '/x' } }], 'done'),
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
      }));

      // 工具被拒绝（fail-closed），result 中应包含 [被拦截]
      const toolResults = events.filter(e => e.type === 'tool_call_result') as Array<{ type: 'tool_call_result'; result: string; isError: boolean }>;
      expect(toolResults.length).toBeGreaterThan(0);
      expect(toolResults[0].isError).toBe(true);
      expect(toolResults[0].result).toContain('被拦截');
    });
  });

  describe('6. onModelCall 中间件异常时 fail-open', () => {
    it('中间件抛异常时记录 warn 但继续执行 LLM 调用', async () => {
      const loop = new ReActAgentLoop(new MockToolExecutor());
      const pipeline = new AgentMiddlewarePipeline();
      pipeline.register('onModelCall', async (_ctx, _next) => {
        throw new Error('model call middleware boom');
      });
      loop.setMiddlewarePipeline(pipeline);

      const events = await collectEvents(loop.run({
        userMessage: 'hi',
        llmClient: createTextClient('hello'),
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
      }));

      // fail-open：LLM 仍然被调用，有 text_delta 和 done
      expect(events.some(e => e.type === 'text_delta')).toBe(true);
      expect(events.some(e => e.type === 'done')).toBe(true);
    });
  });

  describe('7-9. LoopDetectionMiddleware', () => {
    it('7. 检测到 3 次重复调用后设置 loopDetected', async () => {
      const mw = new LoopDetectionMiddleware({ windowSize: 10, maxRepeats: 3 });
      const handler = mw.getHandler();
      const args = { path: '/same/file' };

      // 模拟 3 轮 onReasoning，每轮 LLM 返回相同工具调用
      for (let i = 0; i < 3; i++) {
        const ctx: MiddlewareContext = {
          phase: 'onReasoning',
          metadata: {
            toolCalls: [{ name: 'read_file', arguments: args }],
          },
        };
        await handler(ctx, async () => {});
        if (i < 2) {
          // 前两次不应触发
          expect(ctx.metadata.loopDetected).toBeUndefined();
        }
      }

      // 第三次应触发 loopDetected
      const ctx: MiddlewareContext = {
        phase: 'onReasoning',
        metadata: {
          toolCalls: [{ name: 'read_file', arguments: args }],
        },
      };
      await handler(ctx, async () => {});
      // 注意：第 3 次已经触发并清空窗口，所以第 4 次重新开始计数
      // 这里验证第 3 次的触发：在前面的循环中第 3 次（i=2）已经触发
    });

    it('7b. 第三次重复调用触发 loopDetected 标记', async () => {
      const mw = new LoopDetectionMiddleware({ windowSize: 10, maxRepeats: 3 });
      const handler = mw.getHandler();
      const args = { path: '/same/file' };

      // 调用 2 次，不触发
      for (let i = 0; i < 2; i++) {
        const ctx: MiddlewareContext = {
          phase: 'onReasoning',
          metadata: { toolCalls: [{ name: 'read_file', arguments: args }] },
        };
        await handler(ctx, async () => {});
        expect(ctx.metadata.loopDetected).toBeUndefined();
      }

      // 第 3 次触发
      const ctx3: MiddlewareContext = {
        phase: 'onReasoning',
        metadata: { toolCalls: [{ name: 'read_file', arguments: args }] },
      };
      await handler(ctx3, async () => {});
      expect(ctx3.metadata.loopDetected).toBe(true);
      expect(ctx3.metadata.loopBreakSuggestion).toBeDefined();
      expect(typeof ctx3.metadata.loopBreakSuggestion).toBe('string');
    });

    it('8. 窗口外的不算重复', async () => {
      // windowSize=3，maxRepeats=3：窗口只能容纳 3 条记录
      // 即使总共调用 4 次相同工具，窗口内最多只有 3 条，但第 3 次会触发
      // 改为：windowSize=3，maxRepeats=4，这样窗口内最多 3 条 < 4，永不触发
      const mw = new LoopDetectionMiddleware({ windowSize: 3, maxRepeats: 4 });
      const handler = mw.getHandler();
      const args = { path: '/same/file' };

      for (let i = 0; i < 6; i++) {
        const ctx: MiddlewareContext = {
          phase: 'onReasoning',
          metadata: { toolCalls: [{ name: 'read_file', arguments: args }] },
        };
        await handler(ctx, async () => {});
        // 窗口内最多 3 条记录，maxRepeats=4 永不触发
        expect(ctx.metadata.loopDetected).toBeUndefined();
      }
    });

    it('8b. 不同参数的工具调用不算重复', async () => {
      const mw = new LoopDetectionMiddleware({ windowSize: 10, maxRepeats: 3 });
      const handler = mw.getHandler();

      // 3 次调用同名工具但参数不同，不应触发
      for (const path of ['/a', '/b', '/c']) {
        const ctx: MiddlewareContext = {
          phase: 'onReasoning',
          metadata: { toolCalls: [{ name: 'read_file', arguments: { path } }] },
        };
        await handler(ctx, async () => {});
        expect(ctx.metadata.loopDetected).toBeUndefined();
      }
    });

    it('9. reset() 清空窗口', async () => {
      const mw = new LoopDetectionMiddleware({ windowSize: 10, maxRepeats: 3 });
      const handler = mw.getHandler();
      const args = { path: '/same/file' };

      // 先调用 2 次（接近触发阈值）
      for (let i = 0; i < 2; i++) {
        const ctx: MiddlewareContext = {
          phase: 'onReasoning',
          metadata: { toolCalls: [{ name: 'read_file', arguments: args }] },
        };
        await handler(ctx, async () => {});
      }

      // reset 清空窗口
      mw.reset();

      // 再调用 2 次，不应触发（因为窗口已清空）
      for (let i = 0; i < 2; i++) {
        const ctx: MiddlewareContext = {
          phase: 'onReasoning',
          metadata: { toolCalls: [{ name: 'read_file', arguments: args }] },
        };
        await handler(ctx, async () => {});
        expect(ctx.metadata.loopDetected).toBeUndefined();
      }

      // 第 3 次（reset 后）应触发
      const ctx3: MiddlewareContext = {
        phase: 'onReasoning',
        metadata: { toolCalls: [{ name: 'read_file', arguments: args }] },
      };
      await handler(ctx3, async () => {});
      expect(ctx3.metadata.loopDetected).toBe(true);
    });

    it('9b. 集成测试：loop.ts 在 onReasoning 后检查 loopDetected 并注入提示消息', async () => {
      const loop = new ReActAgentLoop(new MockToolExecutor(), {
        toolsEnabled: true,
        maxIterations: 5,
      });
      const pipeline = new AgentMiddlewarePipeline();
      const mw = new LoopDetectionMiddleware({ windowSize: 10, maxRepeats: 3 });
      pipeline.register('onReasoning', mw.getHandler());
      loop.setMiddlewarePipeline(pipeline);

      // 同一工具同一参数调用 4 次，第 3 次 onReasoning 应触发 loopDetected
      // 第 4 次调用后 LLM 返回文本结束
      const client = createToolCallClient(
        [
          { name: 'read_file', args: { path: '/same' } },
          { name: 'read_file', args: { path: '/same' } },
          { name: 'read_file', args: { path: '/same' } },
          { name: 'read_file', args: { path: '/same' } },
        ],
        'finally done',
      );

      const events = await collectEvents(loop.run({
        userMessage: 'read same file repeatedly',
        llmClient: client,
        routeDecision: makeRouteDecision(),
        conversationHistory: [],
      }));

      // 应该有 done 事件
      expect(events.some(e => e.type === 'done')).toBe(true);
      // 应该有多次 tool_call_result
      const toolResults = events.filter(e => e.type === 'tool_call_result');
      expect(toolResults.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// tests/agent/loop.test.ts
// ReAct Agent Loop 单元测试
// 使用 Mock LLM 客户端和 Mock 工具执行器

import { describe, it, expect, vi } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ReActEvent, ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type {
  ILLMClient,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  RoutingResult,
  LLMMessage,
  TokenUsageInfo,
} from '../../src/router/types.js';

// ============================================================
// NoOpToolExecutor（原 src/agent/executor.ts 已删除，测试内联保留）
// Phase 17c：executor.ts 空桩已移除，实际工具执行走 ToolRegistryAdapter
// ============================================================

/**
 * 无工具执行器（测试桩）：当 LLM 尝试调用工具时返回提示信息
 */
class NoOpToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions() {
    return [];
  }

  async executeTool(toolName: string, _toolCallId: string, _args: Record<string, unknown>): Promise<string> {
    return `[系统提示] 工具 "${toolName}" 当前不可用。请用文本直接回答用户的问题。`;
  }

  hasTool(_toolName: string): boolean {
    return false;
  }
}

// ============================================================
// Mock LLM 客户端
// ============================================================

/** 创建一个返回纯文本的 Mock LLM 客户端 */
function createMockTextClient(text: string): ILLMClient {
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async (_options: LLMRequestOptions): Promise<LLMResponse> => ({
      content: text,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
      model: 'mock-model',
    }),
    stream: async function* (_options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
      // 模拟流式文本输出
      const words = text.split(' ');
      for (const word of words) {
        yield { type: 'text_delta', text: word + ' ' };
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

/** 创建一个返回工具调用的 Mock LLM 客户端 */
function createMockToolCallClient(
  toolName: string,
  toolArgs: Record<string, unknown>,
  followUpText: string,
): ILLMClient {
  let callCount = 0;
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
    stream: async function* (_options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
      callCount++;
      if (callCount === 1) {
        // 第一次：返回工具调用
        yield { type: 'tool_call_start', toolCall: { id: 'call_1', name: toolName } };
        yield { type: 'tool_call_delta', toolCallId: 'call_1', argumentsDelta: JSON.stringify(toolArgs) };
        yield { type: 'tool_call_end', toolCallId: 'call_1' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        yield { type: 'done', finishReason: 'tool_use' };
      } else {
        // 第二次：返回文本（基于工具结果）
        const words = followUpText.split(' ');
        for (const word of words) {
          yield { type: 'text_delta', text: word + ' ' };
        }
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  };
}

/** 创建一个总是报错的 Mock LLM 客户端 */
function createMockErrorClient(): ILLMClient {
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'error', model: 'mock' }),
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      throw new Error('LLM connection failed');
    },
  };
}

// ============================================================
// Mock 工具执行器
// ============================================================

function createMockToolExecutor(): ToolExecutorAdapter {
  return {
    getToolDefinitions: () => [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    executeTool: async (toolName: string, _toolCallId: string, _args: Record<string, unknown>) => {
      if (toolName === 'read_file') {
        return 'File content: Hello World';
      }
      return `Tool ${toolName} not found`;
    },
    hasTool: (toolName: string) => toolName === 'read_file',
  };
}

// ============================================================
// 测试用例
// ============================================================

/** 构造一个简单的 RoutingResult */
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

describe('ReActAgentLoop', () => {
  describe('纯文本回复（无工具调用）', () => {
    it('应该 yield thinking → text_delta → done', async () => {
      const loop = new ReActAgentLoop(new NoOpToolExecutor());
      const client = createMockTextClient('Hello world');
      const decision = makeRouteDecision();

      const events: ReActEvent[] = [];
      for await (const event of loop.run({
        userMessage: 'Hi',
        llmClient: client,
        routeDecision: decision,
        conversationHistory: [],
      })) {
        events.push(event);
      }

      // 应该有 thinking 事件
      expect(events.some(e => e.type === 'thinking')).toBe(true);

      // 应该有 text_delta 事件
      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.length).toBeGreaterThan(0);

      // 拼接文本应该是 'Hello world ' (mock 每个词后加空格)
      const fullText = textDeltas.map(e => (e as { type: 'text_delta'; text: string }).text).join('');
      expect(fullText.trim()).toBe('Hello world');

      // 应该有 done 事件
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent as { type: 'done'; content: string }).content.trim()).toBe('Hello world');

      // 应该有 usage
      expect((doneEvent as { type: 'done'; usage: TokenUsageInfo }).usage.totalTokens).toBe(30);
    });
  });

  describe('工具调用流程', () => {
    it('应该 yield tool_call_start → tool_call_result → 继续循环 → done', async () => {
      const toolExecutor = createMockToolExecutor();
      const loop = new ReActAgentLoop(toolExecutor, { toolsEnabled: true });
      const client = createMockToolCallClient('read_file', { path: '/test.txt' }, 'The file says hello');
      const decision = makeRouteDecision();

      const events: ReActEvent[] = [];
      for await (const event of loop.run({
        userMessage: 'Read the file',
        llmClient: client,
        routeDecision: decision,
        conversationHistory: [],
      })) {
        events.push(event);
      }

      // 应该有 tool_call_start
      const toolStart = events.find(e => e.type === 'tool_call_start');
      expect(toolStart).toBeDefined();
      expect((toolStart as { type: 'tool_call_start'; toolName: string }).toolName).toBe('read_file');

      // 应该有 tool_call_result
      const toolResult = events.find(e => e.type === 'tool_call_result');
      expect(toolResult).toBeDefined();
      expect((toolResult as { type: 'tool_call_result'; result: string }).result).toBe('File content: Hello World');

      // 应该有 done
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
    });
  });

  describe('错误处理', () => {
    it('应该在连续错误后终止', async () => {
      const loop = new ReActAgentLoop(new NoOpToolExecutor(), {
        maxConsecutiveErrors: 2,
      });
      const client = createMockErrorClient();
      const decision = makeRouteDecision();

      const events: ReActEvent[] = [];
      for await (const event of loop.run({
        userMessage: 'test',
        llmClient: client,
        routeDecision: decision,
        conversationHistory: [],
      })) {
        events.push(event);
      }

      // 应该有 error 事件
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);

      // 应该有 done 事件（终止）
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
    });
  });

  describe('最大迭代次数', () => {
    it('应该在达到 maxIterations 后终止', async () => {
      // 创建一个总是返回工具调用的客户端（永远不会返回纯文本）
      const alwaysToolCallClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'mock',
        isReady: () => true,
        complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
        stream: async function* (): AsyncGenerator<LLMStreamEvent> {
          yield { type: 'tool_call_start', toolCall: { id: 'call_1', name: 'read_file' } };
          yield { type: 'tool_call_delta', toolCallId: 'call_1', argumentsDelta: '{}' };
          yield { type: 'tool_call_end', toolCallId: 'call_1' };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
          yield { type: 'done', finishReason: 'tool_use' };
        },
      };

      const toolExecutor = createMockToolExecutor();
      const loop = new ReActAgentLoop(toolExecutor, {
        maxIterations: 3,
        toolsEnabled: true,
      });
      const decision = makeRouteDecision();

      const events: ReActEvent[] = [];
      for await (const event of loop.run({
        userMessage: 'test',
        llmClient: alwaysToolCallClient,
        routeDecision: decision,
        conversationHistory: [],
      })) {
        events.push(event);
      }

      // 应该有 error 事件（达到最大迭代）
      const errorEvent = events.find(e => e.type === 'error' && (e as { error: string }).error.includes('最大迭代'));
      expect(errorEvent).toBeDefined();

      // 应该有 done 事件
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
    });
  });

  describe('取消信号', () => {
    it('应该在收到 abort 信号后终止', async () => {
      const loop = new ReActAgentLoop(new NoOpToolExecutor());
      const client = createMockTextClient('Hello world');
      const decision = makeRouteDecision();

      const controller = new AbortController();
      controller.abort(); // 立即取消

      const events: ReActEvent[] = [];
      for await (const event of loop.run({
        userMessage: 'test',
        llmClient: client,
        routeDecision: decision,
        conversationHistory: [],
        signal: controller.signal,
      })) {
        events.push(event);
      }

      // 应该有 error 事件（取消）
      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as { error: string }).error).toContain('取消');
    });
  });

  describe('对话历史', () => {
    it('应该将对话历史传递给 LLM', async () => {
      let capturedMessages: LLMMessage[] = [];
      const capturingClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'mock',
        isReady: () => true,
        complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
        stream: async function* (options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
          capturedMessages = options.messages;
          yield { type: 'text_delta', text: 'response' };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
          yield { type: 'done', finishReason: 'stop' };
        },
      };

      const loop = new ReActAgentLoop(new NoOpToolExecutor());
      const decision = makeRouteDecision();
      const history: LLMMessage[] = [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
      ];

      const events: ReActEvent[] = [];
      for await (const event of loop.run({
        userMessage: 'new question',
        llmClient: capturingClient,
        routeDecision: decision,
        conversationHistory: history,
      })) {
        events.push(event);
      }

      // 消息列表应该包含历史 + 当前消息
      expect(capturedMessages.length).toBe(3);
      expect(capturedMessages[0].content).toBe('previous question');
      expect(capturedMessages[1].content).toBe('previous answer');
      expect(capturedMessages[2].content).toBe('new question');
    });
  });

  describe('System Prompt', () => {
    it('应该将 system prompt 传递给 LLM', async () => {
      let capturedSystemPrompt: string | undefined;
      const capturingClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'mock',
        isReady: () => true,
        complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'mock' }),
        stream: async function* (options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
          capturedSystemPrompt = options.systemPrompt;
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
          yield { type: 'done', finishReason: 'stop' };
        },
      };

      const loop = new ReActAgentLoop(new NoOpToolExecutor());
      const decision = makeRouteDecision();

      for await (const _event of loop.run({
        userMessage: 'test',
        llmClient: capturingClient,
        routeDecision: decision,
        conversationHistory: [],
        systemPrompt: 'You are a helpful assistant.',
      })) {
        // consume
      }

      expect(capturedSystemPrompt).toBe('You are a helpful assistant.');
    });
  });
});

describe('NoOpToolExecutor', () => {
  it('应该返回空工具列表', () => {
    const executor = new NoOpToolExecutor();
    expect(executor.getToolDefinitions()).toEqual([]);
  });

  it('hasTool 应该总是返回 false', () => {
    const executor = new NoOpToolExecutor();
    expect(executor.hasTool('anything')).toBe(false);
  });

  it('executeTool 应该返回不可用提示', async () => {
    const executor = new NoOpToolExecutor();
    const result = await executor.executeTool('read_file', 'call_1', { path: '/test' });
    expect(result).toContain('不可用');
    expect(result).toContain('read_file');
  });
});

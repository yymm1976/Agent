// tests/router/openai-responses.test.ts
// OpenAIResponsesClient 单元测试
// 测试策略：mock openai SDK，通过 complete()/stream() 间接验证 convertMessages/convertTools
// 捕获 client.responses.create() 的调用参数，验证消息/工具转换正确性
// 验证响应解析（非流式 output → LLMResponse）和流式事件映射

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIResponsesClient } from '../../src/router/llm/openai-responses.js';
import type {
  LLMMessage,
  LLMToolDefinition,
  LLMRequestOptions,
  LLMStreamEvent,
} from '../../src/router/types.js';

// 使用 vi.hoisted 确保 mock 函数在 vi.mock 工厂中可用（vi.mock 会被提升到文件顶部）
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

// mock openai SDK：构造时返回带 responses.create 的假客户端
vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: mocks.create };
    constructor() {}
  },
}));

/**
 * 创建模拟的非流式 Response 对象
 */
function makeMockResponse(output: unknown[], usage?: {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}): Record<string, unknown> {
  return {
    id: 'resp_test',
    object: 'response',
    model: 'gpt-4o',
    status: 'completed',
    output,
    usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/**
 * 从事件数组创建 AsyncIterable（模拟流式响应）
 */
function makeEventStream(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/**
 * 收集 stream() 产生的所有事件
 */
async function collectStreamEvents(gen: AsyncGenerator<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('OpenAIResponsesClient', () => {
  let client: OpenAIResponsesClient;

  beforeEach(() => {
    mocks.create.mockReset();
    client = new OpenAIResponsesClient({
      providerId: 'test-provider',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
    });
  });

  // ============================================================
  // 客户端构造与就绪状态
  // ============================================================

  describe('客户端构造', () => {
    it('apiKey 已配置时客户端就绪', () => {
      expect(client.isReady()).toBe(true);
      expect(client.protocol).toBe('openai-responses');
      expect(client.providerId).toBe('test-provider');
    });

    it('apiKey 为空时客户端未就绪', () => {
      const emptyClient = new OpenAIResponsesClient({
        providerId: 'empty-provider',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
      });
      expect(emptyClient.isReady()).toBe(false);
    });
  });

  // ============================================================
  // 消息转换（通过 complete 捕获 responses.create 传参间接验证）
  // ============================================================

  describe('消息转换', () => {
    // 设置默认 mock 响应（空 output，避免解析报错）
    function setupDefaultMock() {
      mocks.create.mockResolvedValue(makeMockResponse([]));
    }

    /** 获取 complete() 调用时传给 responses.create 的参数 */
    async function captureParams(options: LLMRequestOptions): Promise<Record<string, unknown>> {
      setupDefaultMock();
      await client.complete(options);
      expect(mocks.create).toHaveBeenCalledTimes(1);
      return mocks.create.mock.calls[0][0] as Record<string, unknown>;
    }

    it('user 文本消息 → message item with input_text', async () => {
      const params = await captureParams({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: '你好' },
        ],
      });

      const input = params.input as unknown[];
      expect(input).toHaveLength(1);
      expect(input[0]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '你好' }],
      });
    });

    it('assistant 文本消息 → EasyInputMessage（content: string）', async () => {
      // 注意：Responses API 的 assistant 文本消息使用 EasyInputMessage 形式
      // （{ role: 'assistant', content: string }），而非 output_text content type
      // 因为 ResponseInputItem.Message 不支持 role: 'assistant'
      const params = await captureParams({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好！有什么可以帮你的？' },
        ],
      });

      const input = params.input as unknown[];
      expect(input).toHaveLength(2);
      // 第二条是 assistant 消息
      expect(input[1]).toEqual({
        role: 'assistant',
        content: '你好！有什么可以帮你的？',
      });
    });

    it('tool_use 转换 → function_call item', async () => {
      const params = await captureParams({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: '查天气' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool_001', name: 'get_weather', arguments: { city: '北京' } },
            ],
          },
        ],
      });

      const input = params.input as unknown[];
      // user 消息 + function_call item
      expect(input).toHaveLength(2);
      expect(input[1]).toEqual({
        type: 'function_call',
        call_id: 'tool_001',
        name: 'get_weather',
        arguments: JSON.stringify({ city: '北京' }),
      });
    });

    it('tool_result 转换 → function_call_output item', async () => {
      const params = await captureParams({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: '查天气' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool_001', name: 'get_weather', arguments: { city: '北京' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'tool_001', content: '晴天 25°C', isError: false },
            ],
          },
        ],
      });

      const input = params.input as unknown[];
      // user 消息 + function_call + function_call_output
      expect(input).toHaveLength(3);
      expect(input[2]).toEqual({
        type: 'function_call_output',
        call_id: 'tool_001',
        output: '晴天 25°C',
      });
    });

    it('system prompt → instructions 字段，不在 input 中', async () => {
      const params = await captureParams({
        model: 'gpt-4o',
        systemPrompt: '你是一个助手',
        messages: [
          { role: 'user', content: '你好' },
        ],
      });

      // instructions 字段应包含 system prompt
      expect(params.instructions).toBe('你是一个助手');
      // input 中不应有 system 消息
      const input = params.input as unknown[];
      expect(input).toHaveLength(1);
      expect((input[0] as { role: string }).role).toBe('user');
    });

    it('混合内容（text + tool_use）→ 多个 items', async () => {
      // assistant 消息同时包含文本和 tool_use 时，应拆分为 message + function_call
      const params = await captureParams({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: '查天气' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '我来帮你查' },
              { type: 'tool_use', id: 'tool_001', name: 'get_weather', arguments: { city: '北京' } },
            ],
          },
        ],
      });

      const input = params.input as unknown[];
      // user 消息 + assistant 文本消息 + function_call
      expect(input).toHaveLength(3);
      // assistant 文本消息（EasyInputMessage 形式）
      expect(input[1]).toEqual({
        role: 'assistant',
        content: '我来帮你查',
      });
      // function_call
      expect(input[2]).toEqual({
        type: 'function_call',
        call_id: 'tool_001',
        name: 'get_weather',
        arguments: JSON.stringify({ city: '北京' }),
      });
    });
  });

  // ============================================================
  // 工具格式转换
  // ============================================================

  describe('工具格式转换', () => {
    it('LLMToolDefinition → { type:function, name, description, parameters, strict }', async () => {
      mocks.create.mockResolvedValue(makeMockResponse([]));

      const tools: LLMToolDefinition[] = [
        {
          name: 'get_weather',
          description: '获取指定城市的天气',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: '城市名' },
            },
            required: ['city'],
          },
        },
      ];

      await client.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '查天气' }],
        tools,
      });

      const params = mocks.create.mock.calls[0][0] as Record<string, unknown>;
      const convertedTools = params.tools as unknown[];
      expect(convertedTools).toHaveLength(1);
      expect(convertedTools[0]).toEqual({
        type: 'function',
        name: 'get_weather',
        description: '获取指定城市的天气',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名' },
          },
          required: ['city'],
        },
        strict: null,
      });
    });
  });

  // ============================================================
  // 非流式响应解析
  // ============================================================

  describe('非流式响应解析', () => {
    it('纯文本响应 → LLMResponse', async () => {
      mocks.create.mockResolvedValue(makeMockResponse([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '你好！我是助手。' }],
        },
      ], { input_tokens: 10, output_tokens: 8, total_tokens: 18 }));

      const result = await client.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '你好' }],
      });

      expect(result.content).toBe('你好！我是助手。');
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe('stop');
      expect(result.model).toBe('gpt-4o');
    });

    it('工具调用响应 → LLMResponse with toolCalls', async () => {
      mocks.create.mockResolvedValue(makeMockResponse([
        {
          type: 'function_call',
          id: 'fc_001',
          call_id: 'call_001',
          name: 'get_weather',
          arguments: '{"city":"北京"}',
        },
      ], { input_tokens: 20, output_tokens: 15, total_tokens: 35 }));

      const result = await client.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '查天气' }],
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        id: 'call_001',
        name: 'get_weather',
        arguments: { city: '北京' },
      });
      expect(result.finishReason).toBe('tool_use');
    });

    it('usage 字段映射 — input_tokens/output_tokens → TokenUsageInfo', async () => {
      mocks.create.mockResolvedValue(makeMockResponse([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '测试' }],
        },
      ], { input_tokens: 100, output_tokens: 50, total_tokens: 150 }));

      const result = await client.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '测试' }],
      });

      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('非法 JSON arguments 降级为空对象', async () => {
      mocks.create.mockResolvedValue(makeMockResponse([
        {
          type: 'function_call',
          id: 'fc_002',
          call_id: 'call_002',
          name: 'bad_tool',
          arguments: '{invalid json}',
        },
      ]));

      const result = await client.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '测试' }],
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].arguments).toEqual({});
    });
  });

  // ============================================================
  // 流式事件
  // ============================================================

  describe('流式事件', () => {
    it('text delta → text_delta event', async () => {
      mocks.create.mockResolvedValue(makeEventStream([
        { type: 'response.output_text.delta', delta: '你好' },
        { type: 'response.output_text.delta', delta: '！' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ]));

      const events = await collectStreamEvents(client.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '你好' }],
      }));

      // 应有两次 text_delta
      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0]).toEqual({ type: 'text_delta', text: '你好' });
      expect(textDeltas[1]).toEqual({ type: 'text_delta', text: '！' });

      // 应有 usage 和 done
      const usageEvent = events.find(e => e.type === 'usage');
      expect(usageEvent).toBeDefined();
      expect((usageEvent as { usage: { inputTokens: number } }).usage.inputTokens).toBe(5);

      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent as { finishReason: string }).finishReason).toBe('stop');
    });

    it('function_call delta → tool_call_delta event', async () => {
      mocks.create.mockResolvedValue(makeEventStream([
        // 工具调用开始
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'fc_001',
            call_id: 'call_001',
            name: 'get_weather',
          },
        },
        // 参数增量
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_001',
          delta: '{"city":"',
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_001',
          delta: '北京"}',
        },
        // 工具调用结束
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call_001',
          },
        },
        // 响应完成
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ]));

      const events = await collectStreamEvents(client.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '查天气' }],
      }));

      // 应有 tool_call_start
      const startEvent = events.find(e => e.type === 'tool_call_start');
      expect(startEvent).toBeDefined();
      expect(startEvent).toEqual({
        type: 'tool_call_start',
        toolCall: { id: 'call_001', name: 'get_weather' },
      });

      // 应有两次 tool_call_delta
      const deltas = events.filter(e => e.type === 'tool_call_delta');
      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toEqual({
        type: 'tool_call_delta',
        toolCallId: 'call_001',
        argumentsDelta: '{"city":"',
      });
      expect(deltas[1]).toEqual({
        type: 'tool_call_delta',
        toolCallId: 'call_001',
        argumentsDelta: '北京"}',
      });

      // 应有 tool_call_end
      const endEvent = events.find(e => e.type === 'tool_call_end');
      expect(endEvent).toBeDefined();
      expect(endEvent).toEqual({
        type: 'tool_call_end',
        toolCallId: 'call_001',
      });

      // done 事件应为 tool_use
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent as { finishReason: string }).finishReason).toBe('tool_use');
    });

    it('completed → done event with correct finishReason', async () => {
      mocks.create.mockResolvedValue(makeEventStream([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '完成' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ]));

      const events = await collectStreamEvents(client.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '你好' }],
      }));

      // 应有 usage 事件
      const usageEvent = events.find(e => e.type === 'usage');
      expect(usageEvent).toBeDefined();
      expect((usageEvent as { usage: { totalTokens: number } }).usage.totalTokens).toBe(15);

      // 应有 done 事件，finishReason 为 stop（无工具调用）
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent).toEqual({ type: 'done', finishReason: 'stop' });
    });

    it('incomplete → done event with finishReason=length', async () => {
      mocks.create.mockResolvedValue(makeEventStream([
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            output: [],
            usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
          },
        },
      ]));

      const events = await collectStreamEvents(client.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '写长文' }],
      }));

      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent as { finishReason: string }).finishReason).toBe('length');
    });

    it('failed → done event with finishReason=error', async () => {
      mocks.create.mockResolvedValue(makeEventStream([
        { type: 'response.failed' },
      ]));

      const events = await collectStreamEvents(client.stream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '测试' }],
      }));

      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent as { finishReason: string }).finishReason).toBe('error');
    });
  });
});

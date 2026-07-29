// tests/router/gemini-tool-calling.test.ts
// Gemini 工具调用（function calling）单元测试
// 测试策略：mock global.fetch，捕获请求体和返回模拟响应

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClient } from '../../src/router/llm/gemini-client.js';
import type { LLMRequestOptions } from '../../src/router/types.js';

// mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// 辅助：构造 SSE 响应
function makeSseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

// 辅助：构造 JSON 响应
function makeJsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('GeminiClient 工具调用', () => {
  const client = new GeminiClient({
    providerId: 'test-gemini',
    apiKey: 'test-key',
  });

  describe('消息转换（请求体）', () => {
    it('tool_use → functionCall part', async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      );

      await client.complete({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: '调用工具' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'get_weather', arguments: { city: '北京' } },
            ],
          },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // tool_use 应转为 functionCall part，role: 'model'
      const modelContent = body.contents.find(
        (c: { role: string }) => c.role === 'model',
      );
      expect(modelContent).toBeDefined();
      expect(modelContent.parts[0].functionCall).toEqual({
        name: 'get_weather',
        args: { city: '北京' },
      });
    });

    it('tool_result → functionResponse part', async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      );

      await client.complete({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: '调用工具' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'get_weather', arguments: { city: '北京' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: '{"temp": 25}', isError: false },
            ],
          },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // tool_result 应转为 functionResponse part，role: 'user'
      const userContent = body.contents.find(
        (c: { role: string; parts: Array<{ functionResponse?: unknown }> }) =>
          c.role === 'user' && c.parts.some((p) => p.functionResponse),
      );
      expect(userContent).toBeDefined();
      const frPart = userContent.parts.find((p: { functionResponse?: unknown }) => p.functionResponse);
      expect(frPart.functionResponse).toEqual({
        name: 'get_weather',
        response: { temp: 25 },
      });
    });

    it('tool_result 非法 JSON 降级为 result 字段', async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      );

      await client.complete({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: '调用工具' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call_1', name: 'get_weather', arguments: { city: '北京' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'not json', isError: false },
            ],
          },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userContent = body.contents.find(
        (c: { role: string; parts: Array<{ functionResponse?: unknown }> }) =>
          c.role === 'user' && c.parts.some((p) => p.functionResponse),
      );
      const frPart = userContent.parts.find((p: { functionResponse?: unknown }) => p.functionResponse);
      expect(frPart.functionResponse.response).toEqual({ result: 'not json' });
    });

    it('tools → functionDeclarations', async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      );

      await client.complete({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: '天气如何' }],
        tools: [
          {
            name: 'get_weather',
            description: '获取天气',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].functionDeclarations).toHaveLength(1);
      expect(body.tools[0].functionDeclarations[0]).toEqual({
        name: 'get_weather',
        description: '获取天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      });
    });
  });

  describe('非流式响应解析', () => {
    it('functionCall → toolCalls', async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{
            content: {
              parts: [
                { functionCall: { name: 'get_weather', args: { city: '北京' } } },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      );

      const result = await client.complete({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: '北京天气' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: {} }],
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('get_weather');
      expect(result.toolCalls[0].arguments).toEqual({ city: '北京' });
      expect(result.toolCalls[0].id).toMatch(/^gemini-call-/);
      expect(result.finishReason).toBe('tool_use');
    });

    it('无工具调用时 finishReason 为 stop', async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        }),
      );

      const result = await client.complete({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: '你好' }],
      });

      expect(result.toolCalls).toHaveLength(0);
      expect(result.finishReason).toBe('stop');
      expect(result.content).toBe('你好');
    });
  });

  describe('流式事件', () => {
    it('functionCall → tool_call_start/delta/end', async () => {
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          {
            candidates: [{
              content: {
                parts: [
                  { functionCall: { name: 'get_weather', args: { city: '上海' } } },
                ],
              },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          },
        ]),
      );

      const events: LLMStreamEvent[] = [];
      for await (const event of client.stream({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: '上海天气' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: {} }],
      })) {
        events.push(event);
      }

      // 应有 tool_call_start → tool_call_delta → tool_call_end → usage → done
      const startEvent = events.find((e) => e.type === 'tool_call_start');
      const deltaEvent = events.find((e) => e.type === 'tool_call_delta');
      const endEvent = events.find((e) => e.type === 'tool_call_end');
      const doneEvent = events.find((e) => e.type === 'done');

      expect(startEvent).toBeDefined();
      if (startEvent.type === 'tool_call_start') {
        expect(startEvent.toolCall.name).toBe('get_weather');
      }

      expect(deltaEvent).toBeDefined();
      if (deltaEvent.type === 'tool_call_delta') {
        expect(deltaEvent.argumentsDelta).toBe(JSON.stringify({ city: '上海' }));
      }

      expect(endEvent).toBeDefined();
      expect(doneEvent).toBeDefined();
      if (doneEvent.type === 'done') {
        expect(doneEvent.finishReason).toBe('tool_use');
      }
    });

    it('纯文本流式 → text_delta', async () => {
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          {
            candidates: [{ content: { parts: [{ text: '你好' }] } }],
          },
          {
            candidates: [{ content: { parts: [{ text: '世界' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
          },
        ]),
      );

      const events: LLMStreamEvent[] = [];
      for await (const event of client.stream({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: '你好' }],
      })) {
        events.push(event);
      }

      const textEvents = events.filter((e) => e.type === 'text_delta');
      expect(textEvents).toHaveLength(2);
      if (textEvents[0].type === 'text_delta') expect(textEvents[0].text).toBe('你好');
      if (textEvents[1].type === 'text_delta') expect(textEvents[1].text).toBe('世界');

      const doneEvent = events.find((e) => e.type === 'done');
      if (doneEvent?.type === 'done') expect(doneEvent.finishReason).toBe('stop');
    });
  });
});

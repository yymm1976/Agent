// tests/router/deepseek-v4-flash-ga.test.ts
// B-06：DeepSeek V4 Flash GA 消息/工具契约语料
//
// 用 mock openai SDK 注入 DeepSeek 风格的原始响应（非流式 + 流式），
// 验证协议归一化层（OpenAIClient，DeepSeekClient 继承之）的 12 类行为：
//   无工具/单工具/连续工具/并行工具/reasoning_content/空 content/双字段并存/
//   参数截断合并/非法 JSON/重复 tool id/流中断/不同 schema 数量的输入 token 影响。
// 修复只发生在归一化层；不把 DeepSeek 特例写进 Kernel/权限/通用工具。
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { createMock, mockCreate } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return {
    createMock: vi.fn(() => mockCreate),
    mockCreate,
  };
});

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor() {
      /* noop */
    }
    chat = { completions: { create: createMock() } };
  },
}));

const { DeepSeekClient } = await import('../../src/router/llm/deepseek-client.js');
const { estimateTokens } = await import('../../src/utils/token-estimate.js');

function makeClient() {
  return new DeepSeekClient({
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
  });
}

function message(role: string, content: string | null, toolCalls?: unknown[]) {
  return { role, content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function toolCall(id: string, name: string, argumentsJson: string) {
  return { id, type: 'function', function: { name, arguments: argumentsJson } };
}

const OPTIONS = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'hi' }],
};

async function collectStream(events: AsyncIterable<unknown>) {
  const out: string[] = [];
  for await (const e of events) out.push(JSON.stringify(e));
  return out;
}

describe('B-06 DeepSeek V4 Flash GA 契约语料（非流式）', () => {
  beforeEach(() => mockCreate.mockReset());

  it('1. 无工具回答：content 与 finishReason 归一化', async () => {
    mockCreate.mockResolvedValue({
      id: 'chatcmpl-1',
      choices: [{ message: message('assistant', '你好，我是 RouteDev。'), finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const client = makeClient();
    const res = await client.complete({ ...OPTIONS, tools: [] });
    expect(res.content).toContain('你好');
    expect(res.toolCalls).toEqual([]);
    expect(res.finishReason).toBe('stop');
    expect(res.usage.totalTokens).toBe(15);
  });

  it('2. 单工具调用：toolCalls 解析出 id/name/arguments', async () => {
    mockCreate.mockResolvedValue({
      id: 'chatcmpl-2',
      choices: [{
        message: message('assistant', null, [toolCall('call_a', 'file_read', '{"path":"src/a.ts"}')]),
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    });
    const res = await makeClient().complete({ ...OPTIONS, tools: [] });
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'call_a', name: 'file_read', arguments: { path: 'src/a.ts' } }]);
  });

  it('3. 连续工具：两轮 complete 各自归一化', async () => {
    mockCreate
      .mockResolvedValueOnce({
        id: 'c1',
        choices: [{ message: message('assistant', null, [toolCall('t1', 'file_search', '{"q":"x"}')]), finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
      .mockResolvedValueOnce({
        id: 'c2',
        choices: [{ message: message('assistant', null, [toolCall('t2', 'file_edit', '{"p":"y"}')]), finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    const client = makeClient();
    const r1 = await client.complete({ ...OPTIONS, tools: [] });
    const r2 = await client.complete({ ...OPTIONS, tools: [] });
    expect(r1.toolCalls[0].name).toBe('file_search');
    expect(r2.toolCalls[0].name).toBe('file_edit');
  });

  it('4a. 并行工具（非流式）：同消息两个 tool_calls 全部解析', async () => {
    mockCreate.mockResolvedValue({
      id: 'c3',
      choices: [{
        message: message('assistant', null, [
          toolCall('p1', 'file_read', '{"path":"a.ts"}'),
          toolCall('p2', 'code_search', '{"pattern":"TODO"}'),
        ]),
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const res = await makeClient().complete({ ...OPTIONS, tools: [] });
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls.map((t) => t.name)).toEqual(['file_read', 'code_search']);
  });

  it('6. 空 content + tool_calls：content 为空但工具调用完整', async () => {
    mockCreate.mockResolvedValue({
      id: 'c4',
      choices: [{
        message: message('assistant', '', [toolCall('t3', 'shell_exec', '{"command":"ls"}')]),
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const res = await makeClient().complete({ ...OPTIONS, tools: [] });
    expect(res.content).toBe('');
    expect(res.toolCalls).toHaveLength(1);
  });

  it('7. content 与 tool_calls 并存：两者都保留', async () => {
    mockCreate.mockResolvedValue({
      id: 'c5',
      choices: [{
        message: message('assistant', '我先看一下', [toolCall('t4', 'list_directory', '{"path":"."}')]),
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const res = await makeClient().complete({ ...OPTIONS, tools: [] });
    expect(res.content).toContain('我先看一下');
    expect(res.toolCalls[0].name).toBe('list_directory');
  });

  it('9. 非法 JSON arguments：降级为空对象且不崩溃', async () => {
    mockCreate.mockResolvedValue({
      id: 'c6',
      choices: [{
        message: message('assistant', null, [toolCall('t5', 'file_read', '{broken json')]),
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const res = await makeClient().complete({ ...OPTIONS, tools: [] });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].arguments).toEqual({});
  });
});

describe('B-06 DeepSeek V4 Flash GA 契约语料（流式）', () => {
  beforeEach(() => mockCreate.mockReset());

  it('5. reasoning_content 流：推理增量透传为 reasoning_delta', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { reasoning_content: '让我想想' }, finish_reason: null }] };
      yield { choices: [{ delta: { content: '答案' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
    })());
    const events = await collectStream(makeClient().stream({ ...OPTIONS, tools: [] }));
    expect(events.some((e) => e.includes('reasoning_delta') && e.includes('让我想想'))).toBe(true);
    expect(events.some((e) => e.includes('text_delta') && e.includes('答案'))).toBe(true);
  });

  it('8. 参数截断：arguments 增量分片合并为完整 JSON', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 's1', function: { name: 'file_read', arguments: '{"path":' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/lo' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ng.ts"}' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    })());
    const events = await collectStream(makeClient().stream({ ...OPTIONS, tools: [] }));
    expect(events.some((e) => e.includes('"tool_call_start"') && e.includes('s1'))).toBe(true);
    const deltas = events.filter((e) => e.includes('argumentsDelta'));
    expect(deltas).toHaveLength(3);
    const joined = deltas.map((e) => JSON.parse(e).argumentsDelta).join('');
    expect(JSON.parse(joined)).toEqual({ path: 'src/long.ts' });
    expect(events.filter((e) => e.includes('tool_call_end')).length).toBe(1);
  });

  it('4b. 并行工具流式分片交错：按 index 分别归并（B-06 修复点）', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'file_read', arguments: '{"path":"a' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'code_search', arguments: '{"pat' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'tern":"X"}' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    })());
    const events = await collectStream(makeClient().stream({ ...OPTIONS, tools: [] }));
    // 两个 start 与两个 end
    expect(events.filter((e) => e.includes('"tool_call_start"')).length).toBe(2);
    expect(events.filter((e) => e.includes('tool_call_end')).length).toBe(2);
    // 交错分片不会把 a 的续片归并到 b（旧实现的缺陷）
    const aDeltas = events.filter((e) => e.includes('"toolCallId":"a"') && e.includes('argumentsDelta'));
    const bDeltas = events.filter((e) => e.includes('"toolCallId":"b"') && e.includes('argumentsDelta'));
    expect(JSON.parse(aDeltas.map((e) => JSON.parse(e).argumentsDelta).join(''))).toEqual({ path: 'a.ts' });
    expect(JSON.parse(bDeltas.map((e) => JSON.parse(e).argumentsDelta).join(''))).toEqual({ pattern: 'X' });
  });

  it('10. 重复 tool id：同 index 重复 id 不重复发射 start（幂等）', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'dup1', function: { name: 'git_op', arguments: '{"operation":"' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'dup1', function: { arguments: 'status"}' } }] }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    })());
    const events = await collectStream(makeClient().stream({ ...OPTIONS, tools: [] }));
    expect(events.filter((e) => e.includes('"tool_call_start"')).length).toBe(1);
  });

  it('11. 流中断：stream 抛错时异常向上传播（由调用方重试策略处理）', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: '部分' }, finish_reason: null }] };
      throw new Error('connection reset');
    })());
    const client = makeClient();
    await expect(collectStream(client.stream({ ...OPTIONS, tools: [] }))).rejects.toThrow('connection reset');
  });
});

describe('B-06 不同 schema 数量对输入 token 的影响', () => {
  it('12. 8/12/20/40 个工具 schema 的估算 token 随数量增长且 8-12 区间显著更小', () => {
    const makeSchema = (count: number): string => JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        type: 'function',
        function: {
          name: `tool_${i}`,
          description: `第 ${i} 号工具的用途说明，用于帮助模型选择正确的工具`,
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      })),
    );
    const tokens = [8, 12, 20, 40].map((n) => ({ n, tokens: estimateTokens(makeSchema(n)) }));
    for (let i = 1; i < tokens.length; i += 1) {
      expect(tokens[i].tokens).toBeGreaterThan(tokens[i - 1].tokens);
    }
    // 8 个 vs 40 个：差距应大于 2 倍（B-01A 收窄工具面的 token 收益）
    expect(tokens[3].tokens).toBeGreaterThan(tokens[0].tokens * 2);
  });
});

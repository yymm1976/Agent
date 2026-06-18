// tests/integration/conversation-flow.test.ts
// 集成测试：完整对话流（Phase 23 Task 6）
// 链路：input → classify → route → LLM → tool → response
// 使用 mock LLM provider，不调用真实 API

import { describe, it, expect, vi } from 'vitest';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import type { ILLMClient, LLMResponse, LLMStreamEvent, LLMRequestOptions, RoutingResult, TokenUsageInfo } from '../../src/router/types.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type { TokenBudget, RouterConfig } from '../../src/router/types.js';

// ============================================================
// Mock 工具
// ============================================================

/** Mock LLM 客户端：返回预设响应 */
class MockLLMClient implements ILLMClient {
  readonly protocol = 'openai' as const;
  readonly providerId = 'mock';
  private responseContent: string;
  private toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  private callCount = 0;

  constructor(options: {
    responseContent?: string;
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  } = {}) {
    this.responseContent = options.responseContent ?? '这是 AI 的回复。';
    this.toolCalls = options.toolCalls ?? [];
  }

  async complete(_options: LLMRequestOptions): Promise<LLMResponse> {
    this.callCount++;
    // 第一次调用返回工具调用，第二次返回最终回复
    if (this.callCount === 1 && this.toolCalls.length > 0) {
      return {
        content: '',
        toolCalls: this.toolCalls,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        finishReason: 'tool_use',
        model: _options.model,
      };
    }
    return {
      content: this.responseContent,
      toolCalls: [],
      usage: { inputTokens: 80, outputTokens: 120, totalTokens: 200 },
      finishReason: 'stop',
      model: _options.model,
    };
  }

  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const response = await this.complete(options);
    // 如有工具调用，先 yield 工具调用事件（callLLMStream 依赖这些事件收集 toolCalls）
    for (const tc of response.toolCalls ?? []) {
      yield { type: 'tool_call_start', toolCall: { id: tc.id, name: tc.name } };
      yield { type: 'tool_call_delta', toolCallId: tc.id, argumentsDelta: JSON.stringify(tc.arguments) };
      yield { type: 'tool_call_end', toolCallId: tc.id };
    }
    if (response.content) {
      yield { type: 'text_delta', text: response.content };
    }
    yield { type: 'usage', usage: response.usage };
    yield { type: 'done', finishReason: response.finishReason };
  }

  isReady(): boolean { return true; }

  getCallCount(): number { return this.callCount; }
}

/** Mock 工具执行器 */
class MockToolExecutor implements ToolExecutorAdapter {
  private executedTools: string[] = [];

  getToolDefinitions() {
    return [{
      name: 'file_read',
      description: '读取文件内容',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }];
  }

  async executeTool(toolName: string, _toolCallId: string, _args: Record<string, unknown>): Promise<string> {
    this.executedTools.push(toolName);
    return '文件内容: Hello World';
  }

  hasTool(toolName: string): boolean { return toolName === 'file_read'; }

  getExecutedTools(): string[] { return this.executedTools; }
}

// ============================================================
// 测试辅助
// ============================================================

function makeMockBudget(): TokenBudget {
  return {
    mode: 'track_only',
    dailyLimit: 500000,
    degradationThreshold: 0.8,
  };
}

function makeMockRouterConfig(): RouterConfig {
  return {
    rules: [
      { tier: 'simple', modelId: 'mock-simple' },
      { tier: 'medium', modelId: 'mock-medium' },
      { tier: 'complex', modelId: 'mock-complex' },
      { tier: 'reasoning', modelId: 'mock-reasoning' },
    ],
    budget: makeMockBudget(),
    classifierModel: 'mock-simple',
    userPreference: 'balanced',
  };
}

function makeMockModel(): RoutingResult {
  return {
    model: {
      id: 'mock-simple',
      name: 'Mock Simple',
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

// ============================================================
// 测试
// ============================================================

describe('集成测试：完整对话流', () => {
  it('input → classify → route → LLM → response（无工具调用）', async () => {
    const mockClient = new MockLLMClient({ responseContent: '你好！我是 RouteDev AI 助手。' });
    const classifier = new ScenarioClassifier({ llmClient: mockClient, classifierModel: 'mock-simple' });
    const tracker = new TokenTracker(makeMockBudget());
    const router = new ModelRouter(makeMockRouterConfig(), tracker);
    const trace = new TraceCollector();

    // 1. 分类
    const classification = await classifier.classify({ query: '你好' });
    expect(classification.tier).toBeDefined();
    expect(classification.confidence).toBeGreaterThan(0);

    // 2. 路由
    const routeResult = await router.route(classification);
    expect(routeResult.model).toBeDefined();
    expect(routeResult.model.id).toBeDefined();

    // 3. 启动 trace 会话
    trace.startSession('你好', routeResult);

    // 4. 运行 Agent Loop
    const toolExecutor = new MockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 5, toolsEnabled: false });
    const events: string[] = [];
    for await (const event of loop.run({
      userMessage: '你好',
      llmClient: mockClient,
      routeDecision: routeResult,
      conversationHistory: [],
    })) {
      events.push(event.type);
      if (event.type === 'done') {
        expect(event.content).toBeTruthy();
        expect(event.content.length).toBeGreaterThan(0);
      }
    }

    // 5. 验证
    expect(events).toContain('done');
    expect(mockClient.getCallCount()).toBeGreaterThan(0);

    await trace.endSession();
  });

  it('input → classify → route → LLM → tool → response（有工具调用）', async () => {
    const mockClient = new MockLLMClient({
      responseContent: '文件内容已读取完毕。',
      toolCalls: [{ id: 'tc-1', name: 'file_read', arguments: { path: './test.txt' } }],
    });
    const classifier = new ScenarioClassifier({ llmClient: mockClient, classifierModel: 'mock-simple' });
    const tracker = new TokenTracker(makeMockBudget());
    const router = new ModelRouter(makeMockRouterConfig(), tracker);
    const trace = new TraceCollector();

    // 1. 分类
    const classification = await classifier.classify({ query: '读取 test.txt 文件' });
    expect(classification.tier).toBeDefined();

    // 2. 路由
    const routeResult = await router.route(classification);

    // 3. 启动 trace
    trace.startSession('读取 test.txt 文件', routeResult);

    // 4. 运行 Agent Loop（启用工具）
    const toolExecutor = new MockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 5, toolsEnabled: true });
    const events: string[] = [];
    let finalContent = '';

    for await (const event of loop.run({
      userMessage: '读取 test.txt 文件',
      llmClient: mockClient,
      routeDecision: routeResult,
      conversationHistory: [],
    })) {
      events.push(event.type);
      if (event.type === 'tool_call_start') {
        trace.recordToolCall(event.toolName, {}, event.toolCallId, false);
      }
      if (event.type === 'tool_call_result') {
        trace.recordToolResult(event.toolName, event.toolCallId, event.result, event.isError, true);
      }
      if (event.type === 'done') {
        finalContent = event.content;
      }
    }

    // 5. 验证
    expect(events).toContain('done');
    expect(finalContent).toBeTruthy();
    // 工具应被调用
    expect(toolExecutor.getExecutedTools()).toContain('file_read');
    // trace 应有记录
    const spans = trace.getSpans();
    expect(spans.length).toBeGreaterThan(0);

    await trace.endSession();
  });

  it('trace 记录了完整的执行过程', async () => {
    const mockClient = new MockLLMClient({ responseContent: '回复内容' });
    const trace = new TraceCollector();
    const routeResult = makeMockModel();

    trace.startSession('测试 trace', routeResult);
    trace.recordLLMCall('mock-simple', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 200, 0);

    const spans = trace.getSpans();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0].type).toBe('llm_call');

    await trace.endSession();
    expect(trace.getSessionId()).toBeNull();
  });
});

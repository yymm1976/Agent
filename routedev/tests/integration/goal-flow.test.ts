// tests/integration/goal-flow.test.ts
// 集成测试：/goal 流程（Phase 23 Task 6）
// 链路：parse → plan → execute → verify
// 使用 mock LLM provider，不调用真实 API

import { describe, it, expect } from 'vitest';
import { GoalParser } from '../../src/agent/goal-parser.js';
import { GoalVerifier } from '../../src/agent/goal-verifier.js';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ILLMClient, LLMResponse, LLMStreamEvent, LLMRequestOptions, RoutingResult } from '../../src/router/types.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type { GoalPlan } from '../../src/agent/goal-types.js';

// ============================================================
// Mock 工具
// ============================================================

/** Mock LLM 客户端：支持预设不同响应 */
class MockLLMClient implements ILLMClient {
  readonly protocol = 'openai' as const;
  readonly providerId = 'mock';
  private responses: string[];
  private index = 0;

  constructor(responses: string[] = ['默认回复']) {
    this.responses = responses;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const content = this.responses[this.index % this.responses.length] ?? '默认回复';
    this.index++;
    return {
      content,
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
      model: options.model,
    };
  }

  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const response = await this.complete(options);
    yield { type: 'text_delta', text: response.content };
    yield { type: 'usage', usage: response.usage };
    yield { type: 'done', finishReason: response.finishReason };
  }

  isReady(): boolean { return true; }
}

/** Mock 工具执行器 */
class MockToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions() { return []; }
  async executeTool(_name: string, _id: string, _args: Record<string, unknown>): Promise<string> {
    return '执行完成';
  }
  hasTool(_name: string): boolean { return false; }
}

// ============================================================
// 测试辅助
// ============================================================

function makeMockRouteDecision(): RoutingResult {
  return {
    model: {
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'mock',
      tier: 'complex',
      contextWindow: 128000,
      capabilities: [],
      latencyMs: 0,
      available: true,
    },
    providerId: 'mock',
    fallbackUsed: false,
    originalTier: 'complex',
    degraded: false,
  };
}

// ============================================================
// 测试
// ============================================================

describe('集成测试：/goal 流程', () => {
  it('parse → plan：GoalParser 正确分解目标为步骤', async () => {
    const planJson = JSON.stringify({
      steps: [
        { id: 1, description: '分析项目结构' },
        { id: 2, description: '读取 package.json' },
        { id: 3, description: '运行测试' },
      ],
    });
    const mockClient = new MockLLMClient([planJson]);
    const parser = new GoalParser();
    const routeDecision = makeMockRouteDecision();

    const plan = await parser.parse('检查项目是否可以正常构建', {
      routeDecision,
      llmClient: mockClient,
    });

    expect(plan).toBeDefined();
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0].description).toBeTruthy();
    expect(plan.status).toBe('pending');
  });

  it('plan → execute：执行计划步骤并产生结果', async () => {
    const mockClient = new MockLLMClient([
      '步骤1执行完成：项目结构已分析',
      '步骤2执行完成：package.json 已读取',
      '步骤3执行完成：测试已运行',
    ]);
    const toolExecutor = new MockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 3, toolsEnabled: false });
    const routeDecision = makeMockRouteDecision();

    // 模拟计划步骤
    const steps = [
      { id: 1, description: '分析项目结构', status: 'pending' as const, dependencies: [] },
      { id: 2, description: '读取 package.json', status: 'pending' as const, dependencies: [1] },
      { id: 3, description: '运行测试', status: 'pending' as const, dependencies: [2] },
    ];

    const results: string[] = [];
    for (const step of steps) {
      let stepResult = '';
      for await (const event of loop.run({
        userMessage: step.description,
        llmClient: mockClient,
        routeDecision,
        conversationHistory: [],
      })) {
        if (event.type === 'done') {
          stepResult = event.content;
        }
      }
      results.push(stepResult);
    }

    // 验证：每个步骤都产生了结果
    expect(results).toHaveLength(3);
    expect(results.every(r => r.length > 0)).toBe(true);
  });

  it('execute → verify：GoalVerifier 验证执行结果', async () => {
    const verifyJson = JSON.stringify({
      passed: true,
      confidence: 0.85,
      reasoning: '所有步骤均成功完成，项目可以正常构建',
      missingItems: [],
      suggestions: [],
    });
    const mockClient = new MockLLMClient([verifyJson]);
    const verifier = new GoalVerifier();
    const routeDecision = makeMockRouteDecision();

    const plan: GoalPlan = {
      id: 'test-plan',
      description: '检查项目是否可以正常构建',
      steps: [
        { id: 1, description: '分析项目结构', status: 'completed' as const, dependencies: [], result: '完成' },
        { id: 2, description: '读取 package.json', status: 'completed' as const, dependencies: [1], result: '完成' },
        { id: 3, description: '运行测试', status: 'completed' as const, dependencies: [2], result: '完成' },
      ],
      status: 'verifying',
      createdAt: Date.now(),
    };

    const result = await verifier.verify(plan, {
      llmClient: mockClient,
      routeDecision,
    });

    expect(result).toBeDefined();
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('完整 /goal 流程：parse → execute → verify', async () => {
    const planJson = JSON.stringify({
      steps: [
        { id: 1, description: '检查文件' },
        { id: 2, description: '执行验证' },
      ],
    });
    const verifyJson = JSON.stringify({
      passed: true,
      confidence: 0.9,
      reasoning: '目标已完成',
      missingItems: [],
      suggestions: [],
    });

    // 按调用顺序：1. parse, 2. execute step 1, 3. execute step 2, 4. verify
    const mockClient = new MockLLMClient([planJson, '步骤1完成', '步骤2完成', verifyJson]);
    const routeDecision = makeMockRouteDecision();
    const toolExecutor = new MockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 3, toolsEnabled: false });

    // 1. Parse
    const parser = new GoalParser();
    const plan = await parser.parse('完成简单任务', { routeDecision, llmClient: mockClient });
    expect(plan.steps.length).toBeGreaterThan(0);

    // 2. Execute
    for (const step of plan.steps) {
      for await (const event of loop.run({
        userMessage: step.description,
        llmClient: mockClient,
        routeDecision,
        conversationHistory: [],
      })) {
        if (event.type === 'done') {
          step.status = 'completed';
          step.result = event.content.slice(0, 200);
        }
      }
    }
    expect(plan.steps.every(s => s.status === 'completed')).toBe(true);

    // 3. Verify
    const verifier = new GoalVerifier();
    plan.status = 'verifying';
    const verification = await verifier.verify(plan, { routeDecision, llmClient: mockClient });
    expect(verification.passed).toBe(true);
  });
});

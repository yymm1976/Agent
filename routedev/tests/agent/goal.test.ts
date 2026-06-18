// tests/agent/goal.test.ts
// GoalParser 与 GoalVerifier 单元测试

import { describe, it, expect, vi } from 'vitest';
import { GoalParser } from '../../src/agent/goal-parser.js';
import { GoalVerifier } from '../../src/agent/goal-verifier.js';
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, RoutingResult, TokenUsageInfo, ModelInfo } from '../../src/router/types.js';
import type { GoalPlan } from '../../src/agent/goal-types.js';

function createMockClient(response: string): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => {
      const usage: TokenUsageInfo = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
      return { content: response, toolCalls: [], usage };
    }),
    stream: vi.fn(async function* () { /* not used in tests */ }),
  };
}

const mockModel: ModelInfo = {
  id: 'gpt-4o',
  providerId: 'openai',
  tier: 'medium',
  costPer1kInput: 0.005,
  costPer1kOutput: 0.015,
  maxContextTokens: 128000,
  maxOutputTokens: 4096,
};

const mockRoute: RoutingResult = {
  model: mockModel,
  providerId: 'openai',
  degraded: false,
  reason: 'test',
};

describe('GoalParser', () => {
  it('should parse JSON response into GoalPlan', async () => {
    const response = JSON.stringify({
      steps: [
        { id: 1, description: '读取 package.json' },
        { id: 2, description: '运行 pnpm test' },
        { id: 3, description: '提交更改' },
      ],
    });
    const client = createMockClient(response);
    const parser = new GoalParser();

    const plan = await parser.parse('完成单元测试', { routeDecision: mockRoute, llmClient: client });

    expect(plan.steps.length).toBe(3);
    expect(plan.steps[0].description).toBe('读取 package.json');
    expect(plan.steps[2].status).toBe('pending');
  });

  it('should handle JSON in markdown code block', async () => {
    const response = '```json\n' + JSON.stringify({
      steps: [{ id: 1, description: '执行步骤' }],
    }) + '\n```';
    const client = createMockClient(response);
    const parser = new GoalParser();

    const plan = await parser.parse('目标', { routeDecision: mockRoute, llmClient: client });
    expect(plan.steps.length).toBe(1);
  });

  it('should fall back to single-step plan on parse failure', async () => {
    const client = createMockClient('not valid json at all');
    const parser = new GoalParser();

    const plan = await parser.parse('目标', { routeDecision: mockRoute, llmClient: client });
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].description).toBe('目标');
  });

  it('should pass verification criteria to LLM', async () => {
    const client = createMockClient(JSON.stringify({ steps: [{ id: 1, description: 'x' }] }));
    const parser = new GoalParser();

    await parser.parse('目标', {
      routeDecision: mockRoute,
      llmClient: client,
      verificationCriteria: '必须通过测试',
    });

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMRequestOptions;
    expect(call.messages[0].content).toContain('验证条件');
    expect(call.messages[0].content).toContain('必须通过测试');
  });
});

describe('GoalVerifier', () => {
  const samplePlan: GoalPlan = {
    description: '完成单元测试',
    verificationCriteria: '所有测试通过',
    steps: [
      { id: 1, description: '读取 package.json', status: 'completed', result: 'ok' },
      { id: 2, description: '运行测试', status: 'completed', result: 'all passed' },
    ],
    status: 'verifying',
    createdAt: Date.now(),
  };

  it('should parse passed=true response', async () => {
    const client = createMockClient(JSON.stringify({
      passed: true,
      confidence: 0.95,
      reasoning: '所有测试通过',
      missingItems: [],
      suggestions: [],
    }));
    const verifier = new GoalVerifier();

    const result = await verifier.verify(samplePlan, { routeDecision: mockRoute, llmClient: client });
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeCloseTo(0.95);
    expect(result.missingItems).toEqual([]);
  });

  it('should parse passed=false response with missing items', async () => {
    const client = createMockClient(JSON.stringify({
      passed: false,
      confidence: 0.8,
      reasoning: '测试未全部通过',
      missingItems: ['3 个测试失败'],
      suggestions: ['修复测试用例'],
    }));
    const verifier = new GoalVerifier();

    const result = await verifier.verify(samplePlan, { routeDecision: mockRoute, llmClient: client });
    expect(result.passed).toBe(false);
    expect(result.missingItems).toEqual(['3 个测试失败']);
    expect(result.suggestions).toEqual(['修复测试用例']);
  });

  it('should return default failed result on parse error', async () => {
    const client = createMockClient('not valid json');
    const verifier = new GoalVerifier();

    const result = await verifier.verify(samplePlan, { routeDecision: mockRoute, llmClient: client });
    expect(result.passed).toBe(false);
    expect(result.confidence).toBe(0);
  });
});

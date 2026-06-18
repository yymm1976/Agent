// tests/agent/adversarial.test.ts
// 对抗性验证单元测试（Phase 21 Task 4）
// 验证：正确解析 challenges；threshold 过滤低严重度；
//       无效 JSON 返回空数组；enabled=false 跳过；challenges 不影响 passed

import { describe, it, expect, vi } from 'vitest';
import { GoalVerifier, type AdversarialOptions } from '../../src/agent/goal-verifier.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, TokenUsageInfo } from '../../src/router/types.js';
import type { GoalPlan, Challenge } from '../../src/agent/goal-types.js';

function createMockClient(response: string): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => {
      const usage: TokenUsageInfo = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
      return { content: response, toolCalls: [], usage };
    }),
    stream: vi.fn(async function* () { /* */ }),
  };
}

const samplePlan: GoalPlan = {
  id: 'plan-1',
  description: '完成单元测试',
  verificationCriteria: '所有测试通过',
  steps: [
    { id: 1, description: '读取 package.json', status: 'completed', result: 'ok', dependencies: [] },
    { id: 2, description: '运行测试', status: 'completed', result: 'all passed', dependencies: [1] },
  ],
  status: 'verifying',
  createdAt: Date.now(),
};

// 模拟 RoutingResult（使用 any 绕过严格类型检查，与现有 goal.test.ts 一致）
const mockRoute = {
  model: { id: 'gpt-4o', providerId: 'openai', tier: 'medium' },
  providerId: 'openai',
  fallbackUsed: false,
  originalTier: 'medium',
  degraded: false,
} as any;

describe('对抗性验证（adversarialCheck）', () => {
  describe('adversarialCheck 方法', () => {
    it('正确解析 challenges JSON 数组', async () => {
      const verifier = new GoalVerifier();
      const challenges = [
        { severity: 0.8, description: '测试覆盖率不足', suggestion: '增加边界测试' },
        { severity: 0.6, description: '错误处理缺失' },
      ];
      const adversarialClient = createMockClient(JSON.stringify(challenges));

      const result = await verifier.adversarialCheck(
        '完成单元测试',
        '验证通过，置信度 95%',
        adversarialClient,
        0.5, // threshold
      );

      expect(result.length).toBe(2);
      expect(result[0].severity).toBe(0.8);
      expect(result[0].description).toBe('测试覆盖率不足');
      expect(result[0].suggestion).toBe('增加边界测试');
      expect(result[1].severity).toBe(0.6);
    });

    it('threshold 过滤低严重度的 challenges', async () => {
      const verifier = new GoalVerifier();
      const challenges = [
        { severity: 0.9, description: '严重问题' },
        { severity: 0.6, description: '中等问题' },
        { severity: 0.3, description: '轻微问题' },
        { severity: 0.1, description: '可忽略' },
      ];
      const adversarialClient = createMockClient(JSON.stringify(challenges));

      // threshold=0.5 → 只保留 severity >= 0.5
      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.5,
      );

      expect(result.length).toBe(2); // 0.9 和 0.6
      expect(result.map(c => c.severity)).toEqual([0.9, 0.6]);
    });

    it('threshold=0.8 时只保留高严重度', async () => {
      const verifier = new GoalVerifier();
      const challenges = [
        { severity: 0.95, description: '严重' },
        { severity: 0.7, description: '中等' },
      ];
      const adversarialClient = createMockClient(JSON.stringify(challenges));

      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.8,
      );

      expect(result.length).toBe(1);
      expect(result[0].severity).toBe(0.95);
    });

    it('无效 JSON 返回空数组', async () => {
      const verifier = new GoalVerifier();
      const adversarialClient = createMockClient('这不是 JSON');

      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.5,
      );

      expect(result).toEqual([]);
    });

    it('JSON 但非数组返回空数组', async () => {
      const verifier = new GoalVerifier();
      const adversarialClient = createMockClient('{"not": "an array"}');

      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.5,
      );

      expect(result).toEqual([]);
    });

    it('空数组返回空数组', async () => {
      const verifier = new GoalVerifier();
      const adversarialClient = createMockClient('[]');

      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.5,
      );

      expect(result).toEqual([]);
    });

    it('过滤掉 severity 超出 [0,1] 范围的项', async () => {
      const verifier = new GoalVerifier();
      const challenges = [
        { severity: 0.8, description: '有效' },
        { severity: 1.5, description: '超出上限' },
        { severity: -0.3, description: '低于下限' },
      ];
      const adversarialClient = createMockClient(JSON.stringify(challenges));

      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.0, // threshold=0，但 severity 仍需在 [0,1] 范围内
      );

      expect(result.length).toBe(1);
      expect(result[0].severity).toBe(0.8);
    });

    it('过滤掉缺少 description 的项', async () => {
      const verifier = new GoalVerifier();
      const challenges = [
        { severity: 0.8, description: '有效' },
        { severity: 0.7 }, // 缺少 description
        { severity: 0.6, description: '' }, // 空描述
      ];
      const adversarialClient = createMockClient(JSON.stringify(challenges));

      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.5,
      );

      expect(result.length).toBe(1);
      expect(result[0].description).toBe('有效');
    });

    it('支持 markdown 代码块包裹的 JSON', async () => {
      const verifier = new GoalVerifier();
      const challenges = [{ severity: 0.7, description: '问题' }];
      const adversarialClient = createMockClient(
        '```json\n' + JSON.stringify(challenges) + '\n```',
      );

      const result = await verifier.adversarialCheck(
        '目标',
        '结果',
        adversarialClient,
        0.5,
      );

      expect(result.length).toBe(1);
      expect(result[0].description).toBe('问题');
    });
  });

  describe('verify 集成（adversarial 选项）', () => {
    it('enabled=false 时跳过对抗性验证', async () => {
      const verifier = new GoalVerifier();
      const mainResponse = JSON.stringify({
        passed: true,
        confidence: 0.95,
        reasoning: '所有测试通过',
        missingItems: [],
        suggestions: [],
      });
      const mainClient = createMockClient(mainResponse);
      const adversarialClient = createMockClient(
        JSON.stringify([{ severity: 0.9, description: '不应被调用' }]),
      );

      const adversarial: AdversarialOptions = {
        enabled: false,
        adversarialClient,
      };

      const result = await verifier.verify(samplePlan, {
        routeDecision: mockRoute,
        llmClient: mainClient,
        adversarial,
      });

      expect(result.passed).toBe(true);
      expect(result.challenges).toBeUndefined(); // 未启用 → 无 challenges
      // adversarialClient 不应被调用
      expect((adversarialClient.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('enabled=true 但无 adversarialClient 时跳过', async () => {
      const verifier = new GoalVerifier();
      const mainResponse = JSON.stringify({
        passed: true,
        confidence: 0.9,
        reasoning: '通过',
        missingItems: [],
        suggestions: [],
      });
      const mainClient = createMockClient(mainResponse);

      const adversarial: AdversarialOptions = {
        enabled: true,
        // 不提供 adversarialClient
      };

      const result = await verifier.verify(samplePlan, {
        routeDecision: mockRoute,
        llmClient: mainClient,
        adversarial,
      });

      expect(result.passed).toBe(true);
      expect(result.challenges).toBeUndefined();
    });

    it('enabled=true 时执行对抗性验证，challenges 不影响 passed', async () => {
      const verifier = new GoalVerifier();
      const mainResponse = JSON.stringify({
        passed: true,
        confidence: 0.95,
        reasoning: '所有测试通过',
        missingItems: [],
        suggestions: [],
      });
      const mainClient = createMockClient(mainResponse);
      const adversarialClient = createMockClient(
        JSON.stringify([
          { severity: 0.8, description: '覆盖率不足', suggestion: '增加测试' },
        ]),
      );

      const adversarial: AdversarialOptions = {
        enabled: true,
        threshold: 0.5,
        adversarialClient,
      };

      const result = await verifier.verify(samplePlan, {
        routeDecision: mockRoute,
        llmClient: mainClient,
        adversarial,
      });

      // passed 不受 challenges 影响
      expect(result.passed).toBe(true);
      expect(result.confidence).toBeCloseTo(0.95);
      // challenges 作为附加信息存在
      expect(result.challenges).toBeDefined();
      expect(result.challenges!.length).toBe(1);
      expect(result.challenges![0].severity).toBe(0.8);
      expect(result.challenges![0].description).toBe('覆盖率不足');
    });

    it('对抗性验证失败不阻塞主验证', async () => {
      const verifier = new GoalVerifier();
      const mainResponse = JSON.stringify({
        passed: true,
        confidence: 0.9,
        reasoning: '通过',
        missingItems: [],
        suggestions: [],
      });
      const mainClient = createMockClient(mainResponse);
      // adversarialClient 抛异常
      const adversarialClient: ILLMClient = {
        isReady: () => true,
        complete: vi.fn(async () => { throw new Error('network error'); }),
        stream: vi.fn(async function* () { /* */ }),
      };

      const adversarial: AdversarialOptions = {
        enabled: true,
        adversarialClient,
      };

      const result = await verifier.verify(samplePlan, {
        routeDecision: mockRoute,
        llmClient: mainClient,
        adversarial,
      });

      // 主验证结果正常返回
      expect(result.passed).toBe(true);
      // 对抗性验证失败 → 无 challenges（不阻塞）
      expect(result.challenges).toBeUndefined();
    });

    it('对抗性验证返回空数组时 challenges 为 undefined', async () => {
      const verifier = new GoalVerifier();
      const mainResponse = JSON.stringify({
        passed: true,
        confidence: 0.9,
        reasoning: '通过',
        missingItems: [],
        suggestions: [],
      });
      const mainClient = createMockClient(mainResponse);
      const adversarialClient = createMockClient('[]'); // 空数组

      const adversarial: AdversarialOptions = {
        enabled: true,
        threshold: 0.5,
        adversarialClient,
      };

      const result = await verifier.verify(samplePlan, {
        routeDecision: mockRoute,
        llmClient: mainClient,
        adversarial,
      });

      expect(result.passed).toBe(true);
      // 空数组 → challenges 不设置（避免无意义的空字段）
      expect(result.challenges).toBeUndefined();
    });
  });

  describe('AdversarialConfig schema', () => {
    it('默认值正确', async () => {
      const { AdversarialConfigSchema } = await import('../../src/config/schema.js');
      const parsed = AdversarialConfigSchema.parse({});
      expect(parsed.enabled).toBe(false);
      expect(parsed.threshold).toBe(0.5);
      expect(parsed.modelTier).toBe('fast');
    });

    it('可自定义', async () => {
      const { AdversarialConfigSchema } = await import('../../src/config/schema.js');
      const parsed = AdversarialConfigSchema.parse({
        enabled: true,
        threshold: 0.8,
        modelTier: 'main',
      });
      expect(parsed.enabled).toBe(true);
      expect(parsed.threshold).toBe(0.8);
      expect(parsed.modelTier).toBe('main');
    });

    it('threshold 超出范围被拒绝', async () => {
      const { AdversarialConfigSchema } = await import('../../src/config/schema.js');
      expect(() => AdversarialConfigSchema.parse({ threshold: 1.5 })).toThrow();
      expect(() => AdversarialConfigSchema.parse({ threshold: -0.1 })).toThrow();
    });
  });
});

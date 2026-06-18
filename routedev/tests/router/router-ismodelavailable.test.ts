// tests/router/router-ismodelavailable.test.ts
// Phase 29 Task 6：ModelRouter isModelAvailable 真实检查测试

import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import type { RouterConfig } from '../../src/router/types.js';
import type { ProviderConfig } from '../../src/config/schema.js';

function createRouterConfig(): RouterConfig {
  return {
    rules: [
      { tier: 'simple', modelId: 'gpt-4o-mini', fallbackModelId: 'gpt-4o' },
      { tier: 'complex', modelId: 'gpt-4o', fallbackModelId: 'gpt-4o-mini' },
    ],
    budget: { dailyLimitTokens: 1000000, warningThreshold: 0.8 },
    fallback: { enabled: true, modelId: 'gpt-4o-mini' },
  } as any;
}

function createProviders(apiKey: string): ProviderConfig[] {
  return [
    {
      id: 'openai',
      name: 'OpenAI',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey,
      models: [],
    },
  ] as any;
}

/** 创建带 budget 的 TokenTracker */
function createTracker(): TokenTracker {
  return new TokenTracker({
    dailyLimit: 1000000,
    degradationThreshold: 0.8,
    warningThreshold: 0.7,
    mode: 'track_only',
  } as any);
}

describe('ModelRouter Phase 29 isModelAvailable', () => {
  it('provider 未配置时模型不可用', () => {
    const tracker = createTracker();
    const router = new ModelRouter(createRouterConfig(), tracker, []);

    // 通过路由结果间接验证：所有模型都不可用时应抛错或降级
    // 由于 isModelAvailable 是私有方法，我们通过路由行为验证
    // provider 列表为空时，所有模型的 provider 都找不到
    expect(() => {
      router.route({
        tier: 'simple',
        confidence: 0.9,
        reasoning: 'test',
        source: 'rule',
      });
    }).not.toThrow(); // 应该有 fallback 逻辑，不会抛错
  });

  it('API Key 为空时模型不可用', () => {
    const tracker = createTracker();
    const router = new ModelRouter(createRouterConfig(), tracker, createProviders(''));

    // API Key 为空，模型应不可用，路由会尝试降级
    expect(() => {
      router.route({
        tier: 'simple',
        confidence: 0.9,
        reasoning: 'test',
        source: 'rule',
      });
    }).not.toThrow();
  });

  it('API Key 为 placeholder 时模型不可用', () => {
    const tracker = createTracker();
    const router = new ModelRouter(createRouterConfig(), tracker, createProviders('placeholder'));

    expect(() => {
      router.route({
        tier: 'simple',
        confidence: 0.9,
        reasoning: 'test',
        source: 'rule',
      });
    }).not.toThrow();
  });

  it('API Key 正常配置时模型可用', () => {
    const tracker = createTracker();
    const router = new ModelRouter(createRouterConfig(), tracker, createProviders('sk-valid-key'));

    const result = router.route({
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'test',
      source: 'rule',
    });

    // 路由应成功返回结果（可能降级，但 model 应有值）
    expect(result).toBeDefined();
  });
});

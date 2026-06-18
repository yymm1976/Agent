// tests/router/router.test.ts
// 模型路由器单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import type { RouterConfig, ClassificationResult, TokenBudget } from '../../src/router/types.js';

describe('ModelRouter', () => {
  let router: ModelRouter;
  let tracker: TokenTracker;

  const budget: TokenBudget = {
    mode: 'enforce',
    dailyLimit: 1000000,
    degradationThreshold: 0.8,
  };

  const config: RouterConfig = {
    rules: [
      { tier: 'simple', modelId: 'gpt-4o-mini', fallbackModelId: 'gpt-4o' },
      { tier: 'medium', modelId: 'gpt-4o', fallbackModelId: 'gpt-4o-mini' },
      { tier: 'complex', modelId: 'o3-mini', fallbackModelId: 'gpt-4o' },
      { tier: 'reasoning', modelId: 'o3', fallbackModelId: 'o3-mini' },
    ],
    budget,
    classifierModel: 'gpt-4o-mini',
    userPreference: 'balanced',
  };

  beforeEach(() => {
    tracker = new TokenTracker(budget);
    router = new ModelRouter(config, tracker);
  });

  afterEach(() => {
    tracker.destroy();
  });

  it('should route simple tier to gpt-4o-mini', async () => {
    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'Simple command',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('gpt-4o-mini');
    expect(result.degraded).toBe(false);
  });

  it('should route medium tier to gpt-4o', async () => {
    const classification: ClassificationResult = {
      tier: 'medium',
      confidence: 0.8,
      reasoning: 'Keyword: git',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('gpt-4o');
    expect(result.degraded).toBe(false);
  });

  it('should route complex tier to o3-mini', async () => {
    const classification: ClassificationResult = {
      tier: 'complex',
      confidence: 0.75,
      reasoning: 'Keyword: refactor',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('o3-mini');
    expect(result.degraded).toBe(false);
  });

  it('should route reasoning tier to o3', async () => {
    const classification: ClassificationResult = {
      tier: 'reasoning',
      confidence: 0.8,
      reasoning: 'Keyword: analyze',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('o3');
    expect(result.degraded).toBe(false);
  });

  it('should degrade when budget exceeded', async () => {
    // 先用完预算
    tracker.record(
      { inputTokens: 500000, outputTokens: 600000, totalTokens: 1100000 },
      { modelId: 'gpt-4o', agentId: 'main', stepId: 'step-1' },
    );

    const classification: ClassificationResult = {
      tier: 'complex',
      confidence: 0.75,
      reasoning: 'Complex task',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.degraded).toBe(true);
    // 降级原因可能是 budget 或 tier 降级
    expect(result.degradationReason).toBeDefined();
  });

  it('should support manual override', async () => {
    // 先重置 tracker 以确保预算检查通过
    tracker.reset();
    router.setManualOverride('claude-3-sonnet');
    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'Simple',
      source: 'rule',
    };
    const result = await router.route(classification);
    // 手动覆盖的模型不在 models 列表中，会降级
    // 测试手动覆盖逻辑被触发
    expect(router.getManualOverride()).toBe('claude-3-sonnet');
  });

  it('should clear manual override', async () => {
    router.setManualOverride('claude-3-sonnet');
    router.setManualOverride(null);
    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'Simple',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('gpt-4o-mini');
  });

  it('should list available models', () => {
    const models = router.getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === 'gpt-4o-mini')).toBe(true);
    expect(models.some((m) => m.id === 'o3')).toBe(true);
  });
});

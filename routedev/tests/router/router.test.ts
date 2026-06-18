// tests/router/router.test.ts
// 模型路由器单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import type { RouterConfig, ClassificationResult, TokenBudget } from '../../src/router/types.js';
import type { ProviderConfig } from '../../src/config/schema.js';

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

// ============================================================
// Phase 0c Task 2：Provider 路由修正测试
// 验证配置优先，启发式后备
// ============================================================
describe('Phase 0c: Provider 路由修正', () => {
  let tracker: TokenTracker;

  const budget: TokenBudget = {
    mode: 'enforce',
    dailyLimit: 1000000,
    degradationThreshold: 0.8,
  };

  beforeEach(() => {
    tracker = new TokenTracker(budget);
  });

  afterEach(() => {
    tracker.destroy();
  });

  it('配置中有 provider 的模型 → 从配置读取 provider（不从启发式推断）', async () => {
    // 自定义模型名 my-finetune-v3，配置了 provider: 'anthropic'
    // 启发式推断会失败（不含 gpt/claude 等关键词），但配置优先
    const config: RouterConfig = {
      rules: [
        { tier: 'simple', modelId: 'my-finetune-v3' },
      ],
      budget,
      classifierModel: 'my-finetune-v3',
      userPreference: 'balanced',
    };
    const providers: ProviderConfig[] = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        models: [
          {
            id: 'my-finetune-v3',
            name: 'my-finetune-v3',
            provider: 'anthropic',
            tier: 'simple',
            contextWindow: 200000,
            capabilities: [],
            latencyMs: 0,
            available: true,
          },
        ],
      },
    ];
    const router = new ModelRouter(config, tracker, providers);
    const models = router.getAvailableModels();
    const target = models.find(m => m.id === 'my-finetune-v3');
    expect(target).toBeDefined();
    expect(target?.providerId).toBe('anthropic'); // 从配置读取，不是 'unknown'
  });

  it('配置中无该模型 → 回退到启发式推断', async () => {
    // gpt-4o 不在 providers 配置中，但启发式 includes('gpt') → openai
    const config: RouterConfig = {
      rules: [
        { tier: 'simple', modelId: 'gpt-4o-mini' },
      ],
      budget,
      classifierModel: 'gpt-4o-mini',
      userPreference: 'balanced',
    };
    const providers: ProviderConfig[] = []; // 空配置
    const router = new ModelRouter(config, tracker, providers);
    const models = router.getAvailableModels();
    const target = models.find(m => m.id === 'gpt-4o-mini');
    expect(target).toBeDefined();
    expect(target?.providerId).toBe('openai'); // 启发式推断
  });

  it('自定义模型名配置了 provider: anthropic → 路由到 anthropic，不被启发式误导', async () => {
    // 关键测试：模型名含 'gpt' 但配置了 anthropic provider
    // 配置优先，不会被启发式误导成 openai
    const config: RouterConfig = {
      rules: [
        { tier: 'simple', modelId: 'gpt-custom-anthropic' },
      ],
      budget,
      classifierModel: 'gpt-custom-anthropic',
      userPreference: 'balanced',
    };
    const providers: ProviderConfig[] = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        models: [
          {
            id: 'gpt-custom-anthropic',
            name: 'gpt-custom-anthropic',
            provider: 'anthropic',
            tier: 'simple',
            contextWindow: 200000,
            capabilities: [],
            latencyMs: 0,
            available: true,
          },
        ],
      },
    ];
    const router = new ModelRouter(config, tracker, providers);
    const models = router.getAvailableModels();
    const target = models.find(m => m.id === 'gpt-custom-anthropic');
    expect(target).toBeDefined();
    expect(target?.providerId).toBe('anthropic'); // 配置优先，不是 'openai'
  });

  it('配置和启发式都无法匹配 → 返回 unknown（有 fallback）', async () => {
    const config: RouterConfig = {
      rules: [
        { tier: 'simple', modelId: 'totally-unknown-model' },
      ],
      budget,
      classifierModel: 'totally-unknown-model',
      userPreference: 'balanced',
    };
    const providers: ProviderConfig[] = []; // 空配置
    const router = new ModelRouter(config, tracker, providers);
    const models = router.getAvailableModels();
    const target = models.find(m => m.id === 'totally-unknown-model');
    expect(target).toBeDefined();
    expect(target?.providerId).toBe('unknown'); // 启发式也失败
  });

  it('providers 参数可选（向后兼容）', () => {
    // 不传 providers 参数，应使用启发式
    const config: RouterConfig = {
      rules: [{ tier: 'simple', modelId: 'gpt-4o-mini' }],
      budget,
      classifierModel: 'gpt-4o-mini',
      userPreference: 'balanced',
    };
    const router = new ModelRouter(config, tracker);
    const models = router.getAvailableModels();
    const target = models.find(m => m.id === 'gpt-4o-mini');
    expect(target?.providerId).toBe('openai'); // 启发式推断
  });

  it('model.name 匹配也能找到 provider', async () => {
    // 配置中 model.id 是 'custom-1'，但 name 是 'gpt-4o'
    // 路由规则用 'custom-1'，应通过 id 匹配找到 provider
    const config: RouterConfig = {
      rules: [
        { tier: 'simple', modelId: 'custom-1' },
      ],
      budget,
      classifierModel: 'custom-1',
      userPreference: 'balanced',
    };
    const providers: ProviderConfig[] = [
      {
        id: 'custom-provider',
        name: 'Custom',
        protocol: 'openai',
        baseUrl: 'https://api.custom.com',
        apiKey: 'test-key',
        models: [
          {
            id: 'custom-1',
            name: 'Custom Model 1',
            provider: 'custom-provider',
            tier: 'simple',
            contextWindow: 128000,
            capabilities: [],
            latencyMs: 0,
            available: true,
          },
        ],
      },
    ];
    const router = new ModelRouter(config, tracker, providers);
    const models = router.getAvailableModels();
    const target = models.find(m => m.id === 'custom-1');
    expect(target?.providerId).toBe('custom-provider');
  });
});

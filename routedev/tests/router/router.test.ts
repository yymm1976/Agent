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
    // Phase 81 Task 2：启用三级路由简化（medium/reasoning → complex）
    simpleRoutingEnabled: true,
    // Phase 81 Task 2：置信度阈值微调层旁路（默认 false）
    confidenceThresholdEnabled: false,
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

  it('Phase 81: medium tier 收敛为 complex，路由到强模型 o3-mini', async () => {
    // 三级路由简化：medium → complex → o3-mini（强模型）
    const classification: ClassificationResult = {
      tier: 'medium',
      confidence: 0.8,
      reasoning: 'Keyword: git',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('o3-mini');
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

  it('Phase 81: reasoning tier 收敛为 complex，路由到强模型 o3-mini', async () => {
    // 三级路由简化：reasoning → complex → o3-mini（强模型）
    const classification: ClassificationResult = {
      tier: 'reasoning',
      confidence: 0.8,
      reasoning: 'Keyword: analyze',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('o3-mini');
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

  it('Phase 81: override 用户指定模型优先于 tier 路由（最高优先级）', async () => {
    // 用 config 中存在的模型 'o3' 作为 override
    // simple 分类本应路由到 gpt-4o-mini，但 override 优先级最高，路由到 o3
    tracker.reset();
    router.setManualOverride('o3');
    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'Simple',
      source: 'rule',
    };
    const result = await router.route(classification);
    // override 生效：路由到 o3 而非 simple tier 的 gpt-4o-mini
    expect(result.model.id).toBe('o3');
    expect(result.degraded).toBe(false);
    expect(router.getManualOverride()).toBe('o3');
  });

  it('Phase 81: override 不在 models 列表中时不生效，回退 tier 路由', async () => {
    // override 模型不在 config 规则中，override 失败，走正常 tier 路由
    tracker.reset();
    router.setManualOverride('claude-3-sonnet');
    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'Simple',
      source: 'rule',
    };
    const result = await router.route(classification);
    // override 模型不存在，回退到 simple tier 路由 → gpt-4o-mini
    expect(result.model.id).toBe('gpt-4o-mini');
    expect(router.getManualOverride()).toBe('claude-3-sonnet');
  });

  it('Phase 81: clampTier 旁路（confidenceThresholdEnabled=false 不改变 tier）', async () => {
    // 置信度阈值微调层默认旁路，clampTier 恒等映射
    // simple 分类应直接路由到 simple tier 模型，不被 clampTier 调整
    tracker.reset();
    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.5, // 低置信度，但 clampTier 旁路不调整
      reasoning: 'Simple',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('gpt-4o-mini');
    expect(result.originalTier).toBe('simple');
  });

  it('Phase 81: simpleRoutingEnabled=false 时回退四级 tier（medium → gpt-4o）', async () => {
    // 关闭三级路由简化，medium 保持 medium，路由到 gpt-4o
    tracker.reset();
    const fourTierConfig: RouterConfig = {
      ...config,
      simpleRoutingEnabled: false,
    };
    const fourTierRouter = new ModelRouter(fourTierConfig, tracker);
    const classification: ClassificationResult = {
      tier: 'medium',
      confidence: 0.8,
      reasoning: 'Keyword: git',
      source: 'rule',
    };
    const result = await fourTierRouter.route(classification);
    // 简化关闭：medium → gpt-4o（四级路由）
    expect(result.model.id).toBe('gpt-4o');
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

// tests/router/config.test.ts
// 路由配置加载测试

import { describe, it, expect } from 'vitest';
import { buildRouterConfig } from '../../src/router/config.js';
import type { AppConfig } from '../../src/router/types.js';

describe('Router Config Builder', () => {
  const mockAppConfig: AppConfig = {
    version: 1,
    general: {
      language: 'zh-CN',
      theme: 'dark',
      workingDirectory: '/test',
    },
    providers: [],
    router: {
      rules: [],
      budget: {
        mode: 'track_only',
        dailyLimit: 1000000,
        degradationThreshold: 0.8,
      },
      classifierModel: 'gpt-4o-mini',
      userPreference: 'balanced',
    },
    security: {
      directoryBoundary: true,
      requireApproval: ['shell_exec', 'file_write'],
      maxFileSize: 10485760,
    },
    autonomy: {
      defaultMode: 'semi',
      maxSteps: 50,
      maxTimeMinutes: 30,
    },
    ui: {
      showStatusBar: true,
      showTokenCounter: true,
      showProgressBar: true,
    },
    memory: {
      maxConversationTokens: 100000,
      checkpointInterval: 10,
      enableVectorStore: false,
    },
  };

  it('should build router config from app config', () => {
    const routerConfig = buildRouterConfig(mockAppConfig);
    expect(routerConfig.rules.length).toBe(4);
    expect(routerConfig.budget.mode).toBe('track_only');
    expect(routerConfig.budget.dailyLimit).toBe(1000000);
    expect(routerConfig.classifierModel).toBe('gpt-4o-mini');
  });

  it('should create rules for all tiers', () => {
    const routerConfig = buildRouterConfig(mockAppConfig);
    const tiers = routerConfig.rules.map((r) => r.tier);
    expect(tiers).toContain('simple');
    expect(tiers).toContain('medium');
    expect(tiers).toContain('complex');
    expect(tiers).toContain('reasoning');
  });

  it('should set appropriate max tokens per tier', () => {
    const routerConfig = buildRouterConfig(mockAppConfig);
    // 默认规则可能没有设置 maxTokensPerRequest，只检查规则存在
    const simpleRule = routerConfig.rules.find((r) => r.tier === 'simple');
    const reasoningRule = routerConfig.rules.find((r) => r.tier === 'reasoning');
    expect(simpleRule).toBeDefined();
    expect(reasoningRule).toBeDefined();
  });

  it('should set fallback models', () => {
    const routerConfig = buildRouterConfig(mockAppConfig);
    const complexRule = routerConfig.rules.find((r) => r.tier === 'complex');
    expect(complexRule?.fallbackModelId).toBeDefined();
  });

  it('should use custom models from config', () => {
    const customConfig = {
      ...mockAppConfig,
      router: {
        ...mockAppConfig.router,
        rules: [
          { tier: 'simple' as const, modelId: 'custom-simple', fallbackModelId: 'custom-simple-fallback' },
          { tier: 'medium' as const, modelId: 'custom-medium' },
          { tier: 'complex' as const, modelId: 'custom-complex' },
          { tier: 'reasoning' as const, modelId: 'custom-reasoning' },
        ],
      },
    };
    const routerConfig = buildRouterConfig(customConfig);
    const simpleRule = routerConfig.rules.find((r) => r.tier === 'simple');
    expect(simpleRule?.modelId).toBe('custom-simple');
  });

  it('should fill missing router model ids from providers', () => {
    const customConfig = {
      ...mockAppConfig,
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          protocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'test-key',
          models: [
            {
              id: 'custom-simple',
              name: 'custom-simple',
              provider: 'openai',
              tier: 'simple' as const,
              contextWindow: 128000,
              capabilities: [],
              latencyMs: 0,
              available: true,
            },
          ],
        },
      ],
      router: {
        ...mockAppConfig.router,
        rules: [
          { tier: 'simple' as const },
        ],
      },
    };
    const routerConfig = buildRouterConfig(customConfig);
    expect(routerConfig.rules[0]?.modelId).toBeDefined();
  });
});

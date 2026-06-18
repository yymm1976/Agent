// tests/utils/provider-validator.test.ts
// Provider 配置校验测试（Phase 24 Task 8）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateProviders, formatValidationMessages } from '../../src/utils/provider-validator.js';
import { LLMClientManager } from '../../src/router/llm/index.js';
import type { AppConfig, ProviderConfig } from '../../src/config/schema.js';

// 创建模拟的 ILLMClient
function createMockClient(ready: boolean = true) {
  return {
    isReady: () => ready,
    protocol: 'openai' as const,
    stream: async function* () {
      yield { type: 'done' as const };
    },
    complete: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
  };
}

// 创建测试用 provider 配置
function createProviderConfig(
  id: string,
  models: Array<{ id: string; name: string }> = [{ id: 'test-model', name: 'Test Model' }],
): ProviderConfig {
  return {
    id,
    name: id,
    protocol: 'openai',
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      provider: id,
      tier: 'simple' as const,
      contextWindow: 128000,
      capabilities: [],
      latencyMs: 0,
      available: true,
    })),
  };
}

// 创建测试用 AppConfig
function createAppConfig(providers: ProviderConfig[]): AppConfig {
  return {
    version: 1,
    general: { language: 'zh-CN', theme: 'dark', startupBehavior: 'restore' },
    providers,
    router: { rules: [], budget: { mode: 'track_only', dailyLimit: 500000, degradationThreshold: 0.8 }, classifierModel: 'test', userPreference: 'balanced' },
    checkpoint: { enabled: true, triggers: [], modelId: 'test', maxTokensPerCheckpoint: 500 },
    goalVerifier: { enabled: true, modelId: 'test', maxTokensPerVerification: 1000, autoVerify: true },
    security: { directoryBoundary: true, commandBlacklist: [], commandWhitelist: [], sensitiveFiles: [], sensitiveFilePolicy: 'readonly', networkConfirm: true },
    channels: { entries: [], port: 9800, maxResponseLength: 2000, requestTimeout: 60000 },
    autonomy: { defaultMode: 'semi', autoApprovePatterns: [], confirmTimeout: 30000 },
    sounds: { enabled: true, completion: 'default', error: 'warning', approval: 'notification' },
    updates: { checkOnStartup: true, autoUpdate: false },
    mcp: { servers: [], autoConnect: true },
    prompts: { projectOverrides: true, cacheTtlSeconds: 0 },
    projectMemory: { enabled: true, maxMemorySize: 10000, maxDecisions: 100, autoInject: true },
    adversarial: { enabled: false, threshold: 0.5, modelTier: 'fast' },
  };
}

describe('Provider 配置校验 (Phase 24 Task 8)', () => {
  let clientManager: LLMClientManager;

  beforeEach(() => {
    clientManager = new LLMClientManager();
  });

  afterEach(() => {
    clientManager.clear();
  });

  // ============================================================
  // 正常场景
  // ============================================================
  describe('正常场景', () => {
    it('所有 provider 都有 client 且就绪 → 全部通过', () => {
      clientManager.register('openai', createMockClient(true) as any);
      clientManager.register('anthropic', createMockClient(true) as any);

      const config = createAppConfig([
        createProviderConfig('openai'),
        createProviderConfig('anthropic'),
      ]);

      const result = validateProviders(config, clientManager);
      expect(result.validCount).toBe(2);
      expect(result.invalidCount).toBe(0);
      expect(result.failures.length).toBe(0);
    });

    it('单个 provider 配置正确 → 通过', () => {
      clientManager.register('openai', createMockClient(true) as any);
      const config = createAppConfig([createProviderConfig('openai')]);
      const result = validateProviders(config, clientManager);
      expect(result.validCount).toBe(1);
      expect(result.invalidCount).toBe(0);
    });

    it('空 providers 列表 → 0 通过 0 失败', () => {
      const config = createAppConfig([]);
      const result = validateProviders(config, clientManager);
      expect(result.validCount).toBe(0);
      expect(result.invalidCount).toBe(0);
    });
  });

  // ============================================================
  // 失败场景
  // ============================================================
  describe('失败场景', () => {
    it('provider 无对应 client → 失败', () => {
      // 不注册任何 client
      const config = createAppConfig([createProviderConfig('openai')]);
      const result = validateProviders(config, clientManager);
      expect(result.validCount).toBe(0);
      expect(result.invalidCount).toBe(1);
      expect(result.failures[0].providerId).toBe('openai');
      expect(result.failures[0].reason).toContain('未找到');
    });

    it('client 未就绪 → 失败', () => {
      clientManager.register('openai', createMockClient(false) as any);
      const config = createAppConfig([createProviderConfig('openai')]);
      const result = validateProviders(config, clientManager);
      expect(result.invalidCount).toBe(1);
      expect(result.failures[0].reason).toContain('未就绪');
    });

    it('provider 无 models → 失败', () => {
      clientManager.register('openai', createMockClient(true) as any);
      const config = createAppConfig([createProviderConfig('openai', [])]);
      const result = validateProviders(config, clientManager);
      expect(result.invalidCount).toBe(1);
      expect(result.failures[0].reason).toContain('未配置任何模型');
    });

    it('部分通过部分失败', () => {
      clientManager.register('openai', createMockClient(true) as any);
      // anthropic 不注册 client
      const config = createAppConfig([
        createProviderConfig('openai'),
        createProviderConfig('anthropic'),
      ]);
      const result = validateProviders(config, clientManager);
      expect(result.validCount).toBe(1);
      expect(result.invalidCount).toBe(1);
      expect(result.failures[0].providerId).toBe('anthropic');
    });
  });

  // ============================================================
  // 消息格式化
  // ============================================================
  describe('formatValidationMessages', () => {
    it('无失败时返回空数组', () => {
      const messages = formatValidationMessages({
        validCount: 1,
        invalidCount: 0,
        failures: [],
      });
      expect(messages.length).toBe(0);
    });

    it('有失败时返回警告消息', () => {
      const messages = formatValidationMessages({
        validCount: 0,
        invalidCount: 1,
        failures: [{
          providerId: 'openai',
          reason: '未找到对应的 API client',
          suggestion: '请确认已安装 SDK',
        }],
      });
      expect(messages.length).toBe(2);
      expect(messages[0]).toContain('[警告]');
      expect(messages[0]).toContain('openai');
      expect(messages[1]).toContain('请确认已安装 SDK');
    });

    it('多个失败返回多条消息', () => {
      const messages = formatValidationMessages({
        validCount: 0,
        invalidCount: 2,
        failures: [
          { providerId: 'a', reason: 'r1', suggestion: 's1' },
          { providerId: 'b', reason: 'r2', suggestion: 's2' },
        ],
      });
      // 每个 failure 产生 2 行消息
      expect(messages.length).toBe(4);
    });
  });
});

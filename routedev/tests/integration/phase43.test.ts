// tests/integration/phase43.test.ts
// Phase 43 集成测试：查漏补缺
// 验证代码地图回退 / 策略冲突仲裁 / 远程市场 Registry / 新增配置段
//
// 测试策略：
//   1. Schema 配置验证（subAgents/goal/hookEnhancement）——直接测试 schema.ts
//   2. Defaults 默认值验证——直接测试 defaults.ts
//   3. CodeMapFallback / PolicyArbitrator / RegistryClient——直接 import（本 Phase 新建模块）

import { describe, it, expect } from 'vitest';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { CodeMapFallback } from '../../src/code-map/fallback.js';
import { PolicyArbitrator } from '../../src/policies/arbitration.js';
import {
  StubRegistryClient,
  HttpRegistryClient,
  createRegistryClient,
} from '../../src/skills/registry-client.js';

// ============================================================
// 1. Schema 配置验证
// ============================================================
describe('Phase 43 Integration - Schema 配置', () => {
  it('subAgents.enabled 默认 true', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.subAgents).toBeDefined();
    expect(config.subAgents.enabled).toBe(true);
  });

  it('goal.clarify 默认 true', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.goal).toBeDefined();
    expect(config.goal.clarify).toBe(true);
  });

  it('hookEnhancement.functionHooks 默认 false', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.hookEnhancement).toBeDefined();
    expect(config.hookEnhancement.functionHooks).toBe(false);
  });
});

// ============================================================
// 2. Defaults 默认值验证
// ============================================================
describe('Phase 43 Integration - Defaults 默认值', () => {
  it('subAgents.maxParallel = 3', () => {
    expect(DEFAULT_CONFIG.subAgents).toBeDefined();
    expect(DEFAULT_CONFIG.subAgents.maxParallel).toBe(3);
  });

  it('goal.tokenBudget = 50000', () => {
    expect(DEFAULT_CONFIG.goal).toBeDefined();
    expect(DEFAULT_CONFIG.goal.tokenBudget).toBe(50000);
  });

  it('hookEnhancement.trialDays = 7', () => {
    expect(DEFAULT_CONFIG.hookEnhancement).toBeDefined();
    expect(DEFAULT_CONFIG.hookEnhancement.trialDays).toBe(7);
  });
});

// ============================================================
// 3. CodeMapFallback 测试
// ============================================================
describe('Phase 43 Integration - CodeMapFallback', () => {
  it('resolveEngine: tree-sitter 不可用时回退 regex', async () => {
    // preferred=disabled 直接返回 disabled
    const disabled = await CodeMapFallback.resolveEngine('disabled');
    expect(disabled).toBe('disabled');

    // preferred=regex 直接返回 regex（不检测 tree-sitter）
    const regex = await CodeMapFallback.resolveEngine('regex');
    expect(regex).toBe('regex');

    // preferred=tree-sitter：检测可用性，不可用时回退到 regex
    // 测试环境 tree-sitter 可能可用也可能不可用，结果只能是 tree-sitter 或 regex
    const resolved = await CodeMapFallback.resolveEngine('tree-sitter');
    expect(['tree-sitter', 'regex']).toContain(resolved);
  });

  it('getFallbackMessage: 包含警告信息', () => {
    const msg = CodeMapFallback.getFallbackMessage('WASM not found');
    expect(msg).toContain('tree-sitter');
    expect(msg).toContain('WASM not found');
    expect(msg).toContain('正则引擎');
  });

  it('checkTreeSitterAvailability: 返回 available 字段', async () => {
    const result = await CodeMapFallback.checkTreeSitterAvailability();
    expect(result).toHaveProperty('available');
    expect(typeof result.available).toBe('boolean');
    // 不可用时 reason 字段存在
    if (!result.available) {
      expect(result.reason).toBeDefined();
    }
  });
});

// ============================================================
// 4. PolicyArbitrator 测试
// ============================================================
describe('Phase 43 Integration - PolicyArbitrator', () => {
  it('security 优先于 skill', () => {
    const arbitrator = new PolicyArbitrator();
    const result = arbitrator.arbitrate([
      { type: 'skill', id: 'skill-1', action: 'injectPrompt' },
      { type: 'security', id: 'policy-1', action: 'block' },
      { type: 'hook', id: 'hook-1', action: 'log' },
    ]);
    expect(result.winner).toBe('security');
    expect(result.reason).toContain('security');
    expect(result.conflictingPolicies).toHaveLength(3);
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('resolveBlockVsInject: 返回 security 胜出', () => {
    const result = PolicyArbitrator.resolveBlockVsInject(
      { id: 'block-policy-1' },
      { id: 'inject-skill-1' },
    );
    expect(result.winner).toBe('security');
    expect(result.reason).toContain('block');
    expect(result.reason).toContain('injectPrompt');
    expect(result.conflictingPolicies).toHaveLength(2);
    expect(result.conflictingPolicies[0].type).toBe('security');
    expect(result.conflictingPolicies[0].action).toBe('block');
    expect(result.conflictingPolicies[1].type).toBe('skill');
    expect(result.conflictingPolicies[1].action).toBe('injectPrompt');
  });

  it('arbitrate: 日志记录与清空', () => {
    const arbitrator = new PolicyArbitrator();
    expect(arbitrator.getLog()).toHaveLength(0);
    arbitrator.arbitrate([
      { type: 'security', id: 'p1', action: 'block' },
      { type: 'hook', id: 'h1', action: 'log' },
    ]);
    expect(arbitrator.getLog()).toHaveLength(1);
    arbitrator.clearLog();
    expect(arbitrator.getLog()).toHaveLength(0);
  });

  it('PRIORITY_ORDER: security > skill > hook', () => {
    expect(PolicyArbitrator.PRIORITY_ORDER[0]).toBe('security');
    expect(PolicyArbitrator.PRIORITY_ORDER[1]).toBe('skill');
    expect(PolicyArbitrator.PRIORITY_ORDER[2]).toBe('hook');
  });
});

// ============================================================
// 5. RegistryClient 测试
// ============================================================
describe('Phase 43 Integration - RegistryClient', () => {
  it('StubRegistryClient: listSkills 返回空数组', async () => {
    const client = new StubRegistryClient();
    const skills = await client.listSkills();
    expect(skills).toEqual([]);
    const hooks = await client.listHooks();
    expect(hooks).toEqual([]);
    const profiles = await client.listAgentProfiles();
    expect(profiles).toEqual([]);
    const results = await client.search('test');
    expect(results).toEqual([]);
  });

  it('StubRegistryClient: downloadPackage 抛错', async () => {
    const client = new StubRegistryClient();
    await expect(client.downloadPackage('foo', '1.0.0')).rejects.toThrow('Registry not configured');
  });

  it('createRegistryClient: 无 URL 时返回 StubRegistryClient', () => {
    const client = createRegistryClient();
    expect(client).toBeInstanceOf(StubRegistryClient);
  });

  it('createRegistryClient: 有 URL 时返回 HttpRegistryClient', () => {
    const client = createRegistryClient('https://registry.example.com', 'token-xxx');
    expect(client).toBeInstanceOf(HttpRegistryClient);
  });

  it('HttpRegistryClient: 无网络环境调用方法应抛错', async () => {
    const client = new HttpRegistryClient('https://registry.example.com');
    // 方法已实现（走 HTTP fetch），在无网络环境下应抛 fetch 错误而非 'Not implemented'
    await expect(client.listSkills()).rejects.toThrow();
    await expect(client.listHooks()).rejects.toThrow();
    await expect(client.listAgentProfiles()).rejects.toThrow();
    await expect(client.downloadPackage('test', '1.0.0')).rejects.toThrow();
    await expect(client.search('test')).rejects.toThrow();
  });
});

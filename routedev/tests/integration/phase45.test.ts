// tests/integration/phase45.test.ts
// Phase 45 集成测试：人格 / 语音 / 记忆 / 发现
// 验证 Schema 配置 / Defaults 默认值
//
// 测试策略：
//   1. Schema 配置验证（persona/voice/memory/discovery）——直接测试 schema.ts
//   2. Defaults 默认值验证——直接测试 defaults.ts
// 注：VoiceManager / PersonaEngine / PreferenceManager 模块已删除（死代码清理）

import { describe, it, expect } from 'vitest';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// ============================================================
// 1. Schema 配置验证 - persona
// ============================================================
describe('Phase 45 Integration - Schema persona 配置', () => {
  it('persona.enabled 默认 true', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.persona).toBeDefined();
    expect(config.persona.enabled).toBe(true);
  });

  it('persona.intensity 默认 medium', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.persona).toBeDefined();
    expect(config.persona.intensity).toBe('medium');
  });

  it('persona.currentId 默认 collaborator', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.persona).toBeDefined();
    expect(config.persona.currentId).toBe('collaborator');
  });
});

// ============================================================
// 2. Schema 配置验证 - voice
// ============================================================
describe('Phase 45 Integration - Schema voice 配置', () => {
  it('voice.inputProvider 默认 off', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.voice).toBeDefined();
    expect(config.voice.inputProvider).toBe('off');
  });

  it('voice.outputProvider 默认 off', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.voice).toBeDefined();
    expect(config.voice.outputProvider).toBe('off');
  });

  it('voice.language 默认 zh-CN', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.voice).toBeDefined();
    expect(config.voice.language).toBe('zh-CN');
  });

  it('voice.autoPlay 默认 false', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.voice).toBeDefined();
    expect(config.voice.autoPlay).toBe(false);
  });
});

// ============================================================
// 3. Schema 配置验证 - memory
// ============================================================
describe('Phase 45 Integration - Schema memory 配置', () => {
  it('memory.inference 默认 true', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.memory).toBeDefined();
    expect(config.memory.inference).toBe(true);
  });

  it('memory.autoLearn 默认 true', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.memory).toBeDefined();
    expect(config.memory.autoLearn).toBe(true);
  });

  it('memory.injectThreshold 默认 0.7', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.memory).toBeDefined();
    expect(config.memory.injectThreshold).toBe(0.7);
  });
});

// ============================================================
// 4. Schema 配置验证 - discovery
// ============================================================
describe('Phase 45 Integration - Schema discovery 配置', () => {
  it('discovery.enabled 默认 true', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.discovery).toBeDefined();
    expect(config.discovery.enabled).toBe(true);
  });

  it('discovery.showOnStartup 默认 false', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.discovery).toBeDefined();
    expect(config.discovery.showOnStartup).toBe(false);
  });
});

// ============================================================
// 5. Defaults 默认值验证
// ============================================================
describe('Phase 45 Integration - Defaults 默认值', () => {
  it('persona.currentId = collaborator', () => {
    expect(DEFAULT_CONFIG.persona).toBeDefined();
    expect(DEFAULT_CONFIG.persona.currentId).toBe('collaborator');
  });

  it('voice.language = zh-CN', () => {
    expect(DEFAULT_CONFIG.voice).toBeDefined();
    expect(DEFAULT_CONFIG.voice.language).toBe('zh-CN');
  });

  it('memory.injectThreshold = 0.7', () => {
    expect(DEFAULT_CONFIG.memory).toBeDefined();
    expect(DEFAULT_CONFIG.memory.injectThreshold).toBe(0.7);
  });

  it('discovery.enabled = true', () => {
    expect(DEFAULT_CONFIG.discovery).toBeDefined();
    expect(DEFAULT_CONFIG.discovery.enabled).toBe(true);
  });
});

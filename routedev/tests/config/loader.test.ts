// tests/config/loader.test.ts
// 配置加载器单元测试
// 覆盖：默认值、YAML 解析、环境变量替换、配置合并、错误处理

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, validateConfigFile } from '../../src/config/loader.js';

describe('Config Loader', () => {
  const testDir = join(tmpdir(), `routedev-test-${Date.now()}`);
  const configPath = join(testDir, 'config.yaml');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load default config when no file exists', () => {
    const config = loadConfig({ globalConfigPath: configPath });
    expect(config.version).toBe(1);
    expect(config.general.language).toBe('zh-CN');
    expect(config.router.rules).toHaveLength(4);
    expect(config.autonomy.defaultMode).toBe('semi');
  });

  it('should load and parse YAML config file', () => {
    writeFileSync(configPath, `
version: 1
general:
  language: en-US
  theme: light
router:
  userPreference: premium
`);

    const config = loadConfig({ globalConfigPath: configPath });
    expect(config.general.language).toBe('en-US');
    expect(config.general.theme).toBe('light');
    expect(config.router.userPreference).toBe('premium');
  });

  it('should replace environment variables', () => {
    process.env.TEST_API_KEY = 'sk-test-12345';
    writeFileSync(configPath, `
version: 1
providers:
  - id: test
    name: Test Provider
    protocol: openai
    baseUrl: https://api.test.com/v1
    apiKey: \${TEST_API_KEY}
`);

    const config = loadConfig({ globalConfigPath: configPath });
    expect(config.providers[0].apiKey).toBe('sk-test-12345');
    delete process.env.TEST_API_KEY;
  });

  it('should merge project config over global config', () => {
    writeFileSync(configPath, `
version: 1
router:
  userPreference: saving
`);

    const projectDir = join(testDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, '.routedev.yaml'), `
version: 1
router:
  userPreference: premium
`);

    const config = loadConfig({
      globalConfigPath: configPath,
      projectPath: projectDir,
    });
    expect(config.router.userPreference).toBe('premium');
  });

  it('should throw on invalid config', () => {
    writeFileSync(configPath, `
version: "not-a-number"
`);

    expect(() => loadConfig({ globalConfigPath: configPath })).toThrow('Configuration validation failed');
  });

  it('should validate config file and return errors', () => {
    writeFileSync(configPath, `
version: 1
providers:
  - id: test
    name: Test
    protocol: invalid-protocol
    baseUrl: not-a-url
    apiKey: key
`);

    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

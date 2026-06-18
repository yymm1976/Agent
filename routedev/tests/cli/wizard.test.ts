// tests/cli/wizard.test.ts
// SetupWizard 测试（Phase 23 Task 3）
// 验证步骤定义、验证逻辑、配置生成

import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEPS,
  PROVIDER_OPTIONS,
  PROVIDER_ENV_VARS,
  parseModelAssignments,
  generateConfigYaml,
  shouldRunWizard,
} from '../../src/cli/wizard.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SetupWizard: 步骤定义', () => {
  it('定义了 5 个步骤', () => {
    expect(WIZARD_STEPS).toHaveLength(5);
  });

  it('步骤顺序正确：语言 → Provider → 模型 → 预算 → 自主', () => {
    const ids = WIZARD_STEPS.map(s => s.id);
    expect(ids).toEqual(['lang', 'providers', 'models', 'budget', 'autonomy']);
  });

  it('每个步骤都有必填字段', () => {
    for (const step of WIZARD_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.prompt).toBeTruthy();
      expect(step.type).toBeTruthy();
      expect(step.default).toBeDefined();
    }
  });

  it('lang 步骤是 select 类型，有 zh-CN 和 en-US 选项', () => {
    const lang = WIZARD_STEPS[0];
    expect(lang.type).toBe('select');
    expect(lang.options).toBeDefined();
    const values = lang.options!.map(o => o.value);
    expect(values).toContain('zh-CN');
    expect(values).toContain('en-US');
  });

  it('providers 步骤是 multiselect 类型，包含 5 个 Provider', () => {
    const providers = WIZARD_STEPS[1];
    expect(providers.type).toBe('multiselect');
    expect(providers.options).toBeDefined();
    expect(providers.options!.length).toBe(5);
    const values = providers.options!.map(o => o.value);
    expect(values).toEqual(['openai', 'anthropic', 'deepseek', 'qwen', 'ollama']);
  });

  it('models 步骤是 input 类型，留空时使用默认', () => {
    const models = WIZARD_STEPS[2];
    expect(models.type).toBe('input');
    expect(models.default).toBe('');
  });

  it('budget 步骤是 select 类型，有 saving/balanced/premium', () => {
    const budget = WIZARD_STEPS[3];
    expect(budget.type).toBe('select');
    const values = budget.options!.map(o => o.value);
    expect(values).toEqual(['saving', 'balanced', 'premium']);
  });

  it('autonomy 步骤是 select 类型，有 auto/semi/manual', () => {
    const autonomy = WIZARD_STEPS[4];
    expect(autonomy.type).toBe('select');
    const values = autonomy.options!.map(o => o.value);
    expect(values).toEqual(['auto', 'semi', 'manual']);
  });
});

describe('SetupWizard: 验证逻辑', () => {
  it('providers 验证：空值返回错误', () => {
    const providers = WIZARD_STEPS[1];
    expect(providers.validate!('')).toBe('至少选择一个 Provider');
  });

  it('providers 验证：有效值通过', () => {
    const providers = WIZARD_STEPS[1];
    expect(providers.validate!('openai,deepseek')).toBeNull();
  });

  it('providers 验证：无效值返回错误', () => {
    const providers = WIZARD_STEPS[1];
    expect(providers.validate!('invalid_provider')).toBe('包含无效的 Provider 名称');
  });

  it('models 验证：空值通过（使用默认）', () => {
    const models = WIZARD_STEPS[2];
    expect(models.validate!('')).toBeNull();
  });

  it('models 验证：有效格式通过', () => {
    const models = WIZARD_STEPS[2];
    expect(models.validate!('simple=gpt-4o-mini,complex=gpt-4o')).toBeNull();
  });

  it('models 验证：无效等级返回错误', () => {
    const models = WIZARD_STEPS[2];
    const result = models.validate!('invalid=gpt-4o');
    expect(result).toContain('无效的任务等级');
  });

  it('models 验证：格式错误返回错误', () => {
    const models = WIZARD_STEPS[2];
    const result = models.validate!('simple');
    expect(result).toContain('格式错误');
  });
});

describe('SetupWizard: parseModelAssignments', () => {
  it('空字符串返回空对象', () => {
    expect(parseModelAssignments('')).toEqual({});
  });

  it('单个赋值正确解析', () => {
    expect(parseModelAssignments('simple=gpt-4o-mini')).toEqual({
      simple: 'gpt-4o-mini',
    });
  });

  it('多个赋值正确解析', () => {
    const result = parseModelAssignments('simple=gpt-4o-mini,complex=gpt-4o,reasoning=o1');
    expect(result).toEqual({
      simple: 'gpt-4o-mini',
      complex: 'gpt-4o',
      reasoning: 'o1',
    });
  });

  it('带空格的输入正确 trim', () => {
    const result = parseModelAssignments('  simple = gpt-4o-mini , complex = gpt-4o  ');
    expect(result).toEqual({
      simple: 'gpt-4o-mini',
      complex: 'gpt-4o',
    });
  });
});

describe('SetupWizard: generateConfigYaml', () => {
  it('生成的 YAML 包含注释', () => {
    const yaml = generateConfigYaml({
      lang: 'zh-CN',
      providers: 'openai',
      models: '',
      budget: 'balanced',
      autonomy: 'semi',
    });
    expect(yaml).toContain('#');
    expect(yaml).toContain('# RouteDev 配置文件');
    expect(yaml).toContain('# API Key');
  });

  it('包含 version: 1', () => {
    const yaml = generateConfigYaml({});
    expect(yaml).toContain('version: 1');
  });

  it('包含语言设置', () => {
    const yaml = generateConfigYaml({ lang: 'en-US' });
    expect(yaml).toContain('language: en-US');
  });

  it('包含 Provider 配置和 API Key 环境变量引用', () => {
    const yaml = generateConfigYaml({ providers: 'openai' });
    expect(yaml).toContain('id: openai');
    expect(yaml).toContain('${OPENAI_API_KEY}');
  });

  it('Ollama Provider 不包含 API Key 环境变量', () => {
    const yaml = generateConfigYaml({ providers: 'ollama' });
    expect(yaml).toContain('id: ollama');
    expect(yaml).not.toContain('${');
    expect(yaml).toContain('dummy');
  });

  it('包含路由规则', () => {
    const yaml = generateConfigYaml({ models: 'simple=gpt-4o-mini,complex=gpt-4o' });
    expect(yaml).toContain('rules:');
    expect(yaml).toContain('tier: simple');
    expect(yaml).toContain('modelId: gpt-4o-mini');
    expect(yaml).toContain('tier: complex');
    expect(yaml).toContain('modelId: gpt-4o');
  });

  it('未指定模型时使用默认推荐', () => {
    const yaml = generateConfigYaml({ models: '' });
    expect(yaml).toContain('modelId: deepseek-v4-flash');
    expect(yaml).toContain('modelId: kimi-k2.7');
  });

  it('包含预算偏好', () => {
    const yaml = generateConfigYaml({ budget: 'saving' });
    expect(yaml).toContain('userPreference: saving');
  });

  it('包含自主模式', () => {
    const yaml = generateConfigYaml({ autonomy: 'auto' });
    expect(yaml).toContain('defaultMode: auto');
  });

  it('包含安全配置', () => {
    const yaml = generateConfigYaml({});
    expect(yaml).toContain('security:');
    expect(yaml).toContain('directoryBoundary: true');
  });

  it('多 Provider 时生成多个 provider 条目', () => {
    const yaml = generateConfigYaml({ providers: 'openai,deepseek' });
    expect(yaml).toContain('id: openai');
    expect(yaml).toContain('id: deepseek');
    expect(yaml).toContain('${OPENAI_API_KEY}');
    expect(yaml).toContain('${DEEPSEEK_API_KEY}');
  });
});

describe('SetupWizard: shouldRunWizard', () => {
  it('配置文件不存在时返回 true', () => {
    const nonExistent = join(tmpdir(), `routedev-test-${Date.now()}.yaml`);
    expect(existsSync(nonExistent)).toBe(false);
    expect(shouldRunWizard(nonExistent)).toBe(true);
  });

  it('配置文件存在时返回 false', () => {
    // 使用已存在的 config.example.yaml
    const existingPath = join(process.cwd(), 'config.example.yaml');
    expect(existsSync(existingPath)).toBe(true);
    expect(shouldRunWizard(existingPath)).toBe(false);
  });
});

describe('SetupWizard: PROVIDER_ENV_VARS', () => {
  it('每个 Provider 都有环境变量映射', () => {
    for (const opt of PROVIDER_OPTIONS) {
      expect(PROVIDER_ENV_VARS).toHaveProperty(opt.value);
    }
  });

  it('Ollama 的环境变量为 null（本地模型）', () => {
    expect(PROVIDER_ENV_VARS.ollama).toBeNull();
  });
});

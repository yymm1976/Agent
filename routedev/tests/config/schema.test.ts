// tests/config/schema.test.ts
// Phase 26 Task 9：Config Schema 验证测试

import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';

describe('AppConfigSchema', () => {
  it('应接受空对象（所有字段有默认值或 preprocess）', () => {
    const result = AppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('应接受完整的 providers 数组', () => {
    const config = {
      providers: [
        {
          id: 'openai-main',
          name: 'OpenAI',
          protocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          models: [],
        },
      ],
    };
    const result = AppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('应拒绝无效的 protocol', () => {
    const config = {
      providers: [
        {
          id: 'bad',
          name: 'Bad',
          protocol: 'invalid_protocol',
          baseUrl: 'https://api.example.com',
          apiKey: 'key',
          models: [],
        },
      ],
    };
    const result = AppConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

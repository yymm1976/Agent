// tests/agent/prompts.test.ts
// Phase 26 Task 9：agent/prompts.ts 测试覆盖

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYSTEM_PROMPT_ZH,
  DEFAULT_SYSTEM_PROMPT_EN,
  SYSTEM_PROMPT_TEMPLATE_ID,
  getSystemPrompt,
} from '../../src/agent/prompts.js';

describe('agent/prompts', () => {
  it('SYSTEM_PROMPT_TEMPLATE_ID 应为 main.system', () => {
    expect(SYSTEM_PROMPT_TEMPLATE_ID).toBe('main.system');
  });

  it('getSystemPrompt 默认返回中文提示', () => {
    const prompt = getSystemPrompt();
    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT_ZH);
    expect(prompt).toContain('RouteDev');
  });

  it('getSystemPrompt 传入 zh-CN 返回中文提示', () => {
    const prompt = getSystemPrompt('zh-CN');
    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT_ZH);
  });

  it('getSystemPrompt 传入 en 返回英文提示', () => {
    const prompt = getSystemPrompt('en');
    expect(prompt).toBe(DEFAULT_SYSTEM_PROMPT_EN);
  });

  it('中文提示应包含 Anti-Yes-Engineer 指令', () => {
    expect(DEFAULT_SYSTEM_PROMPT_ZH).toContain('Anti-Yes-Engineer');
  });
});

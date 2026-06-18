// tests/router/llm-phase29.test.ts
// Phase 29 Task 6：LLM 客户端 API Key fail-fast 测试
// 覆盖：OpenAIClient 和 AnthropicClient 的 isReady 行为

import { describe, it, expect } from 'vitest';
import { OpenAIClient } from '../../src/router/llm/openai.js';
import { AnthropicClient } from '../../src/router/llm/anthropic.js';
import { LLMError } from '../../src/router/types.js';

describe('OpenAIClient Phase 29 API Key fail-fast', () => {
  it('apiKey 为空时 isReady 返回 false', () => {
    const client = new OpenAIClient({
      providerId: 'test-openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
    });
    expect(client.isReady()).toBe(false);
  });

  it('apiKey 已配置时 isReady 返回 true', () => {
    const client = new OpenAIClient({
      providerId: 'test-openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
    });
    expect(client.isReady()).toBe(true);
  });

  it('apiKey 为空时 complete 抛出 LLMError', async () => {
    const client = new OpenAIClient({
      providerId: 'test-openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
    });
    await expect(client.complete({
      model: 'gpt-4',
      messages: [],
    })).rejects.toThrow(LLMError);
  });

  it('apiKey 为空时 stream 抛出 LLMError', async () => {
    const client = new OpenAIClient({
      providerId: 'test-openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
    });
    const gen = client.stream({
      model: 'gpt-4',
      messages: [],
    });
    await expect(gen.next()).rejects.toThrow(LLMError);
  });
});

describe('AnthropicClient Phase 29 API Key fail-fast', () => {
  it('apiKey 为空时 isReady 返回 false', () => {
    const client = new AnthropicClient({
      providerId: 'test-anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
    });
    expect(client.isReady()).toBe(false);
  });

  it('apiKey 已配置时 isReady 返回 true', () => {
    const client = new AnthropicClient({
      providerId: 'test-anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
    });
    expect(client.isReady()).toBe(true);
  });

  it('apiKey 为空时 complete 抛出 LLMError', async () => {
    const client = new AnthropicClient({
      providerId: 'test-anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
    });
    await expect(client.complete({
      model: 'claude-3',
      messages: [],
    })).rejects.toThrow(LLMError);
  });
});

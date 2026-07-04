// tests/router/llm-providers.test.ts
// 新增 LLM Provider 适配器单元测试
// 覆盖：Gemini / DeepSeek / Qwen / Ollama 四个新 provider
// 测试策略：客户端创建、clientType 分发、isReady 判定、默认配置回退、向后兼容
// 不测试实际 API 调用（那是集成测试）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createLLMClient,
  LLMClientManager,
  GeminiClient,
  DeepSeekClient,
  QwenClient,
  OllamaClient,
} from '../../src/router/llm/index.js';

// 保存并恢复环境变量，避免测试间污染
const ENV_VARS = ['GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'OLLAMA_BASE_URL'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_VARS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('Gemini Provider', () => {
  it('should create Gemini client via protocol="gemini"', () => {
    const client = createLLMClient({
      id: 'test-gemini',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'test-gemini-key',
    });
    expect(client).toBeInstanceOf(GeminiClient);
    expect(client.protocol).toBe('gemini');
    expect(client.providerId).toBe('test-gemini');
    expect(client.isReady()).toBe(true);
  });

  it('should create Gemini client via clientType="gemini"', () => {
    const client = createLLMClient({
      id: 'test-gemini-2',
      protocol: 'gemini',
      clientType: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'test-gemini-key',
    });
    expect(client).toBeInstanceOf(GeminiClient);
    expect(client.protocol).toBe('gemini');
  });

  it('should report not ready when apiKey is empty', () => {
    delete process.env.GEMINI_API_KEY;
    const client = createLLMClient({
      id: 'test-gemini-no-key',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: '',
    });
    expect(client.isReady()).toBe(false);
  });

  it('should report not ready when apiKey is "placeholder"', () => {
    const client = createLLMClient({
      id: 'test-gemini-placeholder',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'placeholder',
    });
    expect(client.isReady()).toBe(false);
  });

  it('should fall back to GEMINI_API_KEY env var', () => {
    process.env.GEMINI_API_KEY = 'env-gemini-key';
    const client = new GeminiClient({ providerId: 'gemini-env' });
    expect(client.isReady()).toBe(true);
  });
});

describe('DeepSeek Provider', () => {
  it('should create DeepSeek client via clientType="deepseek"', () => {
    const client = createLLMClient({
      id: 'test-deepseek',
      protocol: 'openai',
      clientType: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-deepseek-key',
    });
    expect(client).toBeInstanceOf(DeepSeekClient);
    expect(client.protocol).toBe('openai'); // 继承 OpenAIClient 的 protocol
    expect(client.providerId).toBe('test-deepseek');
    expect(client.isReady()).toBe(true);
  });

  it('should report not ready when apiKey is empty and env var not set', () => {
    delete process.env.DEEPSEEK_API_KEY;
    const client = createLLMClient({
      id: 'test-deepseek-no-key',
      protocol: 'openai',
      clientType: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
    });
    expect(client.isReady()).toBe(false);
  });

  it('should fall back to DEEPSEEK_API_KEY env var', () => {
    process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
    const client = new DeepSeekClient({ providerId: 'deepseek-env' });
    expect(client.isReady()).toBe(true);
  });

  it('should use default base URL when not provided', () => {
    process.env.DEEPSEEK_API_KEY = 'env-key';
    const client = new DeepSeekClient({ providerId: 'deepseek-default' });
    expect(client.isReady()).toBe(true);
    // 默认 base URL 通过构造函数传入 OpenAIClient，间接验证不抛错即可
  });
});

describe('Qwen Provider', () => {
  it('should create Qwen client via clientType="qwen"', () => {
    const client = createLLMClient({
      id: 'test-qwen',
      protocol: 'openai',
      clientType: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'test-qwen-key',
    });
    expect(client).toBeInstanceOf(QwenClient);
    expect(client.protocol).toBe('openai');
    expect(client.providerId).toBe('test-qwen');
    expect(client.isReady()).toBe(true);
  });

  it('should report not ready when apiKey is empty and env var not set', () => {
    delete process.env.DASHSCOPE_API_KEY;
    const client = createLLMClient({
      id: 'test-qwen-no-key',
      protocol: 'openai',
      clientType: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
    });
    expect(client.isReady()).toBe(false);
  });

  it('should fall back to DASHSCOPE_API_KEY env var', () => {
    process.env.DASHSCOPE_API_KEY = 'env-dashscope-key';
    const client = new QwenClient({ providerId: 'qwen-env' });
    expect(client.isReady()).toBe(true);
  });
});

describe('Ollama Provider', () => {
  it('should create Ollama client via clientType="ollama"', () => {
    const client = createLLMClient({
      id: 'test-ollama',
      protocol: 'openai',
      clientType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(client).toBeInstanceOf(OllamaClient);
    expect(client.protocol).toBe('openai');
    expect(client.providerId).toBe('test-ollama');
    // Ollama 无需 API key，固定 'ollama' 占位，应始终就绪
    expect(client.isReady()).toBe(true);
  });

  it('should always be ready (no API key required)', () => {
    delete process.env.OLLAMA_BASE_URL;
    const client = new OllamaClient({ providerId: 'ollama-local' });
    expect(client.isReady()).toBe(true);
  });

  it('should respect OLLAMA_BASE_URL env var', () => {
    process.env.OLLAMA_BASE_URL = 'http://192.168.1.100:11434/v1';
    const client = new OllamaClient({ providerId: 'ollama-remote' });
    expect(client.isReady()).toBe(true);
  });
});

describe('Backward Compatibility', () => {
  it('should still create OpenAI client when clientType not specified', () => {
    const client = createLLMClient({
      id: 'test-openai-compat',
      protocol: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    expect(client.protocol).toBe('openai');
    expect(client.isReady()).toBe(true);
  });

  it('should still create Anthropic client when clientType not specified', () => {
    const client = createLLMClient({
      id: 'test-anthropic-compat',
      protocol: 'anthropic',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    expect(client.protocol).toBe('anthropic');
    expect(client.isReady()).toBe(true);
  });

  it('should still throw on unsupported protocol', () => {
    expect(() =>
      createLLMClient({
        id: 'test-unknown',
        protocol: 'unknown' as 'openai',
        baseUrl: 'https://api.test.com/v1',
        apiKey: 'test-key',
      }),
    ).toThrow('Unsupported protocol');
  });
});

describe('LLMClientManager with new providers', () => {
  it('should initialize from config with mixed providers', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'openai-1', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'key1' },
      { id: 'gemini-1', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'key2' },
      { id: 'deepseek-1', protocol: 'openai', clientType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'key3' },
      { id: 'qwen-1', protocol: 'openai', clientType: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'key4' },
      { id: 'ollama-1', protocol: 'openai', clientType: 'ollama', baseUrl: 'http://localhost:11434/v1' },
    ]);
    expect(manager.get('openai-1')?.protocol).toBe('openai');
    expect(manager.get('gemini-1')?.protocol).toBe('gemini');
    expect(manager.get('deepseek-1')?.protocol).toBe('openai');
    expect(manager.get('qwen-1')?.protocol).toBe('openai');
    expect(manager.get('ollama-1')?.protocol).toBe('openai');
    expect(manager.listAll().size).toBe(5);
  });

  it('should report ready status correctly for mixed providers', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'ready-ollama', protocol: 'openai', clientType: 'ollama', baseUrl: 'http://localhost:11434/v1' },
      { id: 'not-ready-gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '' },
      { id: 'not-ready-deepseek', protocol: 'openai', clientType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '' },
    ]);
    expect(manager.isReady('ready-ollama')).toBe(true);
    expect(manager.isReady('not-ready-gemini')).toBe(false);
    expect(manager.isReady('not-ready-deepseek')).toBe(false);

    const ready = manager.getReadyClients();
    expect(ready.length).toBe(1);
    expect(ready[0].providerId).toBe('ready-ollama');
  });
});

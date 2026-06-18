// tests/router/llm.test.ts
// LLM 客户端单元测试
// 测试策略：测试客户端创建、配置验证、消息格式转换、错误标准化
// 不测试实际 API 调用（那是集成测试）

import { describe, it, expect } from 'vitest';
import { createLLMClient, LLMClientManager } from '../../src/router/llm/index.js';
import { LLMError } from '../../src/router/types.js';

describe('LLM Client Factory', () => {
  it('should create OpenAI client', () => {
    const client = createLLMClient({
      id: 'test-openai',
      protocol: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    expect(client.protocol).toBe('openai');
    expect(client.isReady()).toBe(true);
  });

  it('should create Anthropic client', () => {
    const client = createLLMClient({
      id: 'test-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    expect(client.protocol).toBe('anthropic');
    expect(client.isReady()).toBe(true);
  });

  it('should throw on unsupported protocol', () => {
    expect(() =>
      createLLMClient({
        id: 'test-unknown',
        protocol: 'unknown' as 'openai',
        baseUrl: 'https://api.test.com/v1',
        apiKey: 'test-key',
      }),
    ).toThrow('Unsupported protocol');
  });

  it('should report not ready when no API key', () => {
    const client = createLLMClient({
      id: 'test-no-key',
      protocol: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: '',
    });
    expect(client.isReady()).toBe(false);
  });
});

describe('LLMClientManager', () => {
  it('should register and retrieve clients', () => {
    const manager = new LLMClientManager();
    const client = createLLMClient({
      id: 'test-provider',
      protocol: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
    });
    manager.register('test-provider', client);
    expect(manager.get('test-provider')).toBe(client);
    expect(manager.isReady('test-provider')).toBe(true);
  });

  it('should return undefined for unknown provider', () => {
    const manager = new LLMClientManager();
    expect(manager.get('nonexistent')).toBeUndefined();
    expect(manager.isReady('nonexistent')).toBe(false);
  });

  it('should initialize from config', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'p1', protocol: 'openai', baseUrl: 'https://api1.test.com/v1', apiKey: 'key1' },
      { id: 'p2', protocol: 'anthropic', baseUrl: 'https://api2.test.com/v1', apiKey: 'key2' },
    ]);
    expect(manager.get('p1')?.protocol).toBe('openai');
    expect(manager.get('p2')?.protocol).toBe('anthropic');
  });

  it('should unregister clients', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'p1', protocol: 'openai', baseUrl: 'https://api1.test.com/v1', apiKey: 'key1' },
    ]);
    manager.unregister('p1');
    expect(manager.get('p1')).toBeUndefined();
  });

  it('should list all clients', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'p1', protocol: 'openai', baseUrl: 'https://api1.test.com/v1', apiKey: 'key1' },
      { id: 'p2', protocol: 'anthropic', baseUrl: 'https://api2.test.com/v1', apiKey: 'key2' },
    ]);
    const all = manager.listAll();
    expect(all.size).toBe(2);
  });

  it('should get ready clients', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'p1', protocol: 'openai', baseUrl: 'https://api1.test.com/v1', apiKey: 'key1' },
      { id: 'p2', protocol: 'anthropic', baseUrl: 'https://api2.test.com/v1', apiKey: '' },
    ]);
    const ready = manager.getReadyClients();
    expect(ready.length).toBe(1);
    expect(ready[0].providerId).toBe('p1');
  });

  it('should clear all clients', () => {
    const manager = new LLMClientManager();
    manager.initializeFromConfig([
      { id: 'p1', protocol: 'openai', baseUrl: 'https://api1.test.com/v1', apiKey: 'key1' },
    ]);
    manager.clear();
    expect(manager.listAll().size).toBe(0);
  });
});

describe('LLMError', () => {
  it('should identify rate limit errors', () => {
    const err = new LLMError('Rate limited', 429, 'test-model');
    expect(err.isRateLimited).toBe(true);
    expect(err.isAuthError).toBe(false);
    expect(err.type).toBe('rate_limit');
  });

  it('should identify auth errors', () => {
    const err = new LLMError('Unauthorized', 401, 'test-model');
    expect(err.isAuthError).toBe(true);
    expect(err.isRateLimited).toBe(false);
    expect(err.type).toBe('auth_error');
  });

  it('should identify timeout errors', () => {
    const err = new LLMError('LLM request timeout after 30000ms', undefined, 'test-model');
    expect(err.isTimeout).toBe(true);
    expect(err.type).toBe('timeout');
  });

  it('should identify network errors', () => {
    const err = new LLMError('ECONNREFUSED', undefined, 'test-model');
    expect(err.type).toBe('network_error');
  });

  it('should identify model not found errors', () => {
    const err = new LLMError('Model not found', 404, 'test-model');
    expect(err.type).toBe('model_not_found');
  });

  it('should preserve cause chain', () => {
    const cause = new Error('Network error');
    const err = new LLMError('Failed', 500, 'test-model', cause);
    expect(err.cause).toBe(cause);
  });

  it('should include model and status code', () => {
    const err = new LLMError('Error', 500, 'gpt-4');
    expect(err.model).toBe('gpt-4');
    expect(err.statusCode).toBe(500);
  });
});

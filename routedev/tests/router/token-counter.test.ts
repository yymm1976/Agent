// tests/router/token-counter.test.ts
// Token 计数器单元测试

import { describe, it, expect } from 'vitest';
import {
  estimateTokenCount,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateSystemPromptTokens,
  estimateToolDefinitionTokens,
  checkTokenLimit,
} from '../../src/router/token-counter.js';
import type { LLMMessage } from '../../src/router/types.js';

describe('Token Counter', () => {
  describe('estimateTokenCount', () => {
    it('should estimate English text tokens', () => {
      const text = 'Hello, this is a test message.';
      const tokens = estimateTokenCount(text);
      // 约 30 字符，预计 7-8 tokens
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(15);
    });

    it('should estimate Chinese text tokens', () => {
      const text = '这是一条中文测试消息';
      const tokens = estimateTokenCount(text);
      // 10 个中文字符，约 7 tokens
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(12);
    });

    it('should handle mixed Chinese and English', () => {
      const text = 'Hello 世界, this is 测试';
      const tokens = estimateTokenCount(text);
      expect(tokens).toBeGreaterThan(5);
    });

    it('should return 0 for empty string', () => {
      expect(estimateTokenCount('')).toBe(0);
    });

    it('should handle long text', () => {
      const text = 'a'.repeat(1000);
      const tokens = estimateTokenCount(text);
      // 1000 字符，约 250 tokens
      expect(tokens).toBeGreaterThan(200);
      expect(tokens).toBeLessThan(300);
    });
  });

  describe('estimateMessageTokens', () => {
    it('should estimate simple user message', () => {
      const message: LLMMessage = {
        role: 'user',
        content: 'Hello, how are you?',
      };
      const tokens = estimateMessageTokens(message);
      // 内容约 5 tokens + 4 格式开销
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(15);
    });

    it('should estimate assistant message with tool call', () => {
      const message: LLMMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'read_file',
            arguments: { path: '/test.txt' },
          },
        ],
      };
      const tokens = estimateMessageTokens(message);
      expect(tokens).toBeGreaterThan(10);
    });

    it('should estimate message with tool result', () => {
      const message: LLMMessage = {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'call_123',
            content: 'File content here...',
            isError: false,
          },
        ],
      };
      const tokens = estimateMessageTokens(message);
      expect(tokens).toBeGreaterThan(5);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('should estimate conversation history', () => {
      const messages: LLMMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];
      const tokens = estimateMessagesTokens(messages);
      expect(tokens).toBeGreaterThan(15);
      expect(tokens).toBeLessThan(30);
    });

    it('should return 0 for empty array', () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });
  });

  describe('estimateSystemPromptTokens', () => {
    it('should estimate system prompt', () => {
      const prompt = 'You are a helpful assistant.';
      const tokens = estimateSystemPromptTokens(prompt);
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(15);
    });
  });

  describe('estimateToolDefinitionTokens', () => {
    it('should estimate tool definition', () => {
      const tool = {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
      };
      const tokens = estimateToolDefinitionTokens(tool);
      expect(tokens).toBeGreaterThan(15);
      expect(tokens).toBeLessThan(60);
    });
  });

  describe('checkTokenLimit', () => {
    it('should return within limit for small conversation', () => {
      const messages: LLMMessage[] = [
        { role: 'user', content: 'Hello' },
      ];
      const result = checkTokenLimit(messages, undefined, undefined, 4000);
      expect(result.withinLimit).toBe(true);
      expect(result.estimatedTokens).toBeLessThan(100);
    });

    it('should return over limit for large conversation', () => {
      const messages: LLMMessage[] = [
        { role: 'user', content: 'a'.repeat(20000) },
      ];
      const result = checkTokenLimit(messages, undefined, undefined, 100);
      expect(result.withinLimit).toBe(false);
      expect(result.estimatedTokens).toBeGreaterThan(100);
    });

    it('should include system prompt in calculation', () => {
      const messages: LLMMessage[] = [];
      const result = checkTokenLimit(messages, 'You are helpful', undefined, 1000);
      expect(result.estimatedTokens).toBeGreaterThan(5);
    });

    it('should include tools in calculation', () => {
      const messages: LLMMessage[] = [];
      const tools = [
        {
          name: 'test',
          description: 'Test tool',
          parameters: { type: 'object', properties: {} },
        },
      ];
      const result = checkTokenLimit(messages, undefined, tools, 1000);
      expect(result.estimatedTokens).toBeGreaterThan(5);
    });
  });
});

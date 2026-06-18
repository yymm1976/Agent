// tests/memory/compress-enhanced.test.ts
// 上下文压缩增强单元测试（Phase 21 Task 5）
// 验证：低于 80% 不触发；超 80% 压缩老消息；system prompt 不变；
//       大输出被 offload；最近 6 条保留；压缩事件回调触发

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ContextManager } from '../../src/agent/memory/context-manager.js';
import type { CompressionEvent } from '../../src/agent/memory/context-manager.js';
import { CheckpointWriter } from '../../src/agent/memory/checkpoint-writer.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, LLMMessage } from '../../src/router/types.js';
import type { ToolResultContent, TextContent } from '../../src/router/types.js';

function createMockWriter(): CheckpointWriter {
  const client: ILLMClient = {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => ({
      content: '{}',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    })),
    stream: vi.fn(async function* () { /* */ }),
  };
  return new CheckpointWriter(client, 'mock', 500, '/nonexistent.md');
}

function createManager(window: number, threshold = 0.8): ContextManager {
  return new ContextManager(
    {
      contextWindow: window,
      compressionThreshold: threshold,
      keepRecentMessages: 2,
      checkpointEnabled: true,
    },
    createMockWriter(),
  );
}

/** 生成指定 token 数的文本（每 4 字符约 1 token） */
function makeText(approxTokens: number): string {
  return 'x'.repeat(approxTokens * 4);
}

/** 生成包含 tool_result 的 ContentPart[] */
function makeToolResultContent(content: string): ToolResultContent[] {
  return [{
    type: 'tool_result',
    toolUseId: 'test-id',
    content,
    isError: false,
  }];
}

describe('ContextManager.compressEnhanced（Phase 21 Task 5）', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-compress-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('阈值检查', () => {
    it('低于 80% 不触发压缩', async () => {
      // contextWindow=1000, 80%=800 tokens
      const mgr = createManager(1000);
      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(100) },
        { role: 'user', content: makeText(200) },
        { role: 'assistant', content: makeText(200) },
      ];
      // 总 token ≈ 500 < 800 → 不压缩
      const { compressed, result } = await mgr.compressEnhanced(messages);
      expect(compressed.length).toBe(3);
      expect(result.messagesCompressed).toBe(0);
      expect(result.offloadedOutputs).toBe(0);
      expect(result.tokensBefore).toBe(result.tokensAfter);
    });

    it('超 80% 触发压缩', async () => {
      // contextWindow=1000, 80%=800 tokens
      const mgr = createManager(1000);
      // 生成超过 800 tokens 的消息
      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(200) },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(200) },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
      ];
      // 总 token ≈ 1050 > 800 → 压缩
      const { result } = await mgr.compressEnhanced(messages, { preserveLast: 2 });
      expect(result.tokensBefore).toBeGreaterThan(800);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
      // 应该有消息被压缩
      expect(result.messagesCompressed).toBeGreaterThan(0);
    });
  });

  describe('system prompt 保护', () => {
    it('system prompt 永不压缩', async () => {
      const mgr = createManager(1000);
      const systemContent = makeText(100);
      const messages: LLMMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: makeText(300) },
        { role: 'assistant', content: makeText(300) },
        { role: 'user', content: makeText(100) },
        { role: 'assistant', content: makeText(100) },
        { role: 'user', content: makeText(100) },
        { role: 'assistant', content: makeText(100) },
      ];
      const { compressed } = await mgr.compressEnhanced(messages, { preserveLast: 2 });
      // system prompt 内容不变
      expect(compressed[0].role).toBe('system');
      const sysContent = typeof compressed[0].content === 'string'
        ? compressed[0].content
        : '';
      expect(sysContent).toBe(systemContent);
    });

    it('中间的 system 消息也不被压缩', async () => {
      const mgr = createManager(1000);
      const midSystemContent = makeText(100);
      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(200) },
        { role: 'system', content: midSystemContent },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(200) },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
      ];
      const { compressed } = await mgr.compressEnhanced(messages, { preserveLast: 2 });
      // 找到中间的 system 消息，内容应不变
      const midSystem = compressed.find(
        (m, i) => i > 0 && m.role === 'system' && typeof m.content === 'string',
      );
      expect(midSystem).toBeDefined();
      if (midSystem && typeof midSystem.content === 'string') {
        expect(midSystem.content).toBe(midSystemContent);
      }
    });
  });

  describe('大工具输出 offload', () => {
    it('大工具输出被 offload 到文件', async () => {
      const mgr = createManager(2000);
      const offloadDir = path.join(tempDir, 'offloaded');
      const largeToolOutput = makeText(2500); // > 2000 tokens

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(100) },
        {
          role: 'user',
          content: makeToolResultContent(largeToolOutput),
        },
        { role: 'assistant', content: makeText(100) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
      ];

      const { compressed, result } = await mgr.compressEnhanced(messages, {
        offloadDir,
        maxTokens: 1500,
        preserveLast: 2,
      });

      expect(result.offloadedOutputs).toBeGreaterThan(0);

      // offload 目录下应有文件
      const files = await fs.readdir(offloadDir);
      expect(files.length).toBeGreaterThan(0);

      // 压缩后的 tool_result 内容应包含 [offloaded] 标记
      const offloadedMsg = compressed.find(m => {
        if (typeof m.content === 'string') return m.content.includes('[offloaded]');
        if (Array.isArray(m.content)) {
          return m.content.some(p => p.type === 'tool_result' && p.content.includes('[offloaded]'));
        }
        return false;
      });
      expect(offloadedMsg).toBeDefined();
    });

    it('小工具输出不被 offload', async () => {
      const mgr = createManager(2000);
      const offloadDir = path.join(tempDir, 'offloaded');
      const smallToolOutput = makeText(500); // < 2000 tokens

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(500) },
        {
          role: 'user',
          content: makeToolResultContent(smallToolOutput),
        },
        { role: 'assistant', content: makeText(500) },
        { role: 'user', content: makeText(500) },
        { role: 'assistant', content: makeText(500) },
      ];

      const { result } = await mgr.compressEnhanced(messages, {
        offloadDir,
        maxTokens: 1500,
        preserveLast: 2,
      });

      // 小工具输出不应被 offload
      expect(result.offloadedOutputs).toBe(0);
    });

    it('未提供 offloadDir 时仍替换内容但不写文件', async () => {
      const mgr = createManager(2000);
      const largeToolOutput = makeText(2500);

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(100) },
        {
          role: 'user',
          content: makeToolResultContent(largeToolOutput),
        },
        { role: 'assistant', content: makeText(100) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
      ];

      const { result } = await mgr.compressEnhanced(messages, {
        // 不提供 offloadDir
        maxTokens: 1500,
        preserveLast: 2,
      });

      // 仍标记为 offloaded（内容被替换）
      expect(result.offloadedOutputs).toBeGreaterThan(0);
    });
  });

  describe('保留最近消息', () => {
    it('最近 6 条消息被保留（不被摘要替换）', async () => {
      const mgr = createManager(1000);
      // 生成 12 条消息，每条约 100 tokens，总 1200 > 800
      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        ...Array.from({ length: 11 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant' as const,
          content: makeText(100),
        })),
      ];

      const preserveLast = 6;
      const { compressed, result } = await mgr.compressEnhanced(messages, {
        preserveLast,
        maxTokens: 800,
      });

      // 最后 6 条内容不应包含 [已压缩]
      const last6 = compressed.slice(-preserveLast);
      for (const msg of last6) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        expect(content).not.toContain('[已压缩]');
      }

      // 应该有消息被压缩（前面的消息）
      expect(result.messagesCompressed).toBeGreaterThan(0);
    });

    it('preserveLast=2 时只保留最后 2 条', async () => {
      const mgr = createManager(1000);
      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(200) },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(200) },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
      ];

      const { compressed } = await mgr.compressEnhanced(messages, {
        preserveLast: 2,
        maxTokens: 500,
      });

      // 最后 2 条不被压缩
      const last2 = compressed.slice(-2);
      for (const msg of last2) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        expect(content).not.toContain('[已压缩]');
      }
    });
  });

  describe('压缩事件回调', () => {
    it('压缩时触发回调', async () => {
      const mgr = createManager(1000);
      const callback = vi.fn((event: CompressionEvent) => {
        expect(event.tokensBefore).toBeGreaterThan(0);
        expect(event.tokensAfter).toBeGreaterThanOrEqual(0);
        expect(event.timestamp).toBeGreaterThan(0);
      });

      mgr.onCompression(callback);

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        ...Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant' as const,
          content: makeText(100),
        })),
      ];

      await mgr.compressEnhanced(messages, { maxTokens: 500, preserveLast: 2 });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('未超阈值时不触发回调', async () => {
      const mgr = createManager(1000);
      const callback = vi.fn();
      mgr.onCompression(callback);

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(100) },
        { role: 'assistant', content: makeText(100) },
      ];

      await mgr.compressEnhanced(messages); // 总 250 < 800

      expect(callback).not.toHaveBeenCalled();
    });

    it('offCompression 移除回调', async () => {
      const mgr = createManager(1000);
      const callback = vi.fn();
      mgr.onCompression(callback);
      mgr.offCompression(callback);

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        ...Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant' as const,
          content: makeText(100),
        })),
      ];

      await mgr.compressEnhanced(messages, { maxTokens: 500, preserveLast: 2 });
      expect(callback).not.toHaveBeenCalled();
    });

    it('回调抛异常不影响压缩流程', async () => {
      const mgr = createManager(1000);
      const badCallback = vi.fn(() => {
        throw new Error('callback error');
      });
      const goodCallback = vi.fn();
      mgr.onCompression(badCallback);
      mgr.onCompression(goodCallback);

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        ...Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant' as const,
          content: makeText(100),
        })),
      ];

      const { compressed } = await mgr.compressEnhanced(messages, {
        maxTokens: 500,
        preserveLast: 2,
      });

      // 压缩仍完成
      expect(compressed).toBeDefined();
      // bad callback 被调用但抛异常
      expect(badCallback).toHaveBeenCalled();
      // good callback 仍被调用（异常不传播）
      expect(goodCallback).toHaveBeenCalled();
    });
  });

  describe('CompressionEvent 统计', () => {
    it('tokensBefore 和 tokensAfter 正确记录', async () => {
      const mgr = createManager(1000);
      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        ...Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant' as const,
          content: makeText(100),
        })),
      ];

      const { result } = await mgr.compressEnhanced(messages, {
        maxTokens: 500,
        preserveLast: 2,
      });

      expect(result.tokensBefore).toBeGreaterThan(500);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
      expect(result.messagesCompressed).toBeGreaterThan(0);
    });

    it('messagesCompressed 和 offloadedOutputs 正确计数', async () => {
      const mgr = createManager(2000);
      const offloadDir = path.join(tempDir, 'offloaded');
      const largeToolOutput = makeText(2500);

      const messages: LLMMessage[] = [
        { role: 'system', content: makeText(50) },
        { role: 'user', content: makeText(200) },
        {
          role: 'user',
          content: makeToolResultContent(largeToolOutput),
        },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(200) },
        { role: 'assistant', content: makeText(200) },
        { role: 'user', content: makeText(50) },
        { role: 'assistant', content: makeText(50) },
      ];

      const { result } = await mgr.compressEnhanced(messages, {
        offloadDir,
        maxTokens: 1500,
        preserveLast: 2,
      });

      expect(result.offloadedOutputs).toBe(1); // 1 个大工具输出
      expect(result.messagesCompressed).toBeGreaterThanOrEqual(0); // 可能还有老消息被压缩
    });
  });

  describe('向后兼容', () => {
    it('原有 compress() 方法仍可用', () => {
      const mgr = createManager(1000);
      const messages: LLMMessage[] = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant' as const,
        content: `Msg ${i}`,
      }));

      const { compressed, result } = mgr.compress(messages);
      expect(compressed).toBeDefined();
      expect(result).toBeDefined();
      expect(result.originalCount).toBe(8);
    });

    it('原有 shouldCompress() 方法仍可用', () => {
      const mgr = createManager(1000);
      expect(mgr.shouldCompress(10, 700)).toBe(false);
      expect(mgr.shouldCompress(10, 800)).toBe(true);
    });
  });
});

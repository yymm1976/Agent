// tests/agent/context-compaction.test.ts
// ContextCompactor 单元测试 — 五阶段渐进压缩管线

import { describe, it, expect, vi } from 'vitest';
import { ContextCompactor } from '../../src/agent/context-compaction.js';
import { estimateTokens } from '../../src/utils/token-estimate.js';
import type { LLMMessage } from '../../src/router/types.js';

// 辅助：生成超长字符串（模拟大工具输出）
function makeLongText(length: number): string {
  return 'A'.repeat(length);
}

// 辅助：创建简单消息
function msg(role: 'system' | 'user' | 'assistant', content: string): LLMMessage {
  return { role, content };
}

describe('ContextCompactor', () => {
  describe('L1: Budget Trimming — 截断大工具输出', () => {
    it('应将 >2000 字符的 user 消息截断为 500 首 + 标记 + 500 尾', async () => {
      const longText = makeLongText(3000);
      const messages: LLMMessage[] = [
        msg('user', longText),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0, // 设为 0 强制走完所有阶段
        estimateTokens,
      });
      const { messages: result } = await compactor.compact(messages);
      const content = typeof result[0].content === 'string' ? result[0].content : '';
      // 500 首 + "[...截断...]" (8 字符) + 500 尾 = 1008
      expect(content.length).toBe(500 + '[...截断...]'.length + 500);
      expect(content).toContain('[...截断...]');
      expect(content.startsWith('A'.repeat(500))).toBe(true);
      expect(content.endsWith('A'.repeat(500))).toBe(true);
    });

    it('应截断 ContentPart[] 中的 tool_result', async () => {
      const longText = makeLongText(2500);
      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 't1', content: longText, isError: false },
          ],
        },
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
      });
      const { messages: result } = await compactor.compact(messages);
      const parts = Array.isArray(result[0].content) ? result[0].content : [];
      const toolResult = parts[0];
      expect(toolResult.type).toBe('tool_result');
      if (toolResult.type === 'tool_result') {
        expect(toolResult.content.length).toBe(500 + '[...截断...]'.length + 500);
        expect(toolResult.content).toContain('[...截断...]');
      }
    });

    it('不应截断 <=2000 字符的消息', async () => {
      const shortText = makeLongText(2000);
      const messages: LLMMessage[] = [msg('user', shortText)];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
      });
      const { messages: result } = await compactor.compact(messages);
      const content = typeof result[0].content === 'string' ? result[0].content : '';
      expect(content.length).toBe(2000);
      expect(content).not.toContain('[...截断...]');
    });
  });

  describe('L2: Snipping — 删除旧消息', () => {
    it('超过 10 条消息后应保留最近 10 条 + system 消息', async () => {
      const messages: LLMMessage[] = [
        msg('system', 'system prompt'),
        ...Array.from({ length: 15 }, (_, i) => msg('user', `msg ${i}`)),
      ];
      // 原始 token ≈ 34，L2 后 ≈ 24，设 target=30 使 L1 不达标但 L2 达标
      const compactor = new ContextCompactor({
        targetTokens: 30,
        estimateTokens,
      });
      const { messages: result, result: compactionResult } = await compactor.compact(messages);
      // maxStageReached 应为 2（L2 后达标，L3+ 不执行）
      expect(compactionResult.maxStageReached).toBe(2);
      // 1 system + 10 recent = 11
      expect(result.length).toBe(11);
      expect(result[0].role).toBe('system');
      // 最近 10 条应保留
      const recentContents = result.slice(1).map((m) =>
        typeof m.content === 'string' ? m.content : '',
      );
      expect(recentContents).toContain('msg 5');
      expect(recentContents).toContain('msg 14');
      // 旧消息应被删除
      expect(recentContents).not.toContain('msg 0');
      expect(recentContents).not.toContain('msg 4');
    });

    it('不超过 10 条消息时应全部保留', async () => {
      const messages: LLMMessage[] = Array.from({ length: 8 }, (_, i) =>
        msg('user', `msg ${i}`),
      );
      // 设高 targetTokens 使 L1 后即达标，不触发 L2+
      const compactor = new ContextCompactor({
        targetTokens: 10000,
        estimateTokens,
      });
      const { messages: result, result: compactionResult } = await compactor.compact(messages);
      expect(compactionResult.maxStageReached).toBe(1);
      expect(result.length).toBe(8);
    });
  });

  describe('L3: Micro-Compaction — 清理空消息', () => {
    it('应删除 content 为空字符串的消息', async () => {
      const messages: LLMMessage[] = [
        msg('user', ''),
        msg('user', '   '),
        msg('assistant', 'valid'),
        msg('user', ''),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
      });
      const { messages: result } = await compactor.compact(messages);
      // 只有 'valid' 保留
      expect(result.length).toBe(1);
      const content = typeof result[0].content === 'string' ? result[0].content : '';
      expect(content).toBe('valid');
    });
  });

  describe('L4: Context Collapse — 合并去重', () => {
    it('应合并连续相同 role 的消息', async () => {
      const messages: LLMMessage[] = [
        msg('user', 'hello'),
        msg('user', 'world'),
        msg('assistant', 'hi'),
        msg('assistant', 'there'),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
      });
      const { messages: result } = await compactor.compact(messages);
      // 合并后：1 user + 1 assistant = 2
      expect(result.length).toBe(2);
      expect(result[0].role).toBe('user');
      const userContent = typeof result[0].content === 'string' ? result[0].content : '';
      expect(userContent).toContain('hello');
      expect(userContent).toContain('world');
      expect(result[1].role).toBe('assistant');
    });

    it('应去重相同的 tool_result', async () => {
      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 't1', content: 'result', isError: false },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 't1', content: 'result', isError: false },
          ],
        },
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
      });
      const { messages: result } = await compactor.compact(messages);
      // 合并后 1 条 user，去重后 1 个 tool_result
      expect(result.length).toBe(1);
      const parts = Array.isArray(result[0].content) ? result[0].content : [];
      expect(parts.length).toBe(1);
    });
  });

  describe('L5: LLM Summary', () => {
    it('应在 L1-L4 不足时调用 summarize', async () => {
      const summarize = vi.fn(async (_msgs: LLMMessage[]) => '这是摘要');
      const messages: LLMMessage[] = [
        msg('user', makeLongText(5000)),
        msg('assistant', makeLongText(5000)),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0, // 强制走完所有阶段
        estimateTokens,
        summarize,
      });
      const { messages: result, result: compactionResult } = await compactor.compact(messages);
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(compactionResult.maxStageReached).toBe(5);
      expect(compactionResult.summary).toBe('这是摘要');
      // L5 后应只剩 1 条 system 消息（摘要）
      expect(result.length).toBe(1);
      expect(result[0].role).toBe('system');
      const content = typeof result[0].content === 'string' ? result[0].content : '';
      expect(content).toBe('这是摘要');
    });

    it('未提供 summarize 时 L5 不调用 LLM 但仍标记 maxStageReached=5', async () => {
      const messages: LLMMessage[] = [
        msg('user', makeLongText(5000)),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
        // 不提供 summarize
      });
      const { result: compactionResult } = await compactor.compact(messages);
      expect(compactionResult.maxStageReached).toBe(5);
      expect(compactionResult.summary).toBeUndefined();
    });
  });

  describe('渐进性', () => {
    it('L1 后已达标则不执行 L2+', async () => {
      // 小消息 + 高 targetTokens → L1 后就达标
      const messages: LLMMessage[] = [
        msg('user', 'short'),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 10000, // 远高于实际 token
        estimateTokens,
      });
      const { result } = await compactor.compact(messages);
      expect(result.maxStageReached).toBe(1);
      expect(result.beforeTokens).toBeLessThanOrEqual(10000);
    });

    it('L1-L4 都不够时执行 L5', async () => {
      const summarize = vi.fn(async () => 'final summary');
      const messages: LLMMessage[] = [
        msg('user', makeLongText(3000)),
        msg('assistant', makeLongText(3000)),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
        summarize,
      });
      const { result } = await compactor.compact(messages);
      expect(result.maxStageReached).toBe(5);
      expect(summarize).toHaveBeenCalled();
    });
  });

  describe('CompactionResult 字段', () => {
    it('应正确填充所有字段', async () => {
      const messages: LLMMessage[] = [
        msg('system', 'sys'),
        ...Array.from({ length: 15 }, (_, i) => msg('user', `msg ${i}`)),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
      });
      const { result } = await compactor.compact(messages);
      expect(result).toHaveProperty('beforeTokens');
      expect(result).toHaveProperty('afterTokens');
      expect(result).toHaveProperty('maxStageReached');
      expect(result).toHaveProperty('removedMessages');
      expect(typeof result.beforeTokens).toBe('number');
      expect(typeof result.afterTokens).toBe('number');
      expect(typeof result.maxStageReached).toBe('number');
      expect(typeof result.removedMessages).toBe('number');
      // 原始 16 条 → 压缩后应更少
      expect(result.removedMessages).toBeGreaterThan(0);
      // afterTokens 应 <= beforeTokens
      expect(result.afterTokens).toBeLessThanOrEqual(result.beforeTokens);
    });

    it('beforeTokens 应反映原始消息的 token 数', async () => {
      const text = 'hello world';
      const messages: LLMMessage[] = [msg('user', text)];
      const compactor = new ContextCompactor({
        targetTokens: 10000,
        estimateTokens,
      });
      const { result } = await compactor.compact(messages);
      expect(result.beforeTokens).toBe(estimateTokens(text));
    });
  });
});

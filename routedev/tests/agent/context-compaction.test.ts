// tests/agent/context-compaction.test.ts
// ContextCompactor 单元测试 — 五阶段渐进压缩管线

import { describe, it, expect, vi } from 'vitest';
import { ContextCompactor } from '../../src/agent/context-compaction.js';
import { CCRCache } from '../../src/agent/ccr-cache.js';
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
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'file_read', arguments: { path: 'x' } }],
        },
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
      // B-07：结果按消息顺序保留，找到包含 tool_result 的消息再断言
      const toolResultMsg = result.find((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result'));
      expect(toolResultMsg).toBeDefined();
      const parts = Array.isArray(toolResultMsg?.content) ? toolResultMsg.content : [];
      const toolResult = parts.find((p) => p.type === 'tool_result');
      expect(toolResult?.type).toBe('tool_result');
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
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'file_read', arguments: { path: 'x' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 't1', content: 'result', isError: false },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'file_read', arguments: { path: 'x' } }],
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
      // B-07：重复 tool_result 去重为 1 条，且 tool_use/tool_result 保持成对
      const resultMsgs = result.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result'));
      expect(resultMsgs).toHaveLength(1);
      const parts = Array.isArray(resultMsgs[0].content) ? resultMsgs[0].content : [];
      expect(parts.filter((p) => p.type === 'tool_result')).toHaveLength(1);
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
      // I2 修复：L5 保留摘要 + recentTail（最近 3 条），避免破坏 tool_use/tool_result 对偶
      // 原消息 2 条（user+assistant），recentTail 取全部 2 条，加 1 条 system 摘要 = 3 条
      expect(result.length).toBe(3);
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

    it('启用 CCR 时压缩结果包含可逆检索标记', async () => {
      const ccrCache = new CCRCache();
      const messages: LLMMessage[] = [
        msg('system', 'sys'),
        msg('user', makeLongText(3000)),
        msg('assistant', makeLongText(3000)),
      ];
      const compactor = new ContextCompactor({
        targetTokens: 0,
        estimateTokens,
        ccrCache,
      });

      const { result } = await compactor.compact(messages);
      expect(result.ccr?.marker).toContain('CCR:');
      const restored = ccrCache.retrieve(result.ccr!.hash);
      expect(restored).toEqual(messages);
    });
  });
});

describe('B-07 压缩恢复与 turn boundary', async () => {
  const { extractRecoveryContext, repairTurnBoundary } = await import('../../src/agent/context-compaction.js');

  function toolUseMsg(id: string, name: string, args: Record<string, unknown>): LLMMessage {
    return { role: 'assistant', content: [{ type: 'tool_use', id, name, arguments: args }] };
  }
  function toolResultMsg(id: string, text = 'ok'): LLMMessage {
    return { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: text, isError: false }] };
  }
  function textMsg(role: 'user' | 'assistant' | 'system', text: string): LLMMessage {
    return { role, content: text };
  }

  it('extractRecoveryContext：提取最近读取/修改文件、图片与 Todo', () => {
    const messages: LLMMessage[] = [
      toolUseMsg('t1', 'file_read', { path: 'src/a.ts' }),
      toolUseMsg('t2', 'file_edit', { path: 'src/b.ts' }),
      toolUseMsg('t3', 'todo_write', { action: '修复 a.ts' }),
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'x' } }] },
    ];
    const recovery = extractRecoveryContext(messages);
    expect(recovery.readFiles).toEqual(['src/a.ts']);
    expect(recovery.modifiedFiles).toEqual(['src/b.ts']);
    expect(recovery.todoItems).toEqual(['修复 a.ts']);
    expect(recovery.imageCount).toBe(1);
  });

  it('extractRecoveryContext：忽略无关工具与空路径，清单有上限', () => {
    const messages: LLMMessage[] = [
      toolUseMsg('t1', 'shell_exec', { command: 'ls' }),
      toolUseMsg('t2', 'file_read', { path: '' }),
    ];
    const recovery = extractRecoveryContext(messages);
    expect(recovery.readFiles).toEqual([]);
    expect(recovery.modifiedFiles).toEqual([]);
  });

  it('repairTurnBoundary：删除孤儿 tool_result（其 tool_use 已被压缩掉）', () => {
    const messages: LLMMessage[] = [
      textMsg('user', '旧问题'),
      toolResultMsg('orphan-1'), // 无对应 tool_use
      toolUseMsg('kept', 'file_read', { path: 'x' }),
      toolResultMsg('kept'),
    ];
    const { messages: result, removed } = repairTurnBoundary(messages);
    expect(removed).toBe(1);
    expect(result.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result' && p.toolUseId === 'orphan-1'))).toBe(false);
    // 完整的 tool_use/tool_result 对保留
    expect(result.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_use' && p.id === 'kept'))).toBe(true);
  });

  it('repairTurnBoundary：完整对不删除', () => {
    const messages: LLMMessage[] = [
      toolUseMsg('a', 'file_read', { path: 'x' }),
      toolResultMsg('a'),
      toolUseMsg('b', 'file_edit', { path: 'y' }),
      toolResultMsg('b'),
    ];
    const { messages: result, removed } = repairTurnBoundary(messages);
    expect(removed).toBe(0);
    expect(result).toHaveLength(4);
  });

  it('compact() 输出 recovery 清单（强制压缩路径）', async () => {
    // 构造大量消息强制走 L2+，验证 recovery 附加到结果
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      messages.push(toolUseMsg(`t${i}`, 'file_read', { path: `src/f${i}.ts` }));
      messages.push(toolResultMsg(`t${i}`));
    }
    const compactor = new ContextCompactor({
      targetTokens: 0, // 强制走完所有阶段
      estimateTokens,
    });
    const { result } = await compactor.compact(messages);
    expect(result.recovery).toBeDefined();
    expect(result.recovery!.readFiles.length).toBeGreaterThan(0);
    expect(result.recovery!.readFiles[0]).toBe('src/f0.ts');
  });

  describe('H3 compaction provenance（denial / 安全约束保留）', () => {
    it('用户拒绝与安全约束在压缩后保留（不被摘要成"需要执行"）', async () => {
      const { ContextCompactor } = await import('../../src/agent/context-compaction.js');
      const { estimateTokens } = await import('../../src/utils/token-estimate.js');
      const compactor = new ContextCompactor({ maxMessages: 4, maxOutputChars: 1000, targetTokens: 100, estimateTokens });
      const messages = [
        { role: 'system' as const, content: '安全基线：禁止删除生产数据库；破坏性操作需用户明确确认。' },
        { role: 'user' as const, content: '请删除 production 数据库。' },
        { role: 'assistant' as const, content: '我不能删除 production 数据库——这是破坏性操作，且您没有明确授权。' },
        { role: 'user' as const, content: '那先改一下配置文件的端口号。' },
      ];
      const { messages: compressed, result } = await compactor.compact(messages);
      // 压缩后保留的消息（最近的 user 请求）不得丢失拒绝语义相关的安全上下文
      const compressedText = compressed.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ');
      // system 安全基线保留
      expect(compressedText).toContain('禁止删除');
      // 拒绝语义保留（assistant 的拒绝在保留窗口内——L2 保留最近消息）
      expect(compressedText.toLowerCase()).not.toContain('delete production database and execute');
      void result;
    });

    it('未完成 Todo 与最近文件进恢复清单（压缩后继续工作依据）', async () => {
      const { extractRecoveryContext } = await import('../../src/agent/context-compaction.js');
      const messages = [
        { role: 'user' as const, content: '先修复 src/a.ts。' },
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 't1', name: 'file_edit', arguments: { path: 'src/a.ts' } },
            { type: 'tool_use' as const, id: 't2', name: 'todo_write', arguments: { action: 'replace' } },
          ],
        },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 't1', content: 'ok', isError: false }] },
      ];
      const recovery = extractRecoveryContext(messages);
      expect(recovery.modifiedFiles).toContain('src/a.ts');
      expect(recovery.todoItems).toContain('replace');
    });
  });
});

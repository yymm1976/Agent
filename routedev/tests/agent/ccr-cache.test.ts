import { describe, expect, it } from 'vitest';
import { CCRCache } from '../../src/agent/ccr-cache.js';
import type { LLMMessage } from '../../src/router/types.js';

describe('CCRCache', () => {
  it('store/retrieve 保持原始 messages 可逆', () => {
    const cache = new CCRCache();
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '原始工具输出', isError: false }] },
    ];

    const record = cache.store(messages);
    messages[1].content = 'mutated';
    const restored = cache.retrieve(record.hash);

    expect(restored).not.toBeNull();
    expect(restored?.[1].content).toEqual([{ type: 'tool_result', toolUseId: 't1', content: '原始工具输出', isError: false }]);
  });

  it('buildMarker 生成可读检索标记', () => {
    const marker = new CCRCache().buildMarker('abcdef1234567890', 10, 3);

    expect(marker.marker).toContain('CCR:abcdef123456');
    expect(marker.originalCount).toBe(10);
    expect(marker.compactedCount).toBe(3);
  });
});

// ============================================================
// Phase 60：CCRCache 边界测试补强
// ============================================================

describe('Phase 60: CCRCache 边界测试', () => {
  /** 构造测试消息 */
  function makeMessages(tag: string): LLMMessage[] {
    return [
      { role: 'system', content: `sys-${tag}` },
      { role: 'user', content: `user-${tag}` },
    ];
  }

  it('超过 maxSize 时 LRU 淘汰最早记录', () => {
    // maxSize=2，存 3 个，第 1 个应被淘汰
    const cache = new CCRCache(2);
    const r1 = cache.store(makeMessages('a'));
    const r2 = cache.store(makeMessages('b'));
    const r3 = cache.store(makeMessages('c'));

    // r1 被淘汰
    expect(cache.retrieve(r1.hash)).toBeNull();
    // r2/r3 仍在
    expect(cache.retrieve(r2.hash)).not.toBeNull();
    expect(cache.retrieve(r3.hash)).not.toBeNull();
  });

  it('retrieve 不存在的 hash 返回 null', () => {
    const cache = new CCRCache();
    expect(cache.retrieve('nonexistent-hash-0000000000000000000000000000000000000000000000000000000000000000')).toBeNull();
  });

  it('retrieveByPrefix 传入完整 hash 能取回（精确 hash 也能通过前缀匹配）', () => {
    const cache = new CCRCache();
    const record = cache.store(makeMessages('exact'));
    // 传入完整 hash 作为前缀，应能取回
    const restored = cache.retrieveByPrefix(record.hash);
    expect(restored).not.toBeNull();
    expect(restored?.[0].content).toBe('sys-exact');
  });

  it('retrieveByPrefix 传入 12 位前缀（marker 中的前缀长度）能取回', () => {
    const cache = new CCRCache();
    const record = cache.store(makeMessages('prefix12'));
    const marker = cache.buildMarker(record.hash, 2, 1);
    // marker 中只有 12 位前缀
    const prefix = record.hash.slice(0, 12);
    expect(marker.marker).toContain(`CCR:${prefix}`);
    const restored = cache.retrieveByPrefix(prefix);
    expect(restored).not.toBeNull();
    expect(restored?.[0].content).toBe('sys-prefix12');
  });

  it('retrieveByPrefix 不匹配的前缀返回 null', () => {
    const cache = new CCRCache();
    cache.store(makeMessages('x'));
    expect(cache.retrieveByPrefix('zzzzzzzzzzzz')).toBeNull();
  });
});

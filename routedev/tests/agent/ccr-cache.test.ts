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

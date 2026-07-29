// tests/tools/tool-call-repair/storm.test.ts
// 工序 3：storm 单测

import { describe, it, expect } from 'vitest';
import { storm } from '../../../src/tools/tool-call-repair/storm.js';
import type { RepairContext } from '../../../src/tools/tool-call-repair/types.js';
import type { ToolCallRequest } from '../../../src/router/types.js';

function makeCtx(
  toolCalls: ToolCallRequest[],
  recentToolCalls: ToolCallRequest[] = [],
): RepairContext {
  return { toolCalls, recentToolCalls };
}

const tc = (name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  id: `${name}-${Math.random()}`,
  name,
  arguments: args,
});

describe('ToolCallRepair.storm', () => {
  it('无重复时不修复', () => {
    const ctx = makeCtx([tc('file_read', { path: '/a' })], []);
    const result = storm(ctx);
    expect(result.repaired).toBe(false);
    expect(result.injectedReflection).toBeUndefined();
  });

  it('当前轮内重复 ≥3 次时抑制后续', () => {
    const ctx = makeCtx([
      tc('file_read', { path: '/a' }),
      tc('file_read', { path: '/a' }),
      tc('file_read', { path: '/a' }),
      tc('file_read', { path: '/a' }),
    ]);
    const result = storm(ctx);
    expect(result.repaired).toBe(true);
    // 阈值 REPEAT_THRESHOLD=3：第 3 次出现时 totalCount=3 达阈值且 seen 已有 → 抑制
    // 所以保留前 2 次，抑制第 3、4 次
    expect(result.toolCalls).toHaveLength(2);
    expect(result.injectedReflection).toContain('工具调用循环');
  });

  it('跨轮重复触发抑制', () => {
    // 最近窗口内已有 2 次相同调用，本轮再调用 1 次（达阈值），第 2 次被抑制
    const recent = [
      tc('file_search', { pattern: 'foo' }),
      tc('file_search', { pattern: 'foo' }),
    ];
    const ctx = makeCtx(
      [tc('file_search', { pattern: 'foo' }), tc('file_search', { pattern: 'foo' })],
      recent,
    );
    const result = storm(ctx);
    expect(result.repaired).toBe(true);
    // 第 1 次保留（窗口 2 + 本轮 1 = 3 达阈值），第 2 次被抑制
    expect(result.toolCalls).toHaveLength(1);
  });

  it('不同参数不视为重复', () => {
    const ctx = makeCtx([
      tc('file_read', { path: '/a' }),
      tc('file_read', { path: '/b' }),
      tc('file_read', { path: '/c' }),
    ]);
    const result = storm(ctx);
    expect(result.repaired).toBe(false);
  });

  it('不同工具不视为重复', () => {
    const ctx = makeCtx([
      tc('file_read', { path: '/a' }),
      tc('file_search', { pattern: 'a' }),
      tc('shell_exec', { command: 'ls' }),
    ]);
    const result = storm(ctx);
    expect(result.repaired).toBe(false);
  });

  it('空 toolCalls 不修复', () => {
    const ctx = makeCtx([]);
    const result = storm(ctx);
    expect(result.repaired).toBe(false);
  });

  it('反思提示包含重复工具名', () => {
    const ctx = makeCtx([
      tc('file_read', { path: '/a' }),
      tc('file_read', { path: '/a' }),
      tc('file_read', { path: '/a' }),
    ]);
    const result = storm(ctx);
    expect(result.injectedReflection).toContain('file_read');
  });
});

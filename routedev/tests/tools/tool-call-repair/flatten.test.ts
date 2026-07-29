// tests/tools/tool-call-repair/flatten.test.ts
// 工序 2：flatten 单测

import { describe, it, expect } from 'vitest';
import { flatten } from '../../../src/tools/tool-call-repair/flatten.js';
import type { RepairContext } from '../../../src/tools/tool-call-repair/types.js';
import type { ToolCallRequest } from '../../../src/router/types.js';

function makeCtx(toolCalls: ToolCallRequest[]): RepairContext {
  return { toolCalls, recentToolCalls: [] };
}

describe('ToolCallRepair.flatten', () => {
  it('深度 ≤ 2 且字段数 ≤ 10 时不打平', () => {
    const ctx = makeCtx([
      { id: '1', name: 'file_read', arguments: { path: '/a.ts', offset: 0 } },
    ]);
    const result = flatten(ctx);
    expect(result.repaired).toBe(false);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a.ts', offset: 0 });
  });

  it('深度 > 2 时打平为 dot-notation', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'config_update',
        arguments: { server: { db: { host: 'localhost', port: 5432 } } },
      },
    ]);
    const result = flatten(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({
      'server.db.host': 'localhost',
      'server.db.port': 5432,
    });
  });

  it('字段数 > 10 时打平', () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) args[`field${i}`] = i;
    const ctx = makeCtx([{ id: '1', name: 'bulk_op', arguments: args }]);
    const result = flatten(ctx);
    expect(result.repaired).toBe(true);
    // 顶层 12 字段打平后仍为 12（已是扁平结构），但触发打平逻辑
    expect(Object.keys(result.toolCalls[0].arguments)).toHaveLength(12);
  });

  it('数组参数不打平', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'file_edit',
        arguments: {
          path: '/a.ts',
          edits: [{ old: 'x', new: 'y' }, { old: 'a', new: 'b' }],
        },
      },
    ]);
    const result = flatten(ctx);
    expect(result.repaired).toBe(false);
    expect(result.toolCalls[0].arguments.edits).toEqual([
      { old: 'x', new: 'y' },
      { old: 'a', new: 'b' },
    ]);
  });

  it('空对象不触发打平', () => {
    const ctx = makeCtx([{ id: '1', name: 'noop', arguments: {} }]);
    const result = flatten(ctx);
    expect(result.repaired).toBe(false);
  });

  it('多个工具调用时只打平满足阈值的', () => {
    const ctx = makeCtx([
      { id: '1', name: 'file_read', arguments: { path: '/a.ts' } },
      {
        id: '2',
        name: 'config',
        arguments: { a: { b: { c: { d: 1 } } } },
      },
    ]);
    const result = flatten(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a.ts' });
    expect(result.toolCalls[1].arguments).toEqual({ 'a.b.c.d': 1 });
  });

  it('循环引用对象不导致栈溢出', () => {
    const args: Record<string, unknown> = {};
    args.self = args;
    const ctx = makeCtx([{ id: '1', name: 'cyclic', arguments: args }]);
    // maxDepth 有循环引用保护，应正常返回而非栈溢出
    const result = flatten(ctx);
    expect(result.toolCalls).toHaveLength(1);
  });
});

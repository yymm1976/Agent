// tests/tools/tool-call-repair/truncation.test.ts
// 工序 4：truncation 单测

import { describe, it, expect } from 'vitest';
import { truncation } from '../../../src/tools/tool-call-repair/truncation.js';
import type { RepairContext } from '../../../src/tools/tool-call-repair/types.js';
import type { ToolCallRequest } from '../../../src/router/types.js';

function makeCtx(toolCalls: ToolCallRequest[]): RepairContext {
  return { toolCalls, recentToolCalls: [] };
}

describe('ToolCallRepair.truncation', () => {
  it('arguments 已是合法对象时不修复', () => {
    const ctx = makeCtx([
      { id: '1', name: 'file_read', arguments: { path: '/a.ts' } },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(false);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a.ts' });
  });

  it('arguments 为字符串但 JSON 合法时解析为对象', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'file_read',
        arguments: '{"path": "/a.ts"}' as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    // 字符串 → 对象是类型修复，标记 repaired=true
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a.ts' });
  });

  it('arguments 为不完整 JSON 时补全括号', () => {
    // 缺右括号
    const ctx = makeCtx([
      {
        id: '1',
        name: 'file_read',
        arguments: '{"path": "/a.ts"' as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a.ts' });
  });

  it('arguments 字符串未闭合时补全引号', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'file_read',
        arguments: '{"path": "/a.ts' as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a.ts' });
  });

  it('arguments 为空字符串时替换为空对象', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'noop',
        arguments: '' as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('arguments 为非字符串非对象类型时替换为空对象', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'noop',
        arguments: 42 as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('JSON 语法错误无法补全时替换为空对象', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'file_read',
        arguments: 'path: /a.ts' as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('多层嵌套不完整 JSON 补全', () => {
    // 缺两个 }
    const ctx = makeCtx([
      {
        id: '1',
        name: 'config',
        arguments: '{"a": {"b": {"c": 1' as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({ a: { b: { c: 1 } } });
  });

  it('数组类型 arguments 不视为对象，替换为空对象', () => {
    const ctx = makeCtx([
      {
        id: '1',
        name: 'noop',
        arguments: [1, 2, 3] as unknown as Record<string, unknown>,
      },
    ]);
    const result = truncation(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({});
  });
});

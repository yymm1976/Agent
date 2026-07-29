// tests/tools/tool-call-repair/scavenge.test.ts
// 工序 1：scavenge 单测

import { describe, it, expect } from 'vitest';
import { scavenge } from '../../../src/tools/tool-call-repair/scavenge.js';
import type { RepairContext } from '../../../src/tools/tool-call-repair/types.js';

function makeCtx(partial: Partial<RepairContext>): RepairContext {
  return {
    toolCalls: [],
    reasoningContent: undefined,
    rawText: undefined,
    recentToolCalls: [],
    ...partial,
  };
}

describe('ToolCallRepair.scavenge', () => {
  it('reasoning 中含 name/arguments 形式 tool-call JSON 时捞回', () => {
    const ctx = makeCtx({
      reasoningContent: '我需要读取文件，调用 {"name": "file_read", "arguments": {"path": "/tmp/a.ts"}}',
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('file_read');
    expect(result.toolCalls[0].arguments).toEqual({ path: '/tmp/a.ts' });
    // id 应有 scavenged 前缀
    expect(result.toolCalls[0].id).toMatch(/^scavenged-/);
  });

  it('支持 tool/args 简写形式', () => {
    const ctx = makeCtx({
      reasoningContent: '{"tool": "shell_exec", "args": {"command": "ls"}}',
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].name).toBe('shell_exec');
    expect(result.toolCalls[0].arguments).toEqual({ command: 'ls' });
  });

  it('支持嵌套对象参数', () => {
    const ctx = makeCtx({
      rawText: '{"name": "file_edit", "arguments": {"path": "/a.ts", "edits": [{"old": "x", "new": "y"}]}}',
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({
      path: '/a.ts',
      edits: [{ old: 'x', new: 'y' }],
    });
  });

  it('无 reasoning/rawText 时不修复', () => {
    const ctx = makeCtx({});
    const result = scavenge(ctx);
    expect(result.repaired).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('reasoning 中无 tool-call JSON 时不修复', () => {
    const ctx = makeCtx({
      reasoningContent: '用户想读取文件，我需要调用 file_read 工具',
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(false);
  });

  it('捞回的调用与原 toolCalls 重复时去重', () => {
    const ctx = makeCtx({
      toolCalls: [
        { id: 'orig-1', name: 'file_read', arguments: { path: '/tmp/a.ts' } },
      ],
      reasoningContent: '{"name": "file_read", "arguments": {"path": "/tmp/a.ts"}}',
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(false);
    expect(result.toolCalls).toHaveLength(1);
  });

  it('捞回多个不同调用时全部追加', () => {
    const ctx = makeCtx({
      reasoningContent: `
        先调用 {"name": "file_read", "arguments": {"path": "/a.ts"}}
        再调用 {"name": "file_read", "arguments": {"path": "/b.ts"}}
      `,
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
  });

  it('JSON 解析失败的片段不捞回', () => {
    const ctx = makeCtx({
      reasoningContent: '{"name": "file_read", "arguments": {invalid json}}',
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(false);
  });

  it('参数非对象类型（数组）时不捞回', () => {
    const ctx = makeCtx({
      reasoningContent: '{"name": "file_read", "arguments": [1, 2, 3]}',
    });
    const result = scavenge(ctx);
    expect(result.repaired).toBe(false);
  });
});

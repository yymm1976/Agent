// tests/tools/tool-call-repair/pipeline.test.ts
// 工具调用修复 pipeline 整体单测

import { describe, it, expect } from 'vitest';
import { run } from '../../../src/tools/tool-call-repair/pipeline.js';
import type { RepairContext } from '../../../src/tools/tool-call-repair/types.js';
import type { ToolCallRequest } from '../../../src/router/types.js';

function makeCtx(partial: Partial<RepairContext>): RepairContext {
  return {
    toolCalls: [],
    recentToolCalls: [],
    ...partial,
  };
}

describe('ToolCallRepair.pipeline', () => {
  it('无任何问题时不修复，原样返回', () => {
    const ctx = makeCtx({
      toolCalls: [{ id: '1', name: 'file_read', arguments: { path: '/a.ts' } }],
    });
    const result = run(ctx);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.reflections).toHaveLength(0);
    // summary 应包含全部 4 道工序
    expect(result.summary).toHaveLength(4);
    expect(result.summary.map((s) => s.step)).toEqual([
      'scavenge', 'truncation', 'flatten', 'storm',
    ]);
  });

  it('scavenge 捞回的调用经后续工序处理', () => {
    const ctx = makeCtx({
      reasoningContent: '{"name": "file_read", "arguments": {"path": "/a.ts"}}',
    });
    const result = run(ctx);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('file_read');
    expect(result.summary[0]).toEqual({
      step: 'scavenge',
      repaired: true,
      reason: expect.stringContaining('recovered 1 tool call'),
    });
  });

  it('truncation 修复的调用经后续工序处理', () => {
    const ctx = makeCtx({
      toolCalls: [
        {
          id: '1',
          name: 'file_read',
          arguments: '{"path": "/a.ts"' as unknown as Record<string, unknown>,
        },
      ],
    });
    const result = run(ctx);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a.ts' });
  });

  it('storm 触发时返回反思提示', () => {
    const ctx = makeCtx({
      toolCalls: [
        { id: '1', name: 'file_read', arguments: { path: '/a' } },
        { id: '2', name: 'file_read', arguments: { path: '/a' } },
        { id: '3', name: 'file_read', arguments: { path: '/a' } },
        { id: '4', name: 'file_read', arguments: { path: '/a' } },
      ],
    });
    const result = run(ctx);
    expect(result.reflections.length).toBeGreaterThan(0);
    expect(result.reflections[0]).toContain('工具调用循环');
    // 阈值 3：第 3 次达阈值且 seen 已有 → 抑制；保留前 2 次
    expect(result.toolCalls).toHaveLength(2);
  });

  it('多道工序串联：scavenge 捞回 + truncation 修复', () => {
    // reasoning 中含完整 tool-call JSON，scavenge 捞回
    // recentToolCalls 中已有 2 次相同调用，本轮 scavenge 捞回 1 次
    // totalCount = 2（recent）+ 1（本轮首次）= 3 达阈值，但本轮首次 seen 无 key 不抑制
    const ctx = makeCtx({
      reasoningContent: '{"name": "file_read", "arguments": {"path": "/a"}}',
      recentToolCalls: [
        { id: 'r1', name: 'file_read', arguments: { path: '/a' } },
        { id: 'r2', name: 'file_read', arguments: { path: '/a' } },
      ],
    });
    const result = run(ctx);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toEqual({ path: '/a' });
  });

  it('空 toolCalls 时仍返回 summary', () => {
    const ctx = makeCtx({});
    const result = run(ctx);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.summary).toHaveLength(4);
    expect(result.reflections).toHaveLength(0);
  });
});

// tests/cli/components/TracePanel.test.ts
// TracePanel 组件测试（Phase 23 Task 1）
// 验证 parseTimelineEntries 转换正确性 + 边界情况

import { describe, it, expect } from 'vitest';
import {
  parseTimelineEntries,
  formatTimelineBar,
  formatDuration,
  computeSummary,
  renderTraceTimelineText,
} from '../../../src/cli/components/TracePanel.js';
import type { TraceSpan, TraceSession } from '../../../src/harness/trace-types.js';

/** 构造测试用 span 的辅助函数 */
function makeSpan(partial: Partial<TraceSpan>): TraceSpan {
  return {
    id: 1,
    sessionId: 'test',
    type: 'llm_call',
    startTime: 1000,
    endTime: 2000,
    durationMs: 1000,
    payload: {
      type: 'llm_call',
      modelId: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      responseLength: 200,
      toolCallCount: 0,
    },
    status: 'completed',
    ...partial,
  } as TraceSpan;
}

describe('TracePanel: parseTimelineEntries', () => {
  it('空 spans 返回空数组', () => {
    const entries = parseTimelineEntries([]);
    expect(entries).toHaveLength(0);
  });

  it('llm_call span 正确转换为 model 类别条目', () => {
    const spans = [makeSpan({
      type: 'llm_call',
      payload: {
        type: 'llm_call',
        modelId: 'gpt-4o',
        inputTokens: 420,
        outputTokens: 180,
        responseLength: 500,
        toolCallCount: 1,
      },
    })];
    const entries = parseTimelineEntries(spans);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('model');
    expect(entries[0].label).toBe('LLM Call (gpt-4o)');
    expect(entries[0].metadata.model).toBe('gpt-4o');
    expect(entries[0].metadata.tokensIn).toBe(420);
    expect(entries[0].metadata.tokensOut).toBe(180);
  });

  it('tool_call span 正确转换为 tool 类别条目', () => {
    const spans = [makeSpan({
      type: 'tool_call',
      payload: {
        type: 'tool_call',
        toolName: 'read_file',
        toolCallId: 'tc-1',
        args: { path: './src/index.ts' },
      },
    })];
    const entries = parseTimelineEntries(spans);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('tool');
    expect(entries[0].label).toBe('Tool: read_file');
    expect(entries[0].metadata.toolName).toBe('read_file');
  });

  it('react_iteration span 转换为 assembly 类别', () => {
    const spans = [makeSpan({
      type: 'react_iteration',
      payload: {
        type: 'react_iteration',
        iteration: 1,
        thought: '需要读取文件',
      },
    })];
    const entries = parseTimelineEntries(spans);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('assembly');
    expect(entries[0].label).toContain('ReAct #1');
  });

  it('worker_task span 转换为 assembly 类别', () => {
    const spans = [makeSpan({
      type: 'worker_task',
      payload: {
        type: 'worker_task',
        role: 'coder',
        description: '实现功能 X',
        modifiedFiles: [],
      },
    })];
    const entries = parseTimelineEntries(spans);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('assembly');
    expect(entries[0].label).toContain('Worker [coder]');
  });

  it('goal_step span 转换为 routing 类别', () => {
    const spans = [makeSpan({
      type: 'goal_step',
      payload: {
        type: 'goal_step',
        stepId: 1,
        description: '分析需求',
        totalSteps: 3,
      },
    })];
    const entries = parseTimelineEntries(spans);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('routing');
    expect(entries[0].label).toContain('Goal Step 1/3');
  });

  it('乱序 spans 按 startTime 排序', () => {
    const spans = [
      makeSpan({ id: 2, startTime: 3000, payload: { type: 'llm_call', modelId: 'm2', inputTokens: 10, outputTokens: 5, responseLength: 10, toolCallCount: 0 } }),
      makeSpan({ id: 1, startTime: 1000, payload: { type: 'llm_call', modelId: 'm1', inputTokens: 10, outputTokens: 5, responseLength: 10, toolCallCount: 0 } }),
      makeSpan({ id: 3, startTime: 2000, payload: { type: 'llm_call', modelId: 'm3', inputTokens: 10, outputTokens: 5, responseLength: 10, toolCallCount: 0 } }),
    ];
    const entries = parseTimelineEntries(spans);
    expect(entries[0].metadata.model).toBe('m1');
    expect(entries[1].metadata.model).toBe('m3');
    expect(entries[2].metadata.model).toBe('m2');
  });

  it('stepIndex 从 1 开始递增', () => {
    const spans = [
      makeSpan({ id: 1, startTime: 1000, payload: { type: 'llm_call', modelId: 'm1', inputTokens: 10, outputTokens: 5, responseLength: 10, toolCallCount: 0 } }),
      makeSpan({ id: 2, startTime: 2000, payload: { type: 'llm_call', modelId: 'm2', inputTokens: 10, outputTokens: 5, responseLength: 10, toolCallCount: 0 } }),
    ];
    const entries = parseTimelineEntries(spans);
    expect(entries[0].stepIndex).toBe(1);
    expect(entries[1].stepIndex).toBe(2);
  });

  it('有 routeDecision 的 session 在最前插入 routing 条目', () => {
    const session: TraceSession = {
      id: 'abc123',
      startTime: 500,
      userInput: 'test',
      routeDecision: { modelId: 'gpt-4o', tier: 'simple', fallbackUsed: false },
      spanCount: 1,
      completed: true,
    };
    const spans = [makeSpan({ startTime: 1000 })];
    const entries = parseTimelineEntries(spans, session);
    expect(entries).toHaveLength(2);
    expect(entries[0].category).toBe('routing');
    expect(entries[0].label).toContain('gpt-4o');
    expect(entries[0].stepIndex).toBe(1);
    expect(entries[1].stepIndex).toBe(2);
  });

  it('durationMs 缺失时回退为 0', () => {
    const spans = [makeSpan({
      durationMs: undefined,
      endTime: undefined,
      payload: { type: 'llm_call', modelId: 'm1', inputTokens: 10, outputTokens: 5, responseLength: 10, toolCallCount: 0 },
    })];
    const entries = parseTimelineEntries(spans);
    expect(entries[0].durationMs).toBe(0);
  });

  it('endTime 存在但 durationMs 缺失时自动计算', () => {
    const spans = [makeSpan({
      startTime: 1000,
      endTime: 1500,
      durationMs: undefined,
      payload: { type: 'llm_call', modelId: 'm1', inputTokens: 10, outputTokens: 5, responseLength: 10, toolCallCount: 0 },
    })];
    const entries = parseTimelineEntries(spans);
    expect(entries[0].durationMs).toBe(500);
  });
});

describe('TracePanel: formatTimelineBar', () => {
  it('totalMs 为 0 时返回最少 1 格', () => {
    const bar = formatTimelineBar(100, 0);
    expect(bar.length).toBeGreaterThanOrEqual(1);
    expect(bar[0]).toBe('█');
  });

  it('durationMs 占 totalMs 的 1/4 时条形宽度约 10', () => {
    const bar = formatTimelineBar(250, 1000);
    const filledCount = bar.split('█').length - 1;
    expect(filledCount).toBe(10);
  });

  it('durationMs 等于 totalMs 时全满', () => {
    const bar = formatTimelineBar(1000, 1000);
    const filledCount = bar.split('█').length - 1;
    expect(filledCount).toBe(40);
  });

  it('durationMs 为 0 时至少 1 格填充', () => {
    const bar = formatTimelineBar(0, 1000);
    const filledCount = bar.split('█').length - 1;
    expect(filledCount).toBe(1);
  });

  it('条形总宽度始终为 40', () => {
    const bar = formatTimelineBar(500, 1000);
    expect(bar.length).toBe(40);
  });
});

describe('TracePanel: formatDuration', () => {
  it('小于 1000ms 显示为 ms', () => {
    expect(formatDuration(45)).toBe('45ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('大于等于 1000ms 显示为秒', () => {
    expect(formatDuration(1000)).toBe('1.00s');
    expect(formatDuration(1800)).toBe('1.80s');
  });
});

describe('TracePanel: computeSummary', () => {
  it('空数组返回全 0', () => {
    const summary = computeSummary([]);
    expect(summary.totalMs).toBe(0);
    expect(summary.totalTokensIn).toBe(0);
    expect(summary.totalTokensOut).toBe(0);
    expect(summary.stepCount).toBe(0);
  });

  it('正确累加耗时和 token', () => {
    const entries = parseTimelineEntries([
      makeSpan({ durationMs: 100, payload: { type: 'llm_call', modelId: 'm1', inputTokens: 100, outputTokens: 50, responseLength: 10, toolCallCount: 0 } }),
      makeSpan({ durationMs: 200, startTime: 200, payload: { type: 'llm_call', modelId: 'm2', inputTokens: 200, outputTokens: 100, responseLength: 10, toolCallCount: 0 } }),
    ]);
    const summary = computeSummary(entries);
    expect(summary.totalMs).toBe(300);
    expect(summary.totalTokensIn).toBe(300);
    expect(summary.totalTokensOut).toBe(150);
    expect(summary.stepCount).toBe(2);
  });
});

describe('TracePanel: renderTraceTimelineText', () => {
  it('空数组返回提示文本', () => {
    const text = renderTraceTimelineText([]);
    expect(text).toBe('未找到该会话的 Trace 数据');
  });

  it('非空数组包含标题、条目和汇总行', () => {
    const entries = parseTimelineEntries([
      makeSpan({ durationMs: 100, payload: { type: 'llm_call', modelId: 'gpt-4o', inputTokens: 100, outputTokens: 50, responseLength: 10, toolCallCount: 0 } }),
    ]);
    const text = renderTraceTimelineText(entries, 'sess-1');
    expect(text).toContain('Trace: sess-1');
    expect(text).toContain('LLM Call (gpt-4o)');
    expect(text).toContain('Total:');
    expect(text).toContain('Steps: 1');
  });

  it('L1 仅显示总耗时和步骤数', () => {
    const entries = parseTimelineEntries([
      makeSpan({ durationMs: 100, payload: { type: 'llm_call', modelId: 'gpt-4o', inputTokens: 100, outputTokens: 50, responseLength: 10, toolCallCount: 0 } }),
    ]);
    const text = renderTraceTimelineText(entries, 'sess-1', 1);
    expect(text).toContain('Total:');
    expect(text).toContain('Steps: 1');
    expect(text).not.toContain('Trace: sess-1');
    expect(text).not.toContain('LLM Call');
  });

  it('L2 显示条目但不显示条形图和元数据', () => {
    const entries = parseTimelineEntries([
      makeSpan({ durationMs: 100, payload: { type: 'llm_call', modelId: 'gpt-4o', inputTokens: 100, outputTokens: 50, responseLength: 10, toolCallCount: 0 } }),
    ]);
    const text = renderTraceTimelineText(entries, 'sess-1', 2);
    expect(text).toContain('LLM Call (gpt-4o)');
    expect(text).not.toContain('    █');
    expect(text).not.toContain('tokens:');
  });

  it('L3 显示条形图和 token 元数据', () => {
    const entries = parseTimelineEntries([
      makeSpan({ durationMs: 100, payload: { type: 'llm_call', modelId: 'gpt-4o', inputTokens: 100, outputTokens: 50, responseLength: 10, toolCallCount: 0 } }),
    ]);
    const text = renderTraceTimelineText(entries, 'sess-1', 3);
    expect(text).toContain('LLM Call (gpt-4o)');
    expect(text).toContain('█');
    expect(text).toContain('tokens: 100→50');
  });
});

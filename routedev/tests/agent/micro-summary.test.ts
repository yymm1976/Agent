// tests/agent/micro-summary.test.ts
// Phase 34 Task 2：微摘要系统测试

import { describe, it, expect } from 'vitest';
import { generateMicroSummary, extractDecisions } from '../../src/agent/micro-summary.js';
import type { TraceSpan, TrajectorySummary } from '../../src/harness/trace-types.js';

function makeToolSpan(toolName: string, args: Record<string, unknown>, result: string, isError = false): TraceSpan {
  return {
    id: 1,
    sessionId: 's1',
    type: 'tool_call',
    startTime: Date.now(),
    status: isError ? 'error' : 'completed',
    payload: {
      type: 'tool_call',
      toolName,
      toolCallId: 'c1',
      args,
      result,
      isError,
    },
  };
}

function makeLLMSpan(modelId: string, inputTokens: number, outputTokens: number): TraceSpan {
  return {
    id: 2,
    sessionId: 's1',
    type: 'llm_call',
    startTime: Date.now(),
    status: 'completed',
    payload: {
      type: 'llm_call',
      modelId,
      inputTokens,
      outputTokens,
      responseLength: 10,
      toolCallCount: 0,
    },
  };
}

const baseTrajectory: TrajectorySummary = {
  taskId: 't1',
  totalInputTokens: 100,
  totalOutputTokens: 50,
  totalTokens: 150,
  totalCost: 0.0001,
  toolCallCount: 1,
  llmCallCount: 1,
  retryCount: 0,
  firstAttemptSuccessRate: 1,
  durationMs: 2000,
  success: true,
  terminationReason: 'completed',
};

describe('extractDecisions', () => {
  it('从 <decision> 标签提取决策', () => {
    const content = '开头<decision>采用接口隔离原则</decision>结尾';
    expect(extractDecisions(content)).toEqual(['采用接口隔离原则']);
  });

  it('提取多条决策并截断过长内容', () => {
    const longDecision = 'a'.repeat(200);
    const content = `<decision>${longDecision}</decision>`;
    const result = extractDecisions(content);
    expect(result.length).toBe(1);
    expect(result[0].length).toBe(123);
    expect(result[0].endsWith('...')).toBe(true);
  });

  it('无标签时返回空数组', () => {
    expect(extractDecisions('普通回复内容')).toEqual([]);
  });
});

describe('generateMicroSummary', () => {
  it('成功状态生成正确标题与步骤数', () => {
    const summary = generateMicroSummary(
      '帮我修复登录接口 bug',
      '已完成修复<decision>采用 Token 刷新机制</decision>',
      [makeToolSpan('file_read', { path: 'auth.ts' }, 'ok'), makeLLMSpan('gpt-4', 100, 50)],
      baseTrajectory,
      'success',
    );
    expect(summary.status).toBe('success');
    expect(summary.title).toBe('帮我修复登录接口 bug');
    expect(summary.stepCount).toBe(2);
    expect(summary.keyDecisions).toContain('采用 Token 刷新机制');
  });

  it('用户输入超过 60 字符时截断标题', () => {
    const longInput = 'a'.repeat(100);
    const summary = generateMicroSummary(longInput, 'done', [], null, 'success');
    expect(summary.title.length).toBe(60);
  });

  it('失败状态保留 failure 并生成默认标题', () => {
    const summary = generateMicroSummary('', '出错了', [], null, 'failure');
    expect(summary.status).toBe('failure');
    expect(summary.title).toBe('任务');
    expect(summary.keyDecisions).toEqual([]);
  });

  it('无 trajectory 时从 spans 统计步骤数', () => {
    const spans: TraceSpan[] = [
      makeToolSpan('file_read', { path: 'x.ts' }, 'ok'),
      makeToolSpan('file_write', { path: 'x.ts' }, '+10 / -2'),
      makeLLMSpan('gpt-4', 50, 20),
    ];
    const summary = generateMicroSummary('统计测试', 'done', spans, null, 'success');
    expect(summary.stepCount).toBe(3);
  });

  it('从 file_edit 结果估算文件变更', () => {
    const spans: TraceSpan[] = [
      makeToolSpan('file_edit', { path: 'utils.ts' }, '+5 / -3'),
    ];
    const summary = generateMicroSummary('编辑文件', 'done', spans, null, 'success');
    expect(summary.fileChanges).toHaveLength(1);
    expect(summary.fileChanges[0]).toEqual({ path: 'utils.ts', added: 5, removed: 3 });
  });

  it('从 file_write 结果估算 added/removed', () => {
    const spans: TraceSpan[] = [
      makeToolSpan('file_write', { path: 'new.ts' }, 'added 8 removed 2'),
    ];
    const summary = generateMicroSummary('新建文件', 'done', spans, null, 'success');
    expect(summary.fileChanges[0]).toEqual({ path: 'new.ts', added: 8, removed: 2 });
  });

  it('无变更结果时文件变更列表为空', () => {
    const spans: TraceSpan[] = [makeToolSpan('file_read', { path: 'x.ts' }, 'content')];
    const summary = generateMicroSummary('读取文件', 'done', spans, null, 'success');
    expect(summary.fileChanges).toEqual([]);
  });

  it('未使用 decision 标签时降级提取关键词句子', () => {
    const content = '我分析了代码，决定使用新的错误处理方案。后续可以继续优化。';
    const summary = generateMicroSummary('优化代码', content, [], null, 'success');
    expect(summary.keyDecisions.length).toBeGreaterThan(0);
    expect(summary.keyDecisions[0]).toContain('决定');
  });

  it('paused 状态保留并返回 trajectory', () => {
    const summary = generateMicroSummary('暂停任务', 'paused', [], baseTrajectory, 'paused');
    expect(summary.status).toBe('paused');
    expect(summary.trajectory).toBe(baseTrajectory);
    expect(summary.durationMs).toBe(2000);
  });

  it('多个文件变更合并统计', () => {
    const spans: TraceSpan[] = [
      makeToolSpan('file_edit', { path: 'a.ts' }, '+2 / -1'),
      makeToolSpan('file_edit', { path: 'a.ts' }, '+3 / -0'),
      makeToolSpan('file_edit', { path: 'b.ts' }, '+1 / -1'),
    ];
    const summary = generateMicroSummary('多处编辑', 'done', spans, null, 'success');
    expect(summary.fileChanges).toHaveLength(2);
    const aChange = summary.fileChanges.find(c => c.path === 'a.ts');
    expect(aChange?.added).toBe(5);
    expect(aChange?.removed).toBe(1);
  });
});

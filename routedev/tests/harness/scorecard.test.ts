// tests/harness/scorecard.test.ts
// generateScorecard 单元测试——覆盖 4 项阈值检查 / verdict 三级判定 / qualitySignals 聚合 / totalUsage 覆盖

import { describe, it, expect, vi } from 'vitest';
import { generateScorecard } from '../../src/harness/scorecard.js';
import type { TraceSession, TraceSpan, TraceSpanPayload } from '../../src/harness/trace-types.js';
import type { TraceCollector } from '../../src/harness/trace-collector.js';

// ============================================================
// 辅助工厂
// ============================================================

/** 创建 mock TraceCollector */
function makeMockCollector(session: TraceSession | null, spans: TraceSpan[]): TraceCollector {
  return {
    readSession: vi.fn().mockResolvedValue(session),
    readSessionSpans: vi.fn().mockResolvedValue(spans),
  } as unknown as TraceCollector;
}

/** 构造一个基础 TraceSession */
function makeSession(overrides: Partial<TraceSession> = {}): TraceSession {
  return {
    id: 's1',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    userInput: 'test',
    spanCount: 0,
    completed: true,
    ...overrides,
  };
}

/** 构造 llm_call span */
function makeLLMSpan(inputTokens: number, outputTokens: number): TraceSpan {
  return {
    id: 1,
    sessionId: 's1',
    type: 'llm_call',
    startTime: Date.now(),
    endTime: Date.now(),
    durationMs: 100,
    payload: {
      type: 'llm_call',
      modelId: 'gpt-4',
      inputTokens,
      outputTokens,
      responseLength: 100,
      toolCallCount: 0,
    },
    status: 'completed',
  };
}

/** 构造 tool_call span */
function makeToolCallSpan(
  isError = false,
  status: TraceSpan['status'] = 'completed',
  toolName = 'file_read',
): TraceSpan {
  return {
    id: 2,
    sessionId: 's1',
    type: 'tool_call',
    startTime: Date.now(),
    endTime: Date.now(),
    durationMs: 50,
    payload: {
      type: 'tool_call',
      toolName,
      toolCallId: 'c1',
      isError,
    },
    status,
  };
}

/** 构造 react_iteration span（isError=true 计为一次重试） */
function makeReactIterationSpan(isError = false): TraceSpan {
  return {
    id: 3,
    sessionId: 's1',
    type: 'react_iteration',
    startTime: Date.now(),
    endTime: Date.now(),
    durationMs: 50,
    payload: {
      type: 'react_iteration',
      iteration: 1,
      observation: { result: isError ? 'failed' : 'ok', isError },
    },
    status: 'completed',
  };
}

/** 构造带 error 状态的 span（任意 type） */
function makeErrorSpan(type: TraceSpan['type'], payload: TraceSpanPayload): TraceSpan {
  return {
    id: 4,
    sessionId: 's1',
    type,
    startTime: Date.now(),
    endTime: Date.now(),
    durationMs: 50,
    payload,
    status: 'error',
    error: 'something went wrong',
  };
}

// ============================================================
// 测试
// ============================================================

describe('generateScorecard', () => {
  describe('4 项阈值检查边界', () => {
    it('首次成功率：retryCount=0 → rate=1.0 → 通过（>= 0.8）', async () => {
      const session = makeSession();
      const spans = [makeLLMSpan(100, 50)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const check = card.checks.find((c) => c.name === '首次成功率');
      expect(check!.passed).toBe(true);
      expect(check!.detail).toBe('100%');
    });

    it('首次成功率：retryCount=1 → rate=0.5 → 不通过（< 0.8）', async () => {
      const session = makeSession();
      const spans = [makeReactIterationSpan(true)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const check = card.checks.find((c) => c.name === '首次成功率');
      expect(check!.passed).toBe(false);
      expect(check!.detail).toBe('50%');
    });

    it('重试次数：retryCount=2 → 通过（<= 2）', async () => {
      const session = makeSession();
      const spans = [makeReactIterationSpan(true), makeReactIterationSpan(true)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const check = card.checks.find((c) => c.name === '重试次数');
      expect(check!.passed).toBe(true);
      expect(check!.detail).toBe('2 次');
    });

    it('重试次数：retryCount=3 → 不通过（> 2）', async () => {
      const session = makeSession();
      const spans = [
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
      ];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const check = card.checks.find((c) => c.name === '重试次数');
      expect(check!.passed).toBe(false);
      expect(check!.detail).toBe('3 次');
    });

    it('执行成功：无错误 → 通过', async () => {
      const session = makeSession();
      const spans = [makeLLMSpan(100, 50)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const check = card.checks.find((c) => c.name === '执行成功');
      expect(check!.passed).toBe(true);
      expect(check!.detail).toBe('成功');
    });

    it('执行成功：tool_call isError → 不通过', async () => {
      const session = makeSession();
      const spans = [makeToolCallSpan(true)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const check = card.checks.find((c) => c.name === '执行成功');
      expect(check!.passed).toBe(false);
      expect(check!.detail).toBe('失败');
    });

    it('执行成功：tool_call status=error → 不通过', async () => {
      const session = makeSession();
      const spans = [makeToolCallSpan(false, 'error')];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const check = card.checks.find((c) => c.name === '执行成功');
      expect(check!.passed).toBe(false);
    });

    it('Token 使用：totalTokens=100000 → 通过（<= 100000）', async () => {
      const session = makeSession({
        totalUsage: { inputTokens: 60000, outputTokens: 40000, totalTokens: 100000 },
      });
      const card = await generateScorecard(makeMockCollector(session, []), 's1');
      const check = card.checks.find((c) => c.name === 'Token 使用');
      expect(check!.passed).toBe(true);
      expect(check!.detail).toBe('100000 tokens');
    });

    it('Token 使用：totalTokens=100001 → 不通过（> 100000）', async () => {
      const session = makeSession({
        totalUsage: { inputTokens: 60000, outputTokens: 40001, totalTokens: 100001 },
      });
      const card = await generateScorecard(makeMockCollector(session, []), 's1');
      const check = card.checks.find((c) => c.name === 'Token 使用');
      expect(check!.passed).toBe(false);
    });

    it('checks 列表恰好包含 4 项', async () => {
      const card = await generateScorecard(makeMockCollector(makeSession(), []), 's1');
      expect(card.checks).toHaveLength(4);
      const names = card.checks.map((c) => c.name);
      expect(names).toEqual(['首次成功率', '重试次数', '执行成功', 'Token 使用']);
    });
  });

  describe('verdict 三级判定', () => {
    it('pass：成功 + 无高质量信号 + 重试<=2 + 无中等信号', async () => {
      const session = makeSession();
      const spans = [makeLLMSpan(100, 50)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      expect(card.verdict).toBe('pass');
    });

    it('advisory：成功 + 无高质量信号 + 重试>2', async () => {
      const session = makeSession();
      const spans = [
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
      ];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      expect(card.verdict).toBe('advisory');
    });

    it('fail：执行不成功（tool_call isError）', async () => {
      const session = makeSession();
      const spans = [makeToolCallSpan(true)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      expect(card.verdict).toBe('fail');
    });

    it('fail：存在 high 质量信号（span status=error）', async () => {
      const session = makeSession();
      // llm_call span 带 error 状态 → high 信号 → fail
      // 注意：llm_call error 不影响 hasError（hasError 仅由 tool_call 设置）
      // 但 high 信号本身就会导致 verdict=fail
      const errorSpan = makeErrorSpan('llm_call', {
        type: 'llm_call',
        modelId: 'gpt-4',
        inputTokens: 10,
        outputTokens: 20,
        responseLength: 100,
        toolCallCount: 0,
      });
      const card = await generateScorecard(makeMockCollector(session, [errorSpan]), 's1');
      expect(card.verdict).toBe('fail');
    });

    it('advisory 优先于 pass：成功 + 重试>2 + 无高质量信号', async () => {
      const session = makeSession();
      const spans = [
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
        makeLLMSpan(100, 50),
      ];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      // 成功 + 重试>2 → advisory（不是 pass）
      expect(card.verdict).toBe('advisory');
    });

    it('fail 优先于 advisory：不成功 + 重试>2', async () => {
      const session = makeSession();
      const spans = [
        makeToolCallSpan(true), // hasError → success=false
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
        makeReactIterationSpan(true),
      ];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      // !success → fail（优先于 advisory）
      expect(card.verdict).toBe('fail');
    });
  });

  describe('qualitySignals 聚合', () => {
    it('span status=error → high 信号', async () => {
      const session = makeSession();
      const errorSpan = makeErrorSpan('llm_call', {
        type: 'llm_call',
        modelId: 'gpt-4',
        inputTokens: 10,
        outputTokens: 20,
        responseLength: 100,
        toolCallCount: 0,
      });
      const card = await generateScorecard(makeMockCollector(session, [errorSpan]), 's1');
      expect(card.qualitySignals).toHaveLength(1);
      expect(card.qualitySignals[0].type).toBe('llm_call_error');
      expect(card.qualitySignals[0].severity).toBe('high');
      expect(card.qualitySignals[0].count).toBe(1);
    });

    it('tool_call isError → medium 信号', async () => {
      const session = makeSession();
      const spans = [makeToolCallSpan(true)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      const mediumSignal = card.qualitySignals.find((s) => s.severity === 'medium');
      expect(mediumSignal).toBeDefined();
      expect(mediumSignal!.type).toBe('tool_call_failed');
      expect(mediumSignal!.count).toBe(1);
    });

    it('同类型 error span 计数递增', async () => {
      const session = makeSession();
      const errorSpan1 = makeErrorSpan('llm_call', {
        type: 'llm_call',
        modelId: 'gpt-4',
        inputTokens: 10,
        outputTokens: 20,
        responseLength: 100,
        toolCallCount: 0,
      });
      const errorSpan2 = makeErrorSpan('llm_call', {
        type: 'llm_call',
        modelId: 'gpt-4',
        inputTokens: 10,
        outputTokens: 20,
        responseLength: 100,
        toolCallCount: 0,
      });
      const card = await generateScorecard(makeMockCollector(session, [errorSpan1, errorSpan2]), 's1');
      const highSignal = card.qualitySignals.find((s) => s.severity === 'high');
      expect(highSignal).toBeDefined();
      expect(highSignal!.count).toBe(2);
    });

    it('不同类型 error span 分别聚合', async () => {
      const session = makeSession();
      const llmError = makeErrorSpan('llm_call', {
        type: 'llm_call',
        modelId: 'gpt-4',
        inputTokens: 10,
        outputTokens: 20,
        responseLength: 100,
        toolCallCount: 0,
      });
      const toolError = makeErrorSpan('tool_call', {
        type: 'tool_call',
        toolName: 'file_read',
        toolCallId: 'c1',
      });
      const card = await generateScorecard(makeMockCollector(session, [llmError, toolError]), 's1');
      expect(card.qualitySignals).toHaveLength(2);
      const types = card.qualitySignals.map((s) => s.type).sort();
      expect(types).toEqual(['llm_call_error', 'tool_call_error']);
    });

    it('无异常 span → 空 qualitySignals', async () => {
      const session = makeSession();
      const spans = [makeLLMSpan(100, 50)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      expect(card.qualitySignals).toEqual([]);
    });
  });

  describe('session.totalUsage 覆盖 spans 统计', () => {
    it('session.totalUsage 覆盖 spans 中的 token 统计', async () => {
      const session = makeSession({
        totalUsage: { inputTokens: 9999, outputTokens: 8888, totalTokens: 18887 },
      });
      // spans 中的 token 与 session.totalUsage 不同
      const spans = [makeLLMSpan(100, 50)]; // spans 总计 150
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      expect(card.summary.totalInputTokens).toBe(9999);
      expect(card.summary.totalOutputTokens).toBe(8888);
      expect(card.summary.totalTokens).toBe(18887);
    });

    it('无 session.totalUsage 时使用 spans 统计', async () => {
      const session = makeSession(); // 无 totalUsage
      const spans = [makeLLMSpan(100, 50)]; // 总计 150
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      expect(card.summary.totalInputTokens).toBe(100);
      expect(card.summary.totalOutputTokens).toBe(50);
      expect(card.summary.totalTokens).toBe(150);
    });

    it('session 为 null 时仍可计算（token 来自 spans）', async () => {
      const spans = [makeLLMSpan(200, 100)];
      const card = await generateScorecard(makeMockCollector(null, spans), 's1');
      expect(card.summary.totalInputTokens).toBe(200);
      expect(card.summary.totalOutputTokens).toBe(100);
      expect(card.summary.totalTokens).toBe(300);
    });

    it('session.totalUsage 部分字段缺失时回退到 spans 统计', async () => {
      const session = makeSession({
        totalUsage: { inputTokens: 9999 }, // 无 outputTokens 和 totalTokens
      });
      const spans = [makeLLMSpan(100, 50)];
      const card = await generateScorecard(makeMockCollector(session, spans), 's1');
      // inputTokens 被覆盖
      expect(card.summary.totalInputTokens).toBe(9999);
      // outputTokens 回退到 spans 统计
      expect(card.summary.totalOutputTokens).toBe(50);
      // totalTokens 回退到 spans 统计
      expect(card.summary.totalTokens).toBe(150);
    });
  });

  describe('Scorecard 基本字段', () => {
    it('包含 sessionId 和 generatedAt', async () => {
      const card = await generateScorecard(makeMockCollector(makeSession(), []), 's1');
      expect(card.sessionId).toBe('s1');
      expect(card.generatedAt).toBeDefined();
      expect(new Date(card.generatedAt).getTime()).not.toBeNaN();
    });

    it('session 有 goalId 时写入 card.goalId', async () => {
      const session = makeSession({ goalId: 'goal-123' });
      const card = await generateScorecard(makeMockCollector(session, []), 's1');
      expect(card.goalId).toBe('goal-123');
    });

    it('session 无 goalId 时 card.goalId 为 undefined', async () => {
      const card = await generateScorecard(makeMockCollector(makeSession(), []), 's1');
      expect(card.goalId).toBeUndefined();
    });

    it('summary.taskId 等于 sessionId', async () => {
      const card = await generateScorecard(makeMockCollector(makeSession(), []), 's1');
      expect(card.summary.taskId).toBe('s1');
    });
  });
});

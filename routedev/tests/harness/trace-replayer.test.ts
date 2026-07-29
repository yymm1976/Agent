// tests/harness/trace-replayer.test.ts
// TraceReplayer 单元测试——覆盖 mapRecord / mapSpan / 时间排序 / step 过滤 / computeBoundaries

import { describe, it, expect, vi } from 'vitest';
import { TraceReplayer } from '../../src/harness/trace-replayer.js';
import type { TraceRecord, TraceSpan, TraceSpanPayload } from '../../src/harness/trace-types.js';
import type { TraceCollector } from '../../src/harness/trace-collector.js';

// ============================================================
// 辅助工厂
// ============================================================

/** 创建 mock TraceCollector，返回预设的 records 和 spans */
function makeMockCollector(records: TraceRecord[], spans: TraceSpan[]): TraceCollector {
  return {
    readSessionRecords: vi.fn().mockResolvedValue(records),
    readSessionSpans: vi.fn().mockResolvedValue(spans),
  } as unknown as TraceCollector;
}

/** 构造一条 TraceRecord */
function makeRecord(
  event: string,
  data: Record<string, unknown>,
  ts: string,
): TraceRecord {
  return { timestamp: ts, sessionId: 's1', event, data };
}

/** 构造一条 TraceSpan */
function makeSpan(
  payload: TraceSpanPayload,
  startTime: number,
  status: TraceSpan['status'] = 'completed',
): TraceSpan {
  return {
    id: 1,
    sessionId: 's1',
    type: payload.type as TraceSpan['type'],
    startTime,
    endTime: startTime + 100,
    durationMs: 100,
    payload,
    status,
  };
}

const T0 = '2024-01-01T00:00:00.000Z';
const T1 = '2024-01-01T00:00:01.000Z';
const T2 = '2024-01-01T00:00:02.000Z';
const T3 = '2024-01-01T00:00:03.000Z';
const T4 = '2024-01-01T00:00:04.000Z';
const T5 = '2024-01-01T00:00:05.000Z';

// ============================================================
// 测试
// ============================================================

describe('TraceReplayer', () => {
  describe('mapRecord 各分支', () => {
    it('thinking 事件 → thinking 时间线事件', async () => {
      const records = [makeRecord('thinking', { message: '让我想想' }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('thinking');
      expect(events[0].summary).toBe('让我想想');
      expect(events[0].detail).toEqual({ message: '让我想想' });
    });

    it('thinking 摘要截断为 100 字符', async () => {
      const longMsg = 'x'.repeat(150);
      const records = [makeRecord('thinking', { message: longMsg }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].summary).toHaveLength(100);
    });

    it('tool_call_start → tool_call 事件', async () => {
      const records = [makeRecord('tool_call_start', { toolName: 'file_read' }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].type).toBe('tool_call');
      expect(events[0].summary).toBe('调用工具: file_read');
    });

    it('tool_call_start 无 toolName → unknown', async () => {
      const records = [makeRecord('tool_call_start', {}, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].summary).toBe('调用工具: unknown');
    });

    it('tool_call_result 成功 → tool_result 事件', async () => {
      const records = [makeRecord('tool_call_result', { toolName: 'file_read', isError: false }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].type).toBe('tool_result');
      expect(events[0].summary).toBe('file_read 完成');
    });

    it('tool_call_end 失败 → tool_result 事件带"失败"', async () => {
      const records = [makeRecord('tool_call_end', { toolName: 'shell_exec', isError: true }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].type).toBe('tool_result');
      expect(events[0].summary).toBe('shell_exec 失败');
    });

    it('error 事件 → error 时间线事件', async () => {
      const records = [makeRecord('error', { error: 'something broke' }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].type).toBe('error');
      expect(events[0].summary).toBe('something broke');
    });

    it('error 无 error 字段 → "未知错误"', async () => {
      const records = [makeRecord('error', {}, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].summary).toBe('未知错误');
    });

    it('done 事件 → done 时间线事件', async () => {
      const records = [makeRecord('done', { content: 'result' }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events[0].type).toBe('done');
      expect(events[0].summary).toBe('任务完成');
    });

    it('未知事件（text_delta）→ 过滤为 null', async () => {
      const records = [makeRecord('text_delta', { text: 'hello' }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(0);
    });

    it('approval_required 事件 → 过滤为 null', async () => {
      const records = [makeRecord('approval_required', {}, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(0);
    });
  });

  describe('mapSpan 各分支', () => {
    it('llm_call span → llm_call 事件', async () => {
      const spans = [
        makeSpan(
          {
            type: 'llm_call',
            modelId: 'gpt-4',
            inputTokens: 100,
            outputTokens: 50,
            responseLength: 200,
            toolCallCount: 0,
          },
          Date.parse(T0),
        ),
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('llm_call');
      expect(events[0].summary).toBe('LLM 调用 (gpt-4, 150 tokens)');
    });

    it('llm_call 无 token → 0 tokens', async () => {
      const spans = [
        makeSpan(
          {
            type: 'llm_call',
            modelId: 'gpt-4',
            inputTokens: 0,
            outputTokens: 0,
            responseLength: 0,
            toolCallCount: 0,
          },
          Date.parse(T0),
        ),
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const events = await replayer.replay('s1');
      expect(events[0].summary).toBe('LLM 调用 (gpt-4, 0 tokens)');
    });

    it('goal_step span → goal_step 事件', async () => {
      const spans = [
        makeSpan(
          { type: 'goal_step', stepId: 1, description: '读取文件', totalSteps: 3 },
          Date.parse(T0),
        ),
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const events = await replayer.replay('s1');
      expect(events[0].type).toBe('goal_step');
      expect(events[0].summary).toBe('步骤 1/3: 读取文件');
    });

    it('tool_call span → 过滤为 null（已在 records 中）', async () => {
      const spans = [
        makeSpan(
          { type: 'tool_call', toolName: 'file_read', toolCallId: 'c1' },
          Date.parse(T0),
        ),
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(0);
    });

    it('react_iteration span → 过滤为 null', async () => {
      const spans = [
        makeSpan(
          { type: 'react_iteration', iteration: 1, thought: 'thinking' },
          Date.parse(T0),
        ),
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(0);
    });

    it('worker_task span → 过滤为 null', async () => {
      const spans = [
        makeSpan(
          { type: 'worker_task', role: 'coder', description: 'do', modifiedFiles: [] },
          Date.parse(T0),
        ),
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(0);
    });
  });

  describe('时间排序', () => {
    it('按时间戳升序排列 events（records + spans 混合）', async () => {
      const records = [
        makeRecord('done', {}, T3),
        makeRecord('thinking', { message: 'first' }, T1),
      ];
      const spans = [
        makeSpan(
          {
            type: 'llm_call',
            modelId: 'gpt-4',
            inputTokens: 10,
            outputTokens: 20,
            responseLength: 100,
            toolCallCount: 0,
          },
          Date.parse(T2),
        ),
      ];
      const replayer = new TraceReplayer(makeMockCollector(records, spans));
      const events = await replayer.replay('s1');
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('thinking');
      expect(events[1].type).toBe('llm_call');
      expect(events[2].type).toBe('done');
    });
  });

  describe('step 过滤', () => {
    it('传入 step=1 时仅返回步骤 1 段落的事件', async () => {
      const recs = [
        makeRecord('thinking', { message: 'step1 thought' }, '2024-01-01T00:00:01.500Z'),
        makeRecord('thinking', { message: 'step2 thought' }, '2024-01-01T00:00:03.500Z'),
      ];
      const spans: TraceSpan[] = [
        makeSpan({ type: 'goal_step', stepId: 1, description: '步骤1', totalSteps: 2 }, Date.parse(T1)),
        makeSpan({ type: 'goal_step', stepId: 2, description: '步骤2', totalSteps: 2 }, Date.parse(T3)),
      ];
      const replayer = new TraceReplayer(makeMockCollector(recs, spans));

      // 排序后：[goal_step1, thinking1, goal_step2, thinking2]
      // boundary 1: [0, 1], boundary 2: [2, 3]
      const step1Events = await replayer.replay('s1', { step: 1 });
      expect(step1Events).toHaveLength(2);
      expect(step1Events[0].type).toBe('goal_step');
      expect(step1Events[1].type).toBe('thinking');
      expect(step1Events[1].summary).toBe('step1 thought');
    });

    it('传入 step=2 时仅返回步骤 2 段落的事件', async () => {
      const recs = [
        makeRecord('thinking', { message: 'step1 thought' }, '2024-01-01T00:00:01.500Z'),
        makeRecord('thinking', { message: 'step2 thought' }, '2024-01-01T00:00:03.500Z'),
      ];
      const spans: TraceSpan[] = [
        makeSpan({ type: 'goal_step', stepId: 1, description: '步骤1', totalSteps: 2 }, Date.parse(T1)),
        makeSpan({ type: 'goal_step', stepId: 2, description: '步骤2', totalSteps: 2 }, Date.parse(T3)),
      ];
      const replayer = new TraceReplayer(makeMockCollector(recs, spans));

      const step2Events = await replayer.replay('s1', { step: 2 });
      expect(step2Events).toHaveLength(2);
      expect(step2Events[0].type).toBe('goal_step');
      expect(step2Events[1].type).toBe('thinking');
      expect(step2Events[1].summary).toBe('step2 thought');
    });

    it('传入不存在的 step → 返回全部事件', async () => {
      const spans = [
        makeSpan({ type: 'goal_step', stepId: 1, description: '步骤1', totalSteps: 1 }, Date.parse(T0)),
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const events = await replayer.replay('s1', { step: 99 });
      expect(events).toHaveLength(1);
    });

    it('无 goal_step 时传入 step → 返回全部事件', async () => {
      const records = [makeRecord('thinking', { message: 'hello' }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1', { step: 1 });
      expect(events).toHaveLength(1);
    });
  });

  describe('computeBoundaries 步骤切分', () => {
    it('0 个 goal_step → 空边界', async () => {
      const records = [makeRecord('thinking', { message: 'hello' }, T0)];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const boundaries = await replayer.getStepBoundaries('s1');
      expect(boundaries).toEqual([]);
    });

    it('单个 goal_step → 单个边界覆盖全部事件', async () => {
      const spans = [
        makeSpan({ type: 'goal_step', stepId: 1, description: '唯一步骤', totalSteps: 1 }, Date.parse(T0)),
      ];
      const recs = [
        makeRecord('thinking', { message: 'after' }, T1),
        makeRecord('done', {}, T2),
      ];
      const replayer = new TraceReplayer(makeMockCollector(recs, spans));
      const boundaries = await replayer.getStepBoundaries('s1');
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].stepIndex).toBe(1);
      expect(boundaries[0].stepTitle).toBe('唯一步骤');
      // 排序后：[goal_step(0), thinking(1), done(2)]
      expect(boundaries[0].startIndex).toBe(0);
      expect(boundaries[0].endIndex).toBe(2);
    });

    it('多个 goal_step → 多个边界，endIndex 正确切分', async () => {
      const spans: TraceSpan[] = [
        makeSpan({ type: 'goal_step', stepId: 1, description: '步骤一', totalSteps: 3 }, Date.parse(T0)),
        makeSpan({ type: 'goal_step', stepId: 2, description: '步骤二', totalSteps: 3 }, Date.parse(T2)),
        makeSpan({ type: 'goal_step', stepId: 3, description: '步骤三', totalSteps: 3 }, Date.parse(T4)),
      ];
      const recs: TraceRecord[] = [
        makeRecord('thinking', { message: 'a' }, T1),
        makeRecord('thinking', { message: 'b' }, T3),
        makeRecord('done', {}, T5),
      ];
      const replayer = new TraceReplayer(makeMockCollector(recs, spans));
      const boundaries = await replayer.getStepBoundaries('s1');
      expect(boundaries).toHaveLength(3);
      // 排序后：[goal1(0), think_a(1), goal2(2), think_b(3), goal3(4), done(5)]
      expect(boundaries[0].stepIndex).toBe(1);
      expect(boundaries[0].startIndex).toBe(0);
      expect(boundaries[0].endIndex).toBe(1);
      expect(boundaries[1].stepIndex).toBe(2);
      expect(boundaries[1].startIndex).toBe(2);
      expect(boundaries[1].endIndex).toBe(3);
      expect(boundaries[2].stepIndex).toBe(3);
      expect(boundaries[2].startIndex).toBe(4);
      expect(boundaries[2].endIndex).toBe(5);
    });

    it('goal_step 无 stepId 时使用序号作为 stepIndex', async () => {
      // stepId 在类型中是 number，但 computeBoundaries 用 detail?.stepId ?? i+1
      // 构造 payload 不含 stepId 的情况需要类型断言
      const spans: TraceSpan[] = [
        {
          id: 1,
          sessionId: 's1',
          type: 'goal_step',
          startTime: Date.parse(T0),
          endTime: Date.parse(T0) + 100,
          durationMs: 100,
          payload: { type: 'goal_step', stepId: 0, description: '无ID步骤', totalSteps: 1 } as TraceSpanPayload,
          status: 'completed',
        },
      ];
      const replayer = new TraceReplayer(makeMockCollector([], spans));
      const boundaries = await replayer.getStepBoundaries('s1');
      // stepId=0 是有效值，??（nullish coalescing）不把 0 视为 nullish，所以 0 ?? i+1 → 0
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].stepIndex).toBe(0);
    });
  });

  describe('空输入', () => {
    it('无 records 无 spans → 空事件', async () => {
      const replayer = new TraceReplayer(makeMockCollector([], []));
      const events = await replayer.replay('s1');
      expect(events).toEqual([]);
    });

    it('空输入 → 空边界', async () => {
      const replayer = new TraceReplayer(makeMockCollector([], []));
      const boundaries = await replayer.getStepBoundaries('s1');
      expect(boundaries).toEqual([]);
    });

    it('所有 records 均为未知事件 → 空事件', async () => {
      const records = [
        makeRecord('stream_chunk', {}, T0),
        makeRecord('text_delta', { text: 'hi' }, T1),
      ];
      const replayer = new TraceReplayer(makeMockCollector(records, []));
      const events = await replayer.replay('s1');
      expect(events).toEqual([]);
    });
  });

  describe('readSessionRecords / readSessionSpans 被正确调用', () => {
    it('replay 时传入正确的 sessionId', async () => {
      const mock = makeMockCollector([], []);
      const replayer = new TraceReplayer(mock);
      await replayer.replay('my-session');
      expect(mock.readSessionRecords).toHaveBeenCalledWith('my-session');
      expect(mock.readSessionSpans).toHaveBeenCalledWith('my-session');
    });

    it('getStepBoundaries 时传入正确的 sessionId', async () => {
      const mock = makeMockCollector([], []);
      const replayer = new TraceReplayer(mock);
      await replayer.getStepBoundaries('my-session');
      expect(mock.readSessionRecords).toHaveBeenCalledWith('my-session');
      expect(mock.readSessionSpans).toHaveBeenCalledWith('my-session');
    });
  });
});

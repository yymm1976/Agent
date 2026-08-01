// tests/harness/event-types.test.ts
// Phase 97 Part A：EngineEventV1 事件协议单元测试
//
// 覆盖验收标准：
//   1. SequenceCounter 同一 turn 内 sequence 单调递增
//   2. 生命周期事件类型可被判别并携带公共字段

import { describe, it, expect } from 'vitest';
import { SequenceCounter, type EngineEventV1 } from '../../src/harness/event-types.js';

describe('event-types（EngineEventV1 统一事件协议）', () => {
  describe('SequenceCounter 单调递增', () => {
    it('连续 next() 返回严格递增序号', () => {
      const seq = new SequenceCounter();
      const a = seq.next();
      const b = seq.next();
      const c = seq.next();
      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(c).toBe(3);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
    });

    it('新实例从 1 重新开始', () => {
      const seq = new SequenceCounter();
      expect(seq.next()).toBe(1);
      const seq2 = new SequenceCounter();
      expect(seq2.next()).toBe(1);
    });
  });

  describe('EngineEventV1 类型判别', () => {
    it('turn 生命周期事件携带 turnId 与 sequence', () => {
      const e: EngineEventV1 = {
        id: 'sess-1-1-x',
        sessionId: 'sess-1',
        sequence: 1,
        timestamp: 1000,
        type: 'turn_start',
        turnId: 'turn-1',
        payload: { input: '你好' },
      };
      expect(e.type).toBe('turn_start');
      if (e.type === 'turn_start') {
        expect(e.payload.input).toBe('你好');
        expect(e.turnId).toBe('turn-1');
      }
    });

    it('agent_end 事件携带结束原因', () => {
      const e: EngineEventV1 = {
        id: 'sess-1-9-x',
        sessionId: 'sess-1',
        sequence: 9,
        timestamp: 2000,
        type: 'agent_end',
        payload: { reason: 'completed' },
      };
      if (e.type === 'agent_end') {
        expect(e.payload.reason).toBe('completed');
      }
    });

    it('tool_end 事件携带工具名与错误标志', () => {
      const e: EngineEventV1 = {
        id: 'sess-1-5-x',
        sessionId: 'sess-1',
        sequence: 5,
        timestamp: 1500,
        type: 'tool_end',
        turnId: 'turn-1',
        payload: { toolName: 'file_write', toolCallId: 'call-1', isError: false },
      };
      if (e.type === 'tool_end') {
        expect(e.payload.toolName).toBe('file_write');
        expect(e.payload.isError).toBe(false);
      }
    });
  });
});

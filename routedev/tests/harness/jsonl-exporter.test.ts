// tests/harness/jsonl-exporter.test.ts
// B-15：EngineEventV1 → versioned JSONL 导出契约
//
// 契约：
// 1. 每行 JSON 含 schemaVersion 头与事件全部字段（平铺）
// 2. 事件流逐条转换（行数与事件数一致）
// 3. parseJsonlLine 校验 schemaVersion/必需字段；非法行返回 null
// 4. 导出→解析往返保真（sequence/turnId/payload 不变）

import { describe, it, expect } from 'vitest';
import {
  engineEventToJsonlLine,
  engineEventsToJsonl,
  parseJsonlLine,
  HEADLESS_SCHEMA_VERSION,
} from '../../src/harness/jsonl-exporter.js';
import type { EngineEventV1 } from '../../src/harness/event-types.js';

function makeEvent(overrides: Partial<EngineEventV1> = {}): EngineEventV1 {
  return {
    id: 'ev-1',
    sessionId: 'sess-1',
    sequence: 1,
    timestamp: 1234567,
    type: 'agent_start',
    payload: { kernel: 'routedev-native', model: 'test' },
    ...overrides,
  } as EngineEventV1;
}

describe('B-15 JSONL 导出', () => {
  it('单行包含 schemaVersion 头与事件全部字段（平铺）', () => {
    const line = engineEventToJsonlLine(makeEvent());
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(HEADLESS_SCHEMA_VERSION);
    expect(parsed.id).toBe('ev-1');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.sequence).toBe(1);
    expect(parsed.type).toBe('agent_start');
    expect(parsed.payload).toEqual({ kernel: 'routedev-native', model: 'test' });
  });

  it('turnId/triggerSource 可选字段随事件携带', () => {
    const event = makeEvent({
      type: 'turn_start',
      turnId: 'turn-9',
      triggerSource: 'remote',
      payload: { input: 'hi' },
    });
    const parsed = JSON.parse(engineEventToJsonlLine(event)) as Record<string, unknown>;
    expect(parsed.turnId).toBe('turn-9');
    expect(parsed.triggerSource).toBe('remote');
  });

  it('事件流逐条转换，行数 = 事件数', async () => {
    const events: EngineEventV1[] = [
      makeEvent({ sequence: 1 }),
      makeEvent({ sequence: 2, type: 'turn_start', turnId: 't1', payload: { input: 'x' } }),
      makeEvent({ sequence: 3, type: 'agent_end', payload: { reason: 'completed' } }),
    ];
    async function* source() {
      for (const e of events) yield e;
    }
    const lines: string[] = [];
    for await (const line of engineEventsToJsonl(source())) {
      lines.push(line);
    }
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.schemaVersion).toBe(HEADLESS_SCHEMA_VERSION);
      expect(typeof parsed.sequence).toBe('number');
    }
  });

  it('导出→解析往返保真', () => {
    const event = makeEvent({
      sequence: 7,
      type: 'context_compacted',
      turnId: 't-7',
      payload: { beforeTokens: 100, afterTokens: 40, stage: 2, removedMessages: 5, recoveryItems: 1, elapsedMs: 9 },
    });
    const roundtripped = parseJsonlLine(engineEventToJsonlLine(event));
    expect(roundtripped).not.toBeNull();
    expect(roundtripped!.sequence).toBe(7);
    expect(roundtripped!.turnId).toBe('t-7');
    expect(roundtripped!.type).toBe('context_compacted');
    if (roundtripped?.type === 'context_compacted') {
      expect(roundtripped.payload.beforeTokens).toBe(100);
      expect(roundtripped.payload.recoveryItems).toBe(1);
    }
  });

  it('parseJsonlLine 拒绝非法行（坏 JSON / 版本不符 / 缺字段）', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('not json')).toBeNull();
    expect(parseJsonlLine(JSON.stringify({ schemaVersion: 99, id: 'x' }))).toBeNull();
    expect(parseJsonlLine(JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, id: 'x' }))).toBeNull();
    expect(parseJsonlLine(JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, id: 'x', sessionId: 's', sequence: 1, timestamp: 1, type: 'x', payload: null }))).toBeNull();
  });
});

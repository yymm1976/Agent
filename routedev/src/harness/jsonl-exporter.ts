// src/harness/jsonl-exporter.ts
// B-15：headless JSONL——把 EngineEventV1 事件流导出为 versioned JSONL
//
// 格式（每行一个 JSON）：
//   {"schemaVersion":1,"id":"...","sessionId":"...","sequence":1,"timestamp":...,"type":"agent_start","payload":{...}}
//
// 消费方：
//   - scripts/run-headless.mjs（stdin 任务 → stdout JSONL 事件流）
//   - CI/服务自动化可逐行读取，无需依赖事件总线实现
//
// 版本语义：schemaVersion 固定为 1；字段增删属于破坏性变更，需 bump 版本。

import type { EngineEventV1 } from './event-types.js';

/** headless JSONL schema 版本（字段结构变更时递增） */
export const HEADLESS_SCHEMA_VERSION = 1;

/**
 * 单条 EngineEventV1 → JSONL 行。
 * 事件公共字段（id/sessionId/sequence/timestamp/turnId/triggerSource）与 type/payload
 * 平铺在同一对象，schemaVersion 作为版本头——不嵌套（保持行内可读性与 grep 友好）。
 */
export function engineEventToJsonlLine(event: EngineEventV1): string {
  return JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, ...event });
}

/**
 * 事件流 → JSONL 行流（逐条序列化，消费方逐行输出）。
 * 事件缺失时 yield 空（不吞异常——序列化失败应暴露给调用方）。
 */
export async function* engineEventsToJsonl(events: AsyncIterable<EngineEventV1>): AsyncGenerator<string> {
  for await (const event of events) {
    yield engineEventToJsonlLine(event);
  }
}

/**
 * 解析单条 JSONL 行（供测试与 CI 重放）。
 * 校验 schemaVersion 与必需字段；不合法返回 null。
 */
export function parseJsonlLine(line: string): EngineEventV1 | null {
  if (!line || line.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(line) as EngineEventV1 & { schemaVersion?: number };
    if (parsed.schemaVersion !== HEADLESS_SCHEMA_VERSION) return null;
    if (typeof parsed.id !== 'string' || typeof parsed.sessionId !== 'string') return null;
    if (typeof parsed.sequence !== 'number' || typeof parsed.timestamp !== 'number') return null;
    if (typeof parsed.type !== 'string' || typeof parsed.payload !== 'object' || parsed.payload === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

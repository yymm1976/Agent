// src/harness/trace-replayer.ts
// Phase 77 Task 2：运行回放引擎——把 TraceCollector 落盘的 records + spans 重建为时间线
// 借鉴 HomeRail 的 `hr replay` 命令：按时间顺序回放会话事件，支持按步骤分段

import type { TraceCollector } from './trace-collector.js';
import type { TraceRecord, TraceSpan } from './trace-types.js';

/** 时间线事件（由 TraceRecord / TraceSpan 映射而来） */
export interface TimelineEvent {
  timestamp: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'llm_call' | 'error' | 'done' | 'goal_step';
  summary: string;
  detail?: unknown;
}

/** 步骤段落（由 goal_step span 切分） */
export interface StepBoundary {
  stepIndex: number;
  stepTitle: string;
  startIndex: number;
  endIndex: number;
}

/**
 * 回放引擎：读取指定会话的 records（事件流）+ spans（结构化 span），
 * 合并为按时间排序的时间线，并按 goal_step 切分步骤段落。
 */
export class TraceReplayer {
  constructor(private traceCollector: TraceCollector) {}

  /** 回放指定会话；传入 step 时仅返回该步骤段落的事件 */
  async replay(sessionId: string, options?: { step?: number }): Promise<TimelineEvent[]> {
    const [records, spans] = await Promise.all([
      this.traceCollector.readSessionRecords(sessionId),
      this.traceCollector.readSessionSpans(sessionId),
    ]);

    const events: TimelineEvent[] = [];

    // records → 时间线事件（thinking / tool_call / tool_result / done / error）
    for (const rec of records) {
      const ev = this.mapRecord(rec);
      if (ev) events.push(ev);
    }

    // spans 中未写入 records 的事件（llm_call / goal_step 不走 writeRecord）→ 补充为时间线事件
    for (const span of spans) {
      const ev = this.mapSpan(span);
      if (ev) events.push(ev);
    }

    // 按时间戳升序排序（records 为 ISO 字符串，spans.startTime 转为 ISO 字符串）
    events.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // 按步骤过滤
    if (options?.step !== undefined) {
      const boundaries = this.computeBoundaries(events);
      const boundary = boundaries.find((b) => b.stepIndex === options.step);
      if (boundary) {
        return events.slice(boundary.startIndex, boundary.endIndex + 1);
      }
      return events;
    }

    return events;
  }

  /** 返回会话的步骤段落列表 */
  async getStepBoundaries(sessionId: string): Promise<StepBoundary[]> {
    const events = await this.replay(sessionId);
    return this.computeBoundaries(events);
  }

  // ===== 内部方法 =====

  /** 将一条 TraceRecord 映射为 TimelineEvent；不关注的事件返回 null */
  private mapRecord(rec: TraceRecord): TimelineEvent | null {
    const ts = rec.timestamp;
    const data = rec.data ?? {};
    switch (rec.event) {
      case 'thinking': {
        const msg = String(data.message ?? '');
        return { timestamp: ts, type: 'thinking', summary: msg.slice(0, 100), detail: data };
      }
      case 'tool_call_start': {
        const toolName = String(data.toolName ?? 'unknown');
        return {
          timestamp: ts,
          type: 'tool_call',
          summary: `调用工具: ${toolName}`,
          detail: data,
        };
      }
      case 'tool_call_result':
      case 'tool_call_end': {
        const isError = Boolean(data.isError);
        const toolName = String(data.toolName ?? '');
        return {
          timestamp: ts,
          type: 'tool_result',
          summary: isError ? `${toolName} 失败` : `${toolName} 完成`,
          detail: data,
        };
      }
      case 'error': {
        const err = String(data.error ?? '未知错误');
        return { timestamp: ts, type: 'error', summary: err.slice(0, 100), detail: data };
      }
      case 'done': {
        return { timestamp: ts, type: 'done', summary: '任务完成', detail: data };
      }
      default:
        // text_delta / stream_chunk / approval_required 等不进入回放时间线
        return null;
    }
  }

  /** 将一条 TraceSpan 映射为 TimelineEvent；仅处理 llm_call / goal_step（其余已在 records 中） */
  private mapSpan(span: TraceSpan): TimelineEvent | null {
    const ts = new Date(span.startTime).toISOString();
    const p = span.payload;
    if (p.type === 'llm_call') {
      const tokens = (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
      return {
        timestamp: ts,
        type: 'llm_call',
        summary: `LLM 调用 (${p.modelId}, ${tokens} tokens)`,
        detail: p,
      };
    }
    if (p.type === 'goal_step') {
      return {
        timestamp: ts,
        type: 'goal_step',
        summary: `步骤 ${p.stepId}/${p.totalSteps}: ${p.description}`,
        detail: p,
      };
    }
    return null;
  }

  /** 识别 goal_step 事件，切分为步骤段落 */
  private computeBoundaries(events: TimelineEvent[]): StepBoundary[] {
    const stepIndices: number[] = [];
    events.forEach((ev, idx) => {
      if (ev.type === 'goal_step') stepIndices.push(idx);
    });
    if (stepIndices.length === 0) return [];

    const boundaries: StepBoundary[] = [];
    for (let i = 0; i < stepIndices.length; i++) {
      const start = stepIndices[i];
      const end = i + 1 < stepIndices.length ? stepIndices[i + 1] - 1 : events.length - 1;
      const ev = events[start];
      const detail = ev.detail as { stepId?: number; description?: string } | undefined;
      boundaries.push({
        stepIndex: detail?.stepId ?? i + 1,
        stepTitle: detail?.description ?? ev.summary,
        startIndex: start,
        endIndex: end,
      });
    }
    return boundaries;
  }
}

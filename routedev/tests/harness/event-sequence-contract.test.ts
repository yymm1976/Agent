// tests/harness/event-sequence-contract.test.ts
// B-12：同一 run 的 EngineEventV1 序列契约断言
//
// 契约：session 一致、turn 配对、sequence 单调、agent 事件边界、类型合法。
// 经 NativeAgentKernel.runReAct 驱动（与生产路径一致），非直接调用 sink。
import { describe, expect, it } from 'vitest';
import { NativeAgentKernel } from '../../src/agent/kernel-native.js';
import type { EngineEventV1 } from '../../src/harness/event-types.js';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import type { ReActEvent, ReActRunParams } from '../../src/agent/loop.js';
import type { AgentExecutionContext } from '../../src/agent/execution-context.js';

/** 捕获 recordEngineEvent 的 TraceCollector 替身（断言 kernel 流与 trace 同序列） */
class CapturingTrace extends TraceCollector {
  recorded: EngineEventV1[] = [];
  override recordEngineEvent(event: EngineEventV1): void {
    this.recorded.push(event);
  }
}

/** kernel 运行时访问 routeDecision.model.id，提供最小合法形状 */
function makeRunParams(ctx: AgentExecutionContext, userMessage = 'hi', requestId?: string): ReActRunParams {
  return {
    userMessage,
    context: ctx,
    llmClient: null as never,
    routeDecision: { model: { id: 'test-model' } } as never,
    conversationHistory: [],
    ...(requestId ? { requestId } : {}),
  };
}

/** 模拟 ReActAgentLoop：经 kernel 注入 sink 后发射完整事件序列 */
class ContractLoop {
  sink: ((e: EngineEventV1) => void) | null = null;
  collected: EngineEventV1[] = [];

  setEngineEventSink(sink: ((e: EngineEventV1) => void) | null): void {
    this.sink = sink;
  }

  async *run(params: ReActRunParams): AsyncIterable<ReActEvent> {
    const sessionId = params.context?.sessionId ?? 'sess';
    // 与真实 loop 的 B-12 行为对齐：turnId 优先复用外层 requestId
    const turnId = params.requestId ?? 'turn-1';
    const base = { id: 'ev', sessionId, timestamp: Date.now() } as const;
    let seq = 0;
    const emit = (e: Omit<EngineEventV1, 'id' | 'sessionId' | 'timestamp'>): void => {
      seq += 1;
      const full = { ...base, sequence: seq, ...e } as EngineEventV1;
      this.sink?.(full);
      this.collected.push(full);
    };
    emit({ type: 'agent_start', payload: { kernel: 'routedev-native', model: 'test-model' } });
    emit({ type: 'turn_start', turnId, payload: { input: 'hi' } });
    emit({ type: 'message_start', turnId, messageId: 'm1', payload: { role: 'assistant' } });
    emit({ type: 'message_delta', turnId, messageId: 'm1', payload: { text: 'x', kind: 'text' } });
    emit({ type: 'tool_start', turnId, payload: { toolName: 'file_read', toolCallId: 'c1' } });
    emit({ type: 'tool_end', turnId, payload: { toolName: 'file_read', toolCallId: 'c1', isError: false } });
    emit({ type: 'todo_snapshot', turnId, payload: { todos: [] } });
    emit({ type: 'context_compacted', turnId, payload: { beforeTokens: 100, afterTokens: 50, stage: 2, removedMessages: 3, recoveryItems: 2, elapsedMs: 5 } });
    emit({ type: 'message_end', turnId, messageId: 'm1', payload: { contentLength: 1 } });
    emit({ type: 'turn_end', turnId, payload: { outputLength: 1 } });
    emit({ type: 'agent_end', payload: { reason: 'completed' } });
    yield { type: 'done', content: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as ReActEvent;
  }
}

function makeKernel(loop: ContractLoop): NativeAgentKernel {
  const kernel = new NativeAgentKernel(loop as unknown as import('../../src/agent/loop.js').ReActAgentLoop);
  kernel.setParamsFactory((ctx, input, signal) => ({ ...makeRunParams(ctx, input), signal }));
  return kernel;
}

async function runContract(requestId?: string): Promise<{ events: EngineEventV1[]; loop: ContractLoop }> {
  const loop = new ContractLoop();
  const kernel = makeKernel(loop);
  const ctx: AgentExecutionContext = {
    sessionId: 'contract-sess',
    triggerSource: 'user',
    permissionMode: 'manual',
    attachedResources: [],
  };
  // kernel 把 sink 注入 loop；loop 发射时同步写入 collected（同时作为断言数据源）
  for await (const _event of kernel.runReAct(ctx, makeRunParams(ctx, 'hi', requestId))) {
    // 消费流
  }
  return { events: loop.collected, loop };
}

describe('B-12 EngineEventV1 序列契约', () => {
  it('sessionId 全程一致', async () => {
    const { events } = await runContract();
    expect(events.length).toBeGreaterThan(5);
    for (const e of events) expect(e.sessionId).toBe('contract-sess');
  });

  it('turn_start/turn_end 严格配对且 turnId 一致', async () => {
    const { events } = await runContract();
    const starts = events.filter((e) => e.type === 'turn_start');
    const ends = events.filter((e) => e.type === 'turn_end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0].turnId).toBe('turn-1');
    expect(ends[0].turnId).toBe('turn-1');
  });

  it('外层 requestId 作为 turnId 复用（桌面/SSE timeline 与 Kernel/Trace 同源）', async () => {
    const requestId = 'req-abc123';
    const { events } = await runContract(requestId);
    const starts = events.filter((e) => e.type === 'turn_start');
    const ends = events.filter((e) => e.type === 'turn_end');
    expect(starts[0].turnId).toBe(requestId);
    expect(ends[0].turnId).toBe(requestId);
    // turn 内所有事件都携带同一 turnId（消息/工具/压缩事件）
    for (const e of events) {
      if (e.turnId !== undefined) expect(e.turnId).toBe(requestId);
    }
  });

  it('sequence 在 run 内单调递增且不重复', async () => {
    const { events } = await runContract();
    const seqs = events.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('agent_start 为首事件、agent_end 为尾事件，其余事件夹在中间', async () => {
    const { events } = await runContract();
    expect(events[0].type).toBe('agent_start');
    expect(events[events.length - 1].type).toBe('agent_end');
    const middle = events.slice(1, -1);
    expect(middle.every((e) => e.type !== 'agent_start' && e.type !== 'agent_end')).toBe(true);
  });

  it('工具事件携带 toolName/toolCallId 且 start 先于 end', async () => {
    const { events } = await runContract();
    const toolEvents = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].type).toBe('tool_start');
    expect(toolEvents[1].type).toBe('tool_end');
    const start = toolEvents[0];
    const end = toolEvents[1];
    if (start.type === 'tool_start' && end.type === 'tool_end') {
      expect(start.payload.toolCallId).toBe(end.payload.toolCallId);
      expect(start.payload.toolName).toBe(end.payload.toolName);
    }
  });

  it('context_compacted 事件（B-07）在序列中合法且字段完整', async () => {
    const { events } = await runContract();
    const compacted = events.find((e) => e.type === 'context_compacted');
    expect(compacted).toBeDefined();
    if (compacted?.type === 'context_compacted') {
      expect(compacted.payload.beforeTokens).toBeGreaterThan(compacted.payload.afterTokens);
      expect(compacted.payload.recoveryItems).toBe(2);
      expect(compacted.payload.stage).toBe(2);
    }
  });

  it('事件类型全部在 EngineEventType 白名单内', async () => {
    const { events } = await runContract();
    const allowed = new Set([
      'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start',
      'message_delta', 'message_end', 'tool_start', 'tool_delta', 'tool_end',
      'approval_requested', 'approval_resolved', 'todo_snapshot', 'runtime_status',
      'runtime_error', 'context_compacted',
    ]);
    for (const e of events) expect(allowed.has(e.type)).toBe(true);
  });

  it('kernel.run 流与 trace 记录同序列（B-12 核心：桌面/SSE 与历史存储一致）', async () => {
    const loop = new ContractLoop();
    const trace = new CapturingTrace({ enabled: true });
    const kernel = new NativeAgentKernel(
      loop as unknown as import('../../src/agent/loop.js').ReActAgentLoop,
      { trace: trace as unknown as TraceCollector },
    );
    kernel.setParamsFactory((ctx, input, signal) => ({ ...makeRunParams(ctx, input), signal }));
    const ctx: AgentExecutionContext = {
      sessionId: 'contract-sess',
      triggerSource: 'user',
      permissionMode: 'manual',
      model: 'test-model',
      attachedResources: [],
    };

    const streamed: EngineEventV1[] = [];
    for await (const event of kernel.run(ctx, 'hi')) {
      streamed.push(event);
    }

    // 双向一致：kernel 产出的事件与 trace 收到的事件逐条相同（含 sequence/turnId）
    expect(trace.recorded).toHaveLength(streamed.length);
    for (let i = 0; i < streamed.length; i += 1) {
      const s = streamed[i];
      const t = trace.recorded[i];
      expect(t.type).toBe(s.type);
      expect(t.sequence).toBe(s.sequence);
      expect(t.turnId).toBe(s.turnId);
      expect(t.sessionId).toBe(s.sessionId);
    }
    // trace 侧序列同样单调
    for (let i = 1; i < trace.recorded.length; i += 1) {
      expect(trace.recorded[i].sequence).toBeGreaterThan(trace.recorded[i - 1].sequence);
    }
    // 流侧首尾边界
    expect(streamed[0].type).toBe('agent_start');
    expect(streamed[streamed.length - 1].type).toBe('agent_end');
  });
});

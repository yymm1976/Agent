// tests/agent/kernel.test.ts
// Phase 97 Part A：AgentKernel 内核接口契约测试
//
// 覆盖验收标准：
//   1. routedev-native 内核实现满足 AgentKernel 接口（编译期契约）
//   2. run() 返回 EngineEventV1 事件流，事件 sequence 单调递增
//   3. 未注入执行上下文时使用默认上下文

import { describe, it, expect } from 'vitest';
import type { AgentKernel, KernelSessionState } from '../../src/agent/kernel.js';
import type { EngineEventV1 } from '../../src/harness/event-types.js';
import { SequenceCounter } from '../../src/harness/event-types.js';
import type { AgentExecutionContext } from '../../src/agent/execution-context.js';
import { createDefaultExecutionContext } from '../../src/agent/execution-context.js';

/** 测试用内核实现：验证接口契约可被满足 */
class MockKernel implements AgentKernel {
  readonly id = 'routedev-native';
  private seq = new SequenceCounter();

  async *run(ctx: AgentExecutionContext, input: string): AsyncIterable<EngineEventV1> {
    const base = { sessionId: ctx.sessionId, timestamp: Date.now() };
    yield { ...base, id: 'a', sequence: this.seq.next(), type: 'agent_start', payload: { kernel: this.id } };
    yield { ...base, id: 'b', sequence: this.seq.next(), type: 'turn_start', turnId: 't1', payload: { input } };
    yield { ...base, id: 'c', sequence: this.seq.next(), type: 'agent_end', payload: { reason: 'completed' } };
  }

  async abort(sessionId: string): Promise<void> {
    void sessionId;
  }

  getSessionState(sessionId: string): KernelSessionState | null {
    return sessionId ? { sessionId, running: false, lastEventSequence: this.seq.next() } : null;
  }

  listSessions(): string[] {
    return [];
  }
}

describe('kernel（AgentKernel 内核接口抽象）', () => {
  it('mock 内核满足 AgentKernel 接口契约（编译期验证 + 运行时 id）', () => {
    const kernel: AgentKernel = new MockKernel();
    expect(kernel.id).toBe('routedev-native');
  });

  it('run() 事件流中 sequence 单调递增', async () => {
    const kernel = new MockKernel();
    const ctx: AgentExecutionContext = {
      triggerSource: 'user',
      sessionId: 'sess-1',
      permissionMode: 'semi',
      attachedResources: [],
    };
    const seqs: number[] = [];
    for await (const ev of kernel.run(ctx, '你好')) {
      seqs.push(ev.sequence);
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
  });

  it('默认执行上下文兜底：user 触发 + semi 权限', () => {
    const ctx = createDefaultExecutionContext('sess-2');
    expect(ctx.triggerSource).toBe('user');
    expect(ctx.permissionMode).toBe('semi');
  });

  it('getSessionState 返回状态快照', () => {
    const kernel = new MockKernel();
    const state = kernel.getSessionState('sess-1');
    expect(state?.sessionId).toBe('sess-1');
    expect(state?.running).toBe(false);
  });
});

// ============================================================
// NativeAgentKernel（routedev-native 薄适配）
// ============================================================

import { NativeAgentKernel } from '../../src/agent/kernel-native.js';
import type { ReActEvent, ReActRunParams } from '../../src/agent/loop.js';

/** 模拟 ReActAgentLoop：sink 发射 EngineEventV1 + 消费 ReActEvent 流 */
class FakeLoop {
  sink: ((e: EngineEventV1) => void) | null = null;
  lastParams: ReActRunParams | null = null;
  lastSignal: AbortSignal | undefined;

  setEngineEventSink(sink: ((e: EngineEventV1) => void) | null): void {
    this.sink = sink;
  }

  async *run(params: ReActRunParams): AsyncIterable<ReActEvent> {
    this.lastParams = params;
    this.lastSignal = params.signal;
    const base = {
      id: 'ev',
      sessionId: params.context?.sessionId ?? 'sess',
      sequence: 0,
      timestamp: Date.now(),
    } as const;
    this.sink?.({ ...base, sequence: 1, type: 'agent_start', payload: { model: 'test-model' } });
    this.sink?.({ ...base, sequence: 2, type: 'turn_start', turnId: 't1', payload: {} });
    if (params.signal?.aborted) {
      this.sink?.({ ...base, sequence: 3, type: 'turn_end', turnId: 't1', payload: {} });
      return;
    }
    this.sink?.({ ...base, sequence: 3, type: 'turn_end', turnId: 't1', payload: {} });
    yield { type: 'done', content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as ReActEvent;
  }
}

function makeKernel(fake: FakeLoop): NativeAgentKernel {
  const kernel = new NativeAgentKernel(fake as unknown as import('../../src/agent/loop.js').ReActAgentLoop);
  kernel.setParamsFactory((ctx, input, signal) => ({
    userMessage: input,
    context: ctx,
    signal,
    // 以下字段由 loop.run 实际消费，fake 仅做透传断言
    llmClient: null as never,
    routeDecision: { route: 'chat' } as never,
    conversationHistory: [],
  }));
  return kernel;
}

describe('NativeAgentKernel（routedev-native 薄适配）', () => {
  it('run() 经 sink 收集 EngineEventV1 并透传 context/signal 到 ReActRunParams', async () => {
    const fake = new FakeLoop();
    const kernel = makeKernel(fake);
    const ctx: AgentExecutionContext = {
      triggerSource: 'user',
      sessionId: 'sess-k1',
      permissionMode: 'semi',
      attachedResources: [],
      model: 'ctx-model',
    };

    const events: EngineEventV1[] = [];
    for await (const ev of kernel.run(ctx, '你好')) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual(['agent_start', 'turn_start', 'turn_end']);
    expect(events[0].sequence).toBe(1);
    expect(events[2].sequence).toBe(3);
    expect(fake.lastParams?.userMessage).toBe('你好');
    expect(fake.lastParams?.context).toBe(ctx);
    expect(fake.lastParams?.signal).toBeDefined();
    // sink 在 run 结束后被清除（loop 单例安全）
    expect(fake.sink).toBeNull();
  });

  it('run() 未注册 params factory 时抛错', async () => {
    const kernel = new NativeAgentKernel(new FakeLoop() as unknown as import('../../src/agent/loop.js').ReActAgentLoop);
    const ctx: AgentExecutionContext = {
      triggerSource: 'user',
      sessionId: 'sess-x',
      permissionMode: 'semi',
      attachedResources: [],
    };
    await expect(async () => {
      for await (const _ev of kernel.run(ctx, 'hi')) {
        // 不应产出
      }
    }).rejects.toThrow(/params factory 未注册/);
  });

  it('并发 run（不同会话）被互斥拒绝', async () => {
    const fake = new FakeLoop();
    const kernel = makeKernel(fake);
    const ctx: AgentExecutionContext = {
      triggerSource: 'user',
      sessionId: 'sess-a',
      permissionMode: 'semi',
      attachedResources: [],
    };
    const iterator = kernel.run(ctx, 'first');
    // 第一个 run 启动（sink 注入、runningSessionId 置位）
    const firstEvent = await iterator.next();
    expect(firstEvent.value).toBeDefined();
    // 第二个 run 被互斥拒绝（async generator 的错误在迭代时抛出）
    await expect(async () => {
      for await (const _e of kernel.run({ ...ctx, sessionId: 'sess-b' }, 'second')) {
        // 不应产出
      }
    }).rejects.toThrow(/不支持并发 run/);
    // drain 第一个 run
    for await (const _ev of iterator) {
      // drain
    }
  });

  it('abort 中止活跃 run（signal.aborted 生效）', async () => {
    const fake = new FakeLoop();
    const kernel = makeKernel(fake);
    const ctx: AgentExecutionContext = {
      triggerSource: 'user',
      sessionId: 'sess-abort',
      permissionMode: 'semi',
      attachedResources: [],
    };
    const iterator = kernel.run(ctx, 'work');
    await iterator.next(); // 推进到 sink 已注入
    await kernel.abort('sess-abort');
    for await (const _ev of iterator) {
      // drain
    }
    expect(fake.lastSignal?.aborted).toBe(true);
    const state = kernel.getSessionState('sess-abort');
    expect(state?.running).toBe(false);
    expect(state?.lastEventSequence).toBeGreaterThan(0);
  });

  it('abort 无活跃 run 时记为 pending，下次 run 启动立即中止', async () => {
    const fake = new FakeLoop();
    const kernel = makeKernel(fake);
    const ctx: AgentExecutionContext = {
      triggerSource: 'user',
      sessionId: 'sess-pending',
      permissionMode: 'semi',
      attachedResources: [],
    };
    await kernel.abort('sess-pending');
    for await (const _ev of kernel.run(ctx, 'late')) {
      // drain
    }
    expect(fake.lastSignal?.aborted).toBe(true);
  });

  it('getSessionState 记录生命周期与最近状态（run 结束后保留）', async () => {
    const fake = new FakeLoop();
    const kernel = makeKernel(fake);
    const ctx: AgentExecutionContext = {
      triggerSource: 'user',
      sessionId: 'sess-state',
      permissionMode: 'semi',
      attachedResources: [],
      model: 'm1',
    };
    const iterator = kernel.run(ctx, 'hello');
    const first = await iterator.next();
    expect(first.value).toBeDefined();
    // 运行中：状态可查
    const during = kernel.getSessionState('sess-state');
    expect(during?.running).toBe(true);
    for await (const _ev of iterator) {
      // drain
    }
    const after = kernel.getSessionState('sess-state');
    expect(after?.running).toBe(false);
    expect(after?.lastEventSequence).toBe(3);
    expect(after?.model).toBe('test-model');
    expect(kernel.listSessions()).toContain('sess-state');
    expect(kernel.getBinding('sess-state')?.kernelId).toBe('routedev-native');
  });
});

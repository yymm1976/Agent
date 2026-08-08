// src/agent/kernel-native.ts
// Phase 97 Part A Task A3 Step 2：routedev-native 内核薄适配
//
// 设计目的：
//   将现有 ReActAgentLoop 包装为 AgentKernel 接口的 kernel A（routedev-native），
//   不重构 loop 内部。run() 通过注入的 ReActRunParams 工厂把统一执行上下文翻译成
//   loop 所需参数，EngineEventV1 事件流经 loop.setEngineEventSink 收集后产出。
//   未来接入 Pi / Claude SDK 内核时，上层（引擎桥 / 远程 / 子 Agent）只依赖
//   AgentKernel 接口，无需感知具体循环实现；切换内核时消息持久化复用现有会话存储。
//
// 并发模型：
//   ReActAgentLoop 的 engineSink / currentContext 是实例级单例，不支持并发 run。
//   本适配显式互斥：同一时间只允许一个会话运行（fail-fast 抛错），避免静默串流。

import type { AgentKernel, KernelBinding, KernelSessionState } from './kernel.js';
import type { AgentExecutionContext } from './execution-context.js';
import type { EngineEventV1 } from '../harness/event-types.js';
import type { ReActAgentLoop, ReActRunParams } from './loop.js';
import type { ReActEvent } from './loop-config.js';
// Closure 6（TD-21 Production Closure）：每个生产 Run 创建权威 RunEventLog
import { RunEventLog } from '../harness/run-event-log.js';
// Closure-2：每 Run 唯一 runId（requestId ?? randomUUID）
import { randomUUID } from 'node:crypto';

/** ReActRunParams 工厂：把统一执行上下文翻译为 loop 所需参数（signal 由内核管理） */
export type KernelRunParamsFactory = (
  ctx: AgentExecutionContext,
  input: string,
  signal: AbortSignal | undefined,
) => ReActRunParams | Promise<ReActRunParams>;

/**
 * routedev-native 内核（kernel A）：包装 ReActAgentLoop 满足 AgentKernel 接口。
 *
 * - run()：注入 EngineEventV1 sink → 工厂构建 ReActRunParams → 消费 ReActEvent 流驱动执行
 *   → 产出 EngineEventV1 事件流（sequence 单调递增）
 * - abort()：中止活跃会话；无活跃 run 时记为 pending，下次该会话 run 启动立即生效
 * - getSessionState()：返回会话最近状态（run 结束后保留，供 UI / 状态聚合查询）
 * - getBinding()：会话级内核绑定记录（Task A3 Step 3，切换内核时保留历史）
 */
export class NativeAgentKernel implements AgentKernel {
  readonly id = 'routedev-native';

  private readonly loop: ReActAgentLoop;
  private paramsFactory: KernelRunParamsFactory | null = null;
  /** 运行中的会话：sessionId → 取消信号与实时状态 */
  private readonly active = new Map<string, { controller: AbortController; state: KernelSessionState }>();
  /** 最近状态（run 结束后保留，供 getSessionState 查询历史） */
  private readonly recent = new Map<string, KernelSessionState>();
  /** 会话级内核绑定记录（Task A3 Step 3） */
  private readonly bindings = new Map<string, KernelBinding>();
  /** abort 在无活跃 run 时记入，该会话下次 run 启动时立即中止 */
  private readonly pendingAborts = new Set<string>();
  /** 互斥：loop 单例状态不支持并发 run */
  private runningSessionId: string | null = null;
  /** k3：EngineEventV1 同步写入 trace（携带 sequence/turnId） */
  private readonly trace: import('../harness/trace-collector.js').TraceCollector | null;

  constructor(loop: ReActAgentLoop, options?: { trace?: import('../harness/trace-collector.js').TraceCollector | null }) {
    this.loop = loop;
    this.trace = options?.trace ?? null;
  }

  /** 注册 ReActRunParams 工厂（由装配 / 消费方注入；未注册时 run() 抛错） */
  setParamsFactory(factory: KernelRunParamsFactory | null): void {
    this.paramsFactory = factory;
  }

  /**
   * Production desktop adapter path. It keeps the original ReAct event stream
   * for ChatBridge while the same kernel-owned sink records EngineEventV1.
   */
  async *runReAct(ctx: AgentExecutionContext, params: ReActRunParams): AsyncIterable<ReActEvent> {
    if (this.runningSessionId !== null) {
      throw new Error(`NativeAgentKernel: ReActAgentLoop 正在执行会话 ${this.runningSessionId}`);
    }
    const controller = new AbortController();
    const upstreamSignal = params.signal;
    const abortFromUpstream = (): void => controller.abort();
    if (upstreamSignal?.aborted) controller.abort();
    else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    const state: KernelSessionState = {
      sessionId: ctx.sessionId,
      running: true,
      lastEventSequence: 0,
      model: params.routeDecision.model.id,
    };
    const activeEntry = { controller, state };
    this.active.set(ctx.sessionId, activeEntry);
    if (params.requestId && params.requestId !== ctx.sessionId) {
      this.active.set(params.requestId, activeEntry);
    }
    this.bindings.set(ctx.sessionId, {
      sessionId: ctx.sessionId,
      kernelId: this.id,
      switchedAt: Date.now(),
    });
    if (this.pendingAborts.delete(ctx.sessionId) || (params.requestId && this.pendingAborts.delete(params.requestId))) {
      controller.abort();
    }
    this.runningSessionId = ctx.sessionId;
    const sink = (event: EngineEventV1): void => {
      state.lastEventSequence = Math.max(state.lastEventSequence, event.sequence);
      if (event.type === 'turn_start') state.currentTurnId = event.turnId;
      if (event.type === 'turn_end') state.currentTurnId = undefined;
      if (event.type === 'agent_start' && event.payload.model) state.model = event.payload.model;
      try { this.trace?.recordEngineEvent(event); } catch { /* observability must not break execution */ }
    };
    this.loop.setEngineEventSink(sink);
    // Closure-2：每 Run 唯一 runId 的 RunEventLog（requestId ?? randomUUID），
    // run 结束清理；存储目录沿用 trace 的 storageDir
    const runLog = this.attachRunLog(params.requestId);
    try {
      params.context = ctx;
      params.signal = controller.signal;
      for await (const event of this.loop.run(params)) yield event;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.detachRunLog(runLog);
      this.loop.setEngineEventSink(null);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
      state.running = false;
      this.runningSessionId = null;
      this.active.delete(ctx.sessionId);
      if (params.requestId && params.requestId !== ctx.sessionId) this.active.delete(params.requestId);
      this.recent.set(ctx.sessionId, state);
    }
  }

  /** 会话最近使用的内核绑定记录（供切换内核 / 会话元数据持久化） */
  getBinding(sessionId: string): KernelBinding | undefined {
    return this.bindings.get(sessionId);
  }

  /**
   * Closure-2：每 Run 唯一 runId 的 RunEventLog 装配（runReAct()/run() 共用）。
   * runId = requestId ?? randomUUID()——sessionId 只作 metadata，禁止作为 run
   * identity fallback（同 session 连续 run 会 append 到同一文件导致 sequence 断裂，
   * replay 必失败）。mock/轻量 loop 未实现 setRunEventLog 时返回 null（能力守卫）。
   */
  private attachRunLog(requestId: string | undefined): import('../harness/run-event-log.js').RunEventLog | null {
    const loop = this.loop as { setRunEventLog?: (log: import('../harness/run-event-log.js').RunEventLog | null) => void };
    if (typeof loop.setRunEventLog !== 'function') return null;
    const runId = requestId ?? randomUUID();
    const log = new RunEventLog(runId, this.trace?.getStorageDirPath());
    loop.setRunEventLog(log);
    return log;
  }

  private detachRunLog(log: import('../harness/run-event-log.js').RunEventLog | null): void {
    if (!log) return;
    (this.loop as { setRunEventLog?: (log: import('../harness/run-event-log.js').RunEventLog | null) => void }).setRunEventLog?.(null);
  }

  /** 已登记过的会话 id 列表（供状态聚合查询遍历） */
  listSessions(): string[] {
    return [...new Set([...this.active.keys(), ...this.recent.keys(), ...this.bindings.keys()])];
  }

  async *run(ctx: AgentExecutionContext, input: string): AsyncIterable<EngineEventV1> {
    const factory = this.paramsFactory;
    if (!factory) {
      throw new Error(
        'NativeAgentKernel: params factory 未注册，无法执行 run()（请在装配处注入 KernelRunParamsFactory）',
      );
    }
    if (this.runningSessionId !== null) {
      throw new Error(
        `NativeAgentKernel: ReActAgentLoop 正在执行会话 ${this.runningSessionId}，单例循环不支持并发 run`,
      );
    }

    const controller = new AbortController();
    const state: KernelSessionState = {
      sessionId: ctx.sessionId,
      running: true,
      lastEventSequence: 0,
      model: ctx.model,
    };
    this.active.set(ctx.sessionId, { controller, state });
    this.bindings.set(ctx.sessionId, {
      sessionId: ctx.sessionId,
      kernelId: this.id,
      switchedAt: Date.now(),
    });
    if (this.pendingAborts.delete(ctx.sessionId)) {
      controller.abort();
    }
    this.runningSessionId = ctx.sessionId;

    // k3：EngineEventV1 sink 接通——事件经队列实时 yield（不等 loop.run 结束），
    // 装配时注入的 trace 同步记录（携带 sequence/turnId）
    const queue: EngineEventV1[] = [];
    // 防御上限：消费者长时间不消费时丢弃最旧事件（状态经 state 变量保底，不丢语义）
    const MAX_QUEUE = 1000;
    // 唤醒器（对象属性避免 TS 闭包收窄陷阱：runPromise 闭包内只读变量会被收窄为最后赋值 null）
    const waiter: { fn: (() => void) | null } = { fn: null };
    let loopError: unknown = null;
    let loopDone = false;
    const sink = (e: EngineEventV1): void => {
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(e);
      const wake = waiter.fn;
      if (wake) wake();
      waiter.fn = null;
      state.lastEventSequence = Math.max(state.lastEventSequence, e.sequence);
      if (e.type === 'turn_start') state.currentTurnId = e.turnId;
      if (e.type === 'turn_end') state.currentTurnId = undefined;
      if (e.type === 'agent_start' && e.payload.model) state.model = e.payload.model;
      try {
        this.trace?.recordEngineEvent(e);
      } catch {
        // trace 记录失败不影响主流程（fail-open）
      }
    };
    this.loop.setEngineEventSink(sink);

    const runPromise = (async (): Promise<void> => {
      try {
        const params = await factory(ctx, input, controller.signal);
        // Closure-2：run() 生产路径同样装配每 Run 唯一 runId 的 RunEventLog
        const runLog = this.attachRunLog(params.requestId);
        try {
          // 透传统一执行上下文与取消信号，保证 loop 内部状态与上层一致
          params.context = ctx;
          params.signal = controller.signal;
          // 消费 ReActEvent 流以驱动执行；EngineEventV1 经 sink 实时进入队列
          for await (const _event of this.loop.run(params)) {
            // 事件已通过 sink 进入队列
          }
        } finally {
          this.detachRunLog(runLog);
        }
      } catch (err) {
        loopError = err;
      } finally {
        loopDone = true;
        const wake = waiter.fn;
        if (wake) wake();
        waiter.fn = null;
        this.loop.setEngineEventSink(null);
        state.running = false;
        this.runningSessionId = null;
        this.active.delete(ctx.sessionId);
        this.recent.set(ctx.sessionId, state);
      }
    })();

    try {
      // 边收边 yield：事件实时产出，run 结束后队列排空
      while (!loopDone || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (!loopDone) {
          await new Promise<void>((resolve) => {
            waiter.fn = resolve;
          });
        } else {
          break;
        }
      }
    } finally {
      // 消费者提前 break：不再等待剩余事件；loop 继续跑完（fire-and-forget），
      // 其 finally 负责清理 sink 与状态
      waiter.fn = null;
    }
    if (loopError) {
      state.error = loopError instanceof Error ? loopError.message : String(loopError);
      throw loopError;
    }
  }

  async abort(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId);
    if (entry) {
      entry.controller.abort();
    } else {
      // 无活跃 run：记为 pending，该会话下次 run 启动时立即中止
      this.pendingAborts.add(sessionId);
    }
  }

  getSessionState(sessionId: string): KernelSessionState | null {
    return this.active.get(sessionId)?.state ?? this.recent.get(sessionId) ?? null;
  }
}

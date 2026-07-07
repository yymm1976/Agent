// src/observability/analytics-queue.ts
// P0-11：Analytics 队列 + 后挂 sink 模式
//
// 借鉴 Claude Code `src/services/analytics/index.ts`：
//   - 模块加载时 sink = null（零依赖，避免启动期加载重模块）
//   - logEvent 进 eventQueue（先入队，不阻塞调用方）
//   - attachAnalyticsSink 在 app 启动时挂载并 queueMicrotask 排空队列
//   - fail-open：sink 未挂载时事件入队不丢失，挂载后批量 flush
//   - 避免 analytics→sink→analytics import cycle（sink 通过 attach 注入，不 import）
//
// 设计要点：
//   1. 模块级单例（全局只有一个队列，所有模块共享）
//   2. sink 接口宽进严出：任何符合 AnalyticsSink 接口的对象都可挂载
//   3. 排空策略：queueMicrotask 优先（不阻塞当前事件循环），失败 fallback 到 setImmediate
//   4. 容量上限：避免 sink 长期未挂载时内存泄漏（默认 10000 条，超出丢弃最旧）
//   5. 与 OtelExporter 互补：OtelExporter 是具体 sink 之一，本模块是事件入口

import { logger } from '../utils/logger.js';

/** Analytics 事件结构 */
export interface AnalyticsEvent {
  /** 事件名（如 'tool_call' / 'agent_spawn' / 'command_invoke'） */
  name: string;
  /** 事件时间戳（ms） */
  timestamp: number;
  /** 事件属性（任意可序列化数据） */
  attributes?: Record<string, unknown>;
}

/**
 * Analytics sink 接口
 *
 * 任何符合此接口的对象都可挂载为 sink（OtelExporter / 自定义 console sink 等）
 */
export interface AnalyticsSink {
  /** 消费一批事件（同步或异步） */
  flush(events: AnalyticsEvent[]): void | Promise<void>;
  /** sink 名称（用于日志/审计） */
  name?: string;
}

/** 队列容量上限（避免内存泄漏） */
const QUEUE_CAPACITY = 10000;

/** 模块级状态 */
const state: {
  /** 已挂载的 sink（null = 未挂载） */
  sink: AnalyticsSink | null;
  /** 待 flush 的事件队列 */
  eventQueue: AnalyticsEvent[];
  /** 是否已调度排空任务（避免重复调度） */
  flushScheduled: boolean;
  /** 累计丢弃事件数（超过容量时） */
  droppedCount: number;
  /** 累计已 flush 事件数 */
  totalFlushed: number;
  /** 累计 flush 失败次数 */
  totalErrors: number;
} = {
  sink: null,
  eventQueue: [],
  flushScheduled: false,
  droppedCount: 0,
  totalFlushed: 0,
  totalErrors: 0,
};

/**
 * 记录一个 analytics 事件
 *
 * 行为：
 *   - sink 未挂载：事件入队，不丢失（直到容量上限）
 *   - sink 已挂载：事件入队 + queueMicrotask 调度排空
 *   - 容量超限：丢弃最旧事件，droppedCount++
 *
 * @example
 * logEvent('tool_call', { tool: 'file_edit', durationMs: 120 });
 */
export function logEvent(name: string, attributes?: Record<string, unknown>): void {
  const event: AnalyticsEvent = {
    name,
    timestamp: Date.now(),
    attributes,
  };

  // 入队
  state.eventQueue.push(event);

  // 容量保护：超限时丢弃最旧
  if (state.eventQueue.length > QUEUE_CAPACITY) {
    state.eventQueue.shift();
    state.droppedCount++;
    if (state.droppedCount === 1 || state.droppedCount % 1000 === 0) {
      logger.warn(`analytics-queue: 队列超限，已丢弃 ${state.droppedCount} 条最旧事件`, {
        capacity: QUEUE_CAPACITY,
      });
    }
  }

  // sink 已挂载时调度排空（未挂载时事件保留在队列中，等待 attach 后批量 flush）
  if (state.sink && !state.flushScheduled) {
    state.flushScheduled = true;
    scheduleFlush();
  }
}

/**
 * P0-11：挂载 analytics sink
 *
 * 行为：
 *   1. 设置 state.sink = sink
 *   2. queueMicrotask 调度一次排空，把队列中累积的事件全部 flush
 *
 * 调用时机：app 启动完成、配置加载完毕后调用一次
 * 调用方：app-init.ts（避免在模块加载时调用，防止循环依赖）
 *
 * @param sink 符合 AnalyticsSink 接口的对象
 */
export function attachAnalyticsSink(sink: AnalyticsSink): void {
  if (state.sink) {
    logger.warn(`analytics-queue: sink 已挂载（${state.sink.name ?? 'unnamed'}），将被替换`, {
      newSink: sink.name ?? 'unnamed',
    });
  }
  state.sink = sink;
  logger.info(`analytics-queue: sink 已挂载: ${sink.name ?? 'unnamed'}`, {
    pendingEvents: state.eventQueue.length,
  });

  // 立即调度排空（处理 attach 前累积的事件）
  if (state.eventQueue.length > 0 && !state.flushScheduled) {
    state.flushScheduled = true;
    scheduleFlush();
  }
}

/**
 * P0-11：调度一次排空任务
 *
 * 优先使用 queueMicrotask（最快，不阻塞当前事件循环 tick）
 * 在 microtask 阶段批量 flush，避免每个事件都触发一次 I/O
 */
function scheduleFlush(): void {
  // 用 microtask 优先，但兜底 setImmediate（防止 microtask 队列过长）
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(flushQueue);
  } else {
    setImmediate(flushQueue);
  }
}

/**
 * P0-11：实际排空逻辑
 *
 * 行为：
 *   1. 取出队列中所有事件（原子操作：先 shift 出来再交给 sink）
 *   2. 调用 sink.flush(events)，捕获异常（fail-open）
 *   3. flush 失败时事件不回滚（避免无限重试），仅记 error 日志
 */
async function flushQueue(): Promise<void> {
  state.flushScheduled = false;

  if (!state.sink) return;
  if (state.eventQueue.length === 0) return;

  // 原子取出：把队列引用替换为空数组，原数组交给 sink
  const events = state.eventQueue;
  state.eventQueue = [];

  try {
    await state.sink.flush(events);
    state.totalFlushed += events.length;
  } catch (err) {
    state.totalErrors++;
    logger.error(`analytics-queue: sink.flush 失败（事件已丢弃，不回滚）`, {
      sinkName: state.sink.name ?? 'unnamed',
      eventCount: events.length,
      error: err instanceof Error ? err.message : String(err),
    });
    // fail-open：失败时事件不回滚，避免无限重试导致队列爆炸
  }
}

/**
 * P0-11：同步强制 flush（用于 graceful shutdown）
 *
 * 与 flushQueue 区别：
 *   - flushQueue 是异步调度，可能延迟到下一个 microtask
 *   - forceFlushNow 立即执行，确保关闭前所有事件都已交付
 *
 * @returns 等待所有事件 flush 完成的 Promise
 */
export async function forceFlushNow(): Promise<void> {
  if (state.eventQueue.length === 0) return;
  if (!state.sink) {
    logger.warn(`analytics-queue: forceFlushNow 时 sink 未挂载，丢弃 ${state.eventQueue.length} 条事件`);
    state.eventQueue = [];
    return;
  }
  await flushQueue();
}

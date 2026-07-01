// src/scheduler/engine.ts
// Phase 37 Task 2：调度引擎
// 周期性检查任务列表，到达触发时间时调用 onTaskTrigger
// onTaskTrigger 是异步的，不 await（fire and forget，不阻塞主线程）
// M5 修复：使用最小堆优先队列按 nextRun 排序，check() 只处理到期任务，避免全量扫描

import { ScheduleStore } from './store.js';
import { parseCron, getNextRun } from './cron-parser.js';
import type { ScheduledTask } from './types.js';

/**
 * M5 修复：基于 nextRun 的最小堆优先队列
 * check() 时只需从堆顶取到期任务，无需遍历全部任务
 * 堆在任务增删改时标记为脏，下次 check() 时惰性重建
 */
class TaskMinHeap {
  private heap: ScheduledTask[] = [];

  /** 从任务列表构建堆（过滤掉未启用或无 nextRun 的任务） */
  build(tasks: ScheduledTask[]): void {
    this.heap = tasks.filter((t) => t.enabled && t.nextRun !== undefined);
    // 从最后一个非叶子节点开始下沉，O(n) 建堆
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  /** 查看堆顶任务（不弹出） */
  peek(): ScheduledTask | null {
    return this.heap.length > 0 ? this.heap[0] : null;
  }

  /** 弹出堆顶任务 */
  pop(): ScheduledTask | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** 向堆中插入任务 */
  push(task: ScheduledTask): void {
    this.heap.push(task);
    this.siftUp(this.heap.length - 1);
  }

  get size(): number {
    return this.heap.length;
  }

  /** 上浮操作 */
  private siftUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if ((this.heap[i].nextRun ?? Infinity) < (this.heap[parent].nextRun ?? Infinity)) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  /** 下沉操作 */
  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && (this.heap[left].nextRun ?? Infinity) < (this.heap[smallest].nextRun ?? Infinity)) {
        smallest = left;
      }
      if (right < n && (this.heap[right].nextRun ?? Infinity) < (this.heap[smallest].nextRun ?? Infinity)) {
        smallest = right;
      }
      if (smallest !== i) {
        [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
        i = smallest;
      } else {
        break;
      }
    }
  }
}

/** 调度引擎选项 */
export interface ScheduleEngineOptions {
  /** 任务存储 */
  store: ScheduleStore;
  /** 任务触发回调（异步） */
  onTaskTrigger: (task: ScheduledTask) => Promise<void>;
  /** 检查间隔（毫秒），默认 60000（1 分钟） */
  checkIntervalMs?: number;
}

/**
 * 将时区名称（如 Asia/Shanghai）转换为 UTC 偏移分钟数
 * 使用 Intl.DateTimeFormat（内置，不引入外部库）
 * 时区无效时回退到系统本地时区
 *
 * DST 修复：接受可选的 referenceDate 参数，计算该时刻的偏移量
 * 而非总是用"当前时刻"。调用方应传入目标时刻（如 nextRun）以正确处理夏令时切换。
 */
function getTimezoneOffsetMinutes(timezone: string, referenceDate: Date = new Date()): number {
  try {
    // 通过 Intl 获取目标时区在 referenceDate 时刻的"墙上时间"各字段
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(referenceDate);
    const get = (type: string): number =>
      parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    // 把目标时区的墙上时间当作 UTC 构造时间戳
    const tzAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24, // 处理 hour12:false 在某些环境返回 24 的情况
      get('minute'),
      get('second'),
    );
    // 偏移 = 目标时区墙上时间对应的 UTC - 实际 UTC（均为 referenceDate 时刻）
    const diffMs = tzAsUtc - referenceDate.getTime();
    return Math.round(diffMs / 60000);
  } catch {
    // 时区无效，回退到系统本地时区在 referenceDate 时刻的偏移
    return -referenceDate.getTimezoneOffset();
  }
}

/**
 * 调度引擎
 * 启动后周期性检查所有 enabled 任务，到达 nextRun 时触发 onTaskTrigger
 * M5 修复：使用最小堆优先队列，check() 只弹出到期任务，避免每轮全量扫描
 */
export class ScheduleEngine {
  private readonly store: ScheduleStore;
  private readonly onTaskTrigger: (task: ScheduledTask) => Promise<void>;
  private readonly checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** M5 修复：优先队列（最小堆），按 nextRun 排序 */
  private readonly heap = new TaskMinHeap();
  /** M5 修复：堆是否需要重建（任务增删改时置 true） */
  private heapDirty = true;
  private checking = false;

  constructor(options: ScheduleEngineOptions) {
    this.store = options.store;
    this.onTaskTrigger = options.onTaskTrigger;
    this.checkIntervalMs = options.checkIntervalMs ?? 60000;
  }

  /** 启动调度引擎 */
  start(): void {
    if (this.timer) return; // 已启动，避免重复
    queueMicrotask(() => {
      if (this.timer) {
        this.check();
      }
    });
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /** 停止调度引擎 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 引擎是否正在运行 */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * 添加任务
   * 如果任务已启用且未设置 nextRun，自动计算下次执行时间
   */
  add(task: ScheduledTask): void {
    if (task.enabled && task.nextRun === undefined) {
      try {
        task.nextRun = this.getNextRun(task.cron, task.timezone).getTime();
      } catch {
        // cron 无效，不设置 nextRun（任务不会被触发）
      }
    }
    this.store.add(task);
    // M5 修复：标记堆为脏，下次 check() 时重建
    this.heapDirty = true;
  }

  /** 删除任务 */
  remove(id: string): void {
    this.store.remove(id);
    // M5 修复：标记堆为脏，下次 check() 时重建
    this.heapDirty = true;
  }

  /**
   * 更新任务
   * 如果重新启用或修改了 cron/timezone，自动重新计算 nextRun
   */
  update(id: string, updates: Partial<ScheduledTask>): void {
    const existing = this.store.get(id);
    if (!existing) return;
    const merged: ScheduledTask = { ...existing, ...updates };
    // 以下情况需要重新计算 nextRun：
    // 1. 任务被重新启用
    // 2. cron 表达式被修改
    // 3. 时区被修改
    const needsRecalc = merged.enabled && (
      (updates.enabled === true) ||
      ('cron' in updates) ||
      ('timezone' in updates)
    );
    if (needsRecalc) {
      try {
        merged.nextRun = this.getNextRun(merged.cron, merged.timezone).getTime();
      } catch {
        merged.nextRun = undefined;
      }
    }
    this.store.update(id, merged);
    // M5 修复：标记堆为脏，下次 check() 时重建
    this.heapDirty = true;
  }

  /** 列出所有任务 */
  list(): ScheduledTask[] {
    return this.store.list();
  }

  /**
   * 计算指定 cron 表达式在指定时区下的下次执行时间
   * @param cron cron 表达式
   * @param timezone 时区名称（如 Asia/Shanghai）
   *
   * DST 修复：采用两遍计算——第一遍用当前时刻偏移得到候选 nextRun，
   * 第二遍用候选 nextRun 时刻的偏移重新计算，修正夏令时切换导致的偏移差异。
   */
  getNextRun(cron: string, timezone: string): Date {
    const parsed = parseCron(cron);
    const now = new Date();
    // 第一遍：用当前时刻的偏移计算 nextRun
    const offsetNow = getTimezoneOffsetMinutes(timezone, now);
    const candidate = getNextRun(parsed, now, offsetNow);
    // 第二遍：用候选 nextRun 时刻的偏移重新计算，修正 DST 切换
    const offsetAtCandidate = getTimezoneOffsetMinutes(timezone, candidate);
    if (offsetAtCandidate !== offsetNow) {
      return getNextRun(parsed, now, offsetAtCandidate);
    }
    return candidate;
  }

  /**
   * M5 修复：使用优先队列检查到期任务
   * 从堆顶依次弹出 nextRun <= now 的任务，触发后用新的 nextRun 重新入堆
   * 堆脏时先从 store 重建堆（惰性重建，避免每次增删改都重建）
   * fire and forget：不 await onTaskTrigger，不阻塞定时器
   */
  private check(): void {
    if (this.checking) return;
    this.checking = true;

    try {
    const now = Date.now();

    // M5 修复：堆脏时从 store 重建优先队列
    if (this.heapDirty) {
      let tasks: ScheduledTask[];
      try {
        tasks = this.store.list();
      } catch {
        return; // 存储读取失败，跳过本次检查
      }
      this.heap.build(tasks);
      this.heapDirty = false;
    }

    // 从堆顶取出所有到期任务（nextRun <= now）
    while (this.heap.size > 0) {
      const top = this.heap.peek();
      if (!top || top.nextRun === undefined || top.nextRun > now) break;

      // 弹出到期任务
      const task = this.heap.pop()!;

      try {
        this.store.appendExecutionRecord({
          taskId: task.id,
          startedAt: now,
          status: 'running',
        });

        // 触发任务（fire and forget，不阻塞）
        this.onTaskTrigger(task)
          .then(() => {
            this.store.appendExecutionRecord({
              taskId: task.id,
              startedAt: now,
              finishedAt: Date.now(),
              status: 'completed',
            });
          })
          .catch((error) => {
            this.store.appendExecutionRecord({
              taskId: task.id,
              startedAt: now,
              finishedAt: Date.now(),
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          });

        // 更新 lastRun、runCount
        const newRunCount = task.runCount + 1;
        const updates: Partial<ScheduledTask> = {
          lastRun: now,
          runCount: newRunCount,
        };

        // 检查是否达到 maxRuns
        if (task.maxRuns !== undefined && newRunCount >= task.maxRuns) {
          // 达到最大执行次数，自动禁用（不再入堆）
          updates.enabled = false;
          updates.nextRun = undefined;
        } else {
          // 计算下次执行时间
          // DST 修复：两遍计算，用目标时刻的偏移修正夏令时切换
          try {
            const parsed = parseCron(task.cron);
            const nowDate = new Date(now);
            // 第一遍：用当前时刻的偏移计算 nextRun
            const offsetNow = getTimezoneOffsetMinutes(task.timezone, nowDate);
            const candidate = getNextRun(parsed, nowDate, offsetNow);
            // 第二遍：用候选 nextRun 时刻的偏移重新计算
            const offsetAtCandidate = getTimezoneOffsetMinutes(task.timezone, candidate);
            if (offsetAtCandidate !== offsetNow) {
              updates.nextRun = getNextRun(parsed, nowDate, offsetAtCandidate).getTime();
            } else {
              updates.nextRun = candidate.getTime();
            }
          } catch {
            // cron 无效，禁用任务避免反复触发（不再入堆）
            updates.enabled = false;
            updates.nextRun = undefined;
          }
        }

        const updated = this.store.update(task.id, updates);
        if (!updated) {
          this.heapDirty = true;
          continue;
        }

        // M5 修复：如果任务仍启用且有新的 nextRun，用更新后的数据重新入堆
        if (updates.enabled !== false && updates.nextRun !== undefined) {
          this.heap.push({ ...task, ...updates });
        }
      } catch {
        this.heapDirty = true;
      }
    }
    } finally {
      this.checking = false;
    }
  }
}

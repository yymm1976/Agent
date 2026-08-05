/**
 * Serializes complete agent runs.
 *
 * ReActAgentLoop keeps mutable run-local fields for confirmations, context and
 * event sequencing. A single FIFO at the sendChat boundary is therefore the
 * safety boundary; queueing only the loop body would still allow routing and
 * context preparation to race.
 */
export type AgentRunSchedulerState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentRunSchedulerSnapshot {
  id: string;
  state: AgentRunSchedulerState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** C2：工作区标识（同一 workspace 的 run 排队相邻，供审计/排序） */
  workspaceId?: string;
}

interface QueueEntry {
  id: string;
  queuedAt: number;
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  controller: AbortController;
  workspaceId?: string;
}

const cancelledError = (id: string): Error => {
  const error = new Error(`Agent run cancelled: ${id}`);
  error.name = 'AbortError';
  return error;
};

export class AgentRunScheduler {
  private readonly queue: QueueEntry[] = [];
  private readonly states = new Map<string, AgentRunSchedulerSnapshot>();
  private active: QueueEntry | null = null;
  private draining = false;

  constructor(
    private readonly maxQueueSize = 32,
    private readonly timeoutMs = 30 * 60 * 1000,
  ) {}

  /**
   * 排队一个 agent run。
   * @param options.workspaceId 工作区标识——仅作为状态快照/审计元数据；
   *   调度仍维持全局 FIFO（当前 ReActAgentLoop 是实例级单例，NativeAgentKernel
   *   显式互斥，不同 workspace 的 run 无法并行）。真正的多 worktree 并行需要
   *   每 worktree 一个 loop 实例（未来架构，见技术债 TD-22）。
   */
  enqueue(id: string, run: (signal: AbortSignal) => Promise<void>, options?: { workspaceId?: string }): Promise<void> {
    if (this.active?.id === id || this.queue.some((entry) => entry.id === id)) {
      return Promise.reject(new Error(`Agent run already queued or running: ${id}`));
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new Error('Agent run queue is full'));
    }

    const queuedAt = Date.now();
    this.states.set(id, {
      id,
      state: 'queued',
      queuedAt,
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
    });
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({
        id,
        queuedAt,
        run,
        resolve,
        reject,
        controller: new AbortController(),
        ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      });
    });
    void this.drain();
    return promise;
  }

  cancel(id: string): boolean {
    const queuedIndex = this.queue.findIndex((entry) => entry.id === id);
    if (queuedIndex >= 0) {
      const [entry] = this.queue.splice(queuedIndex, 1);
      this.states.set(id, {
        ...(this.states.get(id) ?? { id, queuedAt: entry.queuedAt }),
        state: 'cancelled',
        finishedAt: Date.now(),
      });
      entry.reject(cancelledError(id));
      return true;
    }
    if (this.active?.id === id) {
      this.active.controller.abort();
      return true;
    }
    return false;
  }

  getState(id: string): AgentRunSchedulerSnapshot | null {
    const state = this.states.get(id);
    return state ? { ...state } : null;
  }

  list(): AgentRunSchedulerSnapshot[] {
    return [...this.states.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  }

  clear(): void {
    for (const entry of [...this.queue]) this.cancel(entry.id);
    if (this.active) this.active.controller.abort();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        this.active = entry;
        this.states.set(entry.id, {
          ...(this.states.get(entry.id) ?? { id: entry.id, queuedAt: entry.queuedAt }),
          state: 'running',
          startedAt: Date.now(),
        });
        try {
          await this.withTimeout(entry, entry.controller.signal);
          this.states.set(entry.id, {
            ...this.states.get(entry.id)!,
            state: 'completed',
            finishedAt: Date.now(),
          });
          entry.resolve();
        } catch (error) {
          const cancelled = entry.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
          this.states.set(entry.id, {
            ...this.states.get(entry.id)!,
            state: cancelled ? 'cancelled' : 'failed',
            finishedAt: Date.now(),
          });
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async withTimeout(entry: QueueEntry, signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        entry.controller.abort();
        reject(new Error(`Agent run timed out: ${entry.id}`));
      }, this.timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(cancelledError(entry.id));
      else signal.addEventListener('abort', () => reject(cancelledError(entry.id)), { once: true });
    });
    try {
      await Promise.race([entry.run(signal), timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

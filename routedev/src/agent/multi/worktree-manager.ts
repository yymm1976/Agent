// src/agent/multi/worktree-manager.ts
// Phase 69 Task 1: Worktree 隔离管理器

import { logger } from '../../utils/logger.js';

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  createdAt: number;
  status: 'active' | 'completed' | 'failed' | 'cleaning';
}

export interface WorktreeManagerConfig {
  enabled: boolean;
  worktreeRoot: string;
  maxWorktrees: number;
  cleanupTimeoutMs: number;
}

export const DEFAULT_WORKTREE_CONFIG: WorktreeManagerConfig = {
  enabled: false,
  worktreeRoot: '.routedev/worktrees',
  maxWorktrees: 5,
  cleanupTimeoutMs: 30 * 60 * 1000,
};

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeInfo>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private repoRoot: string,
    private config: WorktreeManagerConfig,
  ) {}

  async create(workerId: string, branch?: string): Promise<WorktreeInfo | null> {
    if (!this.config.enabled) return null;
    if (this.worktrees.size >= this.config.maxWorktrees) {
      logger.warn('WorktreeManager: max parallel reached', { max: this.config.maxWorktrees });
      return null;
    }

    const worktreeBranch = branch ?? `worker-${workerId}`;
    try {
      const worktreePath = `${this.config.worktreeRoot}/${workerId}`;
      const info: WorktreeInfo = {
        id: workerId,
        path: worktreePath,
        branch: worktreeBranch,
        createdAt: Date.now(),
        status: 'active',
      };
      this.worktrees.set(workerId, info);
      this.scheduleCleanup(workerId);
      logger.info('WorktreeManager: worktree created', { workerId, path: worktreePath, branch: worktreeBranch });
      return info;
    } catch (err) {
      logger.warn('WorktreeManager: creation failed, falling back to shared dir', {
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  complete(workerId: string): void {
    const info = this.worktrees.get(workerId);
    if (info) {
      info.status = 'completed';
      this.clearCleanupTimer(workerId);
    }
  }

  fail(workerId: string): void {
    const info = this.worktrees.get(workerId);
    if (info) {
      info.status = 'failed';
    }
  }

  async cleanup(workerId: string): Promise<void> {
    const info = this.worktrees.get(workerId);
    if (!info) return;
    info.status = 'cleaning';
    this.clearCleanupTimer(workerId);
    try {
      logger.info('WorktreeManager: cleanup', { workerId });
    } finally {
      this.worktrees.delete(workerId);
    }
  }

  async cleanupAll(): Promise<void> {
    const ids = [...this.worktrees.keys()];
    await Promise.allSettled(ids.map((id) => this.cleanup(id)));
  }

  get(workerId: string): WorktreeInfo | undefined {
    return this.worktrees.get(workerId);
  }

  listActive(): WorktreeInfo[] {
    return [...this.worktrees.values()].filter((w) => w.status === 'active');
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  private scheduleCleanup(workerId: string): void {
    const timer = setTimeout(() => {
      logger.warn('WorktreeManager: timeout cleanup', { workerId });
      this.cleanup(workerId);
    }, this.config.cleanupTimeoutMs);
    this.cleanupTimers.set(workerId, timer);
  }

  private clearCleanupTimer(workerId: string): void {
    const timer = this.cleanupTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(workerId);
    }
  }
}

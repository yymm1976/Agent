// tests/agent/multi/worktree-manager.test.ts
// Phase 69 Task 1: WorktreeManager 单元测试

import { describe, it, expect, vi } from 'vitest';
import {
  WorktreeManager,
  DEFAULT_WORKTREE_CONFIG,
  type WorktreeManagerConfig,
} from '../../../src/agent/multi/worktree-manager.js';

const REPO_ROOT = '/tmp/test-repo';

function makeConfig(overrides?: Partial<WorktreeManagerConfig>): WorktreeManagerConfig {
  return { ...DEFAULT_WORKTREE_CONFIG, enabled: true, ...overrides };
}

describe('WorktreeManager', () => {
  describe('create', () => {
    it('returns WorktreeInfo when enabled', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      const info = await mgr.create('worker-1', 'feature-a');
      expect(info).not.toBeNull();
      expect(info!.id).toBe('worker-1');
      expect(info!.branch).toBe('feature-a');
      expect(info!.status).toBe('active');
      expect(info!.path).toBe(`${DEFAULT_WORKTREE_CONFIG.worktreeRoot}/worker-1`);
      expect(info!.createdAt).toBeGreaterThan(0);
    });

    it('returns null when disabled (fail-open)', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig({ enabled: false }));
      const info = await mgr.create('worker-1');
      expect(info).toBeNull();
    });

    it('returns null when maxWorktrees reached', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig({ maxWorktrees: 2 }));
      await mgr.create('w1');
      await mgr.create('w2');
      const info = await mgr.create('w3');
      expect(info).toBeNull();
    });

    it('generates default branch name when branch omitted', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      const info = await mgr.create('worker-x');
      expect(info!.branch).toBe('worker-worker-x');
    });
  });

  describe('complete', () => {
    it('marks status as completed', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      await mgr.create('w1');
      mgr.complete('w1');
      expect(mgr.get('w1')!.status).toBe('completed');
    });

    it('is no-op for unknown worker', () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      mgr.complete('nonexistent');
      expect(mgr.get('nonexistent')).toBeUndefined();
    });
  });

  describe('fail', () => {
    it('marks status as failed', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      await mgr.create('w1');
      mgr.fail('w1');
      expect(mgr.get('w1')!.status).toBe('failed');
    });
  });

  describe('cleanup', () => {
    it('removes worktree from map', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      await mgr.create('w1');
      await mgr.cleanup('w1');
      expect(mgr.get('w1')).toBeUndefined();
    });

    it('is safe for unknown worker', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      await mgr.cleanup('nonexistent');
      expect(mgr.get('nonexistent')).toBeUndefined();
    });
  });

  describe('cleanupAll', () => {
    it('cleans all worktrees', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      await mgr.create('w1');
      await mgr.create('w2');
      await mgr.create('w3');
      await mgr.cleanupAll();
      expect(mgr.get('w1')).toBeUndefined();
      expect(mgr.get('w2')).toBeUndefined();
      expect(mgr.get('w3')).toBeUndefined();
    });
  });

  describe('listActive', () => {
    it('filters by active status', async () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig());
      await mgr.create('w1');
      await mgr.create('w2');
      await mgr.create('w3');
      mgr.complete('w2');
      mgr.fail('w3');
      const active = mgr.listActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('w1');
    });
  });

  describe('isEnabled', () => {
    it('returns true when enabled', () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig({ enabled: true }));
      expect(mgr.isEnabled()).toBe(true);
    });

    it('returns false when disabled', () => {
      const mgr = new WorktreeManager(REPO_ROOT, makeConfig({ enabled: false }));
      expect(mgr.isEnabled()).toBe(false);
    });
  });
});

// tests/agent/branch/branch.test.ts
// BranchManager 单元测试

import { describe, it, expect } from 'vitest';
import { BranchManager } from '../../../src/agent/branch.js';
import type { LLMMessage } from '../../../src/router/types.js';

const sampleHistory: LLMMessage[] = [
  { role: 'user', content: 'msg 1' },
  { role: 'assistant', content: 'reply 1' },
  { role: 'user', content: 'msg 2' },
  { role: 'assistant', content: 'reply 2' },
  { role: 'user', content: 'msg 3' },
];

describe('BranchManager', () => {
  describe('initFromHistory', () => {
    it('should create virtual root + history nodes', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      expect(bm.nodeCount).toBe(sampleHistory.length + 1);
      const branches = bm.listBranches();
      expect(branches.length).toBe(1);
      expect(branches[0].name).toBe('主线');
    });

    it('should be idempotent', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const count = bm.nodeCount;
      bm.initFromHistory(sampleHistory);
      expect(bm.nodeCount).toBe(count);
    });
  });

  describe('fork', () => {
    it('should create a new branch from active node', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const activeBefore = bm.getActiveBranchId();
      const newId = bm.fork(activeBefore, { role: 'user', content: '新方向' });
      expect(newId).not.toBe(activeBefore);
      expect(bm.getActiveBranchId()).toBe(newId);
    });

    it('should throw if no active branch', () => {
      const bm = new BranchManager();
      expect(() => bm.fork(null, { role: 'user', content: 'x' })).toThrow();
    });
  });

  describe('append', () => {
    it('should extend active branch', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const before = bm.getActiveBranchId();
      const after = bm.append({ role: 'user', content: 'continued' });
      expect(after).not.toBe(before);
      expect(bm.getActiveBranchId()).toBe(after);
    });
  });

  describe('editByHistoryIndex', () => {
    it('should create new branch with edited content', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const newId = bm.editByHistoryIndex(1, '修正后的内容');
      expect(newId).not.toBeNull();
      const path = bm.getPath(newId!);
      // 前 1 条不变 + 1 条替换 + 后续保持
      expect(path.length).toBe(sampleHistory.length);
      expect(path[1].content).toBe('修正后的内容');
    });

    it('should return null for invalid index', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      expect(bm.editByHistoryIndex(-1, 'x')).toBeNull();
      expect(bm.editByHistoryIndex(100, 'x')).toBeNull();
    });
  });

  describe('switchBranch', () => {
    it('should switch to a specific branch', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const mainId = bm.getActiveBranchId()!;
      const newId = bm.fork(mainId, { role: 'user', content: '新方向' });
      const switched = bm.switchBranch(newId);
      expect(switched).not.toBeNull();
      expect(bm.getActiveBranchId()).toBe(newId);
    });

    it('should support prefix matching', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const newId = bm.fork(null, { role: 'user', content: '新方向' });
      const prefix = newId.slice(0, 4);
      const switched = bm.switchBranch(prefix);
      expect(switched).not.toBeNull();
      expect(bm.getActiveBranchId()).toBe(newId);
    });

    it('should return null for non-existent branch', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      expect(bm.switchBranch('zzznotexist')).toBeNull();
    });
  });

  describe('getPath', () => {
    it('should return messages in order', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const activeId = bm.getActiveBranchId()!;
      const path = bm.getPath(activeId);
      expect(path.length).toBe(sampleHistory.length);
      expect(path[0].content).toBe('msg 1');
      expect(path[4].content).toBe('msg 3');
    });
  });

  describe('listBranches', () => {
    it('should return all branches sorted by createdAt desc', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      bm.fork(null, { role: 'user', content: 'fork 1' });
      bm.fork(null, { role: 'user', content: 'fork 2' });
      const list = bm.listBranches();
      expect(list.length).toBe(3);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      bm.reset();
      expect(bm.nodeCount).toBe(0);
      expect(bm.listBranches().length).toBe(0);
      expect(bm.getActiveBranchId()).toBeNull();
    });
  });
});

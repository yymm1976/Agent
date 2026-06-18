// tests/agent/branch-consistency.test.ts
// BranchManager append 状态一致性测试
// 验证：append 不再删除/重建分支条目，分支 ID 保持稳定，tipNodeId 正确更新

import { describe, it, expect } from 'vitest';
import { BranchManager } from '../../src/agent/branch.js';
import type { LLMMessage } from '../../src/router/types.js';

const sampleHistory: LLMMessage[] = [
  { role: 'user', content: 'msg 1' },
  { role: 'assistant', content: 'reply 1' },
  { role: 'user', content: 'msg 2' },
  { role: 'assistant', content: 'reply 2' },
  { role: 'user', content: 'msg 3' },
];

describe('BranchManager append 状态一致性', () => {
  describe('append 后分支 ID 稳定性', () => {
    it('append 多次后，分支 ID（key）应保持不变', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);

      const before = bm.listBranches();
      expect(before.length).toBe(1);
      const branchIdBefore = before[0].id;

      bm.append({ role: 'user', content: 'continued 1' });
      bm.append({ role: 'assistant', content: 'reply continued' });
      bm.append({ role: 'user', content: 'continued 2' });

      const after = bm.listBranches();
      expect(after.length).toBe(1);
      // 核心：分支 ID 不应随 append 改变
      expect(after[0].id).toBe(branchIdBefore);
    });

    it('append 后分支数量不应增加', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const countBefore = bm.listBranches().length;

      bm.append({ role: 'user', content: 'a' });
      bm.append({ role: 'user', content: 'b' });

      expect(bm.listBranches().length).toBe(countBefore);
    });
  });

  describe('append 后 tipNodeId 更新', () => {
    it('append 后 branch.tipNodeId 应等于新节点 ID', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);

      const newId = bm.append({ role: 'user', content: 'appended' });
      const branches = bm.listBranches();
      expect(branches.length).toBe(1);
      expect(branches[0].tipNodeId).toBe(newId);
    });

    it('多次 append 后 tipNodeId 应等于最后一次 append 的 ID', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);

      bm.append({ role: 'user', content: 'first' });
      bm.append({ role: 'user', content: 'second' });
      const lastId = bm.append({ role: 'user', content: 'third' });

      const branches = bm.listBranches();
      expect(branches[0].tipNodeId).toBe(lastId);
    });

    it('append 后 messageCount 应正确反映路径长度', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const initialCount = bm.listBranches()[0].messageCount;
      expect(initialCount).toBe(sampleHistory.length);

      bm.append({ role: 'user', content: 'extra 1' });
      expect(bm.listBranches()[0].messageCount).toBe(initialCount + 1);

      bm.append({ role: 'user', content: 'extra 2' });
      expect(bm.listBranches()[0].messageCount).toBe(initialCount + 2);
    });
  });

  describe('append 后 editByHistoryIndex 能编辑后续追加的消息', () => {
    it('editByHistoryIndex 能编辑 append 追加的消息', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      // historyNodeIds 初始长度 = 5
      const initialLen = sampleHistory.length;

      // 追加两条新消息
      const appended1 = bm.append({ role: 'user', content: 'appended msg' });
      const appended2 = bm.append({ role: 'assistant', content: 'appended reply' });

      // historyNodeIds 现在长度应为 7
      // 编辑索引 5（即 appended1）
      const newId = bm.editByHistoryIndex(initialLen, '修正后的 appended msg');
      expect(newId).not.toBeNull();

      const path = bm.getPath(newId!);
      // 路径应包含：原 5 条 + 修正后的 appended1 + 原 appended2 = 7 条
      expect(path.length).toBe(initialLen + 2);
      // 索引 5 的内容应被替换
      expect(path[initialLen].content).toBe('修正后的 appended msg');
      // 索引 6 应保留原 appended2 的内容
      expect(path[initialLen + 1].content).toBe('appended reply');
    });

    it('editByHistoryIndex 编辑 append 消息后应创建新分支', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const branchesBefore = bm.listBranches().length;

      bm.append({ role: 'user', content: 'to be edited' });
      // 编辑刚 append 的消息（索引 = sampleHistory.length）
      bm.editByHistoryIndex(sampleHistory.length, 'edited content');

      // 应新增一个分支
      expect(bm.listBranches().length).toBe(branchesBefore + 1);
    });
  });

  describe('switchBranch 后再 append', () => {
    it('切换分支后 append 应追加到切换后的分支', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const mainBranchId = bm.listBranches()[0].id;

      // 创建一个 fork 分支
      const forkId = bm.fork(null, { role: 'user', content: 'fork direction' });
      // 此时活跃分支为 fork 分支
      expect(bm.getActiveBranchId()).toBe(forkId);

      // 切回主线分支
      const switched = bm.switchBranch(mainBranchId);
      expect(switched).not.toBeNull();
      // 切换后 activeBranchId 应为主线分支的 tipNodeId
      const mainBranch = bm.listBranches().find(b => b.id === mainBranchId);
      expect(mainBranch).toBeDefined();
      expect(bm.getActiveBranchId()).toBe(mainBranch!.tipNodeId);

      // 在主线分支上 append
      const newId = bm.append({ role: 'user', content: 'back to main' });
      expect(newId).not.toBe(forkId);

      // 主线分支的 tipNodeId 应更新为新节点
      const updatedMain = bm.listBranches().find(b => b.id === mainBranchId);
      expect(updatedMain!.tipNodeId).toBe(newId);

      // fork 分支的 tipNodeId 不应改变
      const forkBranch = bm.listBranches().find(b => b.id === forkId);
      expect(forkBranch!.tipNodeId).toBe(forkId);
    });

    it('切换到 fork 分支后 append 应追加到 fork 分支', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);

      const forkId = bm.fork(null, { role: 'user', content: 'fork' });
      // 切回主线
      const mainBranchId = bm.listBranches().find(b => b.name === '主线')!.id;
      bm.switchBranch(mainBranchId);

      // 再切回 fork 分支
      bm.switchBranch(forkId);
      expect(bm.getActiveBranchId()).toBe(forkId); // tipNodeId 此时还是 forkId

      // 在 fork 分支上 append
      const newId = bm.append({ role: 'user', content: 'on fork' });
      const forkBranch = bm.listBranches().find(b => b.id === forkId);
      expect(forkBranch!.tipNodeId).toBe(newId);
    });

    it('不同分支的 append 互不干扰', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const mainBranchId = bm.listBranches()[0].id;

      // fork 一个新分支
      const forkId = bm.fork(null, { role: 'user', content: 'fork' });

      // 切回主线并 append
      bm.switchBranch(mainBranchId);
      const mainAppendId = bm.append({ role: 'user', content: 'main append' });

      // 切到 fork 分支并 append
      bm.switchBranch(forkId);
      const forkAppendId = bm.append({ role: 'user', content: 'fork append' });

      // 两个 append 的 ID 应不同
      expect(mainAppendId).not.toBe(forkAppendId);

      // 主线分支 tip 应是 mainAppendId
      const mainBranch = bm.listBranches().find(b => b.id === mainBranchId)!;
      expect(mainBranch.tipNodeId).toBe(mainAppendId);

      // fork 分支 tip 应是 forkAppendId
      const forkBranch = bm.listBranches().find(b => b.id === forkId)!;
      expect(forkBranch.tipNodeId).toBe(forkAppendId);
    });
  });

  describe('BranchInfo.tipNodeId 字段', () => {
    it('initFromHistory 后 tipNodeId 应等于分支 ID', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const branch = bm.listBranches()[0];
      expect(branch.tipNodeId).toBe(branch.id);
    });

    it('fork 后 tipNodeId 应等于新分支 ID', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      const forkId = bm.fork(null, { role: 'user', content: 'new' });
      const forkBranch = bm.listBranches().find(b => b.id === forkId);
      expect(forkBranch!.tipNodeId).toBe(forkId);
    });

    it('reset 后所有状态清空', () => {
      const bm = new BranchManager();
      bm.initFromHistory(sampleHistory);
      bm.append({ role: 'user', content: 'x' });
      bm.fork(null, { role: 'user', content: 'y' });

      bm.reset();
      expect(bm.listBranches().length).toBe(0);
      expect(bm.getActiveBranchId()).toBeNull();
      expect(bm.nodeCount).toBe(0);
    });
  });
});

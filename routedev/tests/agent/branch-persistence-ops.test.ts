// tests/agent/branch-persistence-ops.test.ts
// 节点持久化 + 节点级操作测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { BranchManager, type BranchNode, type BranchInfo } from '../../src/agent/branch.js';
import type { LLMMessage } from '../../src/router/types.js';
import {
  BranchPersistence,
  type PersistedConversationTree,
} from '../../src/agent/branch-persistence.js';
import { BranchOperations } from '../../src/agent/branch-operations.js';

const sampleHistory: LLMMessage[] = [
  { role: 'user', content: 'msg 1' },
  { role: 'assistant', content: 'reply 1' },
  { role: 'user', content: 'msg 2' },
  { role: 'assistant', content: 'reply 2' },
  { role: 'user', content: 'msg 3' },
];

// ============================================================
// 工具：通过 any 访问 BranchManager 内部字段（与 BranchOperations 同策略）
// ============================================================
function managerInternals(bm: BranchManager): {
  nodes: Map<string, BranchNode>;
  branches: Map<string, BranchInfo>;
  activeBranchId: string | null;
  activeBranchKey: string | null;
  historyNodeIds: string[];
} {
  return bm as unknown as {
    nodes: Map<string, BranchNode>;
    branches: Map<string, BranchInfo>;
    activeBranchId: string | null;
    activeBranchKey: string | null;
    historyNodeIds: string[];
  };
}

describe('BranchPersistence', () => {
  let tmpDir: string;
  let persistence: BranchPersistence;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'routedev-persist-'));
    persistence = new BranchPersistence(tmpDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  function buildTree(): PersistedConversationTree {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    return BranchPersistence.extractFromManager(managerInternals(bm));
  }

  it('1. save + load 往返一致', async () => {
    const tree = buildTree();
    await persistence.save(tree);
    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.nodes.length).toBe(tree.nodes.length);
    expect(loaded!.branches.length).toBe(tree.branches.length);
    expect(loaded!.activeBranchId).toBe(tree.activeBranchId);
    expect(loaded!.activeBranchKey).toBe(tree.activeBranchKey);
    expect(loaded!.historyNodeIds).toEqual(tree.historyNodeIds);
    expect(loaded!.version).toBe(1);
  });

  it('2. load 损坏文件时从 .bak 恢复', async () => {
    const tree = buildTree();
    await persistence.save(tree);
    // 再次 save 一次，让 .bak 也存在（保存时会把当前文件备份到 .bak）
    const tree2 = buildTree();
    tree2.lastModifiedAt = Date.now() + 1000;
    await persistence.save(tree2);

    // 现在正式文件是 tree2，.bak 是 tree
    // 把正式文件破坏
    const filePath = path.join(tmpDir, '.routedev', 'conversation', 'tree.jsonl');
    await fsp.writeFile(filePath, 'not-valid-json\n{broken', 'utf8');

    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    // 应该回退到 .bak（即 tree，第一次保存的）
    expect(loaded!.nodes.length).toBe(tree.nodes.length);
  });

  it('3. validate 检测到缺失节点引用', () => {
    const tree = buildTree();
    // 制造缺失引用：把某个节点的 parentId 改成不存在的值
    const tampered: PersistedConversationTree = {
      ...tree,
      nodes: tree.nodes.map((n, i) =>
        i === 1 ? { ...n, parentId: 'non-existent-parent' } : n,
      ),
    };
    const errors = BranchPersistence.validate(tampered);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('missing-parent'))).toBe(true);
  });

  it('4. validate 检测到孤立分支', () => {
    const tree = buildTree();
    // 制造孤立分支：parentId 指向不存在的分支
    const tampered: PersistedConversationTree = {
      ...tree,
      branches: tree.branches.map((b, i) =>
        i === 0 ? { ...b, parentId: 'non-existent-branch' } : b,
      ),
    };
    const errors = BranchPersistence.validate(tampered);
    expect(errors.some(e => e.includes('orphan-branch'))).toBe(true);
  });

  it('5. saveSnapshot + loadSnapshot 往返', async () => {
    const tree = buildTree();
    const snapName = await persistence.saveSnapshot(tree);
    expect(snapName).toMatch(/^snap-\d+\.jsonl$/);

    const snaps = persistence.listSnapshots();
    expect(snaps).toContain(snapName);

    const loaded = await persistence.loadSnapshot(snapName);
    expect(loaded).not.toBeNull();
    expect(loaded!.nodes.length).toBe(tree.nodes.length);
    expect(loaded!.branches.length).toBe(tree.branches.length);
  });

  it('6. extractFromManager + applyToManager 往返', () => {
    const bm1 = new BranchManager();
    bm1.initFromHistory(sampleHistory);
    bm1.append({ role: 'assistant', content: 'extra' });

    const tree = BranchPersistence.extractFromManager(managerInternals(bm1));
    expect(tree.nodes.length).toBe(sampleHistory.length + 2); // root + 5 + extra

    const bm2 = new BranchManager();
    BranchPersistence.applyToManager(tree, managerInternals(bm2));

    const i2 = managerInternals(bm2);
    const i1 = managerInternals(bm1);
    expect(i2.nodes.size).toBe(i1.nodes.size);
    expect(i2.branches.size).toBe(i1.branches.size);
    expect(i2.activeBranchId).toBe(i1.activeBranchId);
    expect(i2.activeBranchKey).toBe(i1.activeBranchKey);
    expect(i2.historyNodeIds).toEqual(i1.historyNodeIds);

    // 验证 getPath 一致
    const path1 = bm1.getPath(i1.activeBranchId!);
    const path2 = bm2.getPath(i2.activeBranchId!);
    expect(path2).toEqual(path1);
  });
});

describe('BranchOperations', () => {
  let bm: BranchManager;
  let ops: BranchOperations;

  beforeEach(() => {
    bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    ops = new BranchOperations(bm);
  });

  it('7. deleteByHistoryIndex 子节点挂到父节点', () => {
    const m = managerInternals(bm);
    const targetId = m.historyNodeIds[1]; // reply 1
    const target = m.nodes.get(targetId)!;
    const parentId = target.parentId!;
    const childId = m.historyNodeIds[2]; // msg 2 (target 的子节点)

    const result = ops.deleteByHistoryIndex(1);
    expect(result.success).toBe(true);

    // 目标节点已删除
    expect(m.nodes.has(targetId)).toBe(false);
    // 子节点应挂到父节点下
    const parent = m.nodes.get(parentId)!;
    expect(parent.children).toContain(childId);
    const child = m.nodes.get(childId)!;
    expect(child.parentId).toBe(parentId);
    // historyNodeIds 中已移除目标
    expect(m.historyNodeIds).not.toContain(targetId);
  });

  it('8. deleteByHistoryIndex 分支 tip 回退', () => {
    const m = managerInternals(bm);
    // 当前活跃分支 tip 应是最后一条历史消息
    const lastHistoryId = m.historyNodeIds[m.historyNodeIds.length - 1];
    const branch = m.branches.get(m.activeBranchKey!)!;
    expect(branch.tipNodeId).toBe(lastHistoryId);

    // 删除最后一条
    const result = ops.deleteByHistoryIndex(m.historyNodeIds.length - 1);
    expect(result.success).toBe(true);

    // 分支 tip 应回退到父节点
    const updatedBranch = m.branches.get(m.activeBranchKey!)!;
    const deletedNode = m.nodes.get(lastHistoryId); // 已删除
    expect(deletedNode).toBeUndefined();
    // tip 应该不是已删除的节点
    expect(updatedBranch.tipNodeId).not.toBe(lastHistoryId);
    expect(m.nodes.has(updatedBranch.tipNodeId)).toBe(true);
  });

  it('9. insertByHistoryIndex 原后续消息成为新节点子节点', () => {
    const m = managerInternals(bm);
    const insertIndex = 1;
    const targetId = m.historyNodeIds[insertIndex];
    const laterCount = m.historyNodeIds.length - insertIndex - 1; // 后续消息数

    const result = ops.insertByHistoryIndex(insertIndex, {
      role: 'user',
      content: 'inserted msg',
    });
    expect(result.success).toBe(true);
    expect(result.newBranchId).toBeDefined();

    // 新分支应存在
    const newBranch = m.branches.get(result.newBranchId!)!;
    expect(newBranch).toBeDefined();

    // 新节点应存在
    const m2 = managerInternals(bm);
    // 找到新插入的节点（content === 'inserted msg'）
    let insertedNode: BranchNode | undefined;
    for (const n of m2.nodes.values()) {
      if (n.message.content === 'inserted msg') {
        insertedNode = n;
        break;
      }
    }
    expect(insertedNode).toBeDefined();
    expect(insertedNode!.parentId).toBe(targetId);

    // 新节点应有子节点（原后续消息的副本）
    expect(insertedNode!.children.length).toBeGreaterThan(0);

    // 新分支 tip 应是最后一条复制的消息
    const tipNode = m2.nodes.get(newBranch.tipNodeId);
    expect(tipNode).toBeDefined();

    // 新分支 messageCount 应包含：原前缀（insertIndex+1 条，含 root 不计）+ 1 新消息 + laterCount 后续
    // = insertIndex+1 + 1 + laterCount = sampleHistory.length + 1
    expect(newBranch.messageCount).toBe(sampleHistory.length + 1);
  });

  it('10. editRange 批量编辑生成新分支', () => {
    const m = managerInternals(bm);
    const branchCountBefore = m.branches.size;

    const result = ops.editRange(1, 2, [
      { role: 'assistant', content: 'edited reply 1' },
      { role: 'user', content: 'edited msg 2' },
    ]);
    expect(result.success).toBe(true);
    expect(result.newBranchId).toBeDefined();

    // 新分支已创建
    const m2 = managerInternals(bm);
    expect(m2.branches.size).toBe(branchCountBefore + 1);

    const newBranch = m2.branches.get(result.newBranchId!)!;
    expect(newBranch.isActive).toBe(true);

    // 新分支 tip 路径应包含编辑后的内容
    const path = bm.getPath(newBranch.tipNodeId);
    expect(path.some(msg => msg.content === 'edited reply 1')).toBe(true);
    expect(path.some(msg => msg.content === 'edited msg 2')).toBe(true);
  });

  it('11. undo 恢复到操作前状态', () => {
    const m = managerInternals(bm);
    const nodesBefore = m.nodes.size;
    const branchesBefore = m.branches.size;
    const historyBefore = [...m.historyNodeIds];
    const activeBefore = m.activeBranchId;

    ops.deleteByHistoryIndex(1);
    expect(m.nodes.size).toBe(nodesBefore - 1);

    const result = ops.undo();
    expect(result.success).toBe(true);

    expect(m.nodes.size).toBe(nodesBefore);
    expect(m.branches.size).toBe(branchesBefore);
    expect(m.historyNodeIds).toEqual(historyBefore);
    expect(m.activeBranchId).toBe(activeBefore);
  });

  it('12. redo 恢复被 undo 的操作', () => {
    const m = managerInternals(bm);
    const nodesBefore = m.nodes.size;

    ops.deleteByHistoryIndex(1);
    const afterDelete = m.nodes.size;
    expect(afterDelete).toBe(nodesBefore - 1);

    ops.undo();
    expect(m.nodes.size).toBe(nodesBefore);

    const result = ops.redo();
    expect(result.success).toBe(true);
    expect(m.nodes.size).toBe(afterDelete);
  });

  it('13. canUndo/canRedo 状态正确', () => {
    expect(ops.canUndo()).toBe(false);
    expect(ops.canRedo()).toBe(false);

    ops.deleteByHistoryIndex(1);

    expect(ops.canUndo()).toBe(true);
    expect(ops.canRedo()).toBe(false);

    ops.undo();

    expect(ops.canUndo()).toBe(false);
    expect(ops.canRedo()).toBe(true);

    ops.redo();

    expect(ops.canUndo()).toBe(true);
    expect(ops.canRedo()).toBe(false);
  });

  it('14. serializeStacks + deserializeStacks 往返', () => {
    // 执行两个操作
    ops.deleteByHistoryIndex(1);
    ops.insertByHistoryIndex(0, { role: 'user', content: 'x' });

    const serialized = ops.serializeStacks();
    expect(serialized.undo.length).toBe(2);
    expect(serialized.redo.length).toBe(0);

    const m = managerInternals(bm);
    const nodesAfterOps = m.nodes.size;

    // 用新 ops 实例恢复栈
    const ops2 = new BranchOperations(bm);
    ops2.deserializeStacks(serialized);
    expect(ops2.canUndo()).toBe(true);
    expect(ops2.getUndoStack().length).toBe(2);

    // undo 两次应回到初始状态（root + 5 history = 6 nodes）
    expect(ops2.undo().success).toBe(true);
    expect(ops2.undo().success).toBe(true);
    expect(m.nodes.size).toBe(sampleHistory.length + 1);
    expect(ops2.canUndo()).toBe(false);
    expect(ops2.canRedo()).toBe(true);

    // redo 两次应恢复到操作后状态
    expect(ops2.redo().success).toBe(true);
    expect(ops2.redo().success).toBe(true);
    expect(m.nodes.size).toBe(nodesAfterOps);
  });

  it('15. undo 栈超过 maxStack 时丢弃最旧', () => {
    // 执行 60 次操作（超过 maxStack=50）
    for (let i = 0; i < 60; i++) {
      // 交替 delete/insert 避免越界
      const m = managerInternals(bm);
      if (m.historyNodeIds.length > 1) {
        ops.deleteByHistoryIndex(0);
      } else {
        ops.insertByHistoryIndex(0, { role: 'user', content: `msg-${i}` });
      }
    }

    // undo 栈应被截断到 maxStack
    expect(ops.getUndoStack().length).toBeLessThanOrEqual(50);
    expect(ops.canUndo()).toBe(true);
  });
});

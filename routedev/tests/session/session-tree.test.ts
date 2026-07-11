// tests/session/session-tree.test.ts
// Phase 84 Task 1：会话树存储模型测试
//
// 覆盖：
//   1.  空树初始化
//   2.  添加节点——线性增长
//   3.  fork——从指定节点创建新分支
//   4.  fork 后新旧分支独立
//   5.  分支切换——活跃分支正确
//   6.  clone——复制当前分支
//   7.  多分支并发存在时数据隔离
//   8.  线性消息导入——向后兼容
//   9.  序列化/反序列化——toJSON/fromJSON 往返
//   10. getPath——获取节点间路径

import { describe, it, expect } from 'vitest';
import { SessionTree } from '../../src/session/session-tree.js';

describe('SessionTree - Phase 84 Task 1', () => {
  // ============================================================
  // 1. 空树初始化
  // ============================================================
  it('1. 空树初始化——constructor 创建根节点，activeBranchId 指向根', () => {
    const tree = new SessionTree();
    expect(tree.rootId).toBeDefined();
    expect(tree.activeBranchId).toBe(tree.rootId);
    expect(tree.nodes.size).toBe(1);
    expect(tree.branches.size).toBe(1);

    const root = tree.getNode(tree.rootId);
    expect(root).toBeDefined();
    expect(root!.parentId).toBeNull();
    expect(root!.role).toBe('system');
    expect(root!.content).toBeNull();
    expect(root!.children).toHaveLength(0);
  });

  // ============================================================
  // 2. 添加节点——线性增长
  // ============================================================
  it('2. 添加节点——线性增长', () => {
    const tree = new SessionTree();
    const id1 = tree.addNode({ parentId: null, role: 'user', content: 'hello' });
    const id2 = tree.addNode({ parentId: null, role: 'assistant', content: 'hi there' });
    const id3 = tree.addNode({ parentId: null, role: 'user', content: 'bye' });

    // root + 3 个消息节点
    expect(tree.nodes.size).toBe(4);
    expect(tree.activeBranchId).toBe(id3);

    // 验证线性链：root → id1 → id2 → id3
    const n1 = tree.getNode(id1)!;
    const n2 = tree.getNode(id2)!;
    const n3 = tree.getNode(id3)!;
    expect(n1.parentId).toBe(tree.rootId);
    expect(n2.parentId).toBe(id1);
    expect(n3.parentId).toBe(id2);

    // 验证 children 列表
    expect(tree.getNode(tree.rootId)!.children).toContain(id1);
    expect(n1.children).toContain(id2);
    expect(n2.children).toContain(id3);
    expect(n3.children).toHaveLength(0);

    // 验证 timestamp 已自动生成
    expect(n1.timestamp).toBeGreaterThan(0);
    expect(n2.timestamp).toBeGreaterThanOrEqual(n1.timestamp);
    expect(n3.timestamp).toBeGreaterThanOrEqual(n2.timestamp);
  });

  // ============================================================
  // 3. fork——从指定节点创建新分支
  // ============================================================
  it('3. fork——从指定节点创建新分支', () => {
    const tree = new SessionTree();
    const id1 = tree.addNode({ parentId: null, role: 'user', content: 'msg1' });
    tree.addNode({ parentId: null, role: 'assistant', content: 'reply1' });

    const newBranchId = tree.fork(id1);
    expect(newBranchId).toBeDefined();
    expect(tree.branches.size).toBe(2);
    expect(tree.branches.has(newBranchId)).toBe(true);

    // fork 后活跃叶节点应指向 fork 点
    expect(tree.activeBranchId).toBe(id1);

    const branch = tree.branches.get(newBranchId)!;
    expect(branch.leafId).toBe(id1);
  });

  // ============================================================
  // 4. fork 后新旧分支独立
  // ============================================================
  it('4. fork 后新旧分支独立', () => {
    const tree = new SessionTree();
    const id1 = tree.addNode({ parentId: null, role: 'user', content: 'msg1' });
    const id2 = tree.addNode({ parentId: null, role: 'assistant', content: 'reply1' });

    // 在 id1 处 fork，然后在新分支追加消息
    tree.fork(id1);
    const newId = tree.addNode({ parentId: null, role: 'assistant', content: 'alt reply' });

    // 新分支叶节点是 newId
    expect(tree.activeBranchId).toBe(newId);

    // id1 现在有两个子节点：id2（旧分支）和 newId（新分支）
    const node1 = tree.getNode(id1)!;
    expect(node1.children).toContain(id2);
    expect(node1.children).toContain(newId);

    // 活跃分支（新分支）路径：root → id1 → newId
    const activePath = tree.getActiveBranch();
    expect(activePath).toHaveLength(3);
    expect(activePath[1].id).toBe(id1);
    expect(activePath[2].id).toBe(newId);
    // 旧分支的 reply1 不应出现在新分支路径中
    expect(activePath.find(n => n.id === id2)).toBeUndefined();
  });

  // ============================================================
  // 5. 分支切换——活跃分支正确
  // ============================================================
  it('5. 分支切换——活跃分支正确', () => {
    const tree = new SessionTree();
    const id1 = tree.addNode({ parentId: null, role: 'user', content: 'msg1' });
    const id2 = tree.addNode({ parentId: null, role: 'assistant', content: 'reply1' });

    // 记录旧分支 key（初始分支）
    const oldBranchKey = [...tree.branches.keys()][0];

    // fork 新分支并追加消息
    const newBranchId = tree.fork(id1);
    tree.addNode({ parentId: null, role: 'assistant', content: 'alt reply' });

    // 切换回旧分支
    tree.switchBranch(oldBranchKey);
    expect(tree.activeBranchId).toBe(id2);

    const oldActive = tree.getActiveBranch();
    // 旧分支路径：root → id1 → id2
    expect(oldActive).toHaveLength(3);
    expect(oldActive[2].id).toBe(id2);

    // 切换到新分支
    tree.switchBranch(newBranchId);
    const newActive = tree.getActiveBranch();
    // 新分支路径：root → id1 → alt reply
    expect(newActive).toHaveLength(3);
    expect(newActive[2].content).toBe('alt reply');
  });

  // ============================================================
  // 6. clone——复制当前分支
  // ============================================================
  it('6. clone——复制当前分支', () => {
    const tree = new SessionTree();
    tree.addNode({ parentId: null, role: 'user', content: 'msg1' });
    tree.addNode({ parentId: null, role: 'assistant', content: 'reply1' });
    tree.addNode({ parentId: null, role: 'user', content: 'msg2' });

    const cloned = tree.clone();
    expect(cloned).toBeDefined();
    // 新树根 ID 应与原树不同
    expect(cloned.rootId).not.toBe(tree.rootId);

    // 克隆树应有：新根 + 3 个消息节点 = 4 个节点
    expect(cloned.nodes.size).toBe(4);
    expect(cloned.branches.size).toBe(1);

    // 验证内容一致（跳过根节点）
    const origPath = tree.getActiveBranch().filter(n => n.parentId !== null);
    const clonePath = cloned.getActiveBranch().filter(n => n.parentId !== null);
    expect(clonePath).toHaveLength(origPath.length);
    for (let i = 0; i < origPath.length; i++) {
      expect(clonePath[i].role).toBe(origPath[i].role);
      expect(clonePath[i].content).toBe(origPath[i].content);
    }

    // 克隆树的节点 ID 应全部不同
    for (const origNode of origPath) {
      expect(clonePath.find(n => n.id === origNode.id)).toBeUndefined();
    }

    // 克隆树的 activeBranchId 应指向最后一个消息节点
    expect(cloned.activeBranchId).toBe(clonePath[clonePath.length - 1].id);
  });

  // ============================================================
  // 7. 多分支并发存在时数据隔离
  // ============================================================
  it('7. 多分支并发存在时数据隔离', () => {
    const tree = new SessionTree();
    const id1 = tree.addNode({ parentId: null, role: 'user', content: 'base' });

    // 分支 A
    const branchA = tree.fork(id1);
    tree.addNode({ parentId: null, role: 'assistant', content: 'A1' });

    // 分支 B
    const branchB = tree.fork(id1);
    tree.addNode({ parentId: null, role: 'assistant', content: 'B1' });

    // 分支 C
    const branchC = tree.fork(id1);
    tree.addNode({ parentId: null, role: 'assistant', content: 'C1' });

    // main + A + B + C = 4 个分支
    expect(tree.branches.size).toBe(4);

    // 切换到 A，验证内容
    tree.switchBranch(branchA);
    const pathA = tree.getActiveBranch();
    expect(pathA[pathA.length - 1].content).toBe('A1');

    // 切换到 B，验证内容
    tree.switchBranch(branchB);
    const pathB = tree.getActiveBranch();
    expect(pathB[pathB.length - 1].content).toBe('B1');

    // 切换到 C，验证内容
    tree.switchBranch(branchC);
    const pathC = tree.getActiveBranch();
    expect(pathC[pathC.length - 1].content).toBe('C1');

    // 所有分支共享 id1 作为公共前缀
    expect(pathA[1].id).toBe(id1);
    expect(pathB[1].id).toBe(id1);
    expect(pathC[1].id).toBe(id1);

    // 各分支叶节点互不相同
    const leafA = pathA[pathA.length - 1].id;
    const leafB = pathB[pathB.length - 1].id;
    const leafC = pathC[pathC.length - 1].id;
    expect(leafA).not.toBe(leafB);
    expect(leafB).not.toBe(leafC);
    expect(leafA).not.toBe(leafC);
  });

  // ============================================================
  // 8. 线性消息导入——向后兼容
  // ============================================================
  it('8. 线性消息导入——向后兼容', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'how are you' },
      { role: 'assistant', content: 'fine' },
    ];
    const tree = SessionTree.fromLinear(messages);

    // root + 4 个消息节点 = 5 个节点
    expect(tree.nodes.size).toBe(5);
    expect(tree.branches.size).toBe(1);

    const active = tree.getActiveBranch();
    // 路径包含 root + 4 条消息
    expect(active).toHaveLength(5);

    // 跳过 root，验证消息顺序和内容
    const msgs = active.filter(n => n.parentId !== null);
    expect(msgs).toHaveLength(4);
    expect(msgs[0].content).toBe('hello');
    expect(msgs[1].content).toBe('hi');
    expect(msgs[2].content).toBe('how are you');
    expect(msgs[3].content).toBe('fine');

    // 验证 role 正确映射
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  // ============================================================
  // 9. 序列化/反序列化——toJSON/fromJSON 往返
  // ============================================================
  it('9. 序列化/反序列化——toJSON/fromJSON 往返', () => {
    const tree = new SessionTree();
    const id1 = tree.addNode({ parentId: null, role: 'user', content: 'msg1' });
    tree.addNode({ parentId: null, role: 'assistant', content: 'reply1' });

    // 创建分支使树结构更复杂
    tree.fork(id1);
    tree.addNode({ parentId: null, role: 'assistant', content: 'alt reply' });

    const json = tree.toJSON();
    const restored = SessionTree.fromJSON(json);

    // 验证基本字段一致
    expect(restored.rootId).toBe(tree.rootId);
    expect(restored.activeBranchId).toBe(tree.activeBranchId);
    expect(restored.nodes.size).toBe(tree.nodes.size);
    expect(restored.branches.size).toBe(tree.branches.size);

    // 验证所有节点内容一致
    for (const [id, node] of tree.nodes) {
      const restoredNode = restored.getNode(id);
      expect(restoredNode).toBeDefined();
      expect(restoredNode!.role).toBe(node.role);
      expect(restoredNode!.content).toBe(node.content);
      expect(restoredNode!.parentId).toBe(node.parentId);
      expect(restoredNode!.children).toEqual(node.children);
    }

    // 验证活跃分支路径一致
    const origActive = tree.getActiveBranch();
    const restoredActive = restored.getActiveBranch();
    expect(restoredActive).toHaveLength(origActive.length);
    for (let i = 0; i < origActive.length; i++) {
      expect(restoredActive[i].id).toBe(origActive[i].id);
    }
  });

  // ============================================================
  // 10. getPath——获取节点间路径
  // ============================================================
  it('10. getPath——获取节点间路径', () => {
    const tree = new SessionTree();
    const id1 = tree.addNode({ parentId: null, role: 'user', content: 'msg1' });
    const id2 = tree.addNode({ parentId: null, role: 'assistant', content: 'reply1' });
    const id3 = tree.addNode({ parentId: null, role: 'user', content: 'msg2' });

    // 从 id1 到 id3 的路径
    const path = tree.getPath(id1, id3);
    expect(path).toHaveLength(3);
    expect(path[0].id).toBe(id1);
    expect(path[1].id).toBe(id2);
    expect(path[2].id).toBe(id3);

    // 从 root 到 id2 的路径
    const pathFromRoot = tree.getPath(tree.rootId, id2);
    expect(pathFromRoot).toHaveLength(3);
    expect(pathFromRoot[0].id).toBe(tree.rootId);
    expect(pathFromRoot[2].id).toBe(id2);

    // fromId === toId（单节点路径）
    const sameNode = tree.getPath(id2, id2);
    expect(sameNode).toHaveLength(1);
    expect(sameNode[0].id).toBe(id2);

    // toId 不存在时返回空数组
    const notFound = tree.getPath(id1, 'nonexistent-id');
    expect(notFound).toHaveLength(0);
  });
});

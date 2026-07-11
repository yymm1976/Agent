// tests/session/session-commands.test.ts
// Phase 84 Task 2：/tree /fork /clone 命令处理测试
//
// 覆盖：
//   1. /tree 无参数——输出分支结构，标注当前节点
//   2. /tree --jump <nodeId>——跳转到指定节点
//   3. /fork 无参数——从最后一条用户消息 fork
//   4. /fork <nodeId>——从指定节点 fork
//   5. /fork 后新旧分支独立
//   6. /clone——复制当前分支
//   7. 空树时 /tree——返回友好提示
//   8. 无效 nodeId 时 /fork——返回错误提示

import { describe, it, expect } from 'vitest';
import { SessionTree } from '../../src/session/session-tree.js';
import {
  handleTreeCommand,
  handleForkCommand,
  handleCloneCommand,
} from '../../src/session/session-commands.js';

describe('Session Commands - Phase 84 Task 2', () => {
  // ============================================================
  // 1. /tree 无参数——输出分支结构，标注当前节点
  // ============================================================
  it('1. /tree 无参数——输出分支结构，标注当前节点', () => {
    const tree = SessionTree.fromLinear([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);

    const result = handleTreeCommand(tree);

    expect(result.action).toBe('tree');
    // 输出应包含分支结构信息
    expect(result.text).toContain('Session Tree');
    expect(result.text).toContain('user: Hello');
    expect(result.text).toContain('assistant: Hi there');
    // 当前节点（最后一条消息）应被 → 标注
    expect(result.text).toContain('→');
  });

  // ============================================================
  // 2. /tree --jump <nodeId>——跳转到指定节点
  // ============================================================
  it('2. /tree --jump <nodeId>——跳转到指定节点', () => {
    const tree = SessionTree.fromLinear([
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
    ]);

    // 记录 fork 前的路径
    const path = tree.getActiveBranch();
    const reply1Id = path.find(n => n.content === 'reply1')!.id;

    // fork 创建第二个分支
    const firstUser = path.find(n => n.content === 'msg1')!;
    tree.fork(firstUser.id);
    tree.addNode({ parentId: null, role: 'assistant', content: 'alt reply' });

    // 跳转到 reply1（位于 main 分支）
    const result = handleTreeCommand(tree, `--jump ${reply1Id}`);

    expect(result.action).toBe('switch');
    expect(result.text).toContain(reply1Id);
    // 活跃节点应已切换到 reply1
    expect(tree.activeBranchId).toBe(reply1Id);
  });

  // ============================================================
  // 3. /fork 无参数——从最后一条用户消息 fork
  // ============================================================
  it('3. /fork 无参数——从最后一条用户消息 fork', () => {
    const tree = SessionTree.fromLinear([
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
    ]);

    // 获取最后一条用户消息的 ID
    const path = tree.getActiveBranch();
    const lastUser = [...path].reverse().find(n => n.role === 'user')!;
    const expectedForkId = lastUser.id;

    const result = handleForkCommand(tree);

    expect(result.action).toBe('fork');
    expect(result.text).toContain(expectedForkId);
    const data = result.data as { branchId: string; forkNodeId: string };
    expect(data.forkNodeId).toBe(expectedForkId);
    expect(data.branchId).toBeDefined();
    expect(tree.branches.has(data.branchId)).toBe(true);
    // fork 后应自动切换到新分支
    expect(tree.activeBranchId).toBe(expectedForkId);
  });

  // ============================================================
  // 4. /fork <nodeId>——从指定节点 fork
  // ============================================================
  it('4. /fork <nodeId>——从指定节点 fork', () => {
    const tree = SessionTree.fromLinear([
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
    ]);

    const path = tree.getActiveBranch();
    const firstMsg = path.find(n => n.content === 'msg1')!;

    const result = handleForkCommand(tree, firstMsg.id);

    expect(result.action).toBe('fork');
    const data = result.data as { branchId: string; forkNodeId: string };
    expect(data.forkNodeId).toBe(firstMsg.id);
    expect(tree.branches.size).toBe(2);
    expect(tree.branches.has(data.branchId)).toBe(true);
    // fork 后活跃节点应指向 fork 点
    expect(tree.activeBranchId).toBe(firstMsg.id);
  });

  // ============================================================
  // 5. /fork 后新旧分支独立
  // ============================================================
  it('5. /fork 后新旧分支独立', () => {
    const tree = SessionTree.fromLinear([
      { role: 'user', content: 'base' },
      { role: 'assistant', content: 'reply' },
    ]);

    const path = tree.getActiveBranch();
    const baseUser = path.find(n => n.content === 'base')!;
    const oldReplyId = path.find(n => n.content === 'reply')!.id;

    // fork 后追加新消息
    handleForkCommand(tree, baseUser.id);
    const newMsgId = tree.addNode({ parentId: null, role: 'assistant', content: 'alt reply' });

    // 新分支路径应包含 alt reply，不包含旧 reply
    const newActive = tree.getActiveBranch();
    expect(newActive.find(n => n.id === newMsgId)).toBeDefined();
    expect(newActive.find(n => n.content === 'reply')).toBeUndefined();

    // 旧分支的 reply 节点仍在树中（未删除）
    expect(tree.getNode(oldReplyId)).toBeDefined();

    // baseUser 现有两个子节点：旧 reply 和新 alt reply
    const baseNode = tree.getNode(baseUser.id)!;
    expect(baseNode.children).toContain(oldReplyId);
    expect(baseNode.children).toContain(newMsgId);
  });

  // ============================================================
  // 6. /clone——复制当前分支
  // ============================================================
  it('6. /clone——复制当前分支', () => {
    const tree = SessionTree.fromLinear([
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
    ]);

    const result = handleCloneCommand(tree);

    expect(result.action).toBe('clone');
    expect(result.text).toContain('克隆');

    const data = result.data as { newTree: SessionTree; messageCount: number };
    expect(data.newTree).toBeDefined();
    expect(data.messageCount).toBe(2);

    // 新树节点数应与原树一致（root + 2 条消息 = 3）
    expect(data.newTree.nodes.size).toBe(tree.nodes.size);

    // 内容一致但节点 ID 不同
    const origPath = tree.getActiveBranch().filter(n => n.parentId !== null);
    const clonePath = data.newTree.getActiveBranch().filter(n => n.parentId !== null);
    expect(clonePath).toHaveLength(origPath.length);
    expect(clonePath[0].content).toBe('msg1');
    expect(clonePath[1].content).toBe('reply1');
    expect(clonePath[0].id).not.toBe(origPath[0].id);
    expect(clonePath[1].id).not.toBe(origPath[1].id);
  });

  // ============================================================
  // 7. 空树时 /tree——返回友好提示
  // ============================================================
  it('7. 空树时 /tree——返回友好提示', () => {
    const tree = new SessionTree();
    const result = handleTreeCommand(tree);

    expect(result.action).toBe('tree');
    expect(result.text).toContain('空');
  });

  // ============================================================
  // 8. 无效 nodeId 时 /fork——返回错误提示
  // ============================================================
  it('8. 无效 nodeId 时 /fork——返回错误提示', () => {
    const tree = SessionTree.fromLinear([
      { role: 'user', content: 'msg1' },
    ]);

    const result = handleForkCommand(tree, 'nonexistent-id');

    expect(result.action).toBe('fork');
    expect(result.text).toContain('不存在');
    // 树状态不应改变
    expect(tree.branches.size).toBe(1);
  });
});

// src/session/session-tree.ts
// Phase 84 Task 1：会话树存储模型
//
// 管理整棵会话树，支持分支、fork、clone、switchBranch。
// 旧线性消息可通过 fromLinear 导入为单分支树（向后兼容）。
//
// 设计约束：
//   - 纯 TypeScript，无外部依赖（仅用 node:crypto）
//   - ID 生成使用 crypto.randomUUID()
//   - 向后兼容：旧线性消息可通过 fromLinear 导入

import crypto from 'node:crypto';
import type { SessionNode } from './session-node.js';

/** 分支信息 */
export interface BranchInfo {
  /** 分支 ID */
  id: string;
  /** 分支叶节点 ID */
  leafId: string;
  /** 分支标签（可选） */
  label?: string;
}

/** SessionTree 序列化数据结构 */
export interface SessionTreeData {
  rootId: string;
  activeBranchId: string;
  activeBranchKey: string;
  nodes: SessionNode[];
  branches: BranchInfo[];
}

/**
 * 会话树
 *
 * 管理整棵会话树，支持分支、fork、clone、switchBranch。
 * 树由节点（SessionNode）组成，每个节点有唯一 ID、父节点和子节点列表。
 * 分支通过 fork 创建，新旧分支共享 fork 点之前的节点。
 */
export class SessionTree {
  /** 所有节点 */
  nodes: Map<string, SessionNode> = new Map();
  /** 根节点 ID */
  rootId: string;
  /** 当前活跃分支的叶节点 ID */
  activeBranchId: string;
  /** 分支表 */
  branches: Map<string, BranchInfo> = new Map();
  /** 当前活跃分支 key（branches Map 中的键） */
  private activeBranchKey: string;

  /**
   * 初始化空树
   *
   * 创建虚拟根节点（role: 'system', content: null）作为树的起点，
   * 并创建初始分支 'main' 指向根节点。
   */
  constructor() {
    const rootId = crypto.randomUUID();
    const branchId = crypto.randomUUID();
    const now = Date.now();

    this.nodes.set(rootId, {
      id: rootId,
      parentId: null,
      role: 'system',
      content: null,
      timestamp: now,
      children: [],
      branchId,
    });

    this.rootId = rootId;
    this.activeBranchId = rootId;
    this.activeBranchKey = branchId;
    this.branches.set(branchId, { id: branchId, leafId: rootId, label: 'main' });
  }

  /**
   * 添加节点（自动生成 id 和 timestamp）
   *
   * parentId 为 null 时追加到当前活跃分支末尾。
   * 新节点成为活跃分支的新叶节点。
   *
   * @param node 节点数据（不含 id/children/timestamp）
   * @returns 新节点 ID
   */
  addNode(node: Omit<SessionNode, 'id' | 'children' | 'timestamp'>): string {
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    // parentId 为 null 时追加到活跃分支末尾
    const parentId = node.parentId ?? this.activeBranchId;

    const newNode: SessionNode = {
      id,
      parentId,
      role: node.role,
      content: node.content,
      timestamp,
      children: [],
      checkpointId: node.checkpointId,
      branchId: node.branchId ?? this.activeBranchKey,
    };

    this.nodes.set(id, newNode);

    // 更新父节点的 children 列表
    const parent = this.nodes.get(parentId);
    if (parent) {
      parent.children.push(id);
    }

    // 更新活跃分支叶节点
    this.activeBranchId = id;
    const branch = this.branches.get(this.activeBranchKey);
    if (branch) {
      branch.leafId = id;
    }

    return id;
  }

  /**
   * 获取当前活跃分支（从根到活跃叶节点的路径）
   * @returns 节点数组（从根到叶）
   */
  getActiveBranch(): SessionNode[] {
    return this.getPath(this.rootId, this.activeBranchId);
  }

  /**
   * 从指定节点创建新分支
   *
   * 新分支的叶节点初始为 nodeId，后续 addNode 将从该节点延伸。
   * 创建后自动切换到新分支。
   *
   * @param nodeId 分叉点节点 ID
   * @returns 新分支 ID
   */
  fork(nodeId: string): string {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`fork: 节点不存在 ${nodeId}`);
    }

    const branchId = crypto.randomUUID();
    this.branches.set(branchId, { id: branchId, leafId: nodeId });

    // 切换到新分支
    this.activeBranchKey = branchId;
    this.activeBranchId = nodeId;

    return branchId;
  }

  /**
   * 复制当前活跃分支到新会话树
   *
   * 深拷贝活跃分支路径（从根到活跃叶节点）到新的 SessionTree 实例。
   * 新树的所有节点 ID 重新生成，内容保持一致。
   *
   * @returns 新会话树实例（其 rootId 为新树的根 ID）
   */
  clone(): SessionTree {
    const newTree = new SessionTree();
    // 清除新树的默认初始化数据（将重新构建）
    newTree.nodes.clear();
    newTree.branches.clear();

    const now = Date.now();
    const newRootId = crypto.randomUUID();
    const newBranchId = crypto.randomUUID();

    // 创建新根节点
    newTree.nodes.set(newRootId, {
      id: newRootId,
      parentId: null,
      role: 'system',
      content: null,
      timestamp: now,
      children: [],
      branchId: newBranchId,
    });
    newTree.rootId = newRootId;
    newTree.activeBranchId = newRootId;
    newTree.activeBranchKey = newBranchId;
    newTree.branches.set(newBranchId, { id: newBranchId, leafId: newRootId, label: 'main' });

    // 复制活跃分支路径（跳过原树的根节点）
    const path = this.getActiveBranch();
    let prevId = newRootId;
    for (const node of path) {
      if (node.id === this.rootId) continue;
      const newNodeId = crypto.randomUUID();
      newTree.nodes.set(newNodeId, {
        id: newNodeId,
        parentId: prevId,
        role: node.role,
        content: node.content,
        timestamp: now,
        children: [],
        checkpointId: node.checkpointId,
        branchId: newBranchId,
      });
      const parent = newTree.nodes.get(prevId);
      if (parent) parent.children.push(newNodeId);
      prevId = newNodeId;
    }

    // 更新活跃分支叶节点
    if (prevId !== newRootId) {
      newTree.activeBranchId = prevId;
      const branch = newTree.branches.get(newBranchId);
      if (branch) branch.leafId = prevId;
    }

    return newTree;
  }

  /**
   * 切换活跃分支
   * @param branchId 目标分支 ID
   */
  switchBranch(branchId: string): void {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`switchBranch: 分支不存在 ${branchId}`);
    }
    this.activeBranchKey = branchId;
    this.activeBranchId = branch.leafId;
  }

  /**
   * 跳转到指定节点（切换到包含该节点的分支 + 设置活跃节点）
   *
   * 封装"查找目标分支 + switchBranch + 设置 activeBranchId"的完整逻辑，
   * 保证分支信息（activeBranchKey / branch.leafId）与活跃节点保持一致。
   *
   * @param nodeId 目标节点 ID
   * @returns 是否跳转成功（节点不存在或找不到所属分支时返回 false）
   */
  jumpToNode(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;

    // 查找包含该节点的分支
    let targetBranchId: string | null = null;
    for (const branch of this.branches.values()) {
      const path = this.getPath(this.rootId, branch.leafId);
      if (path.some(n => n.id === nodeId)) {
        targetBranchId = branch.id;
        break;
      }
    }
    if (!targetBranchId) return false;

    // 先切换分支（更新 activeBranchKey），再设置活跃节点
    this.activeBranchKey = targetBranchId;
    this.activeBranchId = nodeId;
    return true;
  }

  /**
   * 获取节点
   * @param id 节点 ID
   * @returns 节点（不存在时返回 undefined）
   */
  getNode(id: string): SessionNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * 获取子节点列表
   * @param id 父节点 ID
   * @returns 子节点数组
   */
  getChildren(id: string): SessionNode[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.children
      .map(cid => this.nodes.get(cid))
      .filter((n): n is SessionNode => n !== undefined);
  }

  /**
   * 获取两个节点之间的路径（fromId → toId，包含两端）
   *
   * 从 toId 向上回溯到 fromId，收集路径上的所有节点。
   * 若 fromId 不在 toId 的祖先链上，则返回从根到 toId 的路径。
   *
   * @param fromId 起点节点 ID
   * @param toId 终点节点 ID
   * @returns 节点数组（fromId → toId）
   */
  getPath(fromId: string, toId: string): SessionNode[] {
    const path: SessionNode[] = [];
    let currentId: string | null = toId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      path.unshift(node);
      if (currentId === fromId) break;
      currentId = node.parentId;
    }
    return path;
  }

  /**
   * 序列化为可持久化的普通对象
   * @returns 序列化数据
   */
  toJSON(): SessionTreeData {
    return {
      rootId: this.rootId,
      activeBranchId: this.activeBranchId,
      activeBranchKey: this.activeBranchKey,
      nodes: [...this.nodes.values()],
      branches: [...this.branches.values()],
    };
  }

  /**
   * 从序列化数据反序列化为 SessionTree 实例
   * @param data 序列化数据
   * @returns 新 SessionTree 实例
   */
  static fromJSON(data: object): SessionTree {
    const d = data as SessionTreeData;
    const tree = new SessionTree();
    tree.nodes.clear();
    tree.branches.clear();

    tree.rootId = d.rootId;
    tree.activeBranchId = d.activeBranchId;

    // activeBranchKey 可能缺失（旧格式），回退查找
    tree.activeBranchKey = d.activeBranchKey;
    if (!tree.activeBranchKey) {
      for (const branch of d.branches ?? []) {
        if (branch.leafId === d.activeBranchId) {
          tree.activeBranchKey = branch.id;
          break;
        }
      }
    }

    for (const node of d.nodes ?? []) {
      tree.nodes.set(node.id, node);
    }
    for (const branch of d.branches ?? []) {
      tree.branches.set(branch.id, branch);
    }

    return tree;
  }

  /**
   * 从线性消息列表导入（向后兼容）
   *
   * 将旧的线性消息数组转换为单分支会话树。
   * 每条消息依次追加到活跃分支末尾。
   * role 不在合法值内时默认为 'system'。
   *
   * @param messages 线性消息数组
   * @returns 新 SessionTree 实例（单分支）
   */
  static fromLinear(messages: Array<{ role: string; content: unknown }>): SessionTree {
    const tree = new SessionTree();
    const validRoles: string[] = ['user', 'assistant', 'toolResult', 'system'];
    for (const msg of messages) {
      const role = validRoles.includes(msg.role)
        ? (msg.role as SessionNode['role'])
        : 'system';
      tree.addNode({ parentId: null, role, content: msg.content });
    }
    return tree;
  }
}

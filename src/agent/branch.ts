// src/agent/branch.ts
// BranchManager：分支对话管理
// 蓝本：Phase 12 spec

import type { LLMMessage } from '../router/types.js';
import crypto from 'node:crypto';

/** 分支节点 */
export interface BranchNode {
  id: string;
  parentId: string | null;
  message: LLMMessage;
  children: string[];
  timestamp: number;
}

/** 分支信息 */
export interface BranchInfo {
  id: string;
  name: string;
  messageCount: number;
  isActive: boolean;
  createdAt: number;
}

export class BranchManager {
  private nodes: Map<string, BranchNode> = new Map();
  private branches: Map<string, BranchInfo> = new Map();
  private activeBranchId: string | null = null;
  /** initFromHistory 时记录每条消息对应的节点 ID（按 history 顺序） */
  private historyNodeIds: string[] = [];

  /** 从对话历史初始化分支结构（追加一个虚拟根节点） */
  initFromHistory(history: LLMMessage[]): void {
    if (this.nodes.size > 0) return;

    // 创建虚拟根节点
    const rootId = this.generateId();
    this.nodes.set(rootId, {
      id: rootId,
      parentId: null,
      message: { role: 'system', content: '__root__' },
      children: [],
      timestamp: Date.now(),
    });

    let currentParent = rootId;
    this.historyNodeIds = [];

    for (const msg of history) {
      const id = this.generateId();
      const node: BranchNode = {
        id,
        parentId: currentParent,
        message: msg,
        children: [],
        timestamp: Date.now(),
      };
      this.nodes.set(id, node);
      this.nodes.get(currentParent)!.children.push(id);
      this.historyNodeIds.push(id);
      currentParent = id;
    }

    // 第一个分支
    const firstBranchId = currentParent;
    this.branches.set(firstBranchId, {
      id: firstBranchId,
      name: '主线',
      messageCount: history.length,
      isActive: true,
      createdAt: Date.now(),
    });
    this.activeBranchId = firstBranchId;
  }

  /**
   * 在指定节点处创建分支（编辑/分叉）
   * @param fromNodeId 在此节点处创建分支（null 表示从根分叉）
   * @param newMessage 新分支的第一条消息
   * @returns 新节点 ID
   */
  fork(fromNodeId: string | null, newMessage: LLMMessage): string {
    const parentId = fromNodeId ?? this.activeBranchId;
    if (!parentId) {
      throw new Error('No active branch to fork from');
    }

    const newId = this.generateId();
    const newNode: BranchNode = {
      id: newId,
      parentId,
      message: newMessage,
      children: [],
      timestamp: Date.now(),
    };
    this.nodes.set(newId, newNode);

    const parent = this.nodes.get(parentId);
    if (parent) {
      parent.children.push(newId);
    }

    // 新分支信息
    const parentPath = this.getPath(parentId);
    const branchInfo: BranchInfo = {
      id: newId,
      name: this.deriveBranchName(newMessage),
      messageCount: parentPath.length + 1,
      isActive: true,
      createdAt: Date.now(),
    };
    this.branches.set(newId, branchInfo);

    // 切换活跃
    if (this.activeBranchId) {
      const oldBranch = this.branches.get(this.activeBranchId);
      if (oldBranch) oldBranch.isActive = false;
    }
    this.activeBranchId = newId;

    return newId;
  }

  /**
   * 在当前分支追加消息
   * @returns 新节点 ID
   */
  append(message: LLMMessage): string {
    const id = this.generateId();
    const parentId = this.activeBranchId;
    const node: BranchNode = {
      id,
      parentId,
      message,
      children: [],
      timestamp: Date.now(),
    };
    this.nodes.set(id, node);

    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(id);

      // 更新分支信息：分支末端移动到新节点
      const oldBranch = this.branches.get(parentId);
      if (oldBranch) {
        this.branches.delete(parentId);
        const newBranch: BranchInfo = {
          id,
          name: oldBranch.name,
          messageCount: this.getPathLength(id),
          isActive: true,
          createdAt: oldBranch.createdAt,
        };
        this.branches.set(id, newBranch);
      }
    }

    this.activeBranchId = id;
    return id;
  }

  /**
   * 编辑某条消息：找到该消息的节点，从其父节点创建新分支
   * @returns 新分支 ID
   */
  editByHistoryIndex(historyIndex: number, newContent: string): string | null {
    if (historyIndex < 0 || historyIndex >= this.historyNodeIds.length) {
      return null;
    }
    const targetNodeId = this.historyNodeIds[historyIndex];
    const targetNode = this.nodes.get(targetNodeId);
    if (!targetNode) return null;

    const parentId = targetNode.parentId;
    if (!parentId) return null;

    // 从父节点创建新分支
    const newMessage: LLMMessage = {
      role: targetNode.message.role,
      content: newContent,
    };
    return this.fork(parentId, newMessage);
  }

  /** 切换到指定分支（支持前缀匹配） */
  switchBranch(branchId: string): LLMMessage[] | null {
    // 精确匹配
    let branch = this.branches.get(branchId);
    if (branch) return this.switchToBranch(branchId);

    // 前缀匹配
    for (const [id, b] of this.branches) {
      if (id.startsWith(branchId) || id.slice(0, 4) === branchId) {
        return this.switchToBranch(id);
      }
    }
    return null;
  }

  private switchToBranch(branchId: string): LLMMessage[] {
    if (this.activeBranchId) {
      const oldBranch = this.branches.get(this.activeBranchId);
      if (oldBranch) oldBranch.isActive = false;
    }
    const branch = this.branches.get(branchId);
    if (branch) branch.isActive = true;
    this.activeBranchId = branchId;
    return this.getPath(branchId);
  }

  /** 获取从根到指定节点的消息路径 */
  getPath(nodeId: string): LLMMessage[] {
    const messages: LLMMessage[] = [];
    let currentId: string | null = nodeId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      const msg = node.message;
      // 跳过虚拟根节点
      if (msg.role !== 'system' || (typeof msg.content === 'string' && msg.content !== '__root__')) {
        messages.unshift(msg);
      }
      currentId = node.parentId;
    }
    return messages;
  }

  private getPathLength(nodeId: string): number {
    let count = 0;
    let currentId: string | null = nodeId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      const msg = node.message;
      if (msg.role !== 'system' || (typeof msg.content === 'string' && msg.content !== '__root__')) {
        count++;
      }
      currentId = node.parentId;
    }
    return count;
  }

  listBranches(): BranchInfo[] {
    return [...this.branches.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getActiveBranchId(): string | null {
    return this.activeBranchId;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  /** 重置分支管理（新对话时调用） */
  reset(): void {
    this.nodes.clear();
    this.branches.clear();
    this.activeBranchId = null;
    this.historyNodeIds = [];
  }

  private generateId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  private deriveBranchName(message: LLMMessage): string {
    const content = typeof message.content === 'string' ? message.content : '';
    return content.slice(0, 20) || '分叉';
  }
}

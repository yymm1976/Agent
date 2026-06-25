// src/agent/branch.ts
// BranchManager：分支对话管理
// 蓝本：Phase 12 spec

import type { LLMMessage } from '../router/types.js';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

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
  id: string;           // 稳定的分支 ID（不随 append 变化）
  name: string;
  tipNodeId: string;    // 当前分支末端的节点 ID
  messageCount: number;
  isActive: boolean;
  createdAt: number;
  /** 父分支 ID（null 表示从根节点创建） */
  parentId: string | null;
  /** 最后活跃时间戳（append / switch 时更新） */
  lastActiveAt: number;
}

export class BranchManager {
  private nodes: Map<string, BranchNode> = new Map();
  private branches: Map<string, BranchInfo> = new Map();
  private activeBranchId: string | null = null;
  /** 当前活跃分支的稳定 key（不会随 append 改变） */
  private activeBranchKey: string | null = null;
  /** initFromHistory 时记录每条消息对应的节点 ID（按 history 顺序） */
  private historyNodeIds: string[] = [];
  /** P6：节点 Map 上限（超出时归档早期非活跃节点） */
  private readonly maxNodes = 5000;
  /** P6：分支 Map 上限 */
  private readonly maxBranches = 100;

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
      tipNodeId: firstBranchId,
      messageCount: history.length,
      isActive: true,
      createdAt: Date.now(),
      parentId: null,
      lastActiveAt: Date.now(),
    });
    this.activeBranchId = firstBranchId;
    this.activeBranchKey = firstBranchId;
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
      tipNodeId: newId,
      messageCount: parentPath.length + 1,
      isActive: true,
      createdAt: Date.now(),
      parentId: parentId,
      lastActiveAt: Date.now(),
    };
    this.branches.set(newId, branchInfo);

    // 切换活跃
    if (this.activeBranchKey) {
      const oldBranch = this.branches.get(this.activeBranchKey);
      if (oldBranch) oldBranch.isActive = false;
    }
    this.activeBranchId = newId;
    this.activeBranchKey = newId;

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

    // P6：节点上限检查——超过时清理最早的非活跃、非根节点
    if (this.nodes.size >= this.maxNodes) {
      this.evictOldNodes();
    }

    this.nodes.set(id, node);

    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(id);
    }

    // 只更新当前分支的 tipNodeId，不删除/重建分支条目
    if (this.activeBranchKey) {
      const branch = this.branches.get(this.activeBranchKey);
      if (branch) {
        branch.tipNodeId = id;
        branch.messageCount = this.getPathLength(id);
        branch.lastActiveAt = Date.now();
      }
    }

    this.activeBranchId = id;
    // activeBranchKey 不变！

    // 让后续 editByHistoryIndex 也能编辑本次 append 的消息
    this.historyNodeIds.push(id);

    return id;
  }

  /**
   * 编辑某条消息：找到该消息的节点，从其父节点创建新分支，并保留后续消息
   * @returns 新分支的叶节点 ID（不是 fork 节点，而是末端节点）
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
    this.fork(parentId, newMessage);

    // 保留后续消息：从当前 active 分支的同位置之后所有消息
    // 注意：必须先快照长度，因为 append 会向 historyNodeIds 追加新节点
    let lastId: string | null = null;
    const initialLength = this.historyNodeIds.length;
    for (let i = historyIndex + 1; i < initialLength; i++) {
      const laterNodeId = this.historyNodeIds[i];
      const laterNode = this.nodes.get(laterNodeId);
      if (laterNode) {
        lastId = this.append({ ...laterNode.message });
      }
    }

    // 返回叶节点：只有存在后缀时才返回；否则返回 fork 创建的节点
    return lastId ?? this.activeBranchId;
  }

  /** 切换到指定分支（支持前缀匹配，歧义时报错） */
  switchBranch(branchId: string): LLMMessage[] | null {
    // 精确匹配
    let branch = this.branches.get(branchId);
    if (branch) return this.switchToBranch(branchId);

    // B15：前缀匹配——收集所有命中项，歧义时报错
    const matches: string[] = [];
    for (const id of this.branches.keys()) {
      if (id.startsWith(branchId)) {
        matches.push(id);
      }
    }
    if (matches.length === 1) {
      return this.switchToBranch(matches[0]);
    }
    if (matches.length > 1) {
      // B15：多个分支匹配同一前缀，报错避免不确定行为
      logger.warn('BranchManager: ambiguous branch prefix, multiple matches', {
        prefix: branchId,
        matches: matches.slice(0, 5),
      });
      return null;
    }
    return null;
  }

  private switchToBranch(branchId: string): LLMMessage[] {
    if (this.activeBranchKey) {
      const oldBranch = this.branches.get(this.activeBranchKey);
      if (oldBranch) oldBranch.isActive = false;
    }
    const branch = this.branches.get(branchId);
    if (branch) {
      branch.isActive = true;
      branch.lastActiveAt = Date.now();
    }
    this.activeBranchId = branch!.tipNodeId;  // 切换到分支末端节点
    this.activeBranchKey = branchId;
    return this.getPath(branch!.tipNodeId);
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
    this.activeBranchKey = null;
    this.historyNodeIds = [];
  }

  /** P6：淘汰早期非活跃节点（保留活跃分支路径上的节点） */
  private evictOldNodes(): void {
    // 收集活跃分支路径上的所有节点 ID（不可淘汰）
    const protectedIds = new Set<string>();
    if (this.activeBranchId) {
      let cur: string | null = this.activeBranchId;
      while (cur) {
        protectedIds.add(cur);
        const node = this.nodes.get(cur);
        cur = node?.parentId ?? null;
      }
    }

    // 按时间排序，淘汰最早的非保护节点（保留最近 maxNodes/2 个）
    const candidates: Array<{ id: string; timestamp: number }> = [];
    for (const [id, node] of this.nodes) {
      if (!protectedIds.has(id) && node.message.role !== 'system') {
        candidates.push({ id, timestamp: node.timestamp });
      }
    }
    candidates.sort((a, b) => a.timestamp - b.timestamp);

    const evictCount = Math.min(candidates.length, Math.floor(this.maxNodes / 2));
    for (let i = 0; i < evictCount; i++) {
      const nodeId = candidates[i].id;
      const node = this.nodes.get(nodeId);
      if (node) {
        // 从父节点的 children 中移除引用
        if (node.parentId) {
          const parent = this.nodes.get(node.parentId);
          if (parent) {
            parent.children = parent.children.filter(c => c !== nodeId);
          }
        }
        this.nodes.delete(nodeId);
      }
    }
    // 同步清理 historyNodeIds 中已淘汰的节点
    this.historyNodeIds = this.historyNodeIds.filter(id => this.nodes.has(id));

    if (evictCount > 0) {
      logger.debug('BranchManager: evicted old nodes', { count: evictCount, remaining: this.nodes.size });
    }
  }

  private generateId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  private deriveBranchName(message: LLMMessage): string {
    const content = typeof message.content === 'string' ? message.content : '';
    return content.slice(0, 20) || '分叉';
  }
}

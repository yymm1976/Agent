// src/agent/branch.ts
// BranchManager：分支对话管理
// 蓝本：Phase 12 spec

import type { LLMMessage } from '../router/types.js';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
// Phase 50 Task 4：接入 BranchOperations（提供 delete/insert/undo/redo 等高级操作）
// 注：branch-operations.ts 仅 import 本文件的 type，运行时无循环依赖
import { BranchOperations } from './branch-operations.js';

// Phase 73 Part D：BranchNode 扩展为联合类型
// - MessageNode：原有消息节点
// - CompactionNode：上下文压缩后追加的压缩节点（记录摘要 + 保留起点）
// - BranchSummaryNode：切换分支时为被放弃分支生成的摘要节点
// 所有节点共享 BaseNode 的 id/parentId/children/timestamp 字段

/** 节点基础接口 */
export interface BaseNode {
  id: string;
  parentId: string | null;
  children: string[];
  timestamp: number;
}

/** 消息节点（原有类型） */
export interface MessageNode extends BaseNode {
  type: 'message';
  message: LLMMessage;
}

/** 压缩节点：记录一次上下文压缩的摘要和保留起点 */
export interface CompactionNode extends BaseNode {
  type: 'compaction';
  /** 压缩生成的摘要文本 */
  summary: string;
  /** 压缩后保留的第一条消息节点 ID（重建 context 时从此处开始取 MessageNode） */
  firstKeptEntryId: string;
  /** 压缩前的 token 数 */
  tokensBefore: number;
}

/** 分支摘要节点：切换分支时为被放弃分支生成的统计摘要 */
export interface BranchSummaryNode extends BaseNode {
  type: 'branch_summary';
  /** 被放弃分支的末端节点 ID */
  fromId: string;
  /** 统计摘要文本（不调用 LLM，仅时间戳 + 消息数） */
  summary: string;
}

/** 分支节点联合类型 */
export type BranchNode = MessageNode | CompactionNode | BranchSummaryNode;

/**
 * Phase 89：BranchManager 构造选项
 * - maxNodes：节点 Map 上限（默认 5000）
 * - maxBranches：分支 Map 上限（默认 100）
 */
export interface BranchManagerOptions {
  maxNodes?: number;
  maxBranches?: number;
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
  private readonly maxNodes: number;
  /** P6：分支 Map 上限 */
  private readonly maxBranches: number;

  /**
   * Phase 89：构造函数接受可选 opts，允许外部配置 maxNodes/maxBranches
   * 未传入时使用默认值（5000/100），保持向后兼容
   */
  constructor(opts?: BranchManagerOptions) {
    this.maxNodes = opts?.maxNodes ?? 5000;
    this.maxBranches = opts?.maxBranches ?? 100;
  }

  /** 从对话历史初始化分支结构（追加一个虚拟根节点） */
  initFromHistory(history: LLMMessage[]): void {
    if (this.nodes.size > 0) return;

    // 创建虚拟根节点
    const rootId = this.generateId();
    this.nodes.set(rootId, {
      type: 'message',
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
      const node: MessageNode = {
        type: 'message',
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
    const newNode: MessageNode = {
      type: 'message',
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
    const node: MessageNode = {
      type: 'message',
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
    // Phase 73 Part D：仅 MessageNode 可被编辑
    if (targetNode.type !== 'message') return null;

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
      // Phase 73 Part D：仅 MessageNode 可被复制
      if (laterNode && laterNode.type === 'message') {
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
    // Phase 73 Part D：记录被放弃分支的信息，用于生成 BranchSummaryNode
    const oldTipNodeId = this.activeBranchId;
    const oldBranchKey = this.activeBranchKey;

    if (oldBranchKey) {
      const oldBranch = this.branches.get(oldBranchKey);
      if (oldBranch) oldBranch.isActive = false;
    }
    const branch = this.branches.get(branchId);
    if (branch) {
      branch.isActive = true;
      branch.lastActiveAt = Date.now();
    }
    this.activeBranchId = branch!.tipNodeId;  // 切换到分支末端节点
    this.activeBranchKey = branchId;

    // Phase 73 Part D：切换分支时为被放弃分支生成统计摘要并追加到新分支末端
    // 不调用 LLM，仅用消息数 + 时间范围生成摘要（避免异步复杂度）
    if (oldTipNodeId && oldBranchKey && oldBranchKey !== branchId) {
      const summary = this.generateBranchAbandonmentSummary(oldTipNodeId);
      this.appendBranchSummaryNode(oldTipNodeId, summary);
    }

    return this.getPath(this.activeBranchId);
  }

  /**
   * Phase 73 Part D：追加 CompactionNode
   *
   * 在上下文压缩后调用，记录压缩摘要和保留起点。重建 context 时
   * 从 leaf 往 root 找最新 CompactionNode，用其 summary 替代被压缩的旧消息。
   *
   * @param summary 压缩摘要文本
   * @param firstKeptEntryId 压缩后保留的第一条消息节点 ID
   * @param tokensBefore 压缩前 token 数
   * @returns 新创建的 CompactionNode ID
   */
  appendCompactionNode(summary: string, firstKeptEntryId: string, tokensBefore: number): string {
    const id = this.generateId();
    const parentId = this.activeBranchId;
    const node: CompactionNode = {
      type: 'compaction',
      id,
      parentId,
      summary,
      firstKeptEntryId,
      tokensBefore,
      children: [],
      timestamp: Date.now(),
    };
    this.nodes.set(id, node);
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(id);
    }
    // 更新当前分支 tip 指向新节点
    if (this.activeBranchKey) {
      const branch = this.branches.get(this.activeBranchKey);
      if (branch) {
        branch.tipNodeId = id;
        branch.lastActiveAt = Date.now();
      }
    }
    this.activeBranchId = id;
    return id;
  }

  /**
   * Phase 73 Part D：追加 BranchSummaryNode
   *
   * 切换分支时调用，为被放弃分支生成统计摘要节点并追加到当前分支末端。
   * 摘要不调用 LLM，仅包含消息数和时间范围。
   *
   * @param fromId 被放弃分支的末端节点 ID
   * @param summary 统计摘要文本
   * @returns 新创建的 BranchSummaryNode ID
   */
  appendBranchSummaryNode(fromId: string, summary: string): string {
    const id = this.generateId();
    const parentId = this.activeBranchId;
    const node: BranchSummaryNode = {
      type: 'branch_summary',
      id,
      parentId,
      fromId,
      summary,
      children: [],
      timestamp: Date.now(),
    };
    this.nodes.set(id, node);
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(id);
    }
    // 更新当前分支 tip 指向新节点
    if (this.activeBranchKey) {
      const branch = this.branches.get(this.activeBranchKey);
      if (branch) {
        branch.tipNodeId = id;
        branch.lastActiveAt = Date.now();
      }
    }
    this.activeBranchId = id;
    return id;
  }

  /**
   * Phase 73 Part D：生成被放弃分支的统计摘要
   *
   * 从 tipNodeId 回溯到根，统计 MessageNode 数量和时间范围。
   * 不调用 LLM，避免引入异步复杂度和 API 调用成本。
   */
  private generateBranchAbandonmentSummary(tipNodeId: string): string {
    let count = 0;
    let firstTs = Date.now();
    let lastTs = 0;
    let cur: string | null = tipNodeId;
    while (cur) {
      const node = this.nodes.get(cur);
      if (!node) break;
      // Phase 73 Part D：仅统计 MessageNode（跳过虚拟根节点）
      if (node.type === 'message' && !this.isRootMessage(node.message)) {
        count++;
      }
      firstTs = Math.min(firstTs, node.timestamp);
      lastTs = Math.max(lastTs, node.timestamp);
      cur = node.parentId;
    }
    const startStr = new Date(firstTs).toISOString();
    const endStr = new Date(lastTs).toISOString();
    return `之前探索了 ${count} 条消息的分支（时间范围：${startStr} ~ ${endStr}）`;
  }

  /** Phase 73 Part D：判断是否为虚拟根节点的消息 */
  private isRootMessage(msg: LLMMessage): boolean {
    return msg.role === 'system' && typeof msg.content === 'string' && msg.content === '__root__';
  }

  /**
   * 获取从根到指定节点的消息路径
   *
   * Phase 73 Part D：处理 CompactionNode 和 BranchSummaryNode
   * - CompactionNode：从 leaf 往 root 找最新的，用其 summary 作为第一条 system 消息，
   *   并跳过 firstKeptEntryId 之前的 MessageNode（被压缩部分）
   * - BranchSummaryNode：转换为 user 消息（"[分支探索记录] ..."）
   * - MessageNode：原样保留（跳过虚拟根节点）
   */
  getPath(nodeId: string): LLMMessage[] {
    // 从 root → leaf 收集节点（unshift 保证顺序）
    const pathNodes: BranchNode[] = [];
    let currentId: string | null = nodeId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      pathNodes.unshift(node);
      currentId = node.parentId;
    }

    // Phase 73 Part D：从 leaf 往 root 找最新的 CompactionNode
    let compactionIdx = -1;
    for (let i = pathNodes.length - 1; i >= 0; i--) {
      if (pathNodes[i].type === 'compaction') {
        compactionIdx = i;
        break;
      }
    }

    const messages: LLMMessage[] = [];

    if (compactionIdx >= 0) {
      // 有 CompactionNode：用其 summary 作为第一条 system 消息
      const compaction = pathNodes[compactionIdx] as CompactionNode;
      messages.push({ role: 'system', content: compaction.summary });

      // firstKeptEntryId 及之后、CompactionNode 之前的 MessageNode 保留
      let foundFirstKept = false;
      for (let i = 0; i < compactionIdx; i++) {
        const node = pathNodes[i];
        if (node.id === compaction.firstKeptEntryId) {
          foundFirstKept = true;
        }
        if (foundFirstKept && node.type === 'message' && !this.isRootMessage(node.message)) {
          messages.push(node.message);
        }
      }

      // CompactionNode 之后的节点（MessageNode / BranchSummaryNode）保留
      for (let i = compactionIdx + 1; i < pathNodes.length; i++) {
        const node = pathNodes[i];
        if (node.type === 'message' && !this.isRootMessage(node.message)) {
          messages.push(node.message);
        } else if (node.type === 'branch_summary') {
          messages.push({ role: 'user', content: `[分支探索记录] ${node.summary}` });
        }
      }
    } else {
      // 无 CompactionNode：所有 MessageNode + BranchSummaryNode 按原顺序保留
      for (const node of pathNodes) {
        if (node.type === 'message' && !this.isRootMessage(node.message)) {
          messages.push(node.message);
        } else if (node.type === 'branch_summary') {
          messages.push({ role: 'user', content: `[分支探索记录] ${node.summary}` });
        }
      }
    }

    return messages;
  }

  private getPathLength(nodeId: string): number {
    let count = 0;
    let currentId: string | null = nodeId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      // Phase 73 Part D：仅统计 MessageNode（跳过虚拟根节点）
      if (node.type === 'message' && !this.isRootMessage(node.message)) {
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

  // G-023: 暴露受控公开 API，替代 branch-operations.ts 的私有字段访问

  /** 获取所有节点的 Map 只读视图 */
  getAllNodes(): ReadonlyMap<string, BranchNode> {
    return this.nodes;
  }

  /** 获取所有分支的 Map 只读视图 */
  getAllBranches(): ReadonlyMap<string, BranchInfo> {
    return this.branches;
  }

  /** 获取当前活跃分支 key */
  getActiveBranchKey(): string | null {
    return this.activeBranchKey;
  }

  /** 获取历史节点 ID 列表（只读视图） */
  getHistoryNodeIds(): readonly string[] {
    return this.historyNodeIds;
  }

  /** 设置/更新节点（供 BranchOperations 受控写入） */
  setNode(id: string, node: BranchNode): void {
    this.nodes.set(id, node);
  }

  /** 删除节点（供 BranchOperations 受控写入） */
  deleteNode(id: string): void {
    this.nodes.delete(id);
  }

  /** 清空所有节点（供 BranchOperations restore 使用） */
  clearNodes(): void {
    this.nodes.clear();
  }

  /** 设置/更新分支信息（供 BranchOperations 受控写入） */
  setBranch(id: string, branch: BranchInfo): void {
    this.branches.set(id, branch);
  }

  /** 清空所有分支（供 BranchOperations restore 使用） */
  clearBranches(): void {
    this.branches.clear();
  }

  /** 设置当前活跃分支 ID（供 BranchOperations 受控写入） */
  setActiveBranchId(id: string | null): void {
    this.activeBranchId = id;
  }

  /** 设置当前活跃分支 key（供 BranchOperations 受控写入） */
  setActiveBranchKey(key: string | null): void {
    this.activeBranchKey = key;
  }

  /** 设置历史节点 ID 列表（供 BranchOperations 受控写入） */
  setHistoryNodeIds(ids: string[]): void {
    this.historyNodeIds = ids;
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
    // Phase 73 Part D：仅淘汰 MessageNode（非虚拟根），保留 CompactionNode/BranchSummaryNode
    const candidates: Array<{ id: string; timestamp: number }> = [];
    for (const [id, node] of this.nodes) {
      if (!protectedIds.has(id) && node.type === 'message' && !this.isRootMessage(node.message)) {
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

  generateId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  private deriveBranchName(message: LLMMessage): string {
    const content = typeof message.content === 'string' ? message.content : '';
    return content.slice(0, 20) || '分叉';
  }

  /**
   * 创建 BranchOperations 实例（Phase 50 Task 4 接入点）
   *
   * BranchOperations 提供 BranchManager 未覆盖的高级操作：
   *   - deleteByHistoryIndex：删除消息节点（子节点挂到父节点）
   *   - insertByHistoryIndex：在指定位置插入消息并创建新分支
   *   - editRange：批量编辑范围内的消息
   *   - undo/redo：操作栈（操作前快照 + 整体恢复）
   *   - serializeStacks/deserializeStacks：操作栈持久化
   *
   * 评估结论：BranchOperations 与 BranchManager 功能非完全重叠
   *   - 重叠：fork/append/editByHistoryIndex（BranchManager 已有）
   *   - 独特：delete/insert/batch edit/undo/redo（BranchManager 没有）
   * 因此保留 branch-operations.ts 并通过此方法接入
   */
  createOperations(): BranchOperations {
    return new BranchOperations(this);
  }
}

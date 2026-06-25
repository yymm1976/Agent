// src/agent/branch-operations.ts
// 节点级操作补全：delete / insert / undo / redo / batch edit
//
// 设计说明：
//   - 不修改 BranchManager，通过构造函数接收实例
//   - 由于 BranchManager 没有暴露内部状态（nodes/branches/activeBranchId 等）的公共方法，
//     本模块通过 (manager as any) 访问这些私有字段——这是必要的妥协
//   - undo/redo 采用"操作前快照"策略：每次操作前完整快照 manager 的内部状态，
//     undo 时整体恢复。简单可靠，避免反向操作逻辑出错

import type { BranchManager, BranchNode, BranchInfo } from './branch.js';
import type { LLMMessage } from '../router/types.js';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

/** 操作结果 */
export interface ActionResult {
  success: boolean;
  newBranchId?: string;
  error?: string;
}

/** 操作记录（用于 undo/redo） */
interface ActionRecord {
  type: 'append' | 'fork' | 'edit' | 'delete' | 'insert' | 'batch_edit';
  timestamp: number;
  /** 操作前 manager 内部状态快照 */
  data: {
    nodes: Array<BranchNode>;
    branches: Array<BranchInfo>;
    activeBranchId: string | null;
    activeBranchKey: string | null;
    historyNodeIds: string[];
  };
}

/** 通过 any 访问 BranchManager 私有字段 */
interface ManagerInternals {
  nodes: Map<string, BranchNode>;
  branches: Map<string, BranchInfo>;
  activeBranchId: string | null;
  activeBranchKey: string | null;
  historyNodeIds: string[];
  generateId?: () => string;
}

export class BranchOperations {
  private manager: BranchManager;
  private undoStack: ActionRecord[] = [];
  private redoStack: ActionRecord[] = [];
  private readonly maxStack = 50;

  constructor(manager: BranchManager) {
    this.manager = manager;
  }

  // ============================================================
  // 内部访问
  // ============================================================

  private internals(): ManagerInternals {
    return this.manager as unknown as ManagerInternals;
  }

  private generateId(): string {
    const internals = this.internals();
    if (typeof internals.generateId === 'function') {
      return internals.generateId();
    }
    return crypto.randomUUID().slice(0, 8);
  }

  /** 拍摄当前 manager 内部状态快照 */
  private snapshot(): ActionRecord['data'] {
    const m = this.internals();
    return {
      nodes: Array.from(m.nodes.values()).map(n => ({ ...n, children: [...n.children] })),
      branches: Array.from(m.branches.values()).map(b => ({ ...b })),
      activeBranchId: m.activeBranchId,
      activeBranchKey: m.activeBranchKey,
      historyNodeIds: [...m.historyNodeIds],
    };
  }

  /** 用快照覆盖 manager 内部状态 */
  private restore(data: ActionRecord['data']): void {
    const m = this.internals();
    m.nodes.clear();
    for (const n of data.nodes) m.nodes.set(n.id, { ...n, children: [...n.children] });
    m.branches.clear();
    for (const b of data.branches) m.branches.set(b.id, { ...b });
    m.activeBranchId = data.activeBranchId;
    m.activeBranchKey = data.activeBranchKey;
    m.historyNodeIds = [...data.historyNodeIds];
  }

  /** 压入 undo 栈，超过 maxStack 时丢弃最旧；同时清空 redo 栈 */
  private pushUndo(record: ActionRecord): void {
    this.undoStack.push(record);
    while (this.undoStack.length > this.maxStack) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  // ============================================================
  // delete
  // ============================================================

  /**
   * 删除消息节点：
   *   - 目标节点的子节点挂到父节点下
   *   - 父节点 children 移除目标、添加目标的子节点
   *   - 如果删除的是分支 tip，tip 回退到父节点
   *   - 更新 historyNodeIds
   */
  deleteByHistoryIndex(historyIndex: number): ActionResult {
    const m = this.internals();
    if (historyIndex < 0 || historyIndex >= m.historyNodeIds.length) {
      return { success: false, error: 'invalid-history-index' };
    }
    const targetId = m.historyNodeIds[historyIndex];
    const target = m.nodes.get(targetId);
    if (!target) return { success: false, error: 'target-node-not-found' };
    if (target.parentId === null) {
      return { success: false, error: 'cannot-delete-root' };
    }

    const before = this.snapshot();

    const parent = m.nodes.get(target.parentId);
    if (parent) {
      // 从父节点 children 中移除目标，并把目标的子节点接到父节点
      parent.children = parent.children.filter(c => c !== targetId);
      for (const childId of target.children) {
        const child = m.nodes.get(childId);
        if (child) {
          child.parentId = parent.id;
          parent.children.push(childId);
        }
      }
    }

    // 删除目标节点
    m.nodes.delete(targetId);

    // 更新 historyNodeIds：移除被删除的节点
    m.historyNodeIds = m.historyNodeIds.filter(id => id !== targetId);

    // 如果删除的是分支 tip，回退到父节点
    for (const branch of m.branches.values()) {
      if (branch.tipNodeId === targetId) {
        branch.tipNodeId = target.parentId;
        branch.messageCount = Math.max(0, branch.messageCount - 1);
      }
    }

    // 如果 activeBranchId 指向被删除节点，回退到父节点
    if (m.activeBranchId === targetId) {
      m.activeBranchId = target.parentId;
    }

    this.pushUndo({
      type: 'delete',
      timestamp: Date.now(),
      data: before,
    });

    return { success: true };
  }

  // ============================================================
  // insert
  // ============================================================

  /**
   * 在 historyIndex 位置的消息节点之后插入新消息：
   *   - 在目标节点之后插入新节点
   *   - 原后续消息（historyIndex+1 起）作为新节点的子树（保留它们的相对结构）
   *   - 创建新分支保存插入后的路径
   *
   * 实现策略：复制目标节点到新节点（带新消息），把原后续消息复制一份挂到新节点下，
   * 形成新分支。原路径不动。
   */
  insertByHistoryIndex(
    historyIndex: number,
    message: { role: string; content: string },
  ): ActionResult {
    const m = this.internals();
    if (historyIndex < 0 || historyIndex >= m.historyNodeIds.length) {
      return { success: false, error: 'invalid-history-index' };
    }
    const targetId = m.historyNodeIds[historyIndex];
    const target = m.nodes.get(targetId);
    if (!target) return { success: false, error: 'target-node-not-found' };

    const before = this.snapshot();

    // 1. 在目标节点之后插入新节点（作为目标的子节点）
    const newNodeId = this.generateId();
    const newNode: BranchNode = {
      id: newNodeId,
      parentId: targetId,
      message: { role: message.role as LLMMessage['role'], content: message.content },
      children: [],
      timestamp: Date.now(),
    };
    m.nodes.set(newNodeId, newNode);
    target.children.push(newNodeId);

    // 2. 复制原后续消息（historyIndex+1 起）作为新节点的子树
    //    逐条 append 到新节点下，保持线性顺序
    let lastInsertedId = newNodeId;
    const initialLen = m.historyNodeIds.length;
    for (let i = historyIndex + 1; i < initialLen; i++) {
      const laterId = m.historyNodeIds[i];
      const laterNode = m.nodes.get(laterId);
      if (!laterNode) continue;
      const copyId = this.generateId();
      const copyNode: BranchNode = {
        id: copyId,
        parentId: lastInsertedId,
        message: { ...laterNode.message },
        children: [],
        timestamp: Date.now(),
      };
      m.nodes.set(copyId, copyNode);
      const parent = m.nodes.get(lastInsertedId);
      if (parent) parent.children.push(copyId);
      lastInsertedId = copyId;
    }

    // 3. 创建新分支：以新节点为起点，tip 指向最后插入的节点
    const newBranchId = newNodeId;
    // 计算路径长度：从 lastInsertedId 回溯到根
    const pathLen = this.pathLength(lastInsertedId);
    // 旧活跃分支置为非活跃
    if (m.activeBranchKey) {
      const old = m.branches.get(m.activeBranchKey);
      if (old) old.isActive = false;
    }
    const newBranch: BranchInfo = {
      id: newBranchId,
      name: this.deriveName(message.content),
      tipNodeId: lastInsertedId,
      messageCount: pathLen,
      isActive: true,
      createdAt: Date.now(),
      parentId: targetId,
      lastActiveAt: Date.now(),
    };
    m.branches.set(newBranchId, newBranch);
    m.activeBranchId = lastInsertedId;
    m.activeBranchKey = newBranchId;

    // 4. historyNodeIds 不修改原顺序，但要让新插入的消息可被 editByHistoryIndex 编辑
    //    在 historyIndex+1 位置插入新节点 ID
    m.historyNodeIds.splice(historyIndex + 1, 0, newNodeId);

    this.pushUndo({
      type: 'insert',
      timestamp: Date.now(),
      data: before,
    });

    return { success: true, newBranchId };
  }

  // ============================================================
  // batch edit
  // ============================================================

  /**
   * 批量编辑：对 [startIndex, endIndex] 范围内的每条消息执行 edit，生成新分支。
   * 实现：对范围内每条消息调用 manager.editByHistoryIndex，但 editByHistoryIndex
   * 会切换活跃分支并追加后续消息——多次调用会嵌套创建分支。
   * 为简化：取范围内第一条消息的父节点作为 fork 点，把 newMessages 依次 append，
   * 然后把原范围之后的后续消息也复制过来，形成单一新分支。
   */
  editRange(
    startIndex: number,
    endIndex: number,
    newMessages: { role: string; content: string }[],
  ): ActionResult {
    const m = this.internals();
    if (startIndex < 0 || endIndex >= m.historyNodeIds.length || startIndex > endIndex) {
      return { success: false, error: 'invalid-range' };
    }
    if (newMessages.length === 0) {
      return { success: false, error: 'empty-new-messages' };
    }

    const before = this.snapshot();

    const startNodeId = m.historyNodeIds[startIndex];
    const startNode = m.nodes.get(startNodeId);
    if (!startNode || !startNode.parentId) {
      return { success: false, error: 'start-node-not-found-or-root' };
    }

    // 1. 从 startIndex 的父节点 fork 第一条新消息
    const firstNewId = this.forkAt(startNode.parentId, newMessages[0]);
    if (!firstNewId) {
      return { success: false, error: 'fork-failed' };
    }

    // 2. append 剩余新消息
    let lastId = firstNewId;
    for (let i = 1; i < newMessages.length; i++) {
      lastId = this.appendAt(lastId, newMessages[i]);
    }

    // 3. 复制原 endIndex 之后的后续消息到新分支
    const initialLen = m.historyNodeIds.length;
    for (let i = endIndex + 1; i < initialLen; i++) {
      const laterId = m.historyNodeIds[i];
      const laterNode = m.nodes.get(laterId);
      if (!laterNode) continue;
      lastId = this.appendAt(lastId, {
        role: laterNode.message.role,
        content: typeof laterNode.message.content === 'string'
          ? laterNode.message.content
          : JSON.stringify(laterNode.message.content),
      });
    }

    // 4. 创建新分支
    if (m.activeBranchKey) {
      const old = m.branches.get(m.activeBranchKey);
      if (old) old.isActive = false;
    }
    const newBranchId = firstNewId;
    const newBranch: BranchInfo = {
      id: newBranchId,
      name: this.deriveName(newMessages[0].content),
      tipNodeId: lastId,
      messageCount: this.pathLength(lastId),
      isActive: true,
      createdAt: Date.now(),
      parentId: startNode.parentId,
      lastActiveAt: Date.now(),
    };
    m.branches.set(newBranchId, newBranch);
    m.activeBranchId = lastId;
    m.activeBranchKey = newBranchId;

    this.pushUndo({
      type: 'batch_edit',
      timestamp: Date.now(),
      data: before,
    });

    return { success: true, newBranchId };
  }

  /** 在指定父节点下创建新节点（不创建分支，仅节点） */
  private forkAt(parentId: string, message: { role: string; content: string }): string | null {
    const m = this.internals();
    const parent = m.nodes.get(parentId);
    if (!parent) return null;
    const id = this.generateId();
    const node: BranchNode = {
      id,
      parentId,
      message: { role: message.role as LLMMessage['role'], content: message.content },
      children: [],
      timestamp: Date.now(),
    };
    m.nodes.set(id, node);
    parent.children.push(id);
    return id;
  }

  /** 在指定父节点下追加新节点 */
  private appendAt(parentId: string, message: { role: string; content: string }): string {
    const m = this.internals();
    const parent = m.nodes.get(parentId);
    const id = this.generateId();
    const node: BranchNode = {
      id,
      parentId,
      message: { role: message.role as LLMMessage['role'], content: message.content },
      children: [],
      timestamp: Date.now(),
    };
    m.nodes.set(id, node);
    if (parent) parent.children.push(id);
    return id;
  }

  private pathLength(nodeId: string): number {
    const m = this.internals();
    let count = 0;
    let cur: string | null = nodeId;
    while (cur) {
      const node = m.nodes.get(cur);
      if (!node) break;
      const msg = node.message;
      if (msg.role !== 'system' || (typeof msg.content === 'string' && msg.content !== '__root__')) {
        count++;
      }
      cur = node.parentId;
    }
    return count;
  }

  private deriveName(content: string): string {
    return content.slice(0, 20) || '分叉';
  }

  // ============================================================
  // undo / redo
  // ============================================================

  undo(): ActionResult {
    if (this.undoStack.length === 0) {
      return { success: false, error: 'undo-stack-empty' };
    }
    const record = this.undoStack.pop()!;
    // 保存当前状态到 redo 栈
    const current = this.snapshot();
    this.redoStack.push({
      type: record.type,
      timestamp: Date.now(),
      data: current,
    });
    while (this.redoStack.length > this.maxStack) {
      this.redoStack.shift();
    }
    // 恢复到操作前状态
    this.restore(record.data);
    return { success: true };
  }

  redo(): ActionResult {
    if (this.redoStack.length === 0) {
      return { success: false, error: 'redo-stack-empty' };
    }
    const record = this.redoStack.pop()!;
    // 保存当前状态到 undo 栈
    const current = this.snapshot();
    this.undoStack.push({
      type: record.type,
      timestamp: Date.now(),
      data: current,
    });
    while (this.undoStack.length > this.maxStack) {
      this.undoStack.shift();
    }
    // 恢复到 redo 记录的状态
    this.restore(record.data);
    return { success: true };
  }

  // ============================================================
  // 状态查询
  // ============================================================

  getUndoStack(): ActionRecord[] {
    return this.undoStack;
  }

  getRedoStack(): ActionRecord[] {
    return this.redoStack;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ============================================================
  // 序列化（用于持久化操作栈）
  // ============================================================

  serializeStacks(): { undo: ActionRecord[]; redo: ActionRecord[] } {
    return {
      undo: this.undoStack.map(r => ({
        type: r.type,
        timestamp: r.timestamp,
        data: {
          nodes: r.data.nodes.map(n => ({ ...n, children: [...n.children] })),
          branches: r.data.branches.map(b => ({ ...b })),
          activeBranchId: r.data.activeBranchId,
          activeBranchKey: r.data.activeBranchKey,
          historyNodeIds: [...r.data.historyNodeIds],
        },
      })),
      redo: this.redoStack.map(r => ({
        type: r.type,
        timestamp: r.timestamp,
        data: {
          nodes: r.data.nodes.map(n => ({ ...n, children: [...n.children] })),
          branches: r.data.branches.map(b => ({ ...b })),
          activeBranchId: r.data.activeBranchId,
          activeBranchKey: r.data.activeBranchKey,
          historyNodeIds: [...r.data.historyNodeIds],
        },
      })),
    };
  }

  deserializeStacks(data: { undo: ActionRecord[]; redo: ActionRecord[] }): void {
    this.undoStack = data.undo.map(r => ({
      type: r.type,
      timestamp: r.timestamp,
      data: {
        nodes: r.data.nodes.map(n => ({ ...n, children: [...n.children] })),
        branches: r.data.branches.map(b => ({ ...b })),
        activeBranchId: r.data.activeBranchId,
        activeBranchKey: r.data.activeBranchKey,
        historyNodeIds: [...r.data.historyNodeIds],
      },
    }));
    this.redoStack = data.redo.map(r => ({
      type: r.type,
      timestamp: r.timestamp,
      data: {
        nodes: r.data.nodes.map(n => ({ ...n, children: [...n.children] })),
        branches: r.data.branches.map(b => ({ ...b })),
        activeBranchId: r.data.activeBranchId,
        activeBranchKey: r.data.activeBranchKey,
        historyNodeIds: [...r.data.historyNodeIds],
      },
    }));
    // 截断到 maxStack
    while (this.undoStack.length > this.maxStack) this.undoStack.shift();
    while (this.redoStack.length > this.maxStack) this.redoStack.shift();
  }
}

// 防止 logger 未使用告警（在某些构建配置下）
void logger;

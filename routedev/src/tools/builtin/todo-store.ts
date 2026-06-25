// src/tools/builtin/todo-store.ts
// TodoStore：内存中的任务列表存储
// P1-5：TodoWrite 工具需要共享状态，工具本身无状态，通过注入 store 实现
//
// 设计：
//   1. 单会话单实例，在 app-init.ts 中创建并注入 TodoWriteTool
//   2. 纯内存存储，不持久化（与 Claude Code 行为一致）
//   3. 支持增删改查和状态流转

import { randomUUID } from 'node:crypto';

/** 单个待办项 */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  createdAt: number;
  updatedAt: number;
}

/** 待办列表快照（供外部读取） */
export interface TodoSnapshot {
  items: TodoItem[];
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

/**
 * 待办列表存储
 *
 * 生命周期：与 App 实例一致（单会话）
 * 线程安全：Node.js 单线程，无需锁
 */
export class TodoStore {
  private items: Map<string, TodoItem> = new Map();

  /**
   * 生成唯一 ID
   * M6 修复：使用 crypto.randomUUID() 替代计数器，防止多实例 ID 碰撞
   */
  private nextId(): string {
    return `todo-${randomUUID()}`;
  }

  /** 添加待办项 */
  add(content: string, priority: TodoItem['priority'] = 'medium'): TodoItem {
    const now = Date.now();
    const item: TodoItem = {
      id: this.nextId(),
      content,
      status: 'pending',
      priority,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    return item;
  }

  /** 更新待办项（支持内容、状态、优先级） */
  update(id: string, updates: Partial<Pick<TodoItem, 'content' | 'status' | 'priority'>>): TodoItem | null {
    const item = this.items.get(id);
    if (!item) return null;

    if (updates.content !== undefined) item.content = updates.content;
    if (updates.status !== undefined) item.status = updates.status;
    if (updates.priority !== undefined) item.priority = updates.priority;
    item.updatedAt = Date.now();

    return item;
  }

  /** 删除待办项 */
  delete(id: string): boolean {
    return this.items.delete(id);
  }

  /** 获取单个待办项 */
  get(id: string): TodoItem | null {
    return this.items.get(id) ?? null;
  }

  /** 列出所有待办项（按状态和优先级排序） */
  list(): TodoItem[] {
    const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
    const priorityOrder = { high: 0, medium: 1, low: 2 };

    return Array.from(this.items.values()).sort((a, b) => {
      // 先按状态排序
      const sDiff = statusOrder[a.status] - statusOrder[b.status];
      if (sDiff !== 0) return sDiff;
      // 再按优先级排序
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      // 最后按创建时间排序
      return a.createdAt - b.createdAt;
    });
  }

  /** 清空所有待办项 */
  clear(): void {
    this.items.clear();
    // P2-4 修复：不重置 counter，保持 ID 单调递增
    // 防止 clear 后新增的待办项 ID 与旧引用冲突
  }

  /** 获取统计快照 */
  getSnapshot(): TodoSnapshot {
    const items = this.list();
    return {
      items,
      total: items.length,
      pending: items.filter(i => i.status === 'pending').length,
      inProgress: items.filter(i => i.status === 'in_progress').length,
      completed: items.filter(i => i.status === 'completed').length,
    };
  }
}

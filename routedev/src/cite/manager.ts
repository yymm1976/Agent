// src/cite/manager.ts
// CiteManager：引用管理器（前后端共用）
//
// 设计目标：
//   1. 维护当前输入框中的引用列表（CRUD）
//   2. 通过 maxTags 上限防止引用爆炸（陷阱 #126）
//   3. formatForUI：生成 UI 标签数据（图标/颜色/截断文本）
//   4. toJSON：生成发送给后端的结构化列表
//
// 来源：Phase 48 Task 1 蓝图 1.2

import type { CiteItem, CiteTag, CiteType, CiteStatus } from './types.js';

// ============================================================
// 标签样式映射
// ============================================================

/** 标签样式：图标 + 背景色，按引用类型分配 */
interface TagStyle {
  icon: string;
  color: string;
}

/** 8 种引用类型对应的标签样式 */
const TAG_STYLES: Record<CiteType, TagStyle> = {
  file:    { icon: '📎', color: 'blue' },
  folder:  { icon: '📁', color: 'blue' },
  text:    { icon: '💬', color: 'purple' },
  skill:   { icon: '⚡', color: 'green' },
  tool:    { icon: '🔧', color: 'orange' },
  macro:   { icon: '📋', color: 'cyan' },
  url:     { icon: '🔗', color: 'blue' },
  message: { icon: '💬', color: 'gray' },
};

/** 标签显示文本的截断长度 */
const LABEL_MAX_LENGTH = 30;

// ============================================================
// 异常类型
// ============================================================

/** 引用数量超限时抛出 */
export class CiteLimitExceededError extends Error {
  constructor(maxTags: number) {
    super(`引用数量已达上限（${maxTags}），无法继续添加`);
    this.name = 'CiteLimitExceededError';
  }
}

/** 重复引用（同 type+source）时抛出 */
export class DuplicateCiteError extends Error {
  constructor(source: string, type: CiteType) {
    super(`引用已存在：[${type}] ${source}`);
    this.name = 'DuplicateCiteError';
  }
}

// ============================================================
// CiteManager
// ============================================================

/**
 * 引用管理器
 *
 * 前后端共用：前端用于管理输入框中的引用标签，后端用于接收序列化后的列表并解析
 */
export class CiteManager {
  /** 引用列表（按添加顺序） */
  private items: CiteItem[] = [];
  /** 单次最多引用标签数 */
  private readonly maxTags: number;

  constructor(maxTags: number = 10) {
    // 上限保护：maxTags 至少为 1
    this.maxTags = Math.max(1, Math.floor(maxTags));
  }

  // ============================================================
  // CRUD
  // ============================================================

  /**
   * 添加引用
   *
   * 校验：
   *   1. 已达 maxTags 上限时抛出 CiteLimitExceededError
   *   2. 同 type+source 已存在时抛出 DuplicateCiteError
   *
   * @returns 新添加的引用项（便于链式调用）
   */
  add(item: CiteItem): CiteItem {
    if (this.items.length >= this.maxTags) {
      throw new CiteLimitExceededError(this.maxTags);
    }
    if (this.hasDuplicate(item)) {
      throw new DuplicateCiteError(item.source, item.type);
    }
    this.items.push(item);
    return item;
  }

  /**
   * 删除指定 ID 的引用
   *
   * @returns 是否删除成功（ID 不存在时返回 false）
   */
  remove(id: string): boolean {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    return true;
  }

  /** 清空所有引用 */
  clear(): void {
    this.items = [];
  }

  /** 获取引用列表（只读视图） */
  list(): readonly CiteItem[] {
    return this.items;
  }

  /** 获取当前引用数量 */
  size(): number {
    return this.items.length;
  }

  // ============================================================
  // 序列化
  // ============================================================

  /**
   * 生成发送给后端的结构化引用列表
   *
   * 后端 CiteResolver 接收该列表后进行解析
   */
  toJSON(): CiteItem[] {
    // 深拷贝避免外部修改影响内部状态
    return this.items.map((it) => ({ ...it }));
  }

  /**
   * 生成 UI 标签数据
   *
   * 包含：
   *   - 图标 + 背景色（按类型分配）
   *   - 截断显示文本 + 完整文本（悬浮提示）
   *   - blocked / status 状态徽章
   */
  formatForUI(): CiteTag[] {
    return this.items.map((it) => {
      const style = TAG_STYLES[it.type] ?? TAG_STYLES.text;
      const truncated = CiteManager.truncateLabel(it.label, LABEL_MAX_LENGTH);
      return {
        id: it.id,
        type: it.type,
        label: truncated,
        fullLabel: it.label.length > LABEL_MAX_LENGTH ? it.label : undefined,
        color: style.color,
        icon: style.icon,
        status: it.status,
        blocked: it.blocked,
        removable: true,
      };
    });
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 检查是否已存在相同 type+source 的引用 */
  private hasDuplicate(item: CiteItem): boolean {
    return this.items.some(
      (it) => it.type === item.type && it.source === item.source,
    );
  }

  /**
   * 截断标签显示文本
   *
   * 超过 maxLength 时截断并追加省略号；中文字符按 1 字符计
   */
  private static truncateLabel(label: string, maxLength: number): string {
    if (!label) return '';
    if (label.length <= maxLength) return label;
    return label.slice(0, maxLength - 1) + '…';
  }
}

// ============================================================
// 工厂函数：快速创建 CiteItem
// ============================================================

/** 生成唯一 ID（简单实现，前端可替换为 uuid） */
export function generateCiteId(): string {
  return `cite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建 CiteItem 的便捷工厂
 *
 * 自动填充 id / createdAt，调用方只需提供业务字段
 */
export function createCiteItem(
  partial: Omit<CiteItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): CiteItem {
  return {
    id: partial.id ?? generateCiteId(),
    createdAt: partial.createdAt ?? Date.now(),
    ...partial,
  };
}

/** 标签样式查询（供 UI 单独使用） */
export function getTagStyle(type: CiteType): TagStyle {
  return TAG_STYLES[type] ?? TAG_STYLES.text;
}

/** 引用状态徽章文本 */
export function getStatusBadge(status: CiteStatus): string {
  switch (status) {
    case 'outdated':    return '已过期';
    case 'unreachable': return '分支不可见';
    case 'deleted':     return '已删除';
    case 'ok':
    default:            return '';
  }
}

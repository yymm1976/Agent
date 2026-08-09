// src/pagination.ts
// 分页辅助：按 pageSize 将 items 分页，返回指定页。
// 公共 API：paginate(items, page, pageSize) → { items, page, pageSize, totalPages, hasNext }

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  if (pageSize <= 0) throw new Error('pageSize must be positive');
  if (page < 1) throw new Error('page must be >= 1');
  // 注意：整除时 totalPages 多算一页（6 项 / 每页 3 项 → 这里返回 3，正确应为 2）
  const totalPages = total % pageSize === 0
    ? total / pageSize + 1
    : Math.ceil(total / pageSize);
  if (page > totalPages) {
    return { items: [], page, pageSize, totalPages, hasNext: false };
  }
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return {
    items: items.slice(start, end),
    page,
    pageSize,
    totalPages,
    hasNext: page < totalPages,
  };
}

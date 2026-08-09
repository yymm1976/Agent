// tests/pagination.test.ts
// 公开测试：覆盖常规分页路径（不覆盖整除边界——那是 hidden 的职责）

import { describe, it, expect } from 'vitest';
import { paginate } from '../src/pagination.js';

describe('paginate', () => {
  const items = [1, 2, 3, 4, 5];

  it('第 1 页返回前 pageSize 项', () => {
    const r = paginate(items, 1, 2);
    expect(r.items).toEqual([1, 2]);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(2);
    expect(r.totalPages).toBe(3);
    expect(r.hasNext).toBe(true);
  });

  it('中间页返回对应区间', () => {
    const r = paginate(items, 2, 2);
    expect(r.items).toEqual([3, 4]);
    expect(r.hasNext).toBe(true);
  });

  it('最后一页（非整除）返回剩余项且 hasNext=false', () => {
    const r = paginate(items, 3, 2);
    expect(r.items).toEqual([5]);
    expect(r.hasNext).toBe(false);
  });

  it('越界页返回空列表', () => {
    const r = paginate(items, 99, 2);
    expect(r.items).toEqual([]);
    expect(r.hasNext).toBe(false);
  });

  it('空输入返回空列表', () => {
    const r = paginate([], 1, 5);
    expect(r.items).toEqual([]);
    expect(r.hasNext).toBe(false);
  });

  it('非法参数抛错', () => {
    expect(() => paginate(items, 0, 2)).toThrow('page');
    expect(() => paginate(items, 1, 0)).toThrow('pageSize');
  });
});

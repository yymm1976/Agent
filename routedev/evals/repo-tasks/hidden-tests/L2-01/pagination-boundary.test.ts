// hidden/pagination-boundary.test.ts
// 隐藏测试：整除边界——totalPages 在整除时不得多算一页（fixture 埋的 bug 只在这里被抓）

import { describe, it, expect } from 'vitest';
import { paginate } from '../src/pagination.js';

describe('paginate 整除边界（hidden）', () => {
  it('6 项 / 每页 3 项 → totalPages=2（整除不多算）', () => {
    const r = paginate([1, 2, 3, 4, 5, 6], 1, 3);
    expect(r.totalPages).toBe(2);
    expect(r.hasNext).toBe(true);
  });

  it('整除时最后一页 hasNext=false', () => {
    const r = paginate([1, 2, 3, 4, 5, 6], 2, 3);
    expect(r.items).toEqual([4, 5, 6]);
    expect(r.totalPages).toBe(2);
    expect(r.hasNext).toBe(false);
  });

  it('整除时越界页（page=3）返回空', () => {
    const r = paginate([1, 2, 3, 4, 5, 6], 3, 3);
    expect(r.items).toEqual([]);
    expect(r.totalPages).toBe(2);
  });

  it('空输入 totalPages=0（0 也是整除情形）', () => {
    const r = paginate([], 1, 5);
    expect(r.totalPages).toBe(0);
  });
});

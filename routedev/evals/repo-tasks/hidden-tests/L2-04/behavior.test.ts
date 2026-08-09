// hidden/behavior.test.ts
// 重构后行为保持（public 未覆盖的输入组合）
import { describe, it, expect } from 'vitest';
import { normalizeOrderA, normalizeOrderB } from '../src/order-utils.js';

describe('归一化行为保持（hidden）', () => {
  it('空列表：total=0', () => {
    expect(normalizeOrderA([]).total).toBe(0);
    expect(normalizeOrderB([]).total).toBe(0);
  });

  it('自定义货币透传', () => {
    expect(normalizeOrderA([{ sku: 'x', qty: 1, price: 1 }], 'CNY').currency).toBe('CNY');
  });

  it('排序稳定：同 sku 多行保持相对顺序', () => {
    const rows = [
      { sku: 's', qty: 1, price: 1 },
      { sku: 's', qty: 2, price: 3 },
    ];
    const r = normalizeOrderB(rows);
    expect(r.items[0]!.qty).toBe(1);
    expect(r.items[1]!.qty).toBe(2);
    expect(r.total).toBe(7);
  });

  it('浮点合计', () => {
    expect(normalizeOrderA([{ sku: 'x', qty: 3, price: 0.1 }]).total).toBeCloseTo(0.3);
  });
});

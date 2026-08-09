// tests/order-utils.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeOrderA, normalizeOrderB } from '../src/order-utils.js';

const items = [
  { sku: 'b', qty: 1, price: 10 },
  { sku: 'a', qty: 2, price: 5 },
];

describe('normalizeOrderA / B', () => {
  it('排序 + 合计', () => {
    const a = normalizeOrderA(items);
    expect(a.items.map((i) => i.sku)).toEqual(['a', 'b']);
    expect(a.total).toBe(20);
    expect(a.currency).toBe('USD');
  });

  it('B 与 A 行为一致', () => {
    expect(normalizeOrderB(items)).toEqual(normalizeOrderA(items));
  });

  it('非法输入抛错', () => {
    expect(() => normalizeOrderA([{ sku: '', qty: 1, price: 1 }])).toThrow('sku');
    expect(() => normalizeOrderB([{ sku: 'x', qty: 0, price: 1 }])).toThrow('qty');
  });
});

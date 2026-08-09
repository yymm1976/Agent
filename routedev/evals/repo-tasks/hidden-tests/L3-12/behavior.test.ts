// hidden/behavior.test.ts
// 折扣场景（hidden）：带折扣码的订单必须应用折扣
import { describe, it, expect } from 'vitest';
import { processOrder } from '../src/order-processor.js';

describe('折扣（hidden）', () => {
  it('10% 折扣码生效', () => {
    const r = processOrder({
      id: 'o3',
      lines: [{ sku: 'a', qty: 2, price: 50 }],
      discountPercent: 10,
    });
    expect(r.subtotal).toBe(100);
    expect(r.discount).toBe(10); // 100 * 10%
    expect(r.total).toBe(90);
  });

  it('0% 折扣码不改变总额', () => {
    const r = processOrder({
      id: 'o4',
      lines: [{ sku: 'a', qty: 1, price: 30 }],
      discountPercent: 0,
    });
    expect(r.total).toBe(30);
  });
});

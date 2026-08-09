// tests/order.test.ts
import { describe, it, expect } from 'vitest';
import { processOrder } from '../src/order-processor.js';

describe('processOrder 基础', () => {
  it('无折扣订单：total = subtotal', () => {
    const r = processOrder({
      id: 'o1',
      lines: [{ sku: 'a', qty: 2, price: 10 }],
    });
    expect(r.subtotal).toBe(20);
    expect(r.total).toBe(20);
    expect(r.discount).toBe(0);
  });

  it('多行合计', () => {
    const r = processOrder({
      id: 'o2',
      lines: [
        { sku: 'a', qty: 1, price: 10 },
        { sku: 'b', qty: 3, price: 5 },
      ],
    });
    expect(r.subtotal).toBe(25);
    expect(r.total).toBe(25);
  });
});

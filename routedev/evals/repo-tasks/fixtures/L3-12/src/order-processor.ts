// src/order-processor.ts
// 订单处理：BUG——带折扣码的订单未应用折扣
import { applyDiscount } from './price.js';

export interface OrderLine {
  sku: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  lines: OrderLine[];
  discountPercent?: number;
}

export interface ProcessedOrder {
  id: string;
  subtotal: number;
  discount: number;
  total: number;
}

export function processOrder(order: Order): ProcessedOrder {
  const subtotal = order.lines.reduce((acc, l) => acc + l.qty * l.price, 0);
  // BUG: discountPercent 存在时未调用 applyDiscount——总价未打折
  const discount = 0;
  const total = subtotal - discount;
  return { id: order.id, subtotal, discount, total };
}

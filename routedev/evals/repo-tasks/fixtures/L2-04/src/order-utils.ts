// src/order-utils.ts
// 订单工具：两个高度重复的归一化函数（重构目标——提取公共逻辑，不得改公共 API）

export interface OrderItem {
  sku: string;
  qty: number;
  price: number;
}

export interface NormalizedOrder {
  items: OrderItem[];
  total: number;
  currency: string;
}

function validateOrder(items: readonly OrderItem[]): void {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  for (const item of items) {
    if (typeof item.sku !== 'string' || item.sku.length === 0) throw new Error('sku required');
    if (typeof item.qty !== 'number' || item.qty <= 0) throw new Error('qty must be positive');
    if (typeof item.price !== 'number' || item.price < 0) throw new Error('price must be >= 0');
  }
}

function sortItems(items: readonly OrderItem[]): OrderItem[] {
  return [...items].sort((a, b) => a.sku.localeCompare(b.sku));
}

function computeTotal(items: readonly OrderItem[]): number {
  return items.reduce((acc, it) => acc + it.qty * it.price, 0);
}

export function normalizeOrderA(items: readonly OrderItem[], currency = 'USD'): NormalizedOrder {
  validateOrder(items);
  const sorted = sortItems(items);
  const total = computeTotal(sorted);
  return { items: sorted, total, currency };
}

export function normalizeOrderB(items: readonly OrderItem[], currency = 'USD'): NormalizedOrder {
  validateOrder(items);
  const sorted = sortItems(items);
  const total = computeTotal(sorted);
  return { items: sorted, total, currency };
}

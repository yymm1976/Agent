// src/score-calc.ts
// 统计计算
export function min(values: readonly number[]): number {
  return Math.min(...values);
}

export function max(values: readonly number[]): number {
  return Math.max(...values);
}

export function average(values: readonly number[]): number {
  // BUG: 除以固定 2 而非 values.length（average([1,2,3]) 返回 3 而非 2）
  return values.reduce((a, b) => a + b, 0) / 2;
}

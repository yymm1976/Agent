// src/score-calc.ts
// 评分计算：空输入返回 0
export function computeScore(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// src/utils/jaccard.ts
// 公共 Jaccard 相似度工具函数
//
// 从 graph.ts 中抽取，消除重复实现

/**
 * 分词：按非字母数字字符切分，过滤空串，统一小写
 */
export function tokenizeForJaccard(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter(s => s.length > 0),
  );
}

/**
 * 计算两个词集的 Jaccard 相似度
 *
 * Jaccard = |A ∩ B| / |A ∪ B|
 * - 两个空集返回 1.0
 * - 一个空一个非空返回 0
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}



// src/memory/eval-metrics.ts
// Phase 65 Task 7：EvalMetrics - 评估指标
//
// 论文：检索保真度（Retrieval Fidelity）
// 实现：
//   - retrievalFidelity: top-K 中包含 ground-truth 的比例（Recall@K）
//
// 注：temporalUpdateRobustness 已随 ConservativeMerger 一并删除（死代码清理）

import type { MemoryEntry } from './memory-store.js';

/**
 * 检索保真度（Recall@K）
 * - 取 retrieved 前 K 条
 * - 计算与 groundTruthIds 的命中比例
 * - 返回 [0, 1]
 */
export function retrievalFidelity(
  retrieved: MemoryEntry[],
  groundTruthIds: string[],
  k: number,
): number {
  if (groundTruthIds.length === 0) return 0;
  if (k <= 0) return 0;
  const topK = retrieved.slice(0, k);
  const topKIds = new Set(topK.map((e) => e.id).filter((id): id is string => !!id));
  const hits = groundTruthIds.filter((id) => topKIds.has(id)).length;
  return hits / groundTruthIds.length;
}

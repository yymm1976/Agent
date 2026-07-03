// src/memory/eval-metrics.ts
// Phase 65 Task 7：EvalMetrics - 评估指标
//
// 论文：检索保真度（Retrieval Fidelity）、时序更新鲁棒性（Temporal Update Robustness）
// 实现：
//   - retrievalFidelity: top-K 中包含 ground-truth 的比例（Recall@K）
//   - temporalUpdateRobustness: 更新后返回最新版本的比例

import type { MemoryStore, MemoryEntry } from './memory-store.js';
import { ConservativeMerger, type MatchKey } from './conservative-merger.js';

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

/**
 * 时序更新鲁棒性
 * - 应用一系列更新（用 ConservativeMerger 处理版本）
 * - 检索每个 matchKey 的 latest
 * - 验证返回的是否为最新版本（content 与新内容一致）
 * - 返回 robustness = returnedLatest / total
 *
 * 无更新时（updates 为空），返回 1
 */
export async function temporalUpdateRobustness(
  store: MemoryStore,
  updates: Array<{ matchKey: MatchKey; newContent: string }>,
): Promise<{ robustness: number; returnedLatest: number; returnedStale: number }> {
  if (updates.length === 0) {
    return { robustness: 1, returnedLatest: 0, returnedStale: 0 };
  }

  const merger = new ConservativeMerger(store);

  // 应用所有更新
  for (const update of updates) {
    const entry: MemoryEntry = {
      content: update.newContent,
      type: update.matchKey.type as MemoryEntry['type'],
      source: 'eval',
      validFrom: Date.now(),
      topics: update.matchKey.topics,
    };
    await merger.writeWithVersion(entry, update.matchKey);
  }

  // 检索每个 matchKey 的 latest，验证是否为最新版本
  let returnedLatest = 0;
  let returnedStale = 0;
  for (const update of updates) {
    const latest = await merger.retrieveLatest(update.matchKey);
    if (latest && latest.content === update.newContent) {
      returnedLatest++;
    } else {
      returnedStale++;
    }
  }

  const total = returnedLatest + returnedStale;
  return {
    robustness: total > 0 ? returnedLatest / total : 1,
    returnedLatest,
    returnedStale,
  };
}

// src/memory/hybrid-retriever.ts
// Phase 65 Task 3：HybridRetriever - 混合检索器
//
// 论文：稀疏 BM25 + 稠密向量检索 + 时间衰减
// 实现：
//   - 混合分数：score = (α × bm25_norm + (1-α) × cosine_norm) × timeDecay
//     - bm25_norm = bm25 / max_bm25
//     - cosine_norm = (cosine + 1) / 2
//     - timeDecay = exp(-ln(2) × ageDays / halfLifeDays)
//   - embedder 不可用降级纯 BM25（cosine_norm = 0）
//   - 检索失败 fail-open 返回空

import type { MemoryStore, MemoryEntry } from './memory-store.js';
import type { Embedder } from '../skills/embedder.js';
import { BM25Index } from './bm25-index.js';

export interface HybridRetrieverConfig {
  enabled: boolean;
  /** BM25 权重 α */
  bm25Weight: number;
  /** embedding 权重 (1-α) */
  embeddingWeight: number;
  /** 时间衰减半衰期（天） */
  timeDecayHalfLifeDays: number;
  /** 返回前 K 条 */
  topK: number;
}

export type ScoredMemoryEntry = MemoryEntry & {
  /** 混合最终分数 */
  score: number;
  /** 原始 BM25 分数（未归一化） */
  bm25Score: number;
  /** embedding cosine 归一化分数 [0, 1] */
  embeddingScore: number;
  /** 时间衰减系数 (0, 1] */
  timeDecay: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class HybridRetriever {
  private store: MemoryStore;
  private embedder: Embedder | null;
  private config: HybridRetrieverConfig;

  constructor(store: MemoryStore, embedder: Embedder | null, config: HybridRetrieverConfig) {
    this.store = store;
    this.embedder = embedder;
    this.config = config;
  }

  /**
   * 混合检索
   * 1. 获取所有候选条目
   * 2. 计算 BM25 分数（归一化到 [0, 1]）
   * 3. 计算 embedding cosine（归一化到 [0, 1]）
   * 4. 计算时间衰减
   * 5. 加权求和，返回 top-K
   */
  async retrieve(query: string): Promise<ScoredMemoryEntry[]> {
    if (!query || !query.trim()) return [];
    if (!this.config.enabled) return [];

    try {
      const all = this.store.getAll();
      if (all.length === 0) return [];

      // 仅对有 id 的条目计算
      const candidates = all.filter((e) => !!e.id);
      if (candidates.length === 0) return [];

      // BM25 打分
      const bm25 = new BM25Index();
      bm25.index(candidates.map((e) => ({ id: e.id!, content: e.content })));
      const bm25Results = bm25.search(query, candidates.length);
      const bm25Map = new Map(bm25Results.map((r) => [r.id, r.score]));
      const maxBm25 = bm25Results.length > 0 ? Math.max(...bm25Results.map((r) => r.score)) : 0;

      // Embedding 打分（embedder 不可用时降级）
      let queryEmb: number[] | null = null;
      if (this.embedder) {
        try {
          queryEmb = await this.embedder.embed(query);
        } catch {
          queryEmb = null;
        }
      }

      // α = bm25Weight / (bm25Weight + embeddingWeight)
      const totalWeight = this.config.bm25Weight + this.config.embeddingWeight;
      const alpha = totalWeight > 0 ? this.config.bm25Weight / totalWeight : 0.5;

      const now = Date.now();
      const halfLifeDays = this.config.timeDecayHalfLifeDays;
      const scored: ScoredMemoryEntry[] = [];

      for (const entry of candidates) {
        const id = entry.id!;
        const bm25Score = bm25Map.get(id) ?? 0;
        const bm25Norm = maxBm25 > 0 ? bm25Score / maxBm25 : 0;

        let cosineNorm = 0;
        if (queryEmb) {
          const entryEmb = this.store.getEmbedding(id);
          if (entryEmb) {
            const cosine = this.cosine(queryEmb, entryEmb);
            cosineNorm = (cosine + 1) / 2;
          }
        }

        // 时间衰减
        const ageMs = Math.max(0, now - entry.validFrom);
        const ageDays = ageMs / MS_PER_DAY;
        const timeDecay = Math.exp((-Math.log(2) * ageDays) / (halfLifeDays || 1));

        // 混合分数
        const score = (alpha * bm25Norm + (1 - alpha) * cosineNorm) * timeDecay;

        // 只保留有分数的（BM25 命中或 embedding 命中）
        if (bm25Score > 0 || cosineNorm > 0) {
          scored.push({
            ...entry,
            score,
            bm25Score,
            embeddingScore: cosineNorm,
            timeDecay,
          });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const topK = scored.slice(0, this.config.topK);

      return topK;
    } catch {
      // fail-open：检索失败返回空
      return [];
    }
  }

  /** 计算 cosine 相似度 */
  private cosine(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
    }
    const normA = Math.sqrt(a.reduce((s, v) => s + v * v, 0)) || 1;
    const normB = Math.sqrt(b.reduce((s, v) => s + v * v, 0)) || 1;
    return dot / (normA * normB);
  }
}

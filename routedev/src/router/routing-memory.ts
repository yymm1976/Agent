// src/router/routing-memory.ts
// ACRouter 闭环模型路由：RoutingMemory 向量库与 kNN 检索
// 论文借鉴：ACRouter Memory 模块用 task embedding 为 key，cosine kNN 取 top-10 邻居
// 信息缺失诊断：历史邻居信息是路由决策的关键输入

import type { RoutingHistory, RoutingRecord, ModelStats } from './routing-history.js';
import type { Embedder } from './embedder.js';
import { cosineSimilarity } from './embedder.js';
import { logger } from '../utils/logger.js';

export interface NeighborModelStats {
  neighborCount: number;
  avgQuality: number;
  avgCost: number;
  avgLatency: number;
  weightedScore: number;
}

export class RoutingMemory {
  private readonly history: RoutingHistory;
  private readonly embedder: Embedder;
  private readonly topK: number;
  private readonly minSimilarity: number;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  constructor(
    history: RoutingHistory,
    embedder: Embedder,
    config?: {
      topK?: number;
      minSimilarity?: number;
      enabled?: boolean;
      timeoutMs?: number;
    },
  ) {
    this.history = history;
    this.embedder = embedder;
    this.topK = config?.topK ?? 10;
    this.minSimilarity = config?.minSimilarity ?? 0.3;
    this.enabled = config?.enabled ?? false;
    this.timeoutMs = config?.timeoutMs ?? 500;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async queryNeighbors(query: string): Promise<RoutingRecord[]> {
    if (!this.enabled) return [];
    try {
      const result = await this.queryNeighborsInner(query);
      return result;
    } catch (err) {
      logger.warn('RoutingMemory queryNeighbors failed, fail-open', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async queryNeighborsInner(query: string): Promise<RoutingRecord[]> {
    const queryEmbedding = await this.embedWithTimeout(query);
    const records = this.history.getRecords();
    const scored: Array<{ record: RoutingRecord; similarity: number }> = [];

    for (const record of records) {
      if (!record.taskEmbedding || record.taskEmbedding.length === 0) continue;
      const sim = cosineSimilarity(queryEmbedding, record.taskEmbedding);
      if (sim >= this.minSimilarity) {
        scored.push({ record, similarity: sim });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, this.topK).map(s => s.record);
  }

  async queryModelStats(query: string): Promise<Map<string, NeighborModelStats>> {
    if (!this.enabled) return new Map();
    try {
      const neighbors = await this.queryNeighbors(query);
      if (neighbors.length === 0) return new Map();
      return this.aggregateByModel(neighbors, query);
    } catch (err) {
      logger.warn('RoutingMemory queryModelStats failed, fail-open', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Map();
    }
  }

  private async aggregateByModel(
    neighbors: RoutingRecord[],
    query: string,
  ): Promise<Map<string, NeighborModelStats>> {
    const queryEmbedding = await this.embedWithTimeout(query);
    const buckets = new Map<string, Array<{ record: RoutingRecord; similarity: number }>>();

    for (const n of neighbors) {
      const sim = n.taskEmbedding
        ? cosineSimilarity(queryEmbedding, n.taskEmbedding)
        : 0.1;
      let bucket = buckets.get(n.modelId);
      if (!bucket) {
        bucket = [];
        buckets.set(n.modelId, bucket);
      }
      bucket.push({ record: n, similarity: sim });
    }

    const result = new Map<string, NeighborModelStats>();
    for (const [modelId, entries] of buckets) {
      let totalWeight = 0;
      let weightedQuality = 0;
      let totalCost = 0;
      let totalLatency = 0;
      let costCount = 0;
      let latencyCount = 0;

      for (const { record, similarity } of entries) {
        totalWeight += similarity;
        if (record.qualityScore != null) {
          weightedQuality += similarity * record.qualityScore;
        }
        if (record.tokenCost != null) {
          totalCost += record.tokenCost;
          costCount++;
        }
        if (record.latencyMs != null) {
          totalLatency += record.latencyMs;
          latencyCount++;
        }
      }

      result.set(modelId, {
        neighborCount: entries.length,
        avgQuality: entries.some(e => e.record.qualityScore != null)
          ? entries.reduce((s, e) => s + (e.record.qualityScore ?? 0), 0) / entries.filter(e => e.record.qualityScore != null).length
          : 0.5,
        avgCost: costCount > 0 ? totalCost / costCount : 0,
        avgLatency: latencyCount > 0 ? totalLatency / latencyCount : 0,
        weightedScore: totalWeight > 0 ? weightedQuality / totalWeight : 0.5,
      });
    }

    return result;
  }

  private async embedWithTimeout(text: string): Promise<number[]> {
    return Promise.race([
      this.embedder.embed(text),
      new Promise<number[]>((_, reject) =>
        setTimeout(() => reject(new Error('Embedding timeout')), this.timeoutMs)
      ),
    ]);
  }
}

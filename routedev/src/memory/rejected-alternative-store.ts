// src/memory/rejected-alternative-store.ts
// Phase 65 Task 5：RejectedAlternativeStore - 被拒方案存储
//
// 论文：保留被拒方案及拒绝原因，避免重复提出已拒绝的方案
// 实现：
//   - recordRejection: 调 store.write，type='rejected_alternative'，
//     metadata 含 rejectionReason 和 issues JSON，原文保留不摘要
//   - findSimilarRejections: 用 BM25 检索 type='rejected_alternative' 的条目

import type { MemoryStore, MemoryEntry } from './memory-store.js';
import { BM25Index } from './bm25-index.js';

export interface RejectionIssue {
  severity: string;
  description: string;
}

export interface RecordRejectionParams {
  /** 被拒方案的原文（保留不摘要） */
  proposal: string;
  /** 拒绝原因 */
  rejectionReason: string;
  /** 问题列表 */
  issues: RejectionIssue[];
  /** 关联 topics */
  topics: string[];
  /** 来源（如阶段名） */
  source: string;
}

export type ScoredRejectedAlternative = MemoryEntry & { score: number };

export class RejectedAlternativeStore {
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * 记录被拒方案
   * - type='rejected_alternative'
   * - metadata 包含 rejectionReason 和 issues JSON
   * - 原文保留不摘要（content = proposal 原文）
   */
  async recordRejection(params: RecordRejectionParams): Promise<string> {
    const id = await this.store.write({
      content: params.proposal,
      type: 'rejected_alternative',
      source: params.source,
      validFrom: Date.now(),
      topics: params.topics,
      metadata: {
        rejectionReason: params.rejectionReason,
        issues: JSON.stringify(params.issues),
      },
    });
    return id;
  }

  /**
   * 检索相似的被拒方案
   * - 在 type='rejected_alternative' 的条目中检索
   * - 用 BM25 评分排序
   * - 失败时降级为全文检索（LIKE 匹配，分数为 1）
   */
  async findSimilarRejections(
    query: string,
    limit: number,
  ): Promise<ScoredRejectedAlternative[]> {
    if (!query || !query.trim()) return [];

    const all = this.store.filter((e) => e.type === 'rejected_alternative');
    if (all.length === 0) return [];

    try {
      // BM25 评分
      const bm25 = new BM25Index();
      bm25.index(
        all
          .filter((e) => !!e.id)
          .map((e) => ({ id: e.id!, content: e.content })),
      );
      const scored = bm25.search(query, limit);

      // 关联回原条目
      const idToEntry = new Map(all.map((e) => [e.id, e]));
      const results: ScoredRejectedAlternative[] = [];
      for (const s of scored) {
        const entry = idToEntry.get(s.id);
        if (entry) {
          results.push({ ...entry, score: s.score });
        }
      }
      return results;
    } catch {
      // fail-open：BM25 失败时降级为全文检索（分数为 1）
      const results = await this.store.searchFullText(query, limit);
      return results
        .filter((e) => e.type === 'rejected_alternative')
        .map((e) => ({ ...e, score: 1 }));
    }
  }
}

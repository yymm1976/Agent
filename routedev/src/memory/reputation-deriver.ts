// src/memory/reputation-deriver.ts
// Phase 66 Task 5：信誉派生器
//
// 设计目标：
//   1. 从审计记录派生 topic 信誉
//   2. credibility = successCount / totalCount
//   3. 无引用时 credibility=0.5（中性）
//   4. 缓存 maxCacheAgeMs（默认 60000ms = 1 分钟）
//   5. fail-open：异常时返回 credibility=0.5
//
// 与 audit-logger 的关系：只读取审计记录，不修改 audit-logger.ts

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export interface DerivedReputation {
  topicId: string;
  successRefCount: number;
  rejectedRefCount: number;
  /** 信誉值 [0.0, 1.0]；无引用时为 0.5 */
  credibility: number;
  computedAt: number;
}

/** 话题引用（一条引用代表一次审批结果） */
interface TopicReference {
  topicId: string;
  outcome: 'approved' | 'denied';
}

interface CacheEntry {
  reputation: DerivedReputation;
  computedAt: number;
}

// ============================================================
// ReputationDeriver
// ============================================================

export class ReputationDeriver {
  private config: { enabled: boolean; maxCacheAgeMs: number };
  private cache: Map<string, CacheEntry> = new Map();

  constructor(config: { enabled: boolean; maxCacheAgeMs: number }) {
    this.config = config;
  }

  /**
   * 派生单个 topic 的信誉
   * - 缓存命中且未过期 → 返回缓存
   * - 否则重新计算并写入缓存
   * - credibility = successCount / totalCount；无引用时为 0.5
   */
  deriveReputation(
    topicId: string,
    references: Array<TopicReference>,
  ): DerivedReputation {
    // fail-open：异常时返回默认信誉
    try {
      // 缓存命中检查
      const cached = this.cache.get(topicId);
      if (cached && Date.now() - cached.computedAt < this.config.maxCacheAgeMs) {
        return cached.reputation;
      }

      const topicRefs = (references ?? []).filter((r) => r.topicId === topicId);
      const total = topicRefs.length;
      const successCount = topicRefs.filter((r) => r.outcome === 'approved').length;
      const rejectedCount = topicRefs.filter((r) => r.outcome === 'denied').length;

      const credibility = total === 0 ? 0.5 : successCount / total;

      const reputation: DerivedReputation = {
        topicId,
        successRefCount: successCount,
        rejectedRefCount: rejectedCount,
        credibility,
        computedAt: Date.now(),
      };

      this.cache.set(topicId, { reputation, computedAt: reputation.computedAt });
      return reputation;
    } catch (err) {
      logger.warn('ReputationDeriver: deriveReputation threw, returning default', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        topicId,
        successRefCount: 0,
        rejectedRefCount: 0,
        credibility: 0.5,
        computedAt: Date.now(),
      };
    }
  }

  /**
   * 批量派生多个 topic 的信誉
   * 共享同一份 references（内部按 topicId 过滤）
   */
  deriveBatch(
    topicIds: string[],
    references: Array<TopicReference>,
  ): Map<string, DerivedReputation> {
    const result = new Map<string, DerivedReputation>();
    for (const id of topicIds ?? []) {
      result.set(id, this.deriveReputation(id, references));
    }
    return result;
  }

  /** 缓存失效（强制下次重算） */
  invalidate(topicId: string): void {
    this.cache.delete(topicId);
  }

  /**
   * 从 audit records 查询 topic 引用
   * 兼容两种结构：
   *   - { topicId, result: 'success' | 'denied' | 'failure' | 'approved' }
   *   - { details: { topicId, result } }
   */
  queryTopicReferences(
    topicId: string,
    auditRecords: any[],
  ): Array<TopicReference> {
    const refs: Array<TopicReference> = [];
    try {
      for (const rec of auditRecords ?? []) {
        const recTopicId = rec?.topicId ?? rec?.details?.topicId;
        if (recTopicId !== topicId) continue;

        const result = rec?.result ?? rec?.details?.result;
        let outcome: 'approved' | 'denied';
        if (result === 'success' || result === 'approved') {
          outcome = 'approved';
        } else if (result === 'denied' || result === 'failure') {
          outcome = 'denied';
        } else {
          // 未知结果跳过
          continue;
        }
        refs.push({ topicId, outcome });
      }
    } catch (err) {
      logger.warn('ReputationDeriver: queryTopicReferences threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return refs;
  }
}

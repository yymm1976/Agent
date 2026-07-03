// src/memory/local-maintenance.ts
// Phase 65 Task 6：LocalMaintenancePolicy - 局部维护策略
//
// 论文：局部维护（不触全局）、阈值触发、最旧最少访问优先
// 实现：
//   - shouldMaintain: count > triggerThreshold
//   - maintain: 候选选择（按 validFrom ASC）+ 重组（标记 archived 不删除）
//   - 旧条目标 metadata.archived=true（不删除，保留下文可恢复）

import type { MemoryStore, MemoryEntry } from './memory-store.js';

export interface LocalMaintenanceConfig {
  enabled: boolean;
  /** 触发阈值：count > triggerThreshold 时需要维护 */
  triggerThreshold: number;
  /** 重组比例：取前 count × reorganizeRatio 条作为候选 */
  reorganizeRatio: number;
  /** 最少访问次数：访问次数 < minAccessCount 才作为候选 */
  minAccessCount: number;
}

export interface MaintenanceResult {
  /** 重组条目数 */
  reorganized: number;
  /** 合并条目数 */
  merged: number;
  /** 标记 supersede 条目数 */
  superseded: number;
  /** 维护耗时（ms） */
  durationMs: number;
}

export interface ShouldMaintainResult {
  needed: boolean;
  currentCount: number;
  threshold: number;
}

export class LocalMaintenancePolicy {
  private store: MemoryStore;
  private config: LocalMaintenanceConfig;

  constructor(store: MemoryStore, config: LocalMaintenanceConfig) {
    this.store = store;
    this.config = config;
  }

  /**
   * 判断是否需要维护
   * - count > triggerThreshold 时 needed=true
   */
  shouldMaintain(): ShouldMaintainResult {
    const currentCount = this.store.count();
    return {
      needed: currentCount > this.config.triggerThreshold,
      currentCount,
      threshold: this.config.triggerThreshold,
    };
  }

  /**
   * 执行局部维护
   *
   * 步骤：
   * 1. 未达阈值时不维护
   * 2. 候选选择：按 validFrom ASC 排序（最旧优先），取前 count × reorganizeRatio 条
   * 3. 重组：标记 metadata.archived=true（不删除）
   * 4. 同类合并：同 (type, topics[0]) 的多个条目合并为一条
   * 5. 时效淘汰：旧版本 supersede（已 supersededAt 的不动）
   *
   * 局部维护：只处理候选条目，不触全局
   */
  async maintain(): Promise<MaintenanceResult> {
    const start = Date.now();
    const result: MaintenanceResult = {
      reorganized: 0,
      merged: 0,
      superseded: 0,
      durationMs: 0,
    };

    if (!this.config.enabled) {
      result.durationMs = Date.now() - start;
      return result;
    }

    const status = this.shouldMaintain();
    if (!status.needed) {
      result.durationMs = Date.now() - start;
      return result;
    }

    // 候选选择：按 validFrom ASC 排序（最旧优先）
    const all = this.store.getAll();
    const sorted = [...all].sort((a, b) => a.validFrom - b.validFrom);
    const candidateCount = Math.max(1, Math.floor(all.length * this.config.reorganizeRatio));
    const candidates = sorted.slice(0, candidateCount);

    // 重组：标记 archived=true（不删除）
    for (const entry of candidates) {
      if (!entry.id) continue;
      // 跳过已 archived 的
      if (entry.metadata?.archived === 'true') continue;

      const newMetadata: Record<string, string> = {
        ...(entry.metadata ?? {}),
        archived: 'true',
        archivedAt: String(Date.now()),
      };
      await this.store.update(entry.id, { metadata: newMetadata });
      result.reorganized++;
    }

    // 同类合并：按 (type, topics[0]) 分组，组内 >1 条则合并
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of candidates) {
      const key = `${entry.type}|${entry.topics?.[0] ?? ''}`;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length > 1) {
        // 合并：保留最新的，其他标记 supersededAt
        const sortedGroup = [...group].sort((a, b) => a.validFrom - b.validFrom);
        const newest = sortedGroup[sortedGroup.length - 1];
        for (let i = 0; i < sortedGroup.length - 1; i++) {
          const old = sortedGroup[i];
          if (old.id && !old.supersededAt) {
            await this.store.update(old.id, { supersededAt: Date.now() });
            result.superseded++;
          }
        }
        result.merged++;
      }
    }

    result.durationMs = Date.now() - start;
    return result;
  }
}

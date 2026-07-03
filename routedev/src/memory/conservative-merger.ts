// src/memory/conservative-merger.ts
// Phase 65 Task 4：ConservativeMerger - 保守合并器（M4 多版本）
//
// 论文：M4 多版本记忆、保守合并（不删除旧版本，只 supersede）
// 实现：
//   - writeWithVersion: 查找同 matchKey 的现有记忆
//     - 冲突：旧记忆设 supersededAt，新记忆写入（不删除旧记忆）
//     - 不冲突但同 topic：旧 content 追加 "[补充] new"，不 supersede
//     - 无 matchKey：直接插入
//   - getVersionHistory: 按 validFrom 排序的所有版本
//   - retrieveLatest: 只返回未 supersede 的最新版本

import type { MemoryStore, MemoryEntry } from './memory-store.js';
import { textJaccardSimilarity } from '../utils/jaccard.js';

export interface MatchKey {
  topics: string[];
  type: string;
}

export interface WriteWithVersionResult {
  /** 新版本的 id（冲突或无匹配时为新写入；追加时为旧条目 id） */
  newVersionId: string;
  /** 被 supersede 的旧条目 id 列表 */
  supersededOldIds: string[];
}

export class ConservativeMerger {
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * 写入新条目并处理版本管理
   *
   * 冲突检测：基于 content 相似度（Jaccard > 0.5 视为冲突）
   * - 冲突：旧条目标 supersededAt，新条目写入（不删除旧条目）
   * - 不冲突但同 topic：旧条目 content 追加 "[补充] new"，不 supersede（不写新条目）
   * - 无匹配：直接写入新条目
   */
  async writeWithVersion(
    entry: MemoryEntry,
    matchKey: MatchKey,
  ): Promise<WriteWithVersionResult> {
    // 查找同 matchKey 的现有记忆（topics 交集非空 + type 相同）
    const existing = this.store.filter(
      (e) =>
        e.type === matchKey.type &&
        !!e.topics &&
        e.topics.some((t) => matchKey.topics.includes(t)),
    );

    if (existing.length === 0) {
      // 无 matchKey 时直接插入
      const newId = await this.store.write(entry);
      return { newVersionId: newId, supersededOldIds: [] };
    }

    // 区分冲突 vs 可合并
    const conflicting = existing.filter((e) => this.isConflict(e.content, entry.content));
    const appendable = existing.filter((e) => !this.isConflict(e.content, entry.content));

    const supersededOldIds: string[] = [];

    // 冲突：旧记忆设 supersededAt，新记忆写入
    if (conflicting.length > 0) {
      const now = Date.now();
      for (const old of conflicting) {
        if (old.id) {
          await this.store.update(old.id, { supersededAt: now });
          supersededOldIds.push(old.id);
        }
      }
      const newId = await this.store.write(entry);
      return { newVersionId: newId, supersededOldIds };
    }

    // 不冲突但同 topic：追加（旧 content 追加 "[补充] new"，不 supersede）
    // 取最近一条作为追加目标（validFrom 最大的）
    const target = appendable.reduce((latest, e) =>
      e.validFrom > latest.validFrom ? e : latest,
    );
    if (target.id) {
      const newContent = `${target.content}\n[补充] ${entry.content}`;
      await this.store.update(target.id, { content: newContent });
      return { newVersionId: target.id, supersededOldIds: [] };
    }

    // fallback：直接写入
    const newId = await this.store.write(entry);
    return { newVersionId: newId, supersededOldIds: [] };
  }

  /**
   * 获取版本历史：按 validFrom 升序排列
   * 包含所有版本（已 supersede 和未 supersede）
   */
  async getVersionHistory(memoryId: string): Promise<MemoryEntry[]> {
    const entry = await this.store.read(memoryId);
    if (!entry) return [];
    const matchKey: MatchKey = {
      topics: entry.topics ?? [],
      type: entry.type,
    };
    // 查找同 matchKey 的所有记忆
    const all = this.store.filter(
      (e) =>
        e.type === matchKey.type &&
        !!e.topics &&
        e.topics.some((t) => matchKey.topics.includes(t)),
    );
    return all.sort((a, b) => a.validFrom - b.validFrom);
  }

  /**
   * 检索最新版本：只返回未 supersede 的最新条目
   * 如无未 supersede 的条目，返回 null
   */
  async retrieveLatest(matchKey: MatchKey): Promise<MemoryEntry | null> {
    const candidates = this.store.filter(
      (e) =>
        e.type === matchKey.type &&
        !e.supersededAt &&
        !!e.topics &&
        e.topics.some((t) => matchKey.topics.includes(t)),
    );
    if (candidates.length === 0) return null;
    // 取 validFrom 最大的
    return candidates.reduce((latest, e) => (e.validFrom > latest.validFrom ? e : latest));
  }

  /**
   * 冲突检测：基于 Jaccard 相似度
   * - content 完全相同 → 冲突
   * - Jaccard > 0.5 → 冲突
   * - 否则不冲突
   *
   * P1 修复：复用公共 textJaccardSimilarity
   */
  private isConflict(a: string, b: string): boolean {
    if (a === b) return true;
    return textJaccardSimilarity(a, b) > 0.5;
  }
}

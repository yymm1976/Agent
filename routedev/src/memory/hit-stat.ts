// src/memory/hit-stat.ts
// Phase 97 Part I Task I2：触发率统计与低效淘汰
//
// 借鉴 Proma 的「弱记忆显式触发」思想：不做宽泛 RAG，而是记录
// 每个记忆条目 / Skill / UserProfile 字段被实际引用的次数，
// 周期性评估触发率，低触发条目标记 deprecated 或建议移除/重写。
//
// 约束：
//   - 纯内存计数（不落盘），进程生命周期内有效
//   - record 内部 fail-open，任何异常不影响主流程
//   - 以「key」为粒度计数，key 形如 memory:<nodeId> / skill:<name> / userProfile

// ============================================================
// 类型定义
// ============================================================

/** 命中类别（区分计数维度） */
export type HitCategory = 'memory' | 'skill' | 'userProfile';

/** 单条命中统计 */
export interface HitEntry {
  /** 计数 key（memory:<nodeId> / skill:<name> / userProfile） */
  key: string;
  /** 所属类别 */
  category: HitCategory;
  /** 累计命中次数 */
  count: number;
  /** 最近一次命中时间戳（ms） */
  lastHitAt: number;
}

/** 低触发评估结果 */
export interface LowHitEntry extends HitEntry {
  /** 评估窗口内（since 之后）的命中次数 */
  hitsInWindow: number;
}

// ============================================================
// HitStat
// ============================================================

/**
 * 轻量触发率统计器
 *
 * 能力：
 *   - record：记录一次命中（按 key 累加计数 + 刷新最近时间）
 *   - getCount / report：查询与全量报表
 *   - evaluateLowHits：评估窗口内命中次数低于阈值的条目（供淘汰建议）
 *   - reset：清空全部计数
 *
 * fail-open：record 内部 catch 所有异常，不抛给调用方。
 */
export class HitStat {
  /** 计数表（key → 累计次数） */
  private readonly counts = new Map<string, number>();
  /** 类别表（key → 类别） */
  private readonly categories = new Map<string, HitCategory>();
  /** 最近命中时间表（key → 时间戳） */
  private readonly lastHitAt = new Map<string, number>();

  /**
   * 记录一次命中
   *
   * @param key 计数 key（memory:<nodeId> / skill:<name> / userProfile）
   * @param category 命中类别
   * @param at 命中时间戳（默认当前时间；测试可注入固定值）
   */
  record(key: string, category: HitCategory, at: number = Date.now()): void {
    try {
      if (!key) return;
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      this.categories.set(key, category);
      this.lastHitAt.set(key, at);
    } catch (err) {
      // fail-open：计数失败仅记录日志，不影响主流程
      // 注：本方法内 Map 操作不会抛错，此 catch 是防御性兜底
      void err;
    }
  }

  /** 查询单条累计次数（未命中返回 0） */
  getCount(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** 查询最近命中时间戳（未命中返回 0） */
  getLastHitAt(key: string): number {
    return this.lastHitAt.get(key) ?? 0;
  }

  /** 返回全部统计快照（key → HitEntry 数组） */
  report(): HitEntry[] {
    const entries: HitEntry[] = [];
    for (const [key, count] of this.counts) {
      entries.push({
        key,
        category: this.categories.get(key) ?? 'memory',
        count,
        lastHitAt: this.lastHitAt.get(key) ?? 0,
      });
    }
    // 按类别 + 次数降序，便于消费方直接展示
    return entries.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return b.count - a.count;
    });
  }

  /**
   * 低触发评估（周期统计）
   *
   * 返回评估窗口（since 之后）内命中次数严格低于 minHits 的条目，
   * 供调用方决定：记忆标记 deprecated、Skill 建议移除或重写。
   *
   * @param since 窗口起点时间戳（ms），之前的历史命中不计入
   * @param minHits 窗口内最低命中次数（严格小于视为低触发）
   * @returns 低触发条目列表（含窗口内命中数），无低触发时返回空数组
   */
  evaluateLowHits(since: number, minHits: number): LowHitEntry[] {
    const result: LowHitEntry[] = [];
    if (minHits <= 0) return result;
    for (const entry of this.report()) {
      // 窗口内命中数：最近命中早于窗口起点 → 0；否则记录的是「累计」，
      // 这里用保守估算：以最近命中是否落在窗口内作为窗口内计数依据
      // （计数粒度为累计次数，不保留每次命中时间，避免无界内存）
      const hitsInWindow = entry.lastHitAt >= since ? entry.count : 0;
      if (hitsInWindow < minHits) {
        result.push({ ...entry, hitsInWindow });
      }
    }
    return result;
  }

  /** 清空全部计数（进程生命周期内有效，不落盘） */
  reset(): void {
    this.counts.clear();
    this.categories.clear();
    this.lastHitAt.clear();
  }
}

// src/agent/interruption-broker.ts
// Phase 97 Part C：全局中断队列 Broker
//
// 设计目的：
//   所有需要人工介入的中断（权限/提问/计划审批/冲突/凭据）统一入队，
//   提供 submit / resolve / reject / list / reclaim / abortSession API。
//   - reclaim：渲染层重载后重新取回该 session 的未处理中断
//   - abortSession：会话中止时批量拒绝未处理中断，杜绝 Promise 永久悬挂
//   - 超时策略：expiresAt 到期未处理的中断在查询时自动按拒绝处理

import type { Interruption, InterruptionKind, InterruptionResolution } from './interruption.js';
import { createInterruptionId } from './interruption.js';

/** Broker 配置 */
export interface InterruptionBrokerConfig {
  /** 默认超时（毫秒），0 表示不超时 */
  defaultTimeoutMs?: number;
}

/** 中断详情（随种类变化） */
export interface InterruptionDetail {
  toolName?: string;
  args?: unknown;
  reason?: string;
  question?: string;
  options?: string[];
  plan?: unknown;
  conflict?: unknown;
  provider?: string;
}

/** 队列条目：中断 + 解析回调 */
interface BrokerEntry {
  interruption: Interruption;
  /** 解析回调：approved 为 true 表示用户批准，false 表示拒绝 */
  resolve: (resolution: InterruptionResolution) => void;
  /** 超时定时器（可选） */
  timer?: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class InterruptionBroker {
  private entries = new Map<string, BrokerEntry>();
  private config: InterruptionBrokerConfig;

  constructor(config?: InterruptionBrokerConfig) {
    this.config = { defaultTimeoutMs: DEFAULT_TIMEOUT_MS, ...config };
  }

  /**
   * 提交一个中断并返回其 id
   * @param kind 中断种类
   * @param sessionId 所属会话
   * @param detail 中断详情（随种类变化）
   * @param resolve 用户处理完成时的解析回调（approved: true 批准 / false 拒绝）
   */
  submit(
    kind: InterruptionKind,
    sessionId: string,
    detail: InterruptionDetail,
    resolve: (resolution: InterruptionResolution) => void,
  ): string {
    const id = createInterruptionId(sessionId);
    const createdAt = Date.now();
    const expiresAt = this.config.defaultTimeoutMs ? createdAt + this.config.defaultTimeoutMs : undefined;

    const base = { id, kind, sessionId, createdAt, expiresAt, status: 'pending' as const };
    const interruption: Interruption = this.buildInterruption(base, detail);

    const entry: BrokerEntry = { interruption, resolve };
    if (expiresAt) {
      entry.timer = setTimeout(() => {
        // 超时按拒绝处理：更新状态并调用解析回调
        const current = this.entries.get(id);
        if (!current) return;
        current.interruption = { ...current.interruption, status: 'timed_out' };
        try { current.resolve({ approved: false }); } catch { /* 忽略解析异常 */ }
        this.entries.delete(id);
      }, expiresAt);
      entry.timer.unref?.();
    }

    this.entries.set(id, entry);
    return id;
  }

  /** 按 id 解析中断（approved true 批准 / false 拒绝） */
  resolve(id: string, resolution: InterruptionResolution): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.interruption = { ...entry.interruption, status: 'resolved' };
    try { entry.resolve(resolution); } catch { /* 忽略解析异常 */ }
    this.entries.delete(id);
    return true;
  }

  /** 按 id 拒绝中断（用户显式拒绝） */
  reject(id: string, reason?: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.interruption = { ...entry.interruption, status: 'rejected' };
    try { entry.resolve({ approved: false, payload: reason }); } catch { /* 忽略解析异常 */ }
    this.entries.delete(id);
    return true;
  }

  /** 列出中断（可按会话过滤，含超时自动标记） */
  list(sessionId?: string): Interruption[] {
    this.sweepExpired();
    const all = [...this.entries.values()].map(e => e.interruption);
    return sessionId ? all.filter(i => i.sessionId === sessionId) : all;
  }

  /** 渲染层重载后重新取回未处理中断（仅 pending） */
  reclaim(sessionId?: string): Interruption[] {
    return this.list(sessionId).filter(i => i.status === 'pending');
  }

  /** 会话中止：批量拒绝该会话所有未处理中断 */
  abortSession(sessionId: string): number {
    let count = 0;
    for (const [id, entry] of [...this.entries]) {
      if (entry.interruption.sessionId !== sessionId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.interruption = { ...entry.interruption, status: 'rejected' };
      try { entry.resolve({ approved: false }); } catch { /* 忽略解析异常 */ }
      this.entries.delete(id);
      count++;
    }
    return count;
  }

  /** 全量中止：批量拒绝所有未处理中断（停止全部并发请求场景） */
  abortAll(): number {
    let count = 0;
    for (const [id, entry] of [...this.entries]) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.interruption = { ...entry.interruption, status: 'rejected' };
      try { entry.resolve({ approved: false }); } catch { /* 忽略解析异常 */ }
      this.entries.delete(id);
      count++;
    }
    return count;
  }

  /** 当前队列大小 */
  get size(): number {
    this.sweepExpired();
    return this.entries.size;
  }

  // ===== 内部 =====

  private buildInterruption(
    base: { id: string; kind: InterruptionKind; sessionId: string; createdAt: number; expiresAt?: number; status: 'pending' },
    detail: InterruptionDetail,
  ): Interruption {
    switch (base.kind) {
      case 'permission_request':
        return { ...base, kind: 'permission_request', toolName: detail.toolName ?? 'unknown', args: detail.args, reason: detail.reason ?? '' };
      case 'ask_user':
        return { ...base, kind: 'ask_user', question: detail.question ?? '', options: detail.options };
      case 'plan_approval':
        return { ...base, kind: 'plan_approval', plan: detail.plan };
      case 'conflict_resolution':
        return { ...base, kind: 'conflict_resolution', conflict: detail.conflict };
      case 'credential_required':
        return { ...base, kind: 'credential_required', provider: detail.provider ?? 'unknown' };
    }
  }

  /** 清理超时未处理的中断 */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, entry] of [...this.entries]) {
      if (entry.interruption.expiresAt && now >= entry.interruption.expiresAt) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.interruption = { ...entry.interruption, status: 'timed_out' };
        try { entry.resolve({ approved: false }); } catch { /* 忽略解析异常 */ }
        this.entries.delete(id);
      }
    }
  }
}

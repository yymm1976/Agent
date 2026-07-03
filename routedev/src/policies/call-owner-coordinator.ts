// src/policies/call-owner-coordinator.ts
// Phase 66 Task 2：Call Owner 协调器
//
// 设计目标：
//   1. 管理需要 owner 审批的动作
//   2. always_pass → 直接 approved
//   3. always_call / conditional → 创建 pending，等待 syncWaitMs
//   4. 同步期内响应 → approved/denied
//   5. 超时 → timeout_pending，触发 onRecovery
//   6. 超时后异步响应 → 再次触发 onRecovery
//   7. fail-open：异常或关闭时直接 approved
//
// 持久化：内存模拟（写 Map，不落盘）

import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export type CallOwnerStrategy = 'always_pass' | 'conditional' | 'always_call';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'timeout_pending';

export interface PendingApproval {
  approvalId: string;
  action: any;
  strategy: CallOwnerStrategy;
  state: ApprovalState;
  /** 同步等待截止时间戳（ms） */
  syncTimeoutAt: number;
  contextRef?: string;
  createdAt: number;
}

/** 内部条目：PendingApproval + 异步控制句柄 */
interface PendingEntry extends PendingApproval {
  resolve?: (state: ApprovalState) => void;
  timer?: NodeJS.Timeout;
}

// ============================================================
// CallOwnerCoordinator
// ============================================================

export class CallOwnerCoordinator {
  private config: { enabled: boolean; syncWaitMs: number; persistPath: string };
  private pending: Map<string, PendingEntry> = new Map();
  private recoveryCallbacks: Array<(approval: PendingApproval) => void> = [];

  constructor(config: {
    enabled: boolean;
    syncWaitMs: number;
    persistPath: string;
  }) {
    this.config = config;
  }

  /**
   * 请求审批
   * - always_pass / 配置关闭 → 立即返回 approved
   * - otherwise → 创建 pending，等待 syncWaitMs
   *   - 同步期内响应 → approved/denied
   *   - 超时 → timeout_pending，触发 onRecovery
   */
  async requestApproval(
    action: any,
    strategy: CallOwnerStrategy,
    contextRef?: string,
  ): Promise<{ approvalId: string; state: ApprovalState }> {
    // fail-open：关闭时直接 approved
    if (!this.config.enabled) {
      return { approvalId: crypto.randomUUID(), state: 'approved' };
    }

    // always_pass 直接返回 approved
    if (strategy === 'always_pass') {
      return { approvalId: crypto.randomUUID(), state: 'approved' };
    }

    const approvalId = crypto.randomUUID();
    const now = Date.now();
    const syncTimeoutAt = now + this.config.syncWaitMs;

    const entry: PendingEntry = {
      approvalId,
      action,
      strategy,
      state: 'pending',
      syncTimeoutAt,
      ...(contextRef !== undefined ? { contextRef } : {}),
      createdAt: now,
    };

    this.pending.set(approvalId, entry);
    this.persist();

    // 等待响应或超时
    const finalState = await new Promise<ApprovalState>((resolve) => {
      entry.resolve = resolve;
      entry.timer = setTimeout(() => {
        // 仅当仍处于 pending 时才转 timeout_pending
        if (entry.state === 'pending') {
          entry.state = 'timeout_pending';
          this.persist();
          // 超时触发 onRecovery
          this.fireRecovery(entry);
          resolve('timeout_pending');
        }
      }, this.config.syncWaitMs);
    });

    // 清理 timer
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    return { approvalId, state: finalState };
  }

  /**
   * 响应审批
   * @returns 是否找到对应 approval（找不到返回 false）
   */
  respondApproval(approvalId: string, approved: boolean): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;

    // 超时后的异步响应：触发 onRecovery
    if (entry.state === 'timeout_pending') {
      entry.state = approved ? 'approved' : 'denied';
      this.persist();
      this.fireRecovery(entry);
      return true;
    }

    // 已响应过：幂等返回 true
    if (entry.state !== 'pending') {
      return true;
    }

    entry.state = approved ? 'approved' : 'denied';
    this.persist();
    if (entry.resolve) {
      entry.resolve(entry.state);
    }
    return true;
  }

  /** 加载 pending approvals（内存模拟，从 Map 读取） */
  loadPendingApprovals(): PendingApproval[] {
    return Array.from(this.pending.values()).map((e) => this.toPendingApproval(e));
  }

  /** 持久化到 jsonl（内存模拟：数据已在 Map 中，无需实际写盘） */
  persist(): void {
    // 内存模拟：实际场景下会写入 persistPath 指定的 jsonl 文件
    // 此处保持 Map 为唯一数据源，保证 loadPendingApprovals 一致性
  }

  /** 注册恢复回调（超时或超时后响应时触发） */
  onRecovery(callback: (approval: PendingApproval) => void): void {
    this.recoveryCallbacks.push(callback);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 触发所有恢复回调（fail-open：单个回调异常不影响其他） */
  private fireRecovery(entry: PendingEntry): void {
    const approval = this.toPendingApproval(entry);
    for (const cb of this.recoveryCallbacks) {
      try {
        cb(approval);
      } catch (err) {
        logger.warn('CallOwnerCoordinator: recovery callback threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** PendingEntry → PendingApproval（剥离内部句柄） */
  private toPendingApproval(entry: PendingEntry): PendingApproval {
    return {
      approvalId: entry.approvalId,
      action: entry.action,
      strategy: entry.strategy,
      state: entry.state,
      syncTimeoutAt: entry.syncTimeoutAt,
      ...(entry.contextRef !== undefined ? { contextRef: entry.contextRef } : {}),
      createdAt: entry.createdAt,
    };
  }
}

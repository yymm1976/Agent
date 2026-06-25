// src/observability/trajectory-exporter.ts
// Phase 35 Task 4：执行轨迹导出
//
// 从 AuditLogger + TraceCollector + TokenTracker 三个独立系统中
// 提取并组装一条完整的执行轨迹（TrajectoryBundle）。
//
// 数据来源：
//   - AuditLogger：JSONL 格式的操作记录（按 sessionId 过滤）
//   - TraceCollector：trace.jsonl 格式的 span 记录（readSessionRecords）
//   - TokenTracker：内存中的 token 统计（仅当前会话）
//
// 注意（陷阱 #48）：
//   AuditLogger 和 TraceCollector 都有内存缓冲和异步写入。
//   导出"刚刚结束的会话"时，最近的记录可能还没 flush。
//   本导出器从磁盘读取 JSONL，如需实时数据需要先等 flush 完成。

import type { AuditLogger } from '../harness/audit-logger.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import type { TokenTracker } from '../router/tracker.js';
import type { AuditRecord } from '../harness/trace-types.js';
import type { TraceRecord, TraceSession } from '../harness/trace-types.js';
import type { TokenStats } from '../router/tracker.js';
import { logger } from '../utils/logger.js';

/**
 * 单条执行轨迹的完整快照
 */
export interface TrajectoryBundle {
  /** 会话 ID */
  sessionId: string;
  /** 导出时间戳（ISO） */
  exportedAt: string;
  /** 审计记录（按时间正序） */
  auditRecords: AuditRecord[];
  /** Trace 记录（按时间正序） */
  traceRecords: TraceRecord[];
  /** Token 使用汇总（仅当前会话有值，历史会话为 null） */
  tokenSummary: TokenStats | null;
  /** 会话元信息（如果可获取） */
  sessionInfo?: TraceSession;
  /** Goal 摘要（从审计记录中提取，如果有） */
  goalSummary?: {
    goal: string;
    status: 'started' | 'completed' | 'failed' | 'unknown';
    durationMs: number;
    stepCount: number;
  };
}

/**
 * 执行轨迹导出器
 *
 * 用法：
 *   const exporter = new TrajectoryExporter(audit, trace, tracker);
 *   const bundle = await exporter.exportSession(sessionId);
 *   const json = JSON.stringify(bundle, null, 2);
 */
export class TrajectoryExporter {
  constructor(
    private readonly audit: AuditLogger,
    private readonly trace: TraceCollector,
    private readonly tracker: TokenTracker | null = null,
  ) {}

  /**
   * 导出单个会话的完整轨迹
   *
   * @param sessionId 会话 ID（不传则使用当前会话）
   * @returns 完整的轨迹快照
   */
  async exportSession(sessionId?: string): Promise<TrajectoryBundle> {
    const sid = sessionId ?? this.trace.getSessionId() ?? 'unknown';
    logger.info('TrajectoryExporter: exporting session', { sessionId: sid });

    // 1. 读取审计记录（从今天的 JSONL 文件中按 sessionId 过滤）
    const allAudit = await this.audit.listToday(500);
    const auditRecords = allAudit.filter(r => r.sessionId === sid);

    // 2. 读取 trace 记录
    // 修复：导出前先 flush TraceCollector 内存缓冲，确保最新 span 已写入磁盘
    if (this.trace && typeof (this.trace as any).flush === 'function') {
      await (this.trace as any).flush();
    }
    const traceRecords = await this.trace.readSessionRecords(sid);

    // 3. 获取 token 统计（仅当前会话可用）
    const tokenSummary = this.tracker ? this.tracker.getStats() : null;

    // 4. 尝试获取会话元信息
    let sessionInfo: TraceSession | undefined;
    try {
      const sessions = await this.trace.listSessions(50);
      sessionInfo = sessions.find(s => s.id === sid);
    } catch {
      // 忽略
    }

    // 5. 从审计记录中提取 goal 摘要
    const goalSummary = this.extractGoalSummary(auditRecords);

    return {
      sessionId: sid,
      exportedAt: new Date().toISOString(),
      auditRecords,
      traceRecords,
      tokenSummary,
      sessionInfo,
      goalSummary,
    };
  }

  /**
   * 导出为 JSON 字符串
   */
  async exportAsJson(sessionId?: string): Promise<string> {
    const bundle = await this.exportSession(sessionId);
    return JSON.stringify(bundle, null, 2);
  }

  /**
   * 从审计记录中提取 goal 摘要
   */
  private extractGoalSummary(records: AuditRecord[]): TrajectoryBundle['goalSummary'] {
    const goalStart = records.find(r => r.action === 'goal_start');
    const goalComplete = records.find(r => r.action === 'goal_complete');
    const goalFail = records.find(r => r.action === 'goal_fail');

    if (!goalStart) return undefined;

    let status: NonNullable<TrajectoryBundle['goalSummary']>['status'] = 'unknown';
    if (goalComplete) status = 'completed';
    else if (goalFail) status = 'failed';
    else status = 'started';

    const startTime = new Date(goalStart.timestamp).getTime();
    const endTime = goalComplete
      ? new Date(goalComplete.timestamp).getTime()
      : goalFail
        ? new Date(goalFail.timestamp).getTime()
        : Date.now();

    return {
      goal: String(goalStart.details.description ?? goalStart.target ?? ''),
      status,
      durationMs: endTime - startTime,
      stepCount: Number(goalStart.details.stepCount ?? 0),
    };
  }
}

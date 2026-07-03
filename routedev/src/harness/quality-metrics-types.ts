// src/harness/quality-metrics-types.ts
// Phase 67 Task 6：质量指标元数据类型 + 独立指标记录器
//
// 核心思想（知识库原文）：
//   "审计日志应携带推理质量元数据（rewardVariance / miProxy / epistemicStats），
//    便于事后分析推理质量与执行结果的相关性。
//    所有元数据字段都应纳入哈希计算，防止篡改。"
//
// 设计要点：
//   - 仅定义类型，不修改 audit-logger.ts（保持向后兼容）
//   - QualityMetricsRecorder 是独立的指标记录器（与 AuditLogger 解耦）
//   - hash 包含 qualityMetrics 字段（防篡改）
//   - 失败时降级为不带元数据的普通记录（fail-open）

import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 质量指标元数据（附加到审计记录） */
export interface QualityMetricsMetadata {
  /** 奖励方差（来自 SNRAwareFilter） */
  rewardVariance?: number;
  /** MI 代理快照（来自 MICrossScorer） */
  miProxy?: {
    avgRetrievalAcc: number;
    miZScoreEma: number;
    collapseWarning: boolean;
  };
  /** 认知完整性统计（来自 EpistemicIntegrityChecker） */
  epistemicStats?: {
    originalFrequency: number;
    reviewedFrequency: number;
    frequencyDropRatio: number;
  };
}

/** 带质量指标的审计记录 */
export interface MetricsAuditRecord {
  /** 记录类型 */
  type: string;
  /** 动作 */
  action: string;
  /** 时间戳（ms） */
  timestamp: number;
  /** 质量指标元数据（可选） */
  qualityMetrics?: QualityMetricsMetadata;
  /** SHA-256 哈希（包含 qualityMetrics 字段，防篡改） */
  hash?: string;
}

/** 配置 */
export interface QualityMetricsRecorderConfig {
  /** 是否启用 */
  enabled: boolean;
}

// ============================================================
// 默认配置
// ============================================================

export const DEFAULT_QUALITY_METRICS_RECORDER_CONFIG: QualityMetricsRecorderConfig = {
  enabled: false,
};

// ============================================================
// QualityMetricsRecorder
// ============================================================

/**
 * 质量指标记录器（独立于 AuditLogger）
 *
 * 设计要点：
 *   - 不修改 audit-logger.ts，保持向后兼容
 *   - 每条记录附加 timestamp + hash（SHA-256）
 *   - hash 包含 qualityMetrics 字段（防篡改）
 *   - 提供便捷方法：logWorkerDispatchWithRV / logMIProxySnapshot / logEpistemicIntegrity
 *   - 失败时降级为不带元数据的普通记录（fail-open）
 *
 * 使用方式：
 *   const recorder = new QualityMetricsRecorder({ enabled: true });
 *   recorder.logWorkerDispatchWithRV('task-1', 0.42, true);
 *   recorder.logMIProxySnapshot({ avgRetrievalAcc: 0.85, miZScoreEma: 2.1, collapseWarning: false });
 *   const records = recorder.getRecords();
 */
export class QualityMetricsRecorder {
  private config: QualityMetricsRecorderConfig;
  private records: MetricsAuditRecord[] = [];

  constructor(config: QualityMetricsRecorderConfig = DEFAULT_QUALITY_METRICS_RECORDER_CONFIG) {
    this.config = { ...config };
  }

  /**
   * 记录带质量指标的审计事件
   *
   * 算法：
   *   1. 附加 timestamp
   *   2. 计算 hash = SHA-256(type + action + timestamp + JSON.stringify(qualityMetrics))
   *   3. 存入 records 数组
   *
   * fail-open：配置关闭或异常时返回不带元数据的最小记录
   */
  logWithMetrics(record: {
    type: string;
    action: string;
    qualityMetrics?: QualityMetricsMetadata;
  }): MetricsAuditRecord {
    // 配置关闭时返回最小记录（不带 qualityMetrics 和 hash）
    if (!this.config.enabled) {
      return {
        type: record.type,
        action: record.action,
        timestamp: Date.now(),
      };
    }

    try {
      const timestamp = Date.now();
      const qualityMetrics = record.qualityMetrics;

      // 计算 hash（包含 qualityMetrics 字段，防篡改）
      const hash = this.computeHash(record.type, record.action, timestamp, qualityMetrics);

      const auditRecord: MetricsAuditRecord = {
        type: record.type,
        action: record.action,
        timestamp,
        ...(qualityMetrics !== undefined ? { qualityMetrics } : {}),
        hash,
      };

      this.records.push(auditRecord);
      return auditRecord;
    } catch (err) {
      // fail-open：异常时返回最小记录
      logger.warn('QualityMetricsRecorder: logWithMetrics 异常，返回最小记录', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        type: record.type,
        action: record.action,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 记录 worker dispatch 事件（带 rewardVariance）
   *
   * @param taskId 任务 ID
   * @param rewardVariance 估算的奖励方差
   * @param retained 是否被保留（true=参与执行，false=被过滤）
   */
  logWorkerDispatchWithRV(
    taskId: string,
    rewardVariance: number,
    retained: boolean,
  ): MetricsAuditRecord {
    return this.logWithMetrics({
      type: 'worker_dispatch',
      action: `task=${taskId};retained=${retained}`,
      qualityMetrics: { rewardVariance },
    });
  }

  /**
   * 记录 MI 代理快照
   *
   * @param snapshot MI 代理快照（avgRetrievalAcc / miZScoreEma / collapseWarning）
   */
  logMIProxySnapshot(snapshot: {
    avgRetrievalAcc: number;
    miZScoreEma: number;
    collapseWarning: boolean;
  }): MetricsAuditRecord {
    return this.logWithMetrics({
      type: 'mi_proxy_snapshot',
      action: `collapseWarning=${snapshot.collapseWarning}`,
      qualityMetrics: {
        miProxy: {
          avgRetrievalAcc: snapshot.avgRetrievalAcc,
          miZScoreEma: snapshot.miZScoreEma,
          collapseWarning: snapshot.collapseWarning,
        },
      },
    });
  }

  /**
   * 记录认知完整性统计
   *
   * @param stats 认知完整性统计（originalFrequency / reviewedFrequency / frequencyDropRatio）
   */
  logEpistemicIntegrity(stats: {
    originalFrequency: number;
    reviewedFrequency: number;
    frequencyDropRatio: number;
  }): MetricsAuditRecord {
    return this.logWithMetrics({
      type: 'epistemic_integrity',
      action: `frequencyDropRatio=${stats.frequencyDropRatio.toFixed(4)}`,
      qualityMetrics: {
        epistemicStats: {
          originalFrequency: stats.originalFrequency,
          reviewedFrequency: stats.reviewedFrequency,
          frequencyDropRatio: stats.frequencyDropRatio,
        },
      },
    });
  }

  /**
   * 获取所有记录（用于持久化或验证）
   */
  getRecords(): MetricsAuditRecord[] {
    return [...this.records];
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /**
   * 计算 SHA-256 哈希（包含 qualityMetrics 字段）
   *
   * hash = SHA-256(type + action + timestamp + JSON.stringify(qualityMetrics))
   *
   * 防篡改：任何字段（包括 qualityMetrics）被修改后，hash 都会不匹配
   */
  private computeHash(
    type: string,
    action: string,
    timestamp: number,
    qualityMetrics: QualityMetricsMetadata | undefined,
  ): string {
    const data = `${type}${action}${timestamp}${JSON.stringify(qualityMetrics ?? {})}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}

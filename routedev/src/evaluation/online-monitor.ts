// src/evaluation/online-monitor.ts
// Phase 49 Task 5.3：在线监控信号
//
// 知识库原文：
//   "在线监控 7 类信号：延迟/成本/质量/错误率/安全/用户反馈/漂移。"
//
// 与 ScoreCard 的关系：
//   - ScoreCard 记录单次执行的质量指标
//   - OnlineMonitor 聚合 ScoreCard 数据，按时间窗口统计
//   - 超过阈值时触发告警（Alert）
//
// 7 类信号阈值：
//   1. 延迟：P95 > 300ms 告警
//   2. 成本：Token 日环比 > 30% 告警
//   3. 质量：错误路由率 > 5% 告警
//   4. 错误率：失败率 > 1% 告警
//   5. 安全：注入尝试次数 > 0 告警（任何异常即告警）
//   6. 用户反馈：差评率 > 10% 告警
//   7. 漂移：意图分布 KL 散度日环比 > 20% 告警
//
// 陷阱 #155：配置 ROI 评估——
//   在线监控若只统计"使用频率"而不评估"维护成本"，会鼓励用户堆砌配置。
//   ROI 评估必须同时统计"配置使用率"和"配置维护成本"，
//   对长期未使用的配置主动提示"该 Skill 30 天未使用，是否归档？"

import { logger } from '../utils/logger.js';
import type { ScoreCard } from '../agent/multi/score-card.js';

// ============================================================
// 类型定义
// ============================================================

/** 监控信号类型（7 类 + 1 类配置 ROI） */
export type AlertType =
  | 'latency'
  | 'cost'
  | 'quality'
  | 'error-rate'
  | 'security'
  | 'feedback'
  | 'drift'
  | 'config-roi';

/** 告警严重度 */
export type AlertSeverity = 'low' | 'medium' | 'high';

/** 告警 */
export interface Alert {
  /** 信号类型 */
  type: AlertType;
  /** 严重度 */
  severity: AlertSeverity;
  /** 告警消息 */
  message: string;
  /** 阈值（用于触发告警的边界值） */
  threshold: number;
  /** 实际值（触发告警时的观测值） */
  actual: number;
}

/** runAll 方法的入参（一次性运行全部监控） */
export interface MonitorParams {
  /** 用于延迟/成本/反馈监控的 ScoreCard 列表 */
  scoreCards?: ScoreCard[];
  /** 昨日总 Token 数（成本环比用） */
  yesterdayTotalTokens?: number;
  /** 错误路由数（质量监控用） */
  routingErrors?: number;
  /** 总请求数（质量监控用） */
  totalRequests?: number;
  /** 失败数（错误率监控用） */
  failures?: number;
  /** 总执行数（错误率监控用） */
  total?: number;
  /** 注入尝试次数（安全监控用） */
  injectionAttempts?: number;
  /** 今日意图分布（漂移监控用，键=意图，值=出现次数） */
  todayDistribution?: Record<string, number>;
  /** 昨日意图分布（漂移监控用） */
  yesterdayDistribution?: Record<string, number>;
  /** 配置 ROI 评估所需：每个配置的最近使用天数（键=配置名，值=距今天数） */
  configLastUsedDays?: Record<string, number>;
  /** 配置归档阈值（天数，默认 30 天未使用则提示归档） */
  configArchiveThresholdDays?: number;
}

// ============================================================
// OnlineMonitor
// ============================================================

/**
 * 在线监控——7 类信号 + 配置 ROI 提示（陷阱 #155）
 *
 * 设计要点：
 *   - 每个监控方法返回 Alert[]（无告警时返回空数组）
 *   - runAll 一次性运行全部监控，合并告警
 *   - 不直接调用日志输出——由调用方决定如何展示告警
 *   - 数值计算用简化实现，避免引入额外依赖
 */
export class OnlineMonitor {
  // ============================================================
  // 阈值常量（蓝图 5.3）
  // ============================================================

  /** 延迟阈值：P95 > 300ms 告警 */
  static readonly LATENCY_P95_THRESHOLD_MS = 300;
  /** 成本阈值：Token 日环比 > 30% 告警 */
  static readonly COST_DAY_OVER_DAY_RATIO = 0.3;
  /** 质量阈值：错误路由率 > 5% 告警 */
  static readonly ROUTING_ERROR_RATE_THRESHOLD = 0.05;
  /** 错误率阈值：失败率 > 1% 告警 */
  static readonly FAILURE_RATE_THRESHOLD = 0.01;
  /** 安全阈值：注入尝试次数 > 0 告警 */
  static readonly INJECTION_ATTEMPT_THRESHOLD = 0;
  /** 反馈阈值：差评率 > 10% 告警 */
  static readonly NEGATIVE_FEEDBACK_RATE_THRESHOLD = 0.1;
  /** 漂移阈值：意图分布 KL 散度日环比 > 20% 告警 */
  static readonly KL_DIVERGENCE_THRESHOLD = 0.2;
  /** 配置归档阈值：默认 30 天未使用则提示归档（陷阱 #155） */
  static readonly CONFIG_ARCHIVE_THRESHOLD_DAYS = 30;

  // ============================================================
  // 7 类信号监控
  // ============================================================

  /**
   * 延迟监控——P95 > 300ms 告警
   *
   * @param scoreCards 含 durationMs 的 ScoreCard 列表
   */
  monitorLatency(scoreCards: ScoreCard[]): Alert[] {
    if (scoreCards.length === 0) return [];

    const p95 = this.calculateP95(scoreCards.map(c => c.durationMs));
    if (p95 > OnlineMonitor.LATENCY_P95_THRESHOLD_MS) {
      const severity: AlertSeverity = p95 > 1000 ? 'high' : p95 > 600 ? 'medium' : 'low';
      return [{
        type: 'latency',
        severity,
        message: `P95 延迟 ${p95}ms 超过阈值 ${OnlineMonitor.LATENCY_P95_THRESHOLD_MS}ms`,
        threshold: OnlineMonitor.LATENCY_P95_THRESHOLD_MS,
        actual: p95,
      }];
    }
    return [];
  }

  /**
   * 成本监控——Token 日环比 > 30% 告警
   *
   * @param scoreCards 今天的 ScoreCard 列表
   * @param yesterdayTotalTokens 昨日总 Token 数
   */
  monitorCost(scoreCards: ScoreCard[], yesterdayTotalTokens: number): Alert[] {
    if (yesterdayTotalTokens <= 0) return [];

    const todayTotal = scoreCards.reduce((sum, c) => sum + c.tokenUsage.total, 0);
    const ratio = (todayTotal - yesterdayTotalTokens) / yesterdayTotalTokens;

    if (ratio > OnlineMonitor.COST_DAY_OVER_DAY_RATIO) {
      const severity: AlertSeverity = ratio > 1 ? 'high' : ratio > 0.6 ? 'medium' : 'low';
      return [{
        type: 'cost',
        severity,
        message: `Token 消耗日环比增长 ${(ratio * 100).toFixed(1)}% 超过 30%`,
        threshold: OnlineMonitor.COST_DAY_OVER_DAY_RATIO,
        actual: ratio,
      }];
    }
    return [];
  }

  /**
   * 质量监控——错误路由率 > 5% 告警
   *
   * @param routingErrors 错误路由数
   * @param totalRequests 总请求数
   */
  monitorQuality(routingErrors: number, totalRequests: number): Alert[] {
    if (totalRequests <= 0) return [];

    const errorRate = routingErrors / totalRequests;
    if (errorRate > OnlineMonitor.ROUTING_ERROR_RATE_THRESHOLD) {
      const severity: AlertSeverity = errorRate > 0.2 ? 'high' : errorRate > 0.1 ? 'medium' : 'low';
      return [{
        type: 'quality',
        severity,
        message: `错误路由率 ${(errorRate * 100).toFixed(1)}% 超过 5%`,
        threshold: OnlineMonitor.ROUTING_ERROR_RATE_THRESHOLD,
        actual: errorRate,
      }];
    }
    return [];
  }

  /**
   * 错误率监控——失败率 > 1% 告警
   *
   * @param failures 失败数
   * @param total 总执行数
   */
  monitorErrorRate(failures: number, total: number): Alert[] {
    if (total <= 0) return [];

    const failureRate = failures / total;
    if (failureRate > OnlineMonitor.FAILURE_RATE_THRESHOLD) {
      const severity: AlertSeverity = failureRate > 0.1 ? 'high' : failureRate > 0.05 ? 'medium' : 'low';
      return [{
        type: 'error-rate',
        severity,
        message: `失败率 ${(failureRate * 100).toFixed(2)}% 超过 1%`,
        threshold: OnlineMonitor.FAILURE_RATE_THRESHOLD,
        actual: failureRate,
      }];
    }
    return [];
  }

  /**
   * 安全监控——注入尝试次数 > 0 告警（任何异常即告警）
   *
   * @param injectionAttempts 注入尝试次数
   */
  monitorSecurity(injectionAttempts: number): Alert[] {
    if (injectionAttempts > OnlineMonitor.INJECTION_ATTEMPT_THRESHOLD) {
      const severity: AlertSeverity = injectionAttempts >= 10 ? 'high'
        : injectionAttempts >= 3 ? 'medium' : 'low';
      return [{
        type: 'security',
        severity,
        message: `检测到 ${injectionAttempts} 次注入尝试`,
        threshold: OnlineMonitor.INJECTION_ATTEMPT_THRESHOLD,
        actual: injectionAttempts,
      }];
    }
    return [];
  }

  /**
   * 用户反馈监控——差评率 > 10% 告警
   *
   * 差评 = ScoreCard.userFeedback === 'rejected'
   * 注：'edited' 不计入差评（用户编辑说明方向对但需要调整）
   *
   * @param scoreCards ScoreCard 列表
   */
  monitorUserFeedback(scoreCards: ScoreCard[]): Alert[] {
    if (scoreCards.length === 0) return [];

    const rejectedCount = scoreCards.filter(c => c.userFeedback === 'rejected').length;
    const negativeRate = rejectedCount / scoreCards.length;

    if (negativeRate > OnlineMonitor.NEGATIVE_FEEDBACK_RATE_THRESHOLD) {
      const severity: AlertSeverity = negativeRate > 0.3 ? 'high' : negativeRate > 0.2 ? 'medium' : 'low';
      return [{
        type: 'feedback',
        severity,
        message: `差评率 ${(negativeRate * 100).toFixed(1)}% 超过 10%`,
        threshold: OnlineMonitor.NEGATIVE_FEEDBACK_RATE_THRESHOLD,
        actual: negativeRate,
      }];
    }
    return [];
  }

  /**
   * 漂移监控——意图分布 KL 散度日环比 > 20% 告警
   *
   * KL 散度简化实现：sum(p_i * log(p_i / q_i))
   * 其中 p 为今日分布概率，q 为昨日分布概率
   *
   * @param todayDistribution 今日意图分布（键=意图，值=出现次数）
   * @param yesterdayDistribution 昨日意图分布
   */
  monitorDrift(
    todayDistribution: Record<string, number>,
    yesterdayDistribution: Record<string, number>,
  ): Alert[] {
    const kl = this.calculateKLDivergence(todayDistribution, yesterdayDistribution);

    if (kl > OnlineMonitor.KL_DIVERGENCE_THRESHOLD) {
      const severity: AlertSeverity = kl > 1 ? 'high' : kl > 0.5 ? 'medium' : 'low';
      return [{
        type: 'drift',
        severity,
        message: `意图分布 KL 散度 ${kl.toFixed(4)} 超过 0.2（日环比 > 20%）`,
        threshold: OnlineMonitor.KL_DIVERGENCE_THRESHOLD,
        actual: kl,
      }];
    }
    return [];
  }

  // ============================================================
  // 配置 ROI 评估（陷阱 #155）
  // ============================================================

  /**
   * 配置 ROI 评估——同时统计"配置使用率"和"配置维护成本"
   *
   * 陷阱 #155：
   *   在线监控若只统计"使用频率"而不评估"维护成本"，
   *   会鼓励用户堆砌配置（48 Agent + 182 Skill + 68 命令的维护成本巨大）。
   *   ROI 评估必须对长期未使用的配置主动提示归档。
   *
   * @param configLastUsedDays 每个配置的最近使用天数（键=配置名，值=距今天数）
   * @param archiveThresholdDays 归档阈值天数（默认 30 天）
   * @returns 告警列表（每个长期未使用的配置生成一条 low 严重度提示）
   */
  monitorConfigRoi(
    configLastUsedDays: Record<string, number>,
    archiveThresholdDays: number = OnlineMonitor.CONFIG_ARCHIVE_THRESHOLD_DAYS,
  ): Alert[] {
    const alerts: Alert[] = [];
    for (const [configName, daysSinceLastUse] of Object.entries(configLastUsedDays)) {
      if (daysSinceLastUse > archiveThresholdDays) {
        alerts.push({
          type: 'config-roi',
          severity: 'low',
          message: `配置 ${configName} 已 ${daysSinceLastUse} 天未使用，建议归档以降低维护成本`,
          threshold: archiveThresholdDays,
          actual: daysSinceLastUse,
        });
      }
    }
    return alerts;
  }

  // ============================================================
  // 一次性运行全部监控
  // ============================================================

  /**
   * 一次性运行全部监控（7 类信号 + 配置 ROI）
   *
   * 缺失的入参项会被跳过（返回空 Alert 列表）
   */
  runAll(params: MonitorParams): Alert[] {
    const alerts: Alert[] = [];

    if (params.scoreCards && params.scoreCards.length > 0) {
      alerts.push(...this.monitorLatency(params.scoreCards));
      alerts.push(...this.monitorUserFeedback(params.scoreCards));
      if (params.yesterdayTotalTokens !== undefined) {
        alerts.push(...this.monitorCost(params.scoreCards, params.yesterdayTotalTokens));
      }
    }

    if (params.routingErrors !== undefined && params.totalRequests !== undefined) {
      alerts.push(...this.monitorQuality(params.routingErrors, params.totalRequests));
    }

    if (params.failures !== undefined && params.total !== undefined) {
      alerts.push(...this.monitorErrorRate(params.failures, params.total));
    }

    if (params.injectionAttempts !== undefined) {
      alerts.push(...this.monitorSecurity(params.injectionAttempts));
    }

    if (params.todayDistribution && params.yesterdayDistribution) {
      alerts.push(...this.monitorDrift(params.todayDistribution, params.yesterdayDistribution));
    }

    if (params.configLastUsedDays) {
      alerts.push(...this.monitorConfigRoi(
        params.configLastUsedDays,
        params.configArchiveThresholdDays,
      ));
    }

    if (alerts.length > 0) {
      logger.warn('OnlineMonitor: 检测到告警', {
        count: alerts.length,
        types: alerts.map(a => a.type),
      });
    }

    return alerts;
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /**
   * 计算 P95 百分位数
   *
   * 简化实现：排序后取第 ceil(n * 0.95) - 1 个元素
   */
  private calculateP95(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
    );
    return sorted[idx];
  }

  /**
   * 计算 KL 散度（简化实现）
   *
   * 公式：KL(P || Q) = sum( p_i * log(p_i / q_i) )
   *   - p_i = 今日第 i 个意图的概率
   *   - q_i = 昨日第 i 个意图的概率
   *
   * 边界处理：
   *   - p_i = 0 时跳过（约定 0 * log(0/q) = 0）
   *   - q_i = 0 时用极小值 1e-10 替代（避免除零）
   *   - 输入分布的"次数"会先归一化为"概率"
   *   - 取所有键的并集作为分布支撑集
   */
  private calculateKLDivergence(
    today: Record<string, number>,
    yesterday: Record<string, number>,
  ): number {
    const todayTotal = Object.values(today).reduce((a, b) => a + b, 0);
    const yesterdayTotal = Object.values(yesterday).reduce((a, b) => a + b, 0);

    if (todayTotal === 0 || yesterdayTotal === 0) return 0;

    // 取所有键的并集
    const allKeys = new Set([...Object.keys(today), ...Object.keys(yesterday)]);

    let kl = 0;
    const epsilon = 1e-10; // 防 q_i = 0
    for (const key of allKeys) {
      const p = (today[key] ?? 0) / todayTotal;
      const q = (yesterday[key] ?? 0) / yesterdayTotal;
      if (p > 0) {
        kl += p * Math.log(p / Math.max(q, epsilon));
      }
    }
    return kl;
  }
}

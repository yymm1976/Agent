// src/router/regret-tracker.ts
// ACRouter 闭环模型路由：累积遗憾自评指标
// 论文借鉴：ACRouter 用累积遗憾替代单次准确率评测 router
// Oracle 近似：同 task signature 历史最大 qualityScore

import type { RoutingHistory, RoutingRecord } from './routing-history.js';

export interface RegretCurvePoint {
  timestamp: number;
  cumulativeRegret: number;
}

export interface CumulativeRegretResult {
  regret: number;
  regretCurve: RegretCurvePoint[];
  perModelRegret: Map<string, number>;
}

export class RoutingRegretTracker {
  private readonly history: RoutingHistory;

  constructor(history: RoutingHistory) {
    this.history = history;
  }

  computeCumulativeRegret(): CumulativeRegretResult {
    const records = this.history.getRecords();
    if (records.length === 0) {
      return { regret: 0, regretCurve: [], perModelRegret: new Map() };
    }

    const oracleCache = this.buildOracleCache(records);
    let cumulativeRegret = 0;
    const regretCurve: RegretCurvePoint[] = [];
    const perModelRegret = new Map<string, number>();

    for (const record of records) {
      if (record.qualityScore == null) continue;
      const oracle = oracleCache.get(record.taskSignature);
      if (oracle == null) continue;
      const regret = oracle - record.qualityScore;
      if (regret < 0) continue;
      cumulativeRegret += regret;
      regretCurve.push({ timestamp: record.timestamp, cumulativeRegret });
      const existing = perModelRegret.get(record.modelId) ?? 0;
      perModelRegret.set(record.modelId, existing + regret);
    }

    return { regret: cumulativeRegret, regretCurve, perModelRegret };
  }

  computeMovingAverageRegret(windowSize = 50): number {
    const records = this.history.getRecords();
    if (records.length === 0) return 0;

    const oracleCache = this.buildOracleCache(records);
    const window = records.slice(-windowSize);
    let totalRegret = 0;
    let counted = 0;

    for (const record of window) {
      if (record.qualityScore == null) continue;
      const oracle = oracleCache.get(record.taskSignature);
      if (oracle == null) continue;
      const regret = oracle - record.qualityScore;
      if (regret < 0) continue;
      totalRegret += regret;
      counted++;
    }

    return counted > 0 ? totalRegret / counted : 0;
  }

  getRegretByTier(): Map<string, number> {
    const records = this.history.getRecords();
    if (records.length === 0) return new Map();

    const oracleCache = this.buildOracleCache(records);
    const tierRegret = new Map<string, { total: number; count: number }>();

    for (const record of records) {
      if (record.qualityScore == null) continue;
      const oracle = oracleCache.get(record.taskSignature);
      if (oracle == null) continue;
      const regret = Math.max(0, oracle - record.qualityScore);
      const tier = this.inferTier(record);
      let bucket = tierRegret.get(tier);
      if (!bucket) {
        bucket = { total: 0, count: 0 };
        tierRegret.set(tier, bucket);
      }
      bucket.total += regret;
      bucket.count++;
    }

    const result = new Map<string, number>();
    for (const [tier, { total, count }] of tierRegret) {
      result.set(tier, count > 0 ? total / count : 0);
    }
    return result;
  }

  getNeighborHitRate(): number {
    const records = this.history.getRecords();
    if (records.length === 0) return 0;
    const withEmbedding = records.filter(r => r.taskEmbedding && r.taskEmbedding.length > 0);
    return withEmbedding.length / records.length;
  }

  private buildOracleCache(records: ReadonlyArray<RoutingRecord>): Map<string, number> {
    const taskBest = new Map<string, number>();
    for (const r of records) {
      if (r.qualityScore == null) continue;
      const existing = taskBest.get(r.taskSignature);
      if (existing == null || r.qualityScore > existing) {
        taskBest.set(r.taskSignature, r.qualityScore);
      }
    }
    return taskBest;
  }

  private inferTier(record: RoutingRecord): string {
    if (record.taskSignature.includes('simple')) return 'simple';
    if (record.taskSignature.includes('medium')) return 'medium';
    if (record.taskSignature.includes('complex')) return 'complex';
    if (record.taskSignature.includes('reasoning')) return 'reasoning';
    return 'unknown';
  }
}

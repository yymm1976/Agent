// src/router/routing-history.ts
// ACRouter 闭环模型路由：路由历史记录与持久化
// 论文借鉴：ACRouter Memory 模块的 FIFO 20K 设计
// 记录每次路由决策的执行反馈，供 Memory kNN 检索和 Orchestrator 加权使用

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

export interface RoutingRecord {
  taskSignature: string;
  taskEmbedding?: number[];
  modelId: string;
  qualityScore?: number;
  tokenCost?: number;
  latencyMs?: number;
  verificationTrace?: {
    compiled: boolean;
    testsPassed: boolean;
    typeCheckPassed: boolean;
  };
  timestamp: number;
  userOverride?: boolean;
}

export interface ModelStats {
  avgQuality: number;
  avgCost: number;
  avgLatency: number;
  sampleCount: number;
}

export interface DimensionStats {
  avgQuality: number;
  avgCost: number;
  avgLatency: number;
  sampleCount: number;
}

export class RoutingHistory {
  private records: RoutingRecord[] = [];
  private readonly maxRecords: number;
  private readonly persistPath: string;

  constructor(options?: { maxRecords?: number; persistPath?: string }) {
    this.maxRecords = options?.maxRecords ?? 20000;
    this.persistPath = options?.persistPath ?? '.routedev/routing-history.jsonl';
  }

  append(record: RoutingRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      const overflow = this.records.length - this.maxRecords;
      this.records.splice(0, overflow);
    }
  }

  getRecords(): ReadonlyArray<RoutingRecord> {
    return this.records;
  }

  getRecordCount(): number {
    return this.records.length;
  }

  getStatsByModel(): Map<string, ModelStats> {
    const buckets = new Map<string, { quality: number[]; cost: number[]; latency: number[] }>();
    for (const r of this.records) {
      let bucket = buckets.get(r.modelId);
      if (!bucket) {
        bucket = { quality: [], cost: [], latency: [] };
        buckets.set(r.modelId, bucket);
      }
      if (r.qualityScore != null) bucket.quality.push(r.qualityScore);
      if (r.tokenCost != null) bucket.cost.push(r.tokenCost);
      if (r.latencyMs != null) bucket.latency.push(r.latencyMs);
    }
    const result = new Map<string, ModelStats>();
    for (const [modelId, b] of buckets) {
      result.set(modelId, {
        avgQuality: b.quality.length > 0 ? avg(b.quality) : 0.5,
        avgCost: b.cost.length > 0 ? avg(b.cost) : 0,
        avgLatency: b.latency.length > 0 ? avg(b.latency) : 0,
        sampleCount: Math.max(b.quality.length, b.cost.length, b.latency.length),
      });
    }
    return result;
  }

  getStatsByModelAndDimension(dimension: string): Map<string, Map<string, DimensionStats>> {
    const tree = new Map<string, Map<string, { quality: number[]; cost: number[]; latency: number[] }>>();
    for (const r of this.records) {
      if (r.taskSignature !== dimension) continue;
      let modelMap = tree.get(r.modelId);
      if (!modelMap) {
        modelMap = new Map();
        tree.set(r.modelId, modelMap);
      }
      let bucket = modelMap.get(dimension);
      if (!bucket) {
        bucket = { quality: [], cost: [], latency: [] };
        modelMap.set(dimension, bucket);
      }
      if (r.qualityScore != null) bucket.quality.push(r.qualityScore);
      if (r.tokenCost != null) bucket.cost.push(r.tokenCost);
      if (r.latencyMs != null) bucket.latency.push(r.latencyMs);
    }
    const result = new Map<string, Map<string, DimensionStats>>();
    for (const [modelId, modelMap] of tree) {
      const dimResult = new Map<string, DimensionStats>();
      for (const [dim, b] of modelMap) {
        dimResult.set(dim, {
          avgQuality: b.quality.length > 0 ? avg(b.quality) : 0.5,
          avgCost: b.cost.length > 0 ? avg(b.cost) : 0,
          avgLatency: b.latency.length > 0 ? avg(b.latency) : 0,
          sampleCount: Math.max(b.quality.length, b.cost.length, b.latency.length),
        });
      }
      result.set(modelId, dimResult);
    }
    return result;
  }

  findByTaskSignature(taskSignature: string): RoutingRecord[] {
    return this.records.filter(r => r.taskSignature === taskSignature);
  }

  findByModel(modelId: string): RoutingRecord[] {
    return this.records.filter(r => r.modelId === modelId);
  }

  async flush(): Promise<void> {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const lines = this.records.map(r => JSON.stringify(r)).join('\n') + '\n';
      writeFileSync(this.persistPath, lines, 'utf-8');
    } catch (err) {
      logger.warn('RoutingHistory flush failed', {
        error: err instanceof Error ? err.message : String(err),
        path: this.persistPath,
      });
    }
  }

  async flushAppend(records: RoutingRecord[]): Promise<void> {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
      appendFileSync(this.persistPath, lines, 'utf-8');
    } catch (err) {
      logger.warn('RoutingHistory flushAppend failed', {
        error: err instanceof Error ? err.message : String(err),
        path: this.persistPath,
      });
    }
  }

  async load(): Promise<void> {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const content = readFileSync(this.persistPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);
      const parsed: RoutingRecord[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          logger.debug('RoutingHistory: skipping malformed line');
        }
      }
      this.records = parsed.slice(-this.maxRecords);
    } catch (err) {
      logger.warn('RoutingHistory load failed', {
        error: err instanceof Error ? err.message : String(err),
        path: this.persistPath,
      });
    }
  }

  clear(): void {
    this.records = [];
  }
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

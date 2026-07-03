// src/agent/rejected-alternative-store.ts
// Phase 68 Task 3: 被拒替代保留——让"失败"成为知识图谱的一等公民

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

export interface RejectedAlternative {
  id: string;
  proposalSummary: string;
  rejectionReason: string;
  gate: {
    gateType: 'cross-model-review' | 'quantitative-gate' | 'user-reject';
    score?: number;
    threshold?: number;
  };
  reviewResult: {
    passed: boolean;
    issues: Array<{ severity: string; description: string; file?: string; line?: number }>;
    summary: string;
  };
  taskDescription: string;
  relatedFiles: string[];
  timestamp: number;
  sessionId: string;
  provenanceArtifactId?: string;
}

export class RejectedAlternativeStore {
  private records: RejectedAlternative[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 5000) {
    this.maxRecords = maxRecords;
  }

  add(record: RejectedAlternative): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  queryByTask(taskDescription: string, limit = 5): RejectedAlternative[] {
    const keywords = this.extractKeywords(taskDescription);
    if (keywords.size === 0) return [];
    return this.records
      .map((r) => ({
        record: r,
        score: this.jaccard(keywords, this.extractKeywords(r.taskDescription)),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.record);
  }

  filterByGate(gateType: RejectedAlternative['gate']['gateType']): RejectedAlternative[] {
    return this.records.filter((r) => r.gate.gateType === gateType);
  }

  getById(id: string): RejectedAlternative | undefined {
    return this.records.find((r) => r.id === id);
  }

  list(limit = 50, offset = 0): RejectedAlternative[] {
    return this.records.slice(offset, offset + limit);
  }

  size(): number {
    return this.records.length;
  }

  serialize(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n');
  }

  deserialize(data: string): void {
    this.records = [];
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.records.push(JSON.parse(line));
      } catch {
        // skip corrupted lines
      }
    }
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const data = await readFile(filePath, 'utf-8');
      this.deserialize(data);
      logger.info('RejectedAlternativeStore: loaded from file', { filePath, count: this.records.length });
    } catch {
      // file doesn't exist yet — that's fine
    }
  }

  async flushToFile(filePath: string): Promise<void> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, this.serialize(), 'utf-8');
      logger.debug('RejectedAlternativeStore: flushed to file', { filePath, count: this.records.length });
    } catch (err) {
      logger.warn('RejectedAlternativeStore: flush failed', { filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private extractKeywords(text: string): Set<string> {
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 1);
    return new Set(tokens);
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }
}

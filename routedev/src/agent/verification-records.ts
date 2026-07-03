import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface VerificationRecord {
  id: string;
  type: 'typecheck' | 'lint' | 'test' | 'claim';
  target: string;
  targetHash: string;
  passed: boolean;
  verifiedAt: number;
  source: string;
}

export interface VerificationRecordsConfig {
  enabled: boolean;
  maxRecords: number;
  ttlMs: number;
}

const DEFAULT_CONFIG: VerificationRecordsConfig = {
  enabled: false,
  maxRecords: 1000,
  ttlMs: 3600000,
};

export class VerificationRecords {
  private records = new Map<string, VerificationRecord>();
  private insertionOrder: string[] = [];

  constructor(private readonly config: VerificationRecordsConfig = DEFAULT_CONFIG) {}

  record(input: Omit<VerificationRecord, 'id' | 'verifiedAt'>): VerificationRecord {
    const key = this.buildKey(input.type, input.target, input.targetHash);

    if (this.records.size >= this.config.maxRecords && !this.records.has(key)) {
      const oldestKey = this.insertionOrder.shift();
      if (oldestKey) this.records.delete(oldestKey);
    }

    const rec: VerificationRecord = {
      ...input,
      id: key,
      verifiedAt: Date.now(),
    };
    const wasNew = !this.records.has(key);
    this.records.set(key, rec);
    if (wasNew) this.insertionOrder.push(key);

    return rec;
  }

  isVerified(type: VerificationRecord['type'], target: string, currentHash: string): boolean {
    const key = this.buildKey(type, target, currentHash);
    const rec = this.records.get(key);
    if (!rec) return false;
    if (Date.now() - rec.verifiedAt > this.config.ttlMs) {
      this.records.delete(key);
      return false;
    }
    return rec.passed && rec.targetHash === currentHash;
  }

  batchIsVerified(files: Array<{ path: string; hash: string }>): Map<string, boolean> {
    const result = new Map<string, boolean>();
    for (const f of files) {
      result.set(f.path, this.isVerified('typecheck', f.path, f.hash));
    }
    return result;
  }

  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    const newOrder: string[] = [];
    for (const key of this.insertionOrder) {
      const rec = this.records.get(key);
      if (!rec) continue;
      if (now - rec.verifiedAt > this.config.ttlMs) {
        this.records.delete(key);
        cleaned++;
      } else {
        newOrder.push(key);
      }
    }
    this.insertionOrder = newOrder;
    return cleaned;
  }

  hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  getRecordCount(): number {
    return this.records.size;
  }

  private buildKey(type: string, target: string, hash: string): string {
    return `${type}:${target}:${hash}`;
  }
}

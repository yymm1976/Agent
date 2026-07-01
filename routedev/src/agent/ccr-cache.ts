import { createHash } from 'node:crypto';
import type { LLMMessage } from '../router/types.js';

export interface CCRRecord {
  hash: string;
  messages: LLMMessage[];
  messageCount: number;
  createdAt: number;
}

export interface CCRMarker {
  hash: string;
  originalCount: number;
  compactedCount: number;
  marker: string;
}

export class CCRCache {
  private records = new Map<string, CCRRecord>();
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  store(messages: LLMMessage[]): CCRRecord {
    const snapshot = messages.map((message) => ({
      ...message,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => ({ ...part })),
    }));
    const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const record: CCRRecord = {
      hash,
      messages: snapshot,
      messageCount: snapshot.length,
      createdAt: Date.now(),
    };
    // LRU 淘汰：超过 maxSize 时删除最早的记录
    if (this.records.size >= this.maxSize) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) this.records.delete(oldestKey);
    }
    this.records.set(hash, record);
    return record;
  }

  retrieve(hash: string): LLMMessage[] | null {
    const record = this.records.get(hash);
    if (!record) {
      return null;
    }
    return record.messages.map((message) => ({
      ...message,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => ({ ...part })),
    }));
  }

  /** 通过 hash 前缀模糊匹配取回（marker 中只有 12 位前缀） */
  retrieveByPrefix(prefix: string): LLMMessage[] | null {
    for (const [key, record] of this.records) {
      if (key.startsWith(prefix)) {
        return record.messages.map((message) => ({
          ...message,
          content: typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => ({ ...part })),
        }));
      }
    }
    return null;
  }

  buildMarker(hash: string, originalCount: number, compactedCount: number): CCRMarker {
    return {
      hash,
      originalCount,
      compactedCount,
      marker: `[CCR:${hash.slice(0, 12)} original=${originalCount} compacted=${compactedCount}]`,
    };
  }
}

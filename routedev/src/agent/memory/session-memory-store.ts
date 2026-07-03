import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../../utils/logger.js';

export interface SessionMemory {
  sessionId: string;
  summary: string;
  keyDecisions: string[];
  involvedFiles: string[];
  errorsAndFixes: Array<{ error: string; fix: string }>;
  createdAt: number;
  updatedAt: number;
}

export class SessionMemoryStore {
  private memories = new Map<string, SessionMemory>();
  private readonly maxMemories: number;

  constructor(maxMemories = 100) {
    this.maxMemories = maxMemories;
  }

  save(memory: SessionMemory): void {
    this.memories.set(memory.sessionId, memory);
    if (this.memories.size > this.maxMemories) {
      const oldest = [...this.memories.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) this.memories.delete(oldest[0]);
    }
  }

  get(sessionId: string): SessionMemory | undefined {
    return this.memories.get(sessionId);
  }

  query(keyword: string, limit = 5): SessionMemory[] {
    const results: Array<{ memory: SessionMemory; score: number }> = [];
    for (const memory of this.memories.values()) {
      const text = `${memory.summary} ${memory.keyDecisions.join(' ')} ${memory.involvedFiles.join(' ')}`;
      const score = this.keywordMatch(keyword, text);
      if (score > 0) results.push({ memory, score });
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.memory);
  }

  getRecent(limit = 5): SessionMemory[] {
    return [...this.memories.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  size(): number {
    return this.memories.size;
  }

  serialize(): string {
    return JSON.stringify([...this.memories.values()], null, 2);
  }

  deserialize(data: string): void {
    try {
      const arr = JSON.parse(data) as SessionMemory[];
      this.memories.clear();
      for (const m of arr) this.memories.set(m.sessionId, m);
    } catch {
      // skip corrupted data
    }
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const data = await readFile(filePath, 'utf-8');
      this.deserialize(data);
      logger.info('SessionMemoryStore: loaded from file', { filePath, count: this.memories.size });
    } catch {
      // file doesn't exist yet — that's fine
    }
  }

  async flushToFile(filePath: string): Promise<void> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, this.serialize(), 'utf-8');
      logger.debug('SessionMemoryStore: flushed to file', { filePath, count: this.memories.size });
    } catch (err) {
      logger.warn('SessionMemoryStore: flush failed', { filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private keywordMatch(keyword: string, text: string): number {
    const kw = keyword.toLowerCase();
    const lower = text.toLowerCase();
    if (lower.includes(kw)) return 1;
    const words = kw.split(/\s+/);
    let matchCount = 0;
    for (const w of words) {
      if (lower.includes(w)) matchCount++;
    }
    return matchCount / words.length;
  }
}

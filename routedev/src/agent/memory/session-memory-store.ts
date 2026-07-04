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

/**
 * 会话记忆存储
 * - 默认纯内存模式（向后兼容）
 * - 传入 persistentPath 后启用自动持久化：构造时加载、save 后 debounce 500ms 异步落盘、close() 最终 flush
 * - 持久化格式为 JSONL（每行一个 SessionMemory），与 audit-logger.ts 的哈希链模式一致
 */
export class SessionMemoryStore {
  private memories = new Map<string, SessionMemory>();
  private readonly maxMemories: number;
  private readonly persistentPath?: string;
  /** debounce 定时器句柄（save 后延迟落盘，避免频繁写盘） */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** debounce 延迟毫秒数 */
  private readonly flushDebounceMs = 500;
  /** 标记构造时的初次加载是否已完成（避免在加载完成前 close 触发空写） */
  private initialLoadDone = false;

  constructor(maxMemories = 100, persistentPath?: string) {
    this.maxMemories = maxMemories;
    this.persistentPath = persistentPath;
    if (persistentPath) {
      // 构造时自动加载已持久化的记忆，fail-open：加载失败不阻塞
      this.loadFromFile(persistentPath)
        .then(() => {
          this.initialLoadDone = true;
        })
        .catch(() => {
          this.initialLoadDone = true;
        });
    } else {
      this.initialLoadDone = true;
    }
  }

  save(memory: SessionMemory): void {
    this.memories.set(memory.sessionId, memory);
    if (this.memories.size > this.maxMemories) {
      const oldest = [...this.memories.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) this.memories.delete(oldest[0]);
    }
    // 启用持久化时，debounce 异步落盘
    if (this.persistentPath) {
      this.scheduleFlush();
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

  /**
   * 从 JSONL 文件加载记忆（每行一个 SessionMemory）
   * fail-open：文件不存在或损坏时静默跳过
   */
  async loadFromFile(filePath: string): Promise<void> {
    try {
      const data = await readFile(filePath, 'utf-8');
      this.deserializeJSONL(data);
      logger.info('SessionMemoryStore: loaded from file', { filePath, count: this.memories.size });
    } catch {
      // file doesn't exist yet — that's fine
    }
  }

  /**
   * 将当前记忆以 JSONL 格式写入文件（每行一个 SessionMemory）
   * fail-open：写入失败仅记录 warn，不抛错
   */
  async flushToFile(filePath: string): Promise<void> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, this.serializeJSONL(), 'utf-8');
      logger.debug('SessionMemoryStore: flushed to file', { filePath, count: this.memories.size });
    } catch (err) {
      logger.warn('SessionMemoryStore: flush failed', { filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 最终 flush：取消 pending 的 debounce 定时器，立即同步落盘
   * 在服务关闭钩子中调用，确保 debounce 中的待写数据不丢失
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.persistentPath) {
      await this.flushToFile(this.persistentPath);
    }
  }

  /** JSONL 序列化：每行一个 SessionMemory */
  private serializeJSONL(): string {
    return [...this.memories.values()].map((m) => JSON.stringify(m)).join('\n') + '\n';
  }

  /** JSONL 反序列化：逐行解析，跳过空行和损坏行 */
  private deserializeJSONL(data: string): void {
    this.memories.clear();
    const lines = data.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as SessionMemory;
        if (m && typeof m.sessionId === 'string') {
          this.memories.set(m.sessionId, m);
        }
      } catch {
        // 跳过损坏行，fail-open
      }
    }
  }

  /** debounce 落盘：save 后延迟 500ms 写盘，期间多次 save 只触发一次写入 */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.persistentPath) {
        this.flushToFile(this.persistentPath).catch(() => {
          // fail-open：异步 flush 失败不阻塞主流程
        });
      }
    }, this.flushDebounceMs);
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

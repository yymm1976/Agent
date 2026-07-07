// src/agent/ccr-cache.ts
// Phase 55 Task 9：CCR 可逆压缩缓存
// Phase 72 Task B3：存储层迁移到 SQLite（node:sqlite）—— 进程退出后不丢失
//
// 设计要点：
//   1. 表 ccr_cache(marker TEXT PK, original_content TEXT, created_at INTEGER, token_count INTEGER)
//   2. LRU 淘汰：按 created_at 升序删除超出 maxSize 的记录
//   3. 并发安全：所有写操作在事务内执行（node:sqlite DatabaseSync 同步 API，单线程无并发竞态）
//   4. fail-open：SQLite 不可用时降级到内存 Map（保持原有行为，不阻断主流程）
//   5. API 与原内存版本完全兼容（store / retrieve / retrieveByPrefix / buildMarker）
//
// 存储路径：~/.routedev/ccr.db

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { LLMMessage } from '../router/types.js';

// DatabaseSync 类型降级：node:sqlite 在 Electron 中可能不可用（实验性模块被排除）
// 定义本地接口描述用到的 DatabaseSync 方法，避免静态 import 导致 ERR_UNKNOWN_BUILTIN_MODULE
interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
}
type DatabaseSyncConstructor = new (path: string) => DatabaseSyncLike;

// 动态 require 避免静态 import 导致 Electron 启动失败（ERR_UNKNOWN_BUILTIN_MODULE）
const requireFromESM = createRequire(import.meta.url);
let DatabaseSyncCtor: DatabaseSyncConstructor | null = null;
try {
  const mod = requireFromESM('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
  DatabaseSyncCtor = mod.DatabaseSync;
} catch {
  // fail-open：node:sqlite 不可用（Electron 未包含实验性模块），降级为内存 Map
}

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

/** 默认数据库路径：~/.routedev/ccr.db */
function defaultDbPath(): string {
  return path.join(os.homedir(), '.routedev', 'ccr.db');
}

/** 把 LLMMessage[] 序列化为字符串（content 可能是 string 或 ContentPart[]） */
function serializeMessages(messages: LLMMessage[]): string {
  return JSON.stringify(messages);
}

/** 反序列化（失败返回 null） */
function deserializeMessages(s: string): LLMMessage[] | null {
  try {
    return JSON.parse(s) as LLMMessage[];
  } catch {
    return null;
  }
}

/** 深拷贝 messages（避免外部修改污染缓存） */
function cloneMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => ({ ...part })),
  }));
}

export class CCRCache {
  private readonly maxSize: number;
  private readonly dbPath: string;
  /** SQLite 连接（fail-open：打开失败时为 null，降级到内存 Map） */
  private db: DatabaseSyncLike | null = null;
  /** 内存降级缓存（仅在 SQLite 不可用时使用） */
  private fallbackMap = new Map<string, CCRRecord>();
  /** 是否已初始化表结构 */
  private initialized = false;

  constructor(maxSize = 50, dbPath?: string) {
    this.maxSize = maxSize;
    this.dbPath = dbPath ?? defaultDbPath();
    this.init();
  }

  /**
   * 初始化 SQLite 表结构（幂等）
   * 失败时降级到内存 Map（fail-open）
   */
  private init(): void {
    if (this.initialized) return;
    if (!DatabaseSyncCtor) {
      // node:sqlite 不可用：直接走内存降级（fail-open）
      this.db = null;
      this.initialized = true;
      return;
    }
    try {
      // 确保目录存在
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      const db = new DatabaseSyncCtor(this.dbPath);
      // 启用 WAL 提升并发读性能（虽然 DatabaseSync 同步，但仍可能有跨进程访问）
      db.exec('PRAGMA journal_mode = WAL');
      // ccr_cache 表：marker 字段实际是完整 hash（与原 API 语义一致）
      db.exec(`
        CREATE TABLE IF NOT EXISTS ccr_cache (
          marker TEXT PRIMARY KEY,
          original_content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          token_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_ccr_created_at ON ccr_cache(created_at);
      `);
      this.db = db;
    } catch (err) {
      // SQLite 不可用，降级到内存 Map（fail-open）
      // 不抛错，避免阻断主流程；后续 store/retrieve 走内存路径
      this.db = null;
      // 静默降级（CCR 失败只影响可逆压缩取回能力，不影响主流程）
      // eslint-disable-next-line no-console
      console.warn(`[CCRCache] SQLite init failed, falling back to in-memory: ${String(err)}`);
    }
    this.initialized = true;
  }

  /**
   * 存储 messages 快照
   * @returns CCRRecord（含 hash 用于后续 retrieve）
   */
  store(messages: LLMMessage[]): CCRRecord {
    const snapshot = cloneMessages(messages);
    const hash = createHash('sha256').update(serializeMessages(snapshot)).digest('hex');
    const now = Date.now();
    const record: CCRRecord = {
      hash,
      messages: snapshot,
      messageCount: snapshot.length,
      createdAt: now,
    };

    if (this.db) {
      // SQLite 路径：事务内 upsert + LRU 淘汰
      try {
        const db = this.db;
        db.exec('BEGIN');
        try {
          // upsert：若 hash 已存在则更新 created_at（刷新 LRU 顺序）
          const upsert = db.prepare(
            `INSERT INTO ccr_cache (marker, original_content, created_at, token_count)
             VALUES (?, ?, ?, 0)
             ON CONFLICT(marker) DO UPDATE SET created_at = excluded.created_at`,
          );
          upsert.run(hash, serializeMessages(snapshot), now);
          // LRU 淘汰：按 created_at 升序删除超出 maxSize 的记录
          // 子查询取需要保留的 marker（最新的 maxSize 条），删除其余
          const evict = db.prepare(
            `DELETE FROM ccr_cache WHERE marker NOT IN (
               SELECT marker FROM ccr_cache ORDER BY created_at DESC LIMIT ?
             )`,
          );
          evict.run(this.maxSize);
          db.exec('COMMIT');
        } catch (txErr) {
          db.exec('ROLLBACK');
          throw txErr;
        }
      } catch (err) {
        // SQLite 写入失败，降级到内存 Map
        // eslint-disable-next-line no-console
        console.warn(`[CCRCache] SQLite store failed, using in-memory: ${String(err)}`);
        this.fallbackStore(record);
      }
    } else {
      // 内存降级路径
      this.fallbackStore(record);
    }
    return record;
  }

  /** 内存降级路径的 store 实现 */
  private fallbackStore(record: CCRRecord): void {
    if (this.fallbackMap.size >= this.maxSize) {
      const oldestKey = this.fallbackMap.keys().next().value;
      if (oldestKey) this.fallbackMap.delete(oldestKey);
    }
    this.fallbackMap.set(record.hash, record);
  }

  /**
   * 通过完整 hash 取回 messages
   * @returns messages 快照（深拷贝），未找到返回 null
   */
  retrieve(hash: string): LLMMessage[] | null {
    if (this.db) {
      try {
        const stmt = this.db.prepare(
          'SELECT original_content FROM ccr_cache WHERE marker = ?',
        );
        const row = stmt.get(hash) as { original_content: string } | undefined;
        if (!row) return null;
        return deserializeMessages(row.original_content);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[CCRCache] SQLite retrieve failed, falling back: ${String(err)}`);
      }
    }
    // 内存降级路径
    const record = this.fallbackMap.get(hash);
    if (!record) return null;
    return cloneMessages(record.messages);
  }

  /** 通过 hash 前缀模糊匹配取回（marker 中只有 12 位前缀） */
  retrieveByPrefix(prefix: string): LLMMessage[] | null {
    if (this.db) {
      try {
        // LIKE 'prefix%' 走主键索引（marker 是 PK）
        const stmt = this.db.prepare(
          'SELECT original_content FROM ccr_cache WHERE marker LIKE ? ORDER BY created_at DESC LIMIT 1',
        );
        const row = stmt.get(`${prefix}%`) as { original_content: string } | undefined;
        if (!row) return null;
        return deserializeMessages(row.original_content);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[CCRCache] SQLite retrieveByPrefix failed, falling back: ${String(err)}`);
      }
    }
    // 内存降级路径
    for (const [key, record] of this.fallbackMap) {
      if (key.startsWith(prefix)) {
        return cloneMessages(record.messages);
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

  /** 关闭数据库连接（用于测试 / 优雅关闭） */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // 忽略关闭错误
      }
      this.db = null;
    }
  }
}

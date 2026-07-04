// src/memory/memory-store.ts
// Phase 65 Task 1：MemoryStore - 记忆存储（内存索引 + SQLite 持久化）
//
// 论文：M4 多版本记忆系统、保原文优先于抽象、向量化记忆
// 实现：
//   - 内存 Map 作为主索引（快速查询）
//   - SQLite 持久化后端（重启不丢失），使用 node:sqlite（与 code-map 一致）
//   - dbPath 为真实路径时启用 SQLite；为 ':memory:' 或空时纯内存模式（向后兼容）
// 约束：fail-open，DB 写失败只 log 不阻塞主流程

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HashEmbedder, type Embedder } from '../skills/embedder.js';
import { logger } from '../utils/logger.js';

/**
 * 记忆条目类型
 * - fact: 事实
 * - decision: 决策
 * - error_fix: 错误修复
 * - topic: 主题
 * - rejected_alternative: 被拒方案
 */
export interface MemoryEntry {
  id?: string;
  /** 原文（论文：保原文优先于抽象） */
  content: string;
  type: 'fact' | 'decision' | 'error_fix' | 'topic' | 'rejected_alternative';
  source: string;
  /** 时间戳（M4 多版本用） */
  validFrom: number;
  /** 被取代的时间戳；未定义表示当前有效 */
  supersededAt?: number;
  metadata?: Record<string, string>;
  topics?: string[];
}

export interface MemoryStoreConfig {
  enabled: boolean;
  dbPath: string;
  backend: 'sqlite' | 'file';
  embeddingProvider: 'bi-encoder' | 'hash' | 'none';
}

/**
 * MemoryStore - 记忆存储（内存索引 + SQLite 持久化）
 *
 * 内部使用 Map 作为主索引（快速查询），SQLite 作为持久化后端：
 * - write: 插入，生成 UUID，返回 id；同步写 DB（fail-open）
 * - read: 按 id 查询（命中内存索引）
 * - searchFullText: LIKE 降级（content.includes）
 * - searchVector: kNN 内积
 * - delete / update / flush / close: 完整生命周期管理
 *
 * dbPath 为真实路径时启用 SQLite 持久化；为 ':memory:' 或空时纯内存模式（向后兼容）
 */
export class MemoryStore {
  private config: MemoryStoreConfig;
  private memories = new Map<string, MemoryEntry>();
  private embeddings = new Map<string, number[]>();
  private embedder: Embedder | null = null;
  private initialized = false;
  /** SQLite 连接（dbPath 为真实路径时启用；null 表示纯内存模式） */
  private db: DatabaseSync | null = null;
  /** 是否启用 SQLite 持久化 */
  private persistent = false;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
    // hash 模式：直接使用 HashEmbedder（无需外部模型）
    if (config.embeddingProvider === 'hash') {
      this.embedder = new HashEmbedder();
    }
    // bi-encoder 模式：需外部加载，默认 null，可通过 setEmbedder 注入
    // none 模式：不使用 embedding
    // SQLite 启用条件：dbPath 为真实路径（非 ':memory:' 且非空）
    this.persistent = !!config.dbPath && config.dbPath !== ':memory:';
  }

  /** 注入外部 embedder（用于 bi-encoder） */
  setEmbedder(embedder: Embedder | null): void {
    this.embedder = embedder;
  }

  /** 当前 embedder（用于 HybridRetriever 判断可用性） */
  getEmbedder(): Embedder | null {
    return this.embedder;
  }

  /** 当前 backend 标记 */
  get backend(): 'sqlite' | 'file' {
    return this.config.backend;
  }

  /** 是否已初始化 */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 初始化存储
   * - 纯内存模式（dbPath 为 ':memory:' 或空）：直接标记已初始化
   * - SQLite 模式（dbPath 为真实路径）：打开 DB 连接、建表、加载已有数据到内存 Map
   */
  async initialize(): Promise<void> {
    if (this.persistent && this.config.dbPath) {
      try {
        // 确保目录存在
        fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
        this.db = new DatabaseSync(this.config.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        // 主表：记忆条目（按任务规格的表结构）
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            type TEXT,
            content TEXT,
            source TEXT,
            timestamp INTEGER,
            metadata TEXT
          );
        `);
        // 扩展表：向量持久化（任务表结构未含，作为扩展以支持 searchVector 跨会话恢复）
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS embeddings (
            id TEXT PRIMARY KEY,
            vector TEXT
          );
        `);
        // 从 DB 加载已有数据到内存 Map（保持内存索引用于快速查询）
        this.loadFromDb();
        logger.info('MemoryStore: SQLite backend initialized', {
          dbPath: this.config.dbPath,
          loaded: this.memories.size,
        });
      } catch (err) {
        // DB 初始化失败：降级为纯内存模式（fail-open）
        logger.warn('MemoryStore: SQLite init failed, fallback to memory mode', {
          dbPath: this.config.dbPath,
          error: err instanceof Error ? err.message : String(err),
        });
        this.db = null;
        this.persistent = false;
      }
    }
    this.initialized = true;
  }

  /**
   * 写入记忆条目
   * - 生成 UUID（如未提供 id）
   * - 如果有 embedder，计算 embedding 并 L2 归一化后存储
   * - embedding 失败不阻塞写入（fail-open）
   * - enabled=false 时返回空字符串（no-op）
   * - SQLite 模式下同步写 DB（fail-open：DB 写失败只 log 不阻塞）
   */
  async write(entry: MemoryEntry): Promise<string> {
    if (!this.config.enabled) {
      // fail-open：未启用时返回空 id，不阻塞主流程
      return '';
    }
    const id = entry.id ?? crypto.randomUUID();
    const stored: MemoryEntry = { ...entry, id };
    this.memories.set(id, stored);

    // 如果有 embedder，计算 embedding 存储
    if (this.embedder) {
      try {
        const emb = await this.embedder.embed(entry.content);
        // L2 归一化（论文：向量检索使用内积，需先归一化）
        const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
        const normalized = emb.map((v) => v / norm);
        this.embeddings.set(id, normalized);
        // 持久化 embedding（fail-open）
        this.persistEmbedding(id, normalized);
      } catch {
        // fail-open：embedding 失败不阻塞写入，原文已存
      }
    }
    // 持久化记忆条目到 DB（fail-open）
    this.persistMemory(stored);
    return id;
  }

  /** 按 id 读取，不存在返回 null */
  async read(memoryId: string): Promise<MemoryEntry | null> {
    return this.memories.get(memoryId) ?? null;
  }

  /**
   * 全文检索（LIKE 降级）
   * - 空查询返回空
   * - content.includes(query) 匹配
   * - 返回前 limit 条
   */
  async searchFullText(query: string, limit: number): Promise<MemoryEntry[]> {
    if (!query || !query.trim()) return [];
    const results: MemoryEntry[] = [];
    for (const entry of this.memories.values()) {
      if (entry.content.includes(query)) {
        results.push(entry);
      }
    }
    return results.slice(0, limit);
  }

  /**
   * 向量检索（kNN 内积）
   * - 查询向量先 L2 归一化
   * - 与所有存储的 embedding 计算内积（已归一化 = cosine）
   * - 返回前 limit 条（按分数降序）
   */
  async searchVector(queryEmbedding: number[], limit: number): Promise<MemoryEntry[]> {
    if (!queryEmbedding || queryEmbedding.length === 0) return [];

    // 归一化查询向量
    const norm = Math.sqrt(queryEmbedding.reduce((s, v) => s + v * v, 0)) || 1;
    const normalizedQuery = queryEmbedding.map((v) => v / norm);

    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const [id, emb] of this.embeddings) {
      const entry = this.memories.get(id);
      if (!entry) continue;
      // 内积（向量已归一化，等价于 cosine）
      const score = emb.reduce((s, v, i) => s + v * (normalizedQuery[i] ?? 0), 0);
      scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /**
   * 删除记忆条目
   * - 从内存 Map 移除
   * - SQLite 模式下同步删 DB（fail-open）
   */
  async delete(memoryId: string): Promise<void> {
    this.memories.delete(memoryId);
    this.embeddings.delete(memoryId);
    if (this.db) {
      try {
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
        this.db.prepare('DELETE FROM embeddings WHERE id = ?').run(memoryId);
      } catch (err) {
        logger.warn('MemoryStore: DB delete failed', {
          id: memoryId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 确保数据落盘
   * - SQLite 模式：执行 WAL checkpoint 把日志写回主库
   * - 纯内存模式：no-op
   */
  async flush(): Promise<void> {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        logger.warn('MemoryStore: flush checkpoint failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 关闭存储
   * - flush 落盘
   * - 关闭 DB 连接
   * - 清理内存
   */
  async close(): Promise<void> {
    await this.flush();
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logger.warn('MemoryStore: DB close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.db = null;
    }
    this.memories.clear();
    this.embeddings.clear();
    this.initialized = false;
  }

  // ===== 内部辅助方法（供其他模块使用：ConservativeMerger / LocalMaintenancePolicy 等） =====

  /** 获取所有记忆条目 */
  getAll(): MemoryEntry[] {
    return Array.from(this.memories.values());
  }

  /** 按条件过滤 */
  filter(predicate: (entry: MemoryEntry) => boolean): MemoryEntry[] {
    return Array.from(this.memories.values()).filter(predicate);
  }

  /** 更新记忆条目（部分字段） */
  async update(memoryId: string, patch: Partial<MemoryEntry>): Promise<void> {
    const existing = this.memories.get(memoryId);
    if (!existing) return;
    const updated: MemoryEntry = { ...existing, ...patch, id: memoryId };
    this.memories.set(memoryId, updated);
    // 持久化更新到 DB（fail-open）
    this.persistMemory(updated);
  }

  /** 获取某条记忆的 embedding（用于 HybridRetriever） */
  getEmbedding(memoryId: string): number[] | null {
    return this.embeddings.get(memoryId) ?? null;
  }

  /** 当前条目数 */
  count(): number {
    return this.memories.size;
  }

  // ===== SQLite 持久化内部方法 =====

  /** 是否处于持久化模式 */
  isPersistent(): boolean {
    return this.persistent;
  }

  /**
   * 从 DB 加载全部数据到内存 Map
   * - memories 表 → this.memories
   * - embeddings 表 → this.embeddings
   * fail-open：单行解析失败跳过，不影响其他行
   */
  private loadFromDb(): void {
    if (!this.db) return;
    try {
      const rows = this.db.prepare(
        'SELECT id, type, content, source, timestamp, metadata FROM memories',
      ).all() as Array<{ id: string; type: string; content: string; source: string; timestamp: number; metadata: string | null }>;
      for (const row of rows) {
        try {
          const meta = row.metadata ? JSON.parse(row.metadata) as {
            supersededAt?: number;
            metadata?: Record<string, string>;
            topics?: string[];
          } : {};
          const entry: MemoryEntry = {
            id: row.id,
            type: row.type as MemoryEntry['type'],
            content: row.content,
            source: row.source,
            validFrom: row.timestamp,
            ...(meta.supersededAt !== undefined ? { supersededAt: meta.supersededAt } : {}),
            ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
            ...(meta.topics !== undefined ? { topics: meta.topics } : {}),
          };
          this.memories.set(row.id, entry);
        } catch {
          // 单行损坏跳过
        }
      }
      // 加载 embeddings
      const embRows = this.db.prepare('SELECT id, vector FROM embeddings').all() as Array<{ id: string; vector: string }>;
      for (const row of embRows) {
        try {
          const vec = JSON.parse(row.vector) as number[];
          if (Array.isArray(vec)) {
            this.embeddings.set(row.id, vec);
          }
        } catch {
          // 单行损坏跳过
        }
      }
    } catch (err) {
      logger.warn('MemoryStore: loadFromDb failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 持久化单条记忆到 DB（fail-open）
   * 字段映射：id/type/content/source 直接存，validFrom → timestamp，
   * 其余（supersededAt/metadata/topics）序列化到 metadata TEXT 列
   */
  private persistMemory(entry: MemoryEntry): void {
    if (!this.db) return;
    try {
      const meta: Record<string, unknown> = {};
      if (entry.supersededAt !== undefined) meta.supersededAt = entry.supersededAt;
      if (entry.metadata !== undefined) meta.metadata = entry.metadata;
      if (entry.topics !== undefined) meta.topics = entry.topics;
      this.db.prepare(`
        INSERT OR REPLACE INTO memories (id, type, content, source, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entry.id ?? '',
        entry.type,
        entry.content,
        entry.source,
        entry.validFrom,
        Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
      );
    } catch (err) {
      logger.warn('MemoryStore: DB persist memory failed', {
        id: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 持久化 embedding 向量到 DB（fail-open） */
  private persistEmbedding(id: string, vector: number[]): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO embeddings (id, vector) VALUES (?, ?)
      `).run(id, JSON.stringify(vector));
    } catch (err) {
      logger.warn('MemoryStore: DB persist embedding failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

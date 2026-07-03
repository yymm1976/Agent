// src/memory/memory-store.ts
// Phase 65 Task 1：MemoryStore - 内存模拟 SQLite 的记忆存储
//
// 论文：M4 多版本记忆系统、保原文优先于抽象、向量化记忆
// 实现：纯内存 Map 模拟 SQLite，接口设计好后续可替换为真实 SQLite
// 约束：fail-open，不阻塞主流程；不依赖 better-sqlite3 / node:sqlite

import crypto from 'node:crypto';
import { HashEmbedder, type Embedder } from '../skills/embedder.js';

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
 * MemoryStore - 内存模拟 SQLite 的记忆存储
 *
 * 内部使用 Map 存储记忆条目和向量，接口与 SQLite 一致：
 * - write: 插入，生成 UUID，返回 id
 * - read: 按 id 查询
 * - searchFullText: LIKE 降级（content.includes）
 * - searchVector: kNN 内积
 *
 * 后续可替换为真实 SQLite：保持接口不变，内部 Map 替换为 better-sqlite3
 */
export class MemoryStore {
  private config: MemoryStoreConfig;
  private memories = new Map<string, MemoryEntry>();
  private embeddings = new Map<string, number[]>();
  private embedder: Embedder | null = null;
  private initialized = false;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
    // hash 模式：直接使用 HashEmbedder（无需外部模型）
    if (config.embeddingProvider === 'hash') {
      this.embedder = new HashEmbedder();
    }
    // bi-encoder 模式：需外部加载，默认 null，可通过 setEmbedder 注入
    // none 模式：不使用 embedding
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
   * 内存模式：直接创建 Map（构造中已创建），标记已初始化
   * 真实 SQLite 模式：此处会打开数据库连接、建表
   */
  async initialize(): Promise<void> {
    // 内存模式：直接标记已初始化
    // 真实 SQLite 模式：此处打开 db、CREATE TABLE IF NOT EXISTS
    this.initialized = true;
  }

  /**
   * 写入记忆条目
   * - 生成 UUID（如未提供 id）
   * - 如果有 embedder，计算 embedding 并 L2 归一化后存储
   * - embedding 失败不阻塞写入（fail-open）
   * - enabled=false 时返回空字符串（no-op）
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
      } catch {
        // fail-open：embedding 失败不阻塞写入，原文已存
      }
    }
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

  /** 关闭存储（清理内存） */
  async close(): Promise<void> {
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
    this.memories.set(memoryId, { ...existing, ...patch, id: memoryId });
  }

  /** 获取某条记忆的 embedding（用于 HybridRetriever） */
  getEmbedding(memoryId: string): number[] | null {
    return this.embeddings.get(memoryId) ?? null;
  }

  /** 当前条目数 */
  count(): number {
    return this.memories.size;
  }
}

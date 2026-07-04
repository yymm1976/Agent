// src/memory/unified-memory.ts
// 统一记忆接口：桥接 src/memory/（MemoryStore + CodebaseMemory）与 src/agent/memory/（KnowledgeGraph）
//
// 设计要点：
//   - store：同时写入 MemoryStore 和 KnowledgeGraph（如果存在），fail-open
//   - retrieve：从 MemoryStore（全文检索）和 KnowledgeGraph（图遍历 recall）合并结果，去重
//   - storeTo / retrieveFrom：委托给指定子系统
//   - fail-open：任一子系统失败不影响另一个，整体不抛错
//   - 类型映射：unified MemoryEntry（timestamp）↔ MemoryStore MemoryEntry（validFrom）↔ GraphNode（createdAt）

import { MemoryStore, type MemoryEntry as StoreMemoryEntry } from './memory-store.js';
import { KnowledgeGraph, type NodeType } from '../agent/memory/graph.js';
import type { CodebaseMemory } from './codebase-memory.js';
import { logger } from '../utils/logger.js';

/** 统一记忆条目（跨子系统通用格式） */
export interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  source: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** 检索选项 */
export interface RetrieveOptions {
  /** 最大返回数（默认 10） */
  limit?: number;
  /** 是否包含 KnowledgeGraph 图遍历结果（默认 true） */
  includeGraph?: boolean;
}

/** 记忆来源子系统标识 */
export type MemorySource = 'memory' | 'knowledge' | 'codebase';

/** 统一记忆存储接口 */
export interface UnifiedMemoryStore {
  /** 存储：同时写入 MemoryStore 和 KnowledgeGraph（如果存在） */
  store(key: string, value: MemoryEntry): Promise<void>;
  /** 检索：从 MemoryStore 和 KnowledgeGraph 合并结果 */
  retrieve(query: string, options?: RetrieveOptions): Promise<MemoryEntry[]>;
  /** 删除：从所有子系统移除 */
  delete(key: string): Promise<void>;

  /** 委托存储到指定子系统 */
  storeTo(source: MemorySource, key: string, value: MemoryEntry): Promise<void>;
  /** 委托从指定子系统检索 */
  retrieveFrom(source: MemorySource, query: string, options?: RetrieveOptions): Promise<MemoryEntry[]>;
}

/**
 * UnifiedMemoryStore 默认实现
 *
 * fail-open 策略：每个子系统的调用独立 try/catch，任一失败只 log 不影响另一个，
 * 整体方法永不因单个子系统故障而 reject。
 */
export class UnifiedMemoryStoreImpl implements UnifiedMemoryStore {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly knowledgeGraph: KnowledgeGraph | null = null,
    private readonly codebaseMemory: CodebaseMemory | null = null,
  ) {}

  /** 存储：同时写入 MemoryStore 和 KnowledgeGraph（如果存在） */
  async store(key: string, value: MemoryEntry): Promise<void> {
    await Promise.all([
      this.storeTo('memory', key, value),
      this.storeTo('knowledge', key, value),
    ]);
  }

  /** 检索：从 MemoryStore（全文检索）和 KnowledgeGraph（图遍历）合并结果，去重后截断到 limit */
  async retrieve(query: string, options?: RetrieveOptions): Promise<MemoryEntry[]> {
    const limit = options?.limit ?? 10;
    const includeGraph = options?.includeGraph ?? true;

    const [memoryResults, graphResults] = await Promise.all([
      this.retrieveFrom('memory', query, options),
      includeGraph ? this.retrieveFrom('knowledge', query, options) : Promise.resolve([]),
    ]);

    // 合并去重（同 id 取先出现的），截断到 limit
    const seen = new Set<string>();
    const merged: MemoryEntry[] = [];
    for (const entry of [...memoryResults, ...graphResults]) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        merged.push(entry);
      }
    }
    return merged.slice(0, limit);
  }

  /** 删除：从 MemoryStore 硬删，从 KnowledgeGraph 标记 deprecated（图不支持硬删） */
  async delete(key: string): Promise<void> {
    await Promise.all([
      this.deleteFromMemory(key),
      this.deleteFromGraph(key),
    ]);
  }

  /** 委托存储到指定子系统 */
  async storeTo(source: MemorySource, key: string, value: MemoryEntry): Promise<void> {
    switch (source) {
      case 'memory':
        await this.storeToMemory(key, value);
        break;
      case 'knowledge':
        await this.storeToGraph(key, value);
        break;
      case 'codebase':
        // CodebaseMemory 是基于文件扫描的只读索引，不支持任意 key-value 写入
        logger.debug('UnifiedMemory: storeTo(codebase) is no-op (read-only index)', { key });
        break;
    }
  }

  /** 委托从指定子系统检索 */
  async retrieveFrom(source: MemorySource, query: string, options?: RetrieveOptions): Promise<MemoryEntry[]> {
    const limit = options?.limit ?? 10;
    switch (source) {
      case 'memory':
        return this.retrieveFromMemory(query, limit);
      case 'knowledge':
        return this.retrieveFromGraph(query, limit);
      case 'codebase':
        return this.retrieveFromCodebase(query, limit);
    }
  }

  // ===== 子系统委托实现（每个独立 try/catch，fail-open） =====

  /** 写入 MemoryStore（timestamp → validFrom） */
  private async storeToMemory(key: string, value: MemoryEntry): Promise<void> {
    try {
      const entry: StoreMemoryEntry = {
        id: key,
        content: value.content,
        type: this.normalizeStoreType(value.type),
        source: value.source,
        validFrom: value.timestamp,
        metadata: this.stringifyMetadata(value.metadata),
      };
      await this.memoryStore.write(entry);
    } catch (err) {
      logger.warn('UnifiedMemory: memoryStore store failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 写入 KnowledgeGraph（addNode） */
  private async storeToGraph(key: string, value: MemoryEntry): Promise<void> {
    if (!this.knowledgeGraph) return;
    try {
      this.knowledgeGraph.addNode({
        id: key,
        type: this.toNodeType(value.type),
        content: value.content,
        validatedCount: 1,
        createdAt: value.timestamp,
        updatedAt: value.timestamp,
        deprecated: false,
        distinctSources: 1,
      });
    } catch (err) {
      logger.warn('UnifiedMemory: knowledgeGraph store failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 从 MemoryStore 全文检索 */
  private async retrieveFromMemory(query: string, limit: number): Promise<MemoryEntry[]> {
    try {
      const entries = await this.memoryStore.searchFullText(query, limit);
      return entries.map((e) => this.storeEntryToUnified(e));
    } catch (err) {
      logger.warn('UnifiedMemory: memoryStore retrieve failed', {
        query: query.slice(0, 50),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** 从 KnowledgeGraph 图遍历召回 */
  private async retrieveFromGraph(query: string, limit: number): Promise<MemoryEntry[]> {
    if (!this.knowledgeGraph) return [];
    try {
      const recalled = this.knowledgeGraph.recall(query, { maxResults: limit });
      return recalled.map((r) => this.nodeToUnified(r.node, { score: r.score, path: r.path }));
    } catch (err) {
      logger.warn('UnifiedMemory: knowledgeGraph retrieve failed', {
        query: query.slice(0, 50),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** 从 CodebaseMemory 语义检索（BM25 + 向量） */
  private async retrieveFromCodebase(query: string, limit: number): Promise<MemoryEntry[]> {
    if (!this.codebaseMemory) return [];
    try {
      const entries = await this.codebaseMemory.query(query, limit);
      return entries.map((e) => ({
        id: e.filePath,
        type: 'codebase',
        content: e.summary,
        source: 'codebase',
        timestamp: e.lastScanned,
        metadata: { filePath: e.filePath },
      }));
    } catch (err) {
      logger.warn('UnifiedMemory: codebaseMemory retrieve failed', {
        query: query.slice(0, 50),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** 从 MemoryStore 硬删 */
  private async deleteFromMemory(key: string): Promise<void> {
    try {
      await this.memoryStore.delete(key);
    } catch (err) {
      logger.warn('UnifiedMemory: memoryStore delete failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 从 KnowledgeGraph 标记 deprecated（图不支持硬删，遗忘语义） */
  private async deleteFromGraph(key: string): Promise<void> {
    if (!this.knowledgeGraph) return;
    try {
      this.knowledgeGraph.forget({ nodeIds: [key] });
    } catch (err) {
      logger.warn('UnifiedMemory: knowledgeGraph delete failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ===== 类型映射辅助 =====

  /** unified type → MemoryStore type 联合（不匹配时降级为 'topic'） */
  private normalizeStoreType(type: string): StoreMemoryEntry['type'] {
    const allowed: StoreMemoryEntry['type'][] = ['fact', 'decision', 'error_fix', 'topic', 'rejected_alternative'];
    return (allowed as string[]).includes(type) ? (type as StoreMemoryEntry['type']) : 'topic';
  }

  /** unified type → KnowledgeGraph NodeType（不匹配时降级为 'fact'） */
  private toNodeType(type: string): NodeType {
    const allowed: NodeType[] = ['fact', 'decision', 'skill', 'event'];
    return (allowed as string[]).includes(type) ? (type as NodeType) : 'fact';
  }

  /** Record<string, unknown> → Record<string, string>（MemoryStore metadata 是 string 值） */
  private stringifyMetadata(meta?: Record<string, unknown>): Record<string, string> | undefined {
    if (!meta) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  }

  /** MemoryStore MemoryEntry → unified MemoryEntry */
  private storeEntryToUnified(e: StoreMemoryEntry): MemoryEntry {
    const meta: Record<string, unknown> = {};
    if (e.metadata) Object.assign(meta, e.metadata);
    if (e.topics) meta.topics = e.topics;
    if (e.supersededAt !== undefined) meta.supersededAt = e.supersededAt;
    return {
      id: e.id ?? '',
      type: e.type,
      content: e.content,
      source: e.source,
      timestamp: e.validFrom,
      ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    };
  }

  /** GraphNode → unified MemoryEntry */
  private nodeToUnified(
    node: { id: string; type: NodeType; content: string; createdAt: number; updatedAt: number; validatedCount: number },
    extra: { score: number; path: string },
  ): MemoryEntry {
    return {
      id: node.id,
      type: node.type,
      content: node.content,
      source: 'knowledge',
      timestamp: node.createdAt,
      metadata: {
        score: extra.score,
        path: extra.path,
        updatedAt: node.updatedAt,
        validatedCount: node.validatedCount,
      },
    };
  }
}

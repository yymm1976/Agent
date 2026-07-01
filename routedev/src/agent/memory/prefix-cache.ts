// src/agent/memory/prefix-cache.ts
// Phase 53 Task 8：前缀感知上下文缓存
//
// 借鉴 LMCache：内容可寻址分块缓存，相同 Token 序列产生相同缓存键。
// 核心思想：
//   1. 将长 Token 序列切分为固定大小的块
//   2. 链式哈希：每块 hash = SHA-256(blockContent + previousBlockHash)
//      —— 改变前缀则后续所有块的哈希都变化，防前缀碰撞
//   3. skipExistingWrite：逐块顺序检查，遇到第一个未缓存块即停止
//      —— 已缓存的公共前缀无需重复计算
//   4. LRU 淘汰：当 L1 容量达到上限时，删除最早插入的 key
//
// 设计约束：
//   - 不依赖任何共享配置（schema.ts / defaults.ts），通过 constructor opts 注入
//   - 不修改任何共享文件，独立可运行

import { createHash } from 'node:crypto';

// ============================================================
// 类型定义
// ============================================================

/** 缓存块：分块 + 链式哈希后的产物 */
export interface CacheBlock {
  /** SHA-256 链式哈希（64 位十六进制） */
  hash: string;
  /** Token 序列（简化为数字数组） */
  tokens: number[];
  /** Token 数 */
  size: number;
}

/** 缓存统计信息 */
export interface CacheStats {
  hits: number;
  misses: number;
  /** 命中率：hits / (hits + misses)，分母为 0 时返回 0 */
  hitRate: number;
  l1Size: number;
  l1MaxSize: number;
}

// ============================================================
// PrefixAwareCache
// ============================================================

/**
 * 前缀感知上下文缓存
 *
 * 工作流程：
 *   1. chunkAndHash(tokens) → 切分并计算每块的链式哈希
 *   2. skipExistingWrite(blocks) → 找出第一个未缓存块的索引
 *   3. put(block) → 将未缓存块逐个写入（触发 LRU 淘汰）
 *   4. get(hash) → 取出已缓存的块
 */
export class PrefixAwareCache {
  /** 块大小（每块包含的 Token 数） */
  private readonly blockSize: number;
  /** L1 缓存：hash → CacheBlock */
  private l1Cache: Map<string, CacheBlock> = new Map();
  /** L1 缓存最大条目数 */
  private l1MaxSize: number;
  /** 命中计数 */
  private hits: number = 0;
  /** 未命中计数 */
  private misses: number = 0;

  constructor(opts?: { blockSize?: number; l1MaxSize?: number }) {
    this.blockSize = opts?.blockSize ?? 256;
    this.l1MaxSize = opts?.l1MaxSize ?? 1000;
    // 防御：块大小必须为正整数
    if (this.blockSize <= 0) {
      throw new Error(`PrefixAwareCache: blockSize 必须为正整数，收到 ${this.blockSize}`);
    }
    if (this.l1MaxSize <= 0) {
      throw new Error(`PrefixAwareCache: l1MaxSize 必须为正整数，收到 ${this.l1MaxSize}`);
    }
  }

  /**
   * 分块并计算哈希
   *
   * 链式哈希规则：
   *   - 第一块的 previousHash = '0'.repeat(64)（64 位 0）
   *   - 后续每块 hash = SHA-256(tokens.join(',') + previousHash)
   *
   * @param tokens Token 序列
   * @returns 切分后的块数组（最后一块可能不足 blockSize）
   */
  chunkAndHash(tokens: number[]): CacheBlock[] {
    const blocks: CacheBlock[] = [];
    let previousHash = '0'.repeat(64);

    for (let i = 0; i < tokens.length; i += this.blockSize) {
      const chunk = tokens.slice(i, i + this.blockSize);
      // 链式哈希：内容 + 上一块哈希
      const hash = createHash('sha256')
        .update(chunk.join(','))
        .update(previousHash)
        .digest('hex');
      blocks.push({
        hash,
        tokens: chunk,
        size: chunk.length,
      });
      previousHash = hash;
    }
    return blocks;
  }

  /**
   * Skip-existing 写入
   *
   * 逐块顺序检查，遇到第一个未缓存的块即停止。
   * 命中的块计入 hits，未命中的块计入 misses（仅一次）。
   *
   * @param blocks 已分块并计算好哈希的块序列
   * @returns 第一个未缓存块的索引（-1 表示全部命中）
   */
  skipExistingWrite(blocks: CacheBlock[]): number {
    for (let i = 0; i < blocks.length; i++) {
      const existed = this.l1Cache.has(blocks[i].hash);
      if (existed) {
        this.hits++;
      } else {
        this.misses++;
        return i;
      }
    }
    // 全部命中
    return -1;
  }

  /**
   * 查询单块是否命中（不计入 hits/misses 统计）
   *
   * @param hash 块哈希
   * @returns 是否命中
   */
  has(hash: string): boolean {
    return this.l1Cache.has(hash);
  }

  /**
   * 获取单块（未命中返回 undefined，计入 miss）
   *
   * @param hash 块哈希
   * @returns 块内容或 undefined
   */
  get(hash: string): CacheBlock | undefined {
    const block = this.l1Cache.get(hash);
    if (block) {
      this.hits++;
    } else {
      this.misses++;
    }
    return block;
  }

  /**
   * 写入单块（触发 LRU 淘汰）
   *
   * 当 l1Cache.size >= l1MaxSize 时，删除最早插入的 key（Map 保持插入顺序）。
   * 若该块已存在（hash 相同），覆盖原值但不重新计算 LRU 顺序。
   *
   * @param block 待写入的块
   */
  put(block: CacheBlock): void {
    // 已存在则不重复写入，也不触发 LRU 淘汰
    if (this.l1Cache.has(block.hash)) {
      return;
    }
    // 触发 LRU 淘汰
    while (this.l1Cache.size >= this.l1MaxSize) {
      // Map 的迭代顺序按插入顺序，删除最早的 key
      const oldestKey = this.l1Cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.l1Cache.delete(oldestKey);
    }
    this.l1Cache.set(block.hash, block);
  }

  /**
   * 获取统计信息
   *
   * @returns 缓存统计
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      l1Size: this.l1Cache.size,
      l1MaxSize: this.l1MaxSize,
    };
  }

  /**
   * 清空缓存（重置统计）
   */
  clear(): void {
    this.l1Cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

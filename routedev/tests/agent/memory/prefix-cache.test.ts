// tests/agent/memory/prefix-cache.test.ts
// Phase 53 Task 8：前缀感知上下文缓存测试
//
// 覆盖场景：
//   1. 相同 Token 序列产生相同缓存键（chunkAndHash 确定性）
//   2. 链式哈希：改变前缀则后续所有块的哈希都变化
//   3. skipExistingWrite 在第一个未缓存块停止
//   4. LRU 淘汰：l1Cache 达到上限时删除最早插入的 key
//   5. （补充）哈希计算与 node:crypto 一致性验证
//   6. （补充）get/has 命中与未命中统计正确

import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import {
  PrefixAwareCache,
  type CacheBlock,
} from '../../../src/agent/memory/prefix-cache.js';

// ============================================================
// 辅助函数
// ============================================================

/** 生成连续 token 序列 [1, 2, 3, ..., n] */
function makeTokens(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** 手动按规则计算链式哈希（用于交叉验证） */
function manualChainHash(tokens: number[], blockSize: number): string[] {
  const hashes: string[] = [];
  let prev = '0'.repeat(64);
  for (let i = 0; i < tokens.length; i += blockSize) {
    const chunk = tokens.slice(i, i + blockSize);
    const h = crypto.createHash('sha256')
      .update(chunk.join(','))
      .update(prev)
      .digest('hex');
    hashes.push(h);
    prev = h;
  }
  return hashes;
}

// ============================================================
// 测试用例
// ============================================================

describe('PrefixAwareCache', () => {
  let cache: PrefixAwareCache;

  beforeEach(() => {
    cache = new PrefixAwareCache({ blockSize: 4, l1MaxSize: 3 });
  });

  describe('chunkAndHash 确定性', () => {
    it('相同 Token 序列产生相同缓存键（hash 完全一致）', () => {
      const tokens = makeTokens(10);
      const blocks1 = cache.chunkAndHash(tokens);
      const blocks2 = cache.chunkAndHash(tokens);

      expect(blocks1.length).toBe(blocks2.length);
      for (let i = 0; i < blocks1.length; i++) {
        expect(blocks1[i].hash).toBe(blocks2[i].hash);
        expect(blocks1[i].tokens).toEqual(blocks2[i].tokens);
        expect(blocks1[i].size).toBe(blocks2[i].size);
      }
    });

    it('哈希计算与 node:crypto 手动计算一致', () => {
      const tokens = makeTokens(9); // blockSize=4 → 3 块
      const blocks = cache.chunkAndHash(tokens);
      const expected = manualChainHash(tokens, 4);

      expect(blocks.map(b => b.hash)).toEqual(expected);
    });

    it('最后一块可能不足 blockSize', () => {
      const tokens = makeTokens(10); // blockSize=4 → [4,4,2]
      const blocks = cache.chunkAndHash(tokens);
      expect(blocks.length).toBe(3);
      expect(blocks[0].size).toBe(4);
      expect(blocks[1].size).toBe(4);
      expect(blocks[2].size).toBe(2);
    });
  });

  describe('链式哈希前缀敏感性', () => {
    it('改变前缀则后续所有块的哈希都变化', () => {
      // 原始序列
      const original = makeTokens(12); // 3 块
      const blocksOrig = cache.chunkAndHash(original);

      // 修改第一个 token（前缀变化）
      const modified = [...original];
      modified[0] = 999;
      const blocksMod = cache.chunkAndHash(modified);

      expect(blocksOrig.length).toBe(blocksMod.length);
      // 第一块内容变化 → 哈希变化
      expect(blocksOrig[0].hash).not.toBe(blocksMod[0].hash);
      // 链式：后续所有块哈希都应变化
      expect(blocksOrig[1].hash).not.toBe(blocksMod[1].hash);
      expect(blocksOrig[2].hash).not.toBe(blocksMod[2].hash);
    });

    it('前缀不变时，后续相同内容产生相同哈希', () => {
      const tokens = makeTokens(12);
      const blocks1 = cache.chunkAndHash(tokens);
      // 末尾修改，不影响前两块
      const modified = [...tokens];
      modified[modified.length - 1] = -1;
      const blocks2 = cache.chunkAndHash(modified);

      // 前两块应保持一致
      expect(blocks1[0].hash).toBe(blocks2[0].hash);
      expect(blocks1[1].hash).toBe(blocks2[1].hash);
      // 最后一块变化
      expect(blocks1[2].hash).not.toBe(blocks2[2].hash);
    });
  });

  describe('skipExistingWrite', () => {
    it('在第一个未缓存块停止，返回其索引', () => {
      const tokens = makeTokens(12);
      const blocks = cache.chunkAndHash(tokens);
      // 仅写入第 0 块
      cache.put(blocks[0]);

      const idx = cache.skipExistingWrite(blocks);
      // 第 0 块命中，第 1 块未命中 → 返回 1
      expect(idx).toBe(1);
      // hits=1, misses=1
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('全部命中时返回 -1', () => {
      const tokens = makeTokens(8);
      const blocks = cache.chunkAndHash(tokens);
      // 全部写入
      for (const b of blocks) cache.put(b);

      const idx = cache.skipExistingWrite(blocks);
      expect(idx).toBe(-1);
      expect(cache.getStats().hits).toBe(blocks.length);
    });

    it('全部未命中时返回 0', () => {
      const tokens = makeTokens(8);
      const blocks = cache.chunkAndHash(tokens);
      const idx = cache.skipExistingWrite(blocks);
      expect(idx).toBe(0);
    });
  });

  describe('LRU 淘汰', () => {
    it('l1Cache 达到上限时删除最早插入的 key', () => {
      const tokens = makeTokens(8);
      const blocks = cache.chunkAndHash(tokens); // 2 块
      // l1MaxSize=3，依次插入不同 hash 的块
      const extra: CacheBlock = {
        hash: 'a'.repeat(64),
        tokens: [1],
        size: 1,
      };
      const extra2: CacheBlock = {
        hash: 'b'.repeat(64),
        tokens: [2],
        size: 1,
      };
      const extra3: CacheBlock = {
        hash: 'c'.repeat(64),
        tokens: [3],
        size: 1,
      };
      const extra4: CacheBlock = {
        hash: 'd'.repeat(64),
        tokens: [4],
        size: 1,
      };

      // 前 3 次插入不会触发淘汰
      cache.put(blocks[0]);   // size=1
      cache.put(blocks[1]);   // size=2
      cache.put(extra);        // size=3（已满）
      expect(cache.has(blocks[0].hash)).toBe(true);

      // 第 4 次 put：size >= l1MaxSize (3>=3) 触发淘汰，删除 blocks[0]
      cache.put(extra2);
      expect(cache.has(blocks[0].hash)).toBe(false);
      expect(cache.has(blocks[1].hash)).toBe(true);
      expect(cache.has(extra.hash)).toBe(true);
      expect(cache.has(extra2.hash)).toBe(true);

      // 第 5 次 put：删除 blocks[1]
      cache.put(extra3);
      expect(cache.has(blocks[1].hash)).toBe(false);
      expect(cache.has(extra3.hash)).toBe(true);

      // 第 6 次 put：删除 extra
      cache.put(extra4);
      expect(cache.has(extra.hash)).toBe(false);
      expect(cache.has(extra4.hash)).toBe(true);

      // l1Size 始终不超过 l1MaxSize
      const stats = cache.getStats();
      expect(stats.l1Size).toBeLessThanOrEqual(stats.l1MaxSize);
    });

    it('重复 put 同一 hash 不触发淘汰且不计入新条目', () => {
      const block: CacheBlock = {
        hash: 'x'.repeat(64),
        tokens: [1],
        size: 1,
      };
      cache.put(block);
      cache.put(block); // 重复写入
      expect(cache.getStats().l1Size).toBe(1);
    });
  });

  describe('get / has 统计', () => {
    it('get 命中计入 hits，未命中计入 misses', () => {
      const block: CacheBlock = {
        hash: 'h'.repeat(64),
        tokens: [1, 2, 3],
        size: 3,
      };
      cache.put(block);

      const hit = cache.get(block.hash);
      const miss = cache.get('z'.repeat(64));

      expect(hit).toEqual(block);
      expect(miss).toBeUndefined();
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      // hitRate = 1/2 = 0.5
      expect(stats.hitRate).toBeCloseTo(0.5, 5);
    });

    it('has 不影响 hits/misses 统计', () => {
      const block: CacheBlock = {
        hash: 'h'.repeat(64),
        tokens: [1],
        size: 1,
      };
      cache.put(block);
      cache.has(block.hash);
      cache.has('y'.repeat(64));
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('clear 重置缓存和统计', () => {
      const block: CacheBlock = {
        hash: 'h'.repeat(64),
        tokens: [1],
        size: 1,
      };
      cache.put(block);
      cache.get(block.hash);
      cache.clear();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.l1Size).toBe(0);
      expect(cache.has(block.hash)).toBe(false);
    });

    it('hitRate 在空缓存时返回 0', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });
});

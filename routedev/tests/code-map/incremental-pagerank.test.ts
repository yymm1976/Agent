// tests/code-map/incremental-pagerank.test.ts
// Phase 71 Task A5：增量 PageRank 测试
// 验证 incrementalPageRank 仅重算受影响节点，非受影响节点保留旧分数

import { describe, it, expect } from 'vitest';
import { incrementalPageRank, type RankedEdge } from '../../src/code-map/ranker.js';

describe('incrementalPageRank', () => {
  // 1. 无变更时分数不变
  it('无变更时（affectedNodeIds 为空）所有分数与旧分数一致', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const edges: RankedEdge[] = [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'b', target: 'c', weight: 1 },
    ];
    const oldScores = new Map([
      ['a', 0.4],
      ['b', 0.3],
      ['c', 0.2],
      ['d', 0.1],
    ]);

    const scores = incrementalPageRank(nodes, edges, new Set(), oldScores);

    for (const id of nodes) {
      expect(scores.get(id)).toBe(oldScores.get(id));
    }
  });

  // 2. 单节点变更重算
  it('单节点变更：受影响节点分数与旧分数不同', () => {
    const nodes = ['a', 'b', 'c'];
    const edges: RankedEdge[] = [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'b', target: 'c', weight: 1 },
    ];
    const oldScores = new Map([
      ['a', 0.33],
      ['b', 0.33],
      ['c', 0.34],
    ]);

    // 只重算 a
    const scores = incrementalPageRank(nodes, edges, new Set(['a']), oldScores);

    // a 的分数应该发生变化（因为有出边到 b，teleportation 贡献不同）
    expect(scores.get('a')).not.toBe(oldScores.get('a'));
    // 非受影响节点 b、c 保留旧分数
    expect(scores.get('b')).toBe(oldScores.get('b'));
    expect(scores.get('c')).toBe(oldScores.get('c'));
  });

  // 3. 多节点变更重算
  it('多节点变更：所有受影响节点分数都重算', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const edges: RankedEdge[] = [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'c', target: 'd', weight: 1 },
    ];
    const oldScores = new Map([
      ['a', 0.25],
      ['b', 0.25],
      ['c', 0.25],
      ['d', 0.25],
    ]);

    const scores = incrementalPageRank(nodes, edges, new Set(['a', 'c']), oldScores);

    // a 和 c 的分数应发生变化
    expect(scores.get('a')).not.toBe(oldScores.get('a'));
    expect(scores.get('c')).not.toBe(oldScores.get('c'));
    // 非受影响节点保留旧分数
    expect(scores.get('b')).toBe(oldScores.get('b'));
    expect(scores.get('d')).toBe(oldScores.get('d'));
  });

  // 4. 邻居节点分数更新
  it('邻居节点分数更新：变更节点的一阶邻居在受影响集合中时分数重算', () => {
    const nodes = ['x', 'y', 'z'];
    const edges: RankedEdge[] = [
      { source: 'x', target: 'y', weight: 1 },
      { source: 'y', target: 'z', weight: 1 },
    ];
    // x 是变更节点，y 是 x 的一阶邻居（入边来自 x）
    // 旧分数：y 的分数较低
    const oldScores = new Map([
      ['x', 0.2],
      ['y', 0.2],
      ['z', 0.6],
    ]);

    // 受影响节点 = {x, y}（x 变更 + y 是一阶邻居）
    const scores = incrementalPageRank(nodes, edges, new Set(['x', 'y']), oldScores);

    // y 的分数应重算（因为 y 在受影响集合中，且其入边来自 x）
    // y 的新分数应与旧分数不同
    expect(scores.get('y')).not.toBe(oldScores.get('y'));
    // z 不在受影响集合中，分数不变
    expect(scores.get('z')).toBe(oldScores.get('z'));
  });

  // 5. 孤立节点不受影响
  it('孤立节点（无边连接）不在受影响集合中时分数不变', () => {
    const nodes = ['a', 'b', 'isolated'];
    const edges: RankedEdge[] = [
      { source: 'a', target: 'b', weight: 1 },
      // isolated 无任何边
    ];
    const oldScores = new Map([
      ['a', 0.4],
      ['b', 0.4],
      ['isolated', 0.2],
    ]);

    // 只重算 a（b 不在受影响集合中，isolated 更不在）
    const scores = incrementalPageRank(nodes, edges, new Set(['a']), oldScores);

    // isolated 分数不变
    expect(scores.get('isolated')).toBe(oldScores.get('isolated'));
    // b 分数不变（不在受影响集合）
    expect(scores.get('b')).toBe(oldScores.get('b'));
    // a 分数重算
    expect(scores.get('a')).not.toBe(oldScores.get('a'));
  });

  // 额外：空节点列表
  it('空节点列表返回空 Map', () => {
    const scores = incrementalPageRank([], [], new Set(['a']), new Map());
    expect(scores.size).toBe(0);
  });

  // 额外：所有节点都受影响时等价于全量重算
  it('所有节点都受影响时所有分数都重算', () => {
    const nodes = ['a', 'b', 'c'];
    const edges: RankedEdge[] = [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'b', target: 'c', weight: 1 },
    ];
    const oldScores = new Map([
      ['a', 0.5],
      ['b', 0.3],
      ['c', 0.2],
    ]);

    const scores = incrementalPageRank(nodes, edges, new Set(['a', 'b', 'c']), oldScores);

    // 所有节点都应重算（分数可能与旧分数不同）
    for (const id of nodes) {
      expect(scores.has(id)).toBe(true);
      expect(scores.get(id)).toBeGreaterThanOrEqual(0);
    }
  });
});

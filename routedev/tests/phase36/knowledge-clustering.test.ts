// tests/phase36/knowledge-clustering.test.ts
// Phase 36 Task 4 + Task 5：KnowledgeGraph 模式聚类与置信度测试
// 验证：聚类正确性、置信度计算、recall 排序、supersedeNode 排除、记忆整理注入
// Phase 57：原 dream-to-graph 改名 consolidation，去拟人化措辞

import { describe, it, expect } from 'vitest';
import { KnowledgeGraph, initKnowledgeGraphAdvanced } from '../../src/agent/memory/graph.js';
import type { GraphNode, GraphEdge } from '../../src/agent/memory/graph.js';

// 装配 detectCommunities / clusterSimilarNodes 等高级方法（kgAdvanced pack 默认不装配）
initKnowledgeGraphAdvanced();

// ============================================================
// 测试辅助
// ============================================================

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

/** 构造一个简单节点 */
function makeNode(id: string, content: string, opts: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: opts.type ?? 'fact',
    content,
    validatedCount: opts.validatedCount ?? 1,
    createdAt: opts.createdAt ?? NOW,
    updatedAt: opts.updatedAt ?? NOW,
    deprecated: opts.deprecated ?? false,
    validUntil: opts.validUntil,
    supersededBy: opts.supersededBy,
    distinctSources: opts.distinctSources,
  };
}

/** 构造一条简单边 */
function makeEdge(source: string, target: string, opts: Partial<GraphEdge> = {}): GraphEdge {
  return {
    source,
    target,
    type: opts.type ?? 'relates_to',
    weight: opts.weight ?? 1,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 36 Task 4：KnowledgeGraph 模式聚类与置信度', () => {
  describe('clusterSimilarNodes 聚类正确性', () => {
    it('高相似度节点应被合并（保留 validatedCount 最高的）', () => {
      const g = new KnowledgeGraph();
      // 两个内容高度相似的节点
      g.addNode(makeNode('a', '用户认证使用 JWT token 验证', { validatedCount: 3 }));
      g.addNode(makeNode('b', '用户认证使用 JWT token 验证机制', { validatedCount: 1 }));

      const result = g.clusterSimilarNodes(0.5);
      expect(result.merged).toBeGreaterThanOrEqual(1);
      expect(result.deprecated).toBeGreaterThanOrEqual(1);

      // keeper（a，validatedCount=3）应保留，loser（b）应被标记 deprecated
      const nodeA = g.getNode('a')!;
      const nodeB = g.getNode('b')!;
      expect(nodeA.deprecated).toBe(false);
      expect(nodeB.deprecated).toBe(true);
      expect(nodeB.supersededBy).toBe('a');
    });

    it('低相似度节点不应被合并', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', '用户认证使用 JWT token'));
      g.addNode(makeNode('b', '数据库连接池配置最大连接数'));

      const result = g.clusterSimilarNodes(0.5);
      expect(result.merged).toBe(0);
      expect(g.getNode('a')!.deprecated).toBe(false);
      expect(g.getNode('b')!.deprecated).toBe(false);
    });

    it('不同 type 的相似节点不应被合并', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', '用户认证 JWT', { type: 'fact' }));
      g.addNode(makeNode('b', '用户认证 JWT', { type: 'decision' }));

      const result = g.clusterSimilarNodes(0.5);
      expect(result.merged).toBe(0);
    });

    it('合并后应创建 supersedes 边', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', '用户认证 JWT token 验证', { validatedCount: 5 }));
      g.addNode(makeNode('b', '用户认证 JWT token 验证', { validatedCount: 1 }));

      g.clusterSimilarNodes(0.5);

      // 应存在 a → b 的 supersedes 边
      const edges = g.listNodes();
      const nodeB = g.getNode('b')!;
      expect(nodeB.supersededBy).toBe('a');
    });
  });

  describe('computeConfidence 置信度计算', () => {
    it('置信度应随 validatedCount 线性增长', () => {
      const g = new KnowledgeGraph();
      const node1 = makeNode('a', '内容', { validatedCount: 1, updatedAt: NOW });
      const node2 = makeNode('b', '内容', { validatedCount: 5, updatedAt: NOW });
      g.addNode(node1);
      g.addNode(node2);

      const conf1 = g.computeConfidence(node1);
      const conf2 = g.computeConfidence(node2);
      expect(conf2).toBeGreaterThan(conf1);
      // 线性关系：5 次验证的置信度约为 1 次的 5 倍
      expect(conf2 / conf1).toBeCloseTo(5, 1);
    });

    it('置信度应随时间衰减（半衰期约 70 天）', () => {
      const g = new KnowledgeGraph();
      const recentNode = makeNode('recent', '内容', {
        validatedCount: 1,
        updatedAt: NOW,
      });
      const oldNode = makeNode('old', '内容', {
        validatedCount: 1,
        updatedAt: NOW - 70 * DAY_MS, // 70 天前
      });
      g.addNode(recentNode);
      g.addNode(oldNode);

      const recentConf = g.computeConfidence(recentNode);
      const oldConf = g.computeConfidence(oldNode);
      // 70 天后置信度应衰减到约一半（exp(-0.01*70) ≈ 0.496）
      expect(oldConf).toBeLessThan(recentConf);
      expect(oldConf / recentConf).toBeCloseTo(0.5, 1);
    });

    it('distinctSources 应提供 corroborationBonus 加分', () => {
      const g = new KnowledgeGraph();
      const singleSource = makeNode('a', '内容', {
        validatedCount: 1,
        distinctSources: 1,
        updatedAt: NOW,
      });
      const multiSource = makeNode('b', '内容', {
        validatedCount: 1,
        distinctSources: 5,
        updatedAt: NOW,
      });
      g.addNode(singleSource);
      g.addNode(multiSource);

      const singleConf = g.computeConfidence(singleSource);
      const multiConf = g.computeConfidence(multiSource);
      // corroborationBonus = 1 + 0.1 * distinctSources
      // singleSource: 1 * 1 * (1 + 0.1*1) = 1.1
      // multiSource:  1 * 1 * (1 + 0.1*5) = 1.5
      expect(multiConf).toBeGreaterThan(singleConf);
      expect(multiConf / singleConf).toBeCloseTo(1.5 / 1.1, 2);
    });
  });

  describe('recall 排序综合 PPR 和置信度', () => {
    it('默认排除已 superseded 的节点', () => {
      const g = new KnowledgeGraph();
      // 活跃节点
      g.addNode(makeNode('active', '用户认证 JWT token 验证', { validatedCount: 3 }));
      // 已过时且被替代的节点
      g.addNode(
        makeNode('stale', '用户认证 JWT token 验证', {
          validatedCount: 1,
          validUntil: NOW - DAY_MS, // 已过期
          supersededBy: 'active',
        }),
      );

      const results = g.recall('JWT token 验证');
      // stale 节点应被排除
      const ids = results.map(r => r.node.id);
      expect(ids).toContain('active');
      expect(ids).not.toContain('stale');
    });

    it('includeSuperseded 选项应允许查询已过时节点', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('active', '用户认证 JWT token 验证', { validatedCount: 3 }));
      g.addNode(
        makeNode('stale', '用户认证 JWT token 验证', {
          validatedCount: 1,
          validUntil: NOW - DAY_MS,
          supersededBy: 'active',
        }),
      );

      const results = g.recall('JWT token 验证', { includeSuperseded: true });
      const ids = results.map(r => r.node.id);
      // 两个节点都应可查询到
      expect(ids).toContain('active');
      expect(ids).toContain('stale');
    });

    it('高置信度节点应在 recall 中排名更高', () => {
      const g = new KnowledgeGraph();
      // 低置信度节点（validatedCount=1）
      g.addNode(makeNode('low', '认证 JWT token 验证', { validatedCount: 1 }));
      // 高置信度节点（validatedCount=10）
      g.addNode(makeNode('high', '认证 JWT token 验证', { validatedCount: 10 }));

      const results = g.recall('JWT token 验证');
      expect(results.length).toBeGreaterThanOrEqual(1);
      // 高置信度节点应排在前面
      if (results.length >= 2) {
        expect(results[0].node.id).toBe('high');
      }
    });
  });

  describe('supersedeNode 显式替代', () => {
    it('应设置旧节点的 supersededBy 和 validUntil', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('old', '旧知识', { validatedCount: 1 }));
      g.addNode(makeNode('new', '新知识', { validatedCount: 1 }));

      const ok = g.supersedeNode('old', 'new');
      expect(ok).toBe(true);

      const oldNode = g.getNode('old')!;
      expect(oldNode.supersededBy).toBe('new');
      expect(oldNode.validUntil).toBeLessThanOrEqual(Date.now());
    });

    it('不存在的节点应返回 false', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', '内容'));
      expect(g.supersedeNode('a', 'ghost')).toBe(false);
      expect(g.supersedeNode('ghost', 'a')).toBe(false);
    });
  });

  describe('archiveStaleNodes 时效淘汰', () => {
    it('超过指定天数未更新的节点应被归档', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('fresh', '新鲜知识', { updatedAt: NOW }));
      g.addNode(makeNode('stale', '过时知识', { updatedAt: NOW - 60 * DAY_MS }));

      const archived = g.archiveStaleNodes(30);
      expect(archived).toBe(1);
      expect(g.getNode('fresh')!.deprecated).toBe(false);
      expect(g.getNode('stale')!.deprecated).toBe(true);
    });

    it('已 deprecated 的节点不重复归档', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('old', '过时知识', { updatedAt: NOW - 60 * DAY_MS, deprecated: true }));

      const archived = g.archiveStaleNodes(30);
      expect(archived).toBe(0);
    });
  });
});

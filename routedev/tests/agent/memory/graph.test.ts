// tests/agent/memory/graph.test.ts
// KnowledgeGraph 单元测试（PPR + 双路径召回 + Label Propagation + 持久化）

import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from '../../../src/agent/memory/graph.js';
import type { GraphNode, GraphEdge } from '../../../src/agent/memory/graph.js';

/** 构造一个简单节点 */
function makeNode(id: string, content: string, opts: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: opts.type ?? 'fact',
    content,
    validatedCount: opts.validatedCount ?? 1,
    createdAt: opts.createdAt ?? 1000,
    updatedAt: opts.updatedAt ?? 1000,
    deprecated: opts.deprecated ?? false,
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

describe('KnowledgeGraph', () => {
  describe('基础 CRUD', () => {
    it('addNode / getNode 应正确存取', () => {
      const g = new KnowledgeGraph();
      const n = makeNode('a', '内容A');
      g.addNode(n);
      expect(g.getNode('a')).toBe(n);
      expect(g.getNode('not-exist')).toBeUndefined();
    });

    it('listNodes 返回所有节点', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      expect(g.listNodes().length).toBe(2);
    });

    it('listNodes 按 type 过滤', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A', { type: 'fact' }));
      g.addNode(makeNode('b', 'B', { type: 'decision' }));
      const facts = g.listNodes({ type: 'fact' });
      expect(facts.length).toBe(1);
      expect(facts[0].id).toBe('a');
    });

    it('listNodes 按 deprecated 过滤', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A', { deprecated: false }));
      g.addNode(makeNode('b', 'B', { deprecated: true }));
      const active = g.listNodes({ deprecated: false });
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('a');
    });

    it('addEdge 维护邻接表，端点不存在时忽略', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      g.addEdge(makeEdge('a', 'b'));
      // 端点不存在的边应被忽略
      g.addEdge(makeEdge('a', 'ghost'));
      g.addEdge(makeEdge('ghost', 'b'));
      // 不应抛错
      expect(g.listNodes().length).toBe(2);
    });
  });

  describe('个性化 PageRank (PPR)', () => {
    it('从 seed 出发，邻居分数 > 远处节点', () => {
      const g = new KnowledgeGraph();
      // 构造环形图：a -> b -> c -> d -> a（无悬挂节点）
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      g.addNode(makeNode('c', 'C'));
      g.addNode(makeNode('d', 'D'));
      g.addEdge(makeEdge('a', 'b'));
      g.addEdge(makeEdge('b', 'c'));
      g.addEdge(makeEdge('c', 'd'));
      g.addEdge(makeEdge('d', 'a'));

      const results = g.personalizedPageRank(['a'], { iterations: 30 });
      const scoreMap = new Map(results.map(r => [r.node.id, r.score]));

      // 规范要求：邻居节点分数 > 远处节点
      // b 是 a 的直接邻居（1 跳），d 是远处节点（3 跳），b 分数应高于 d
      expect(scoreMap.get('b')!).toBeGreaterThan(scoreMap.get('d')!);
      // c 是中间节点（2 跳），分数也应高于 d（3 跳）
      expect(scoreMap.get('c')!).toBeGreaterThan(scoreMap.get('d')!);
    });

    it('不同 seed 返回不同排序', () => {
      const g = new KnowledgeGraph();
      // 构造图：a - b - c - d，且 a - d 直连
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      g.addNode(makeNode('c', 'C'));
      g.addNode(makeNode('d', 'D'));
      g.addEdge(makeEdge('a', 'b'));
      g.addEdge(makeEdge('b', 'c'));
      g.addEdge(makeEdge('c', 'd'));
      g.addEdge(makeEdge('a', 'd'));

      const fromA = g.personalizedPageRank(['a'], { iterations: 30 });
      const fromC = g.personalizedPageRank(['c'], { iterations: 30 });

      // 两次排序结果应不同（不同 seed 产生不同分布）
      const orderA = fromA.map(r => r.node.id).join(',');
      const orderC = fromC.map(r => r.node.id).join(',');
      expect(orderA).not.toBe(orderC);

      // seed 节点应出现在结果中
      const idsFromA = fromA.map(r => r.node.id);
      const idsFromC = fromC.map(r => r.node.id);
      expect(idsFromA).toContain('a');
      expect(idsFromC).toContain('c');

      // 从 c 出发，c 的分数应高于从 a 出发时 c 的分数（c 作为 seed 得分更多）
      const scoreC_fromC = fromC.find(r => r.node.id === 'c')!.score;
      const scoreC_fromA = fromA.find(r => r.node.id === 'c')!.score;
      expect(scoreC_fromC).toBeGreaterThan(scoreC_fromA);
    });

    it('topK 限制生效', () => {
      const g = new KnowledgeGraph();
      for (let i = 0; i < 10; i++) {
        g.addNode(makeNode(`n${i}`, `N${i}`));
        if (i > 0) g.addEdge(makeEdge(`n${i - 1}`, `n${i}`));
      }
      const results = g.personalizedPageRank(['n0'], { topK: 3 });
      expect(results.length).toBe(3);
    });

    it('空 seed 或空图返回空数组', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A'));
      expect(g.personalizedPageRank([])).toEqual([]);
      const empty = new KnowledgeGraph();
      expect(empty.personalizedPageRank(['a'])).toEqual([]);
    });

    it('deprecated 节点不返回', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B', { deprecated: true }));
      g.addEdge(makeEdge('a', 'b'));
      const results = g.personalizedPageRank(['a']);
      const ids = results.map(r => r.node.id);
      expect(ids).not.toContain('b');
    });

    it('悬挂节点分数均分给所有节点（不丢失分数）', () => {
      const g = new KnowledgeGraph();
      // a -> b，b 是悬挂节点（无出边）
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      g.addNode(makeNode('c', 'C'));
      g.addEdge(makeEdge('a', 'b'));
      g.addEdge(makeEdge('a', 'c'));

      const results = g.personalizedPageRank(['a'], { iterations: 50 });
      const totalScore = results.reduce((sum, r) => sum + r.score, 0);
      // 总分应接近 1（允许浮点误差）
      expect(totalScore).toBeGreaterThan(0.99);
      expect(totalScore).toBeLessThan(1.01);
    });
  });

  describe('双路径召回', () => {
    function buildGraphForRecall(): KnowledgeGraph {
      const g = new KnowledgeGraph();
      // 精确路径匹配的节点
      g.addNode(makeNode('a', 'TypeScript 编译器配置', { validatedCount: 5 }));
      g.addNode(makeNode('b', 'tsconfig.json 选项说明', { validatedCount: 3 }));
      g.addNode(makeNode('c', 'TypeScript 严格模式', { validatedCount: 2 }));
      // 与 a/b/c 连接，形成社区
      g.addEdge(makeEdge('a', 'b'));
      g.addEdge(makeEdge('b', 'c'));

      // 另一个社区：Python
      g.addNode(makeNode('d', 'Python 类型注解', { validatedCount: 10 }));
      g.addNode(makeNode('e', 'mypy 检查器', { validatedCount: 8 }));
      g.addEdge(makeEdge('d', 'e'));

      return g;
    }

    it('精确路径 keyword 匹配返回结果', () => {
      const g = buildGraphForRecall();
      const results = g.recall('TypeScript');
      expect(results.length).toBeGreaterThan(0);
      // 至少包含一个含 TypeScript 的节点
      const contents = results.map(r => r.node.content);
      expect(contents.some(c => c.includes('TypeScript'))).toBe(true);
    });

    it('泛化路径社区匹配返回结果', () => {
      const g = buildGraphForRecall();
      // 用一个能匹配到社区代表的关键词
      const results = g.recall('TypeScript');
      // 应有结果返回（path 可能是 precise / generalized / both）
      expect(results.length).toBeGreaterThan(0);
      // path 字段必须是合法值
      for (const r of results) {
        expect(['precise', 'generalized', 'both']).toContain(r.path);
      }
    });

    it('path 字段正确标记（同节点出现两条路径时为 both）', () => {
      const g = buildGraphForRecall();
      // 用 TypeScript 关键词：精确路径会命中 a/b/c，泛化路径代表也来自同社区
      const results = g.recall('TypeScript');
      // 至少有一个结果，path 字段合法
      expect(results.length).toBeGreaterThan(0);
      const paths = results.map(r => r.path);
      for (const p of paths) {
        expect(['precise', 'generalized', 'both']).toContain(p);
      }
      // 当代表节点同时被精确路径命中时，应出现 both
      // （a 是 validatedCount 最高的 TypeScript 节点，会被选为代表；同时 a 也含 TypeScript 关键词）
      expect(paths).toContain('both');
    });

    it('空 query 或无匹配返回空数组', () => {
      const g = buildGraphForRecall();
      expect(g.recall('')).toEqual([]);
      expect(g.recall('不存在的关键词XYZ')).toEqual([]);
    });

    it('maxResults 限制生效', () => {
      const g = buildGraphForRecall();
      const results = g.recall('TypeScript', { maxResults: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('deprecated 节点不参与召回', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'TypeScript 基础', { deprecated: true }));
      g.addNode(makeNode('b', 'TypeScript 进阶'));
      const results = g.recall('TypeScript');
      const ids = results.map(r => r.node.id);
      expect(ids).not.toContain('a');
    });
  });

  describe('Label Propagation 社区检测', () => {
    it('紧密连接的节点归入同一社区', () => {
      const g = new KnowledgeGraph();
      // 社区 1：a-b-c 互连
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      g.addNode(makeNode('c', 'C'));
      g.addEdge(makeEdge('a', 'b'));
      g.addEdge(makeEdge('b', 'c'));
      g.addEdge(makeEdge('c', 'a'));

      // 社区 2：d-e 互连
      g.addNode(makeNode('d', 'D'));
      g.addNode(makeNode('e', 'E'));
      g.addEdge(makeEdge('d', 'e'));
      g.addEdge(makeEdge('e', 'd'));

      const communities = g.detectCommunities();
      expect(communities.size).toBe(2);

      // a/b/c 应在同一社区
      const all = Array.from(communities.entries());
      const findComm = (id: string) => all.find(([, ids]) => ids.includes(id))![0];
      expect(findComm('a')).toBe(findComm('b'));
      expect(findComm('b')).toBe(findComm('c'));
      // d/e 应在同一社区
      expect(findComm('d')).toBe(findComm('e'));
      // 两个社区应不同
      expect(findComm('a')).not.toBe(findComm('d'));
    });

    it('收敛后停止（结果稳定）', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      g.addEdge(makeEdge('a', 'b'));
      g.addEdge(makeEdge('b', 'a'));

      const c1 = g.detectCommunities();
      const c2 = g.detectCommunities();
      // 两次结果应一致（已收敛）
      expect(c1.size).toBe(c2.size);
      const ids1 = Array.from(c1.entries()).sort(([a], [b]) => a.localeCompare(b));
      const ids2 = Array.from(c2.entries()).sort(([a], [b]) => a.localeCompare(b));
      expect(JSON.stringify(ids1)).toBe(JSON.stringify(ids2));
    });

    it('孤立节点各自成社区', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      g.addNode(makeNode('c', 'C'));
      const communities = g.detectCommunities();
      expect(communities.size).toBe(3);
    });

    it('空图返回空 Map', () => {
      const g = new KnowledgeGraph();
      expect(g.detectCommunities().size).toBe(0);
    });

    it('maxIterations 限制生效（不会无限循环）', () => {
      const g = new KnowledgeGraph();
      // 构造一个长链
      for (let i = 0; i < 10; i++) {
        g.addNode(makeNode(`n${i}`, `N${i}`));
        if (i > 0) g.addEdge(makeEdge(`n${i - 1}`, `n${i}`));
      }
      // 只迭代 1 次，不应抛错
      const communities = g.detectCommunities(1);
      expect(communities.size).toBeGreaterThan(0);
    });
  });

  describe('持久化', () => {
    it('toJSON → fromJSON 不丢数据', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A', { validatedCount: 5, type: 'fact' }));
      g.addNode(makeNode('b', 'B', { type: 'decision', deprecated: true }));
      g.addEdge(makeEdge('a', 'b', { type: 'derived_from', weight: 0.5 }));

      const json = g.toJSON();
      const restored = KnowledgeGraph.fromJSON(json);

      // 节点完整
      expect(restored.listNodes().length).toBe(2);
      const a = restored.getNode('a')!;
      expect(a.content).toBe('A');
      expect(a.validatedCount).toBe(5);
      expect(a.type).toBe('fact');
      const b = restored.getNode('b')!;
      expect(b.deprecated).toBe(true);

      // 边的邻接表已重建（通过 PPR 间接验证）
      const results = restored.personalizedPageRank(['a']);
      // a 有出边到 b，但 b 是 deprecated 不会返回；a 应返回
      const ids = results.map(r => r.node.id);
      expect(ids).toContain('a');
    });

    it('fromJSON 处理空图', () => {
      const g = new KnowledgeGraph();
      const json = g.toJSON();
      const restored = KnowledgeGraph.fromJSON(json);
      expect(restored.listNodes().length).toBe(0);
    });

    it('fromJSON 处理只有节点没有边的情况', () => {
      const g = new KnowledgeGraph();
      g.addNode(makeNode('a', 'A'));
      g.addNode(makeNode('b', 'B'));
      const json = g.toJSON();
      const restored = KnowledgeGraph.fromJSON(json);
      expect(restored.listNodes().length).toBe(2);
    });
  });
});

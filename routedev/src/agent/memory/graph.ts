// src/agent/memory/graph.ts
// 轻量知识图谱（借鉴 graph-memory，纯内存实现，无 SQLite/向量数据库依赖）
//
// 提供三种核心能力：
//   1. 个性化 PageRank (PPR)：从 seed 节点出发按图结构传播相关性分数
//   2. 双路径召回：精确路径（关键词 + BFS + PPR）+ 泛化路径（社区代表 + BFS + PPR）
//   3. Label Propagation 社区检测：迭代传播邻居社区标签

export type NodeType = 'fact' | 'decision' | 'skill' | 'event';
export type EdgeType = 'relates_to' | 'derived_from' | 'supersedes' | 'conflicts_with';

export interface GraphNode {
  id: string;
  type: NodeType;
  content: string;
  embedding?: number[];
  /** 被验证次数（用户确认或后续引用次数），用于排序代表节点 */
  validatedCount: number;
  createdAt: number;
  updatedAt: number;
  /** 是否已废弃（deprecated=true 的节点默认在召回时过滤） */
  deprecated: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
}

/** PPR / 召回结果条目 */
export interface ScoredNode {
  node: GraphNode;
  score: number;
}

/** 召回结果（带路径来源标记） */
export interface RecallResult extends ScoredNode {
  path: 'precise' | 'generalized' | 'both';
}

/** PPR 默认参数 */
const DEFAULT_PPR_DAMPING = 0.85;
const DEFAULT_PPR_ITERATIONS = 20;
const DEFAULT_PPR_TOPK = 10;
/** PPR 收敛阈值（分数变化小于此值则提前停止） */
const PPR_CONVERGE_EPSILON = 1e-6;
/** Label Propagation 默认最大迭代次数 */
const DEFAULT_LP_ITERATIONS = 10;
/** 召回默认参数 */
const DEFAULT_RECALL_MAX = 10;
const DEFAULT_PRECISE_WEIGHT = 0.7;
const DEFAULT_GENERALIZED_WEIGHT = 0.3;
/** BFS 扩展深度常量 */
const PRECISE_BFS_DEPTH = 2;
const GENERALIZED_BFS_DEPTH = 1;

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  /** 邻接表：source → Set<target>（仅记录有向出边） */
  private adjacency = new Map<string, Set<string>>();
  /** 反向邻接表：target → Set<source>（PPR 入边计算用） */
  private reverseAdjacency = new Map<string, Set<string>>();

  /** 添加节点（同 id 覆盖） */
  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    // 确保邻接表项存在
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, new Set());
    if (!this.reverseAdjacency.has(node.id)) this.reverseAdjacency.set(node.id, new Set());
  }

  /** 添加边（自动维护邻接表；端点不存在时忽略） */
  addEdge(edge: GraphEdge): void {
    if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) return;
    this.edges.push(edge);
    if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, new Set());
    this.adjacency.get(edge.source)!.add(edge.target);
    if (!this.reverseAdjacency.has(edge.target)) this.reverseAdjacency.set(edge.target, new Set());
    this.reverseAdjacency.get(edge.target)!.add(edge.source);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** 列出节点（可按 type / deprecated 过滤） */
  listNodes(filter?: { type?: NodeType; deprecated?: boolean }): GraphNode[] {
    const all = Array.from(this.nodes.values());
    if (!filter) return all;
    return all.filter(n => {
      if (filter.type !== undefined && n.type !== filter.type) return false;
      if (filter.deprecated !== undefined && n.deprecated !== filter.deprecated) return false;
      return true;
    });
  }

  /**
   * 个性化 PageRank (PPR)
   *
   * 算法：
   *   1. 初始化：seedNodes 分数 = 1.0 / seedCount，其他 = 0.0
   *   2. 迭代 N 次（默认 20）：
   *      new_score[node] = (1-damping) * initial_score[node]
   *                      + damping * sum(incoming / outdegree(source))
   *   3. 悬挂节点（无出边）：分数均分给所有节点
   *   4. 收敛（变化 < 1e-6）或达到迭代上限停止
   *   5. 返回 topK 个按分数降序
   */
  personalizedPageRank(
    seedNodeIds: string[],
    options?: { damping?: number; iterations?: number; topK?: number },
  ): Array<{ node: GraphNode; score: number }> {
    const damping = options?.damping ?? DEFAULT_PPR_DAMPING;
    const iterations = options?.iterations ?? DEFAULT_PPR_ITERATIONS;
    const topK = options?.topK ?? DEFAULT_PPR_TOPK;

    const allIds = Array.from(this.nodes.keys());
    if (allIds.length === 0 || seedNodeIds.length === 0) return [];

    // 过滤有效 seed
    const validSeeds = seedNodeIds.filter(id => this.nodes.has(id));
    if (validSeeds.length === 0) return [];

    const N = allIds.length;
    const seedWeight = 1 / validSeeds.length;

    // 初始分数：seed = 1/seedCount，其他 = 0
    const initial = new Map<string, number>();
    for (const id of allIds) initial.set(id, 0);
    for (const id of validSeeds) initial.set(id, seedWeight);

    let current = new Map<string, number>(initial);

    for (let iter = 0; iter < iterations; iter++) {
      const next = new Map<string, number>();
      for (const id of allIds) next.set(id, 0);

      // 收集悬挂节点（无出边）的分数总和
      let danglingSum = 0;
      for (const id of allIds) {
        const out = this.adjacency.get(id);
        if (!out || out.size === 0) {
          danglingSum += current.get(id) ?? 0;
        }
      }

      // 悬挂节点分数均分给所有节点（乘以 damping）
      const danglingShare = (damping * danglingSum) / N;

      // 重启分量（1-damping）* initial
      for (const id of allIds) {
        const restart = (1 - damping) * (initial.get(id) ?? 0);
        next.set(id, restart + danglingShare);
      }

      // 沿边传播：source 把 damping * score / outdegree 分给 target
      for (const id of allIds) {
        const out = this.adjacency.get(id);
        if (!out || out.size === 0) continue;
        const score = current.get(id) ?? 0;
        if (score === 0) continue;
        const share = (damping * score) / out.size;
        for (const target of out) {
          next.set(target, (next.get(target) ?? 0) + share);
        }
      }

      // 检查收敛
      let maxDelta = 0;
      for (const id of allIds) {
        const diff = Math.abs((next.get(id) ?? 0) - (current.get(id) ?? 0));
        if (diff > maxDelta) maxDelta = diff;
      }
      current = next;
      if (maxDelta < PPR_CONVERGE_EPSILON) break;
    }

    // 排序并取 topK
    const results = allIds
      .map(id => ({ node: this.nodes.get(id)!, score: current.get(id) ?? 0 }))
      .filter(r => r.node && !r.node.deprecated)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return results;
  }

  /**
   * 双路径召回
   *
   * 精确路径：
   *   a. keyword 匹配：content 包含 query 关键词 → seedNodes
   *   b. BFS 扩展 depth 2：从 seed 沿边扩展
   *   c. PPR 排序：以 seed 为起点跑 PPR
   *
   * 泛化路径：
   *   a. detectCommunities() 获取社区
   *   b. 找到与 query 关键词匹配最多的社区
   *   c. 取该社区中 validatedCount 最高的节点作为代表
   *   d. BFS depth 1 + PPR
   *
   * 合并：精确权重 0.7，泛化权重 0.3；同节点取较高分，标记 path='both'
   */
  recall(
    query: string,
    options?: { maxResults?: number; preciseWeight?: number },
  ): Array<{ node: GraphNode; score: number; path: 'precise' | 'generalized' | 'both' }> {
    const maxResults = options?.maxResults ?? DEFAULT_RECALL_MAX;
    const preciseWeight = options?.preciseWeight ?? DEFAULT_PRECISE_WEIGHT;
    const generalizedWeight = 1 - preciseWeight; // 默认 0.3

    const keywords = this.extractKeywords(query);
    if (keywords.length === 0 || this.nodes.size === 0) return [];

    // ===== 精确路径 =====
    const preciseSeeds: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.deprecated) continue;
      if (keywords.some(kw => node.content.includes(kw))) {
        preciseSeeds.push(node.id);
      }
    }
    const preciseResults = this.runPath(preciseSeeds, PRECISE_BFS_DEPTH, maxResults);

    // ===== 泛化路径 =====
    const communities = this.detectCommunities();
    // 找到与 query 关键词匹配最多的社区
    let bestCommunityId: string | null = null;
    let bestMatchCount = 0;
    for (const [commId, nodeIds] of communities) {
      let matchCount = 0;
      for (const id of nodeIds) {
        const node = this.nodes.get(id);
        if (!node || node.deprecated) continue;
        for (const kw of keywords) {
          if (node.content.includes(kw)) matchCount++;
        }
      }
      if (matchCount > bestMatchCount) {
        bestMatchCount = matchCount;
        bestCommunityId = commId;
      }
    }
    let generalizedSeeds: string[] = [];
    if (bestCommunityId !== null) {
      const commNodeIds = communities.get(bestCommunityId) ?? [];
      // 取该社区中 validatedCount 最高的节点作为代表
      const representative = commNodeIds
        .map(id => this.nodes.get(id))
        .filter((n): n is GraphNode => !!n && !n.deprecated)
        .sort((a, b) => b.validatedCount - a.validatedCount)[0];
      if (representative) generalizedSeeds = [representative.id];
    }
    const generalizedResults = this.runPath(generalizedSeeds, GENERALIZED_BFS_DEPTH, maxResults);

    // ===== 合并去重 =====
    const merged = new Map<string, { score: number; path: 'precise' | 'generalized' | 'both' }>();
    for (const r of preciseResults) {
      merged.set(r.node.id, { score: r.score * preciseWeight, path: 'precise' });
    }
    for (const r of generalizedResults) {
      const existing = merged.get(r.node.id);
      const generalizedScore = r.score * generalizedWeight;
      if (existing) {
        // 同节点取较高分，标记 both
        merged.set(r.node.id, {
          score: Math.max(existing.score, generalizedScore),
          path: 'both',
        });
      } else {
        merged.set(r.node.id, { score: generalizedScore, path: 'generalized' });
      }
    }

    return Array.from(merged.entries())
      .map(([id, info]) => ({
        node: this.nodes.get(id)!,
        score: info.score,
        path: info.path,
      }))
      .filter(r => r.node)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Label Propagation 社区检测
   *
   * 算法：
   *   1. 每个节点初始社区 = 自己的 ID
   *   2. 迭代（默认 10 次）：
   *      a. 遍历每个节点
   *      b. 统计邻居（含入边+出边）社区频率
   *      c. 采纳频率最高的社区（平局取字典序最小）
   *   3. 收敛（本轮无变化）则停止
   *   4. 返回 Map<communityId, nodeIds[]>
   */
  detectCommunities(maxIterations?: number): Map<string, string[]> {
    const maxIter = maxIterations ?? DEFAULT_LP_ITERATIONS;
    const allIds = Array.from(this.nodes.keys());
    if (allIds.length === 0) return new Map();

    // 初始化：每个节点社区 = 自己 ID
    const label = new Map<string, string>();
    for (const id of allIds) label.set(id, id);

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      for (const id of allIds) {
        // 统计邻居社区频率（无向图：入边 + 出边邻居）
        const neighbors = this.getNeighbors(id);
        if (neighbors.size === 0) continue;

        const freq = new Map<string, number>();
        for (const nbId of neighbors) {
          const lbl = label.get(nbId);
          if (lbl === undefined) continue;
          freq.set(lbl, (freq.get(lbl) ?? 0) + 1);
        }
        if (freq.size === 0) continue;

        // 找出频率最高的社区（平局取字典序最小）
        let bestLabel: string | null = null;
        let bestCount = -1;
        const sortedLabels = Array.from(freq.keys()).sort();
        for (const lbl of sortedLabels) {
          const count = freq.get(lbl)!;
          if (count > bestCount) {
            bestCount = count;
            bestLabel = lbl;
          }
        }

        if (bestLabel !== null && bestLabel !== label.get(id)) {
          label.set(id, bestLabel);
          changed = true;
        }
      }
      if (!changed) break; // 收敛
    }

    // 汇总：communityId → nodeIds[]
    const result = new Map<string, string[]>();
    for (const id of allIds) {
      const lbl = label.get(id)!;
      if (!result.has(lbl)) result.set(lbl, []);
      result.get(lbl)!.push(id);
    }
    return result;
  }

  /** 序列化为 JSON 字符串 */
  toJSON(): string {
    return JSON.stringify({
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
    });
  }

  /** 从 JSON 字符串反序列化（重建邻接表） */
  static fromJSON(json: string): KnowledgeGraph {
    const graph = new KnowledgeGraph();
    const data = JSON.parse(json) as { nodes: GraphNode[]; edges: GraphEdge[] };
    for (const node of data.nodes ?? []) graph.addNode(node);
    for (const edge of data.edges ?? []) graph.addEdge(edge);
    return graph;
  }

  // ===== 私有辅助方法 =====

  /** 从 query 提取关键词（按空白切分，过滤空串） */
  private extractKeywords(query: string): string[] {
    return query
      .split(/\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /** 获取节点的所有邻居（无向：入边 + 出边） */
  private getNeighbors(id: string): Set<string> {
    const neighbors = new Set<string>();
    const out = this.adjacency.get(id);
    if (out) for (const t of out) neighbors.add(t);
    const inN = this.reverseAdjacency.get(id);
    if (inN) for (const s of inN) neighbors.add(s);
    return neighbors;
  }

  /**
   * 单路径执行：BFS 扩展 seed → PPR 排序
   * @param seeds 起始 seed 节点 ID 列表
   * @param depth BFS 扩展深度
   * @param topK 返回前 K 个
   */
  private runPath(
    seeds: string[],
    depth: number,
    topK: number,
  ): Array<{ node: GraphNode; score: number }> {
    if (seeds.length === 0) return [];
    // BFS 扩展 seed 集合
    const expanded = new Set<string>(seeds);
    let frontier = [...seeds];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const neighbors = this.getNeighbors(id);
        for (const nb of neighbors) {
          if (!expanded.has(nb)) {
            expanded.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    // PPR 排序（以原始 seed 为起点）
    return this.personalizedPageRank(seeds, { topK });
  }
}

// src/agent/memory/graph.ts
// 轻量知识图谱（借鉴 graph-memory，纯内存实现，无 SQLite/向量数据库依赖）
//
// 提供三种核心能力：
//   1. 个性化 PageRank (PPR)：从 seed 节点出发按图结构传播相关性分数
//   2. 双路径召回：精确路径（关键词 + BFS + PPR）+ 泛化路径（社区代表 + BFS + PPR）
//   3. Label Propagation 社区检测：迭代传播邻居社区标签
//
// Phase 36 Task 4 增强：
//   4a. clusterSimilarNodes()：Jaccard 相似度聚类合并
//   4b. computeConfidence()：置信度评分（validatedCount * timeDecay * corroborationBonus）
//   4b2. validUntil / supersededBy：过时知识显式标记
//   4c. recall() 排序综合 PPR 分数和置信度，默认排除已 superseded 的节点

export type NodeType = 'fact' | 'decision' | 'skill' | 'event';
export type EdgeType = 'relates_to' | 'derived_from' | 'supersedes' | 'conflicts_with';

export interface GraphNode {
  id: string;
  type: NodeType;
  content: string;
  /** 预留字段，当前未使用。未来如需语义搜索可重新启用。 */
  embedding?: number[];
  /** 被验证次数（用户确认或后续引用次数），用于排序代表节点 */
  validatedCount: number;
  createdAt: number;
  updatedAt: number;
  /** 是否已废弃（deprecated=true 的节点默认在召回时过滤） */
  deprecated: boolean;
  /** Phase 36 Task 4b2：过时时间戳，过了此时间该知识被视为过时 */
  validUntil?: number;
  /** Phase 36 Task 4b2：如果有新知识替代了本条，指向新知识的 nodeId */
  supersededBy?: string;
  /** Phase 36 Task 4b：不同来源的验证次数（用于 corroborationBonus 计算） */
  distinctSources?: number;
  /** Phase 38 Task 3.2：被标记为 unused 的次数（用于遗忘机制判断） */
  unusedCount?: number;
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

/** Phase 38 Task 3.2：improve() 反馈结果 */
export interface ImproveResult {
  updatedNodes: number;
  supersededNodes: number;
  details: string;
}

/** Phase 38 Task 3.3：forget() 遗忘结果 */
export interface ForgetResult {
  forgotten: number;
  nodes: Array<{ id: string; content: string; type: NodeType }>;
}

/** Phase 38 Task 4.1：recallV2 多策略召回策略类型 */
export type RecallStrategy = 'semantic' | 'graph' | 'temporal' | 'type_weighted' | 'hybrid';

/** Phase 38 Task 4.1：recallV2 召回结果条目 */
export interface RecallV2Result {
  node: GraphNode;
  score: number;
  strategy: RecallStrategy;
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

// Phase 36 Task 4 常量
/** 时间衰减系数 λ（半衰期约 70 天） */
const CONFIDENCE_LAMBDA = 0.01;
/** 置信度在 recall 排序中的权重（PPR 占 0.6，置信度占 0.4） */
const RECALL_PPR_WEIGHT = 0.6;
const RECALL_CONFIDENCE_WEIGHT = 0.4;
/** Jaccard 相似度默认阈值（超过此值认为节点相似） */
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
/** 归纳层：超过此天数未被引用的节点降级为归档 */
const ARCHIVE_STALE_DAYS = 30;

// Phase 38 Task 4 常量
/** recallV2 默认最大返回数 */
const DEFAULT_RECALL_V2_MAX = 10;
/** BFS 扩展深度（graph 策略） */
const RECALL_V2_BFS_DEPTH = 3;
/** hybrid 策略：semantic 权重 */
const HYBRID_SEMANTIC_WEIGHT = 0.4;
/** hybrid 策略：graph 权重 */
const HYBRID_GRAPH_WEIGHT = 0.3;
/** hybrid 策略：temporal 权重 */
const HYBRID_TEMPORAL_WEIGHT = 0.3;
/** type_weighted 策略：匹配类型的额外加分 */
const TYPE_WEIGHTED_BONUS = 0.5;

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  /** 邻接表：source → Set<target>（仅记录有向出边） */
  private adjacency = new Map<string, Set<string>>();
  /** 反向邻接表：target → Set<source>（PPR 入边计算用） */
  private reverseAdjacency = new Map<string, Set<string>>();
  /**
   * I22 修复：已参与过合并的节点 ID 集合（跨多次 clusterSimilarNodes 调用持久化）
   * 一旦节点被合并（无论作为 winner 还是 loser），后续调用不再对其进行合并操作，
   * 避免多次调用时重复合并相同节点导致内容无限膨胀。
   */
  private mergedNodeIds = new Set<string>();

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
   *
   * Phase 36 Task 4 增强：
   *   - 默认排除已 superseded 的节点（validUntil < now 且 supersededBy 有值）
   *   - 排序综合 PPR 分数和置信度：finalScore = pprScore * 0.6 + normalizedConfidence * 0.4
   *   - includeSuperseded 选项允许"时间旅行"查询
   */
  recall(
    query: string,
    options?: {
      maxResults?: number;
      preciseWeight?: number;
      /** Phase 36 Task 4b2：是否包含已过时/superseded 的节点（默认 false） */
      includeSuperseded?: boolean;
    },
  ): Array<{ node: GraphNode; score: number; path: 'precise' | 'generalized' | 'both' }> {
    const maxResults = options?.maxResults ?? DEFAULT_RECALL_MAX;
    const preciseWeight = options?.preciseWeight ?? DEFAULT_PRECISE_WEIGHT;
    const generalizedWeight = 1 - preciseWeight; // 默认 0.3
    const includeSuperseded = options?.includeSuperseded ?? false;

    const keywords = this.extractKeywords(query);
    if (keywords.length === 0 || this.nodes.size === 0) return [];

    // Phase 36 Task 4b2：判断节点是否应被排除（已 superseded 且未请求包含）
    const isExcluded = (node: GraphNode): boolean => {
      if (node.deprecated) return true;
      if (includeSuperseded) return false;
      // validUntil 已过期 且 supersededBy 有值 → 排除
      if (node.validUntil !== undefined && node.validUntil < Date.now() && node.supersededBy) {
        return true;
      }
      return false;
    };

    // ===== 精确路径 =====
    const preciseSeeds: string[] = [];
    for (const node of this.nodes.values()) {
      if (isExcluded(node)) continue;
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
        if (!node || isExcluded(node)) continue;
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
        .filter((n): n is GraphNode => !!n && !isExcluded(n))
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

    // Phase 36 Task 4b：排序综合 PPR 分数和置信度
    // finalScore = pprScore * 0.6 + normalizedConfidence * 0.4
    // 注意：PPR 内部只过滤 deprecated，不过滤 validUntil+supersededBy，
    // 因此最终结果需要再次应用 isExcluded 过滤（防止已 superseded 的节点通过图传播进入结果）
    // M3 修复：tanh 在 confidence >= 3 时已饱和接近 1，丢失区分度；改用 min-max 归一化
    // 第一遍：收集所有候选节点的 confidence，计算 min/max
    const candidates = Array.from(merged.entries())
      .map(([id, info]) => {
        const node = this.nodes.get(id);
        if (!node) return null;
        if (isExcluded(node)) return null;
        const confidence = this.computeConfidence(node);
        return { node, info, confidence };
      })
      .filter((r): r is { node: GraphNode; info: { score: number; path: 'precise' | 'generalized' | 'both' }; confidence: number } => r !== null);

    // 计算 min-max 归一化所需的边界值
    const confidences = candidates.map((c) => c.confidence);
    const minConf = confidences.length > 0 ? Math.min(...confidences) : 0;
    const maxConf = confidences.length > 0 ? Math.max(...confidences) : 0;
    const confRange = maxConf - minConf;

    const results = candidates
      .map((c) => {
        // min-max 归一化到 [0, 1]；所有 confidence 相同时统一归一化为 1（避免除零）
        const normalizedConfidence = confRange > 0 ? (c.confidence - minConf) / confRange : 1;
        const finalScore = c.info.score * RECALL_PPR_WEIGHT + normalizedConfidence * RECALL_CONFIDENCE_WEIGHT;
        return { node: c.node, score: finalScore, path: c.info.path };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return results;
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

  // ===== Phase 36 Task 4：模式聚类与置信度 =====

  /**
   * Phase 36 Task 4a：内容相似性聚类
   *
   * 对同一 type 的节点计算 Jaccard 相似度（基于分词后的词集），
   * 相似度 > 阈值的节点合并：保留 validatedCount 最高的节点，
   * 将其 content 扩展为合并后的版本，其他节点标记 deprecated。
   * 合并后创建 supersedes 边指向被合并的节点。
   *
   * @param threshold Jaccard 相似度阈值（默认 0.5）
   * @returns 合并统计 { merged: 合并的节点数, deprecated: 标记废弃的节点数 }
   */
  clusterSimilarNodes(threshold: number = DEFAULT_SIMILARITY_THRESHOLD): {
    merged: number;
    deprecated: number;
  } {
    let mergedCount = 0;
    let deprecatedCount = 0;

    // 按 type 分组
    const byType = new Map<NodeType, GraphNode[]>();
    for (const node of this.nodes.values()) {
      if (node.deprecated) continue; // 已废弃的不再参与聚类
      const list = byType.get(node.type) ?? [];
      list.push(node);
      byType.set(node.type, list);
    }

    // 对每个 type 内部做聚类
    for (const [, nodes] of byType) {
      // 已处理标记（被合并的节点跳过）
      const processed = new Set<string>();

      for (let i = 0; i < nodes.length; i++) {
        if (processed.has(nodes[i].id)) continue;
        const keeper = nodes[i];
        // I22 修复：已参与过合并的节点跳过，避免多次调用时重复合并
        if (this.mergedNodeIds.has(keeper.id)) continue;
        const keeperWords = this.tokenize(keeper.content);

        // 寻找与 keeper 相似的节点
        for (let j = i + 1; j < nodes.length; j++) {
          if (processed.has(nodes[j].id)) continue;
          const candidate = nodes[j];
          // I22 修复：已参与过合并的候选节点跳过
          if (this.mergedNodeIds.has(candidate.id)) continue;
          const candidateWords = this.tokenize(candidate.content);

          const similarity = this.jaccardSimilarity(keeperWords, candidateWords);
          if (similarity >= threshold) {
            // 合并：保留 validatedCount 最高的
            const winner = keeper.validatedCount >= candidate.validatedCount ? keeper : candidate;
            const loser = winner === keeper ? candidate : keeper;

            // I22 修复：将 winner 和 loser 都标记为已合并，避免后续重复操作
            this.mergedNodeIds.add(winner.id);
            this.mergedNodeIds.add(loser.id);

            // 如果 winner 是 candidate，需要交换（确保 keeper 始终是 winner）
            if (winner === candidate) {
              // keeper 变为 loser，candidate 变为 keeper
              // 但为了简化逻辑，我们直接处理 winner/loser
              processed.add(keeper.id);
              // 将 keeper 的内容合并到 winner
              winner.content = `${winner.content}\n[合并] ${keeper.content}`;
              winner.validatedCount += keeper.validatedCount;
              // 合并 distinctSources
              const sources = (winner.distinctSources ?? 1) + (keeper.distinctSources ?? 1);
              winner.distinctSources = sources;
              winner.updatedAt = Date.now();

              // loser（keeper）标记废弃
              keeper.deprecated = true;
              keeper.supersededBy = winner.id;
              keeper.validUntil = Date.now();

              // 创建 supersedes 边
              this.addEdge({
                source: winner.id,
                target: keeper.id,
                type: 'supersedes',
                weight: similarity,
              });

              deprecatedCount++;
              mergedCount++;
              break; // keeper 已被合并，跳出内层循环
            } else {
              // keeper 是 winner，candidate 是 loser
              processed.add(candidate.id);
              keeper.content = `${keeper.content}\n[合并] ${candidate.content}`;
              keeper.validatedCount += candidate.validatedCount;
              const sources = (keeper.distinctSources ?? 1) + (candidate.distinctSources ?? 1);
              keeper.distinctSources = sources;
              keeper.updatedAt = Date.now();

              candidate.deprecated = true;
              candidate.supersededBy = keeper.id;
              candidate.validUntil = Date.now();

              this.addEdge({
                source: keeper.id,
                target: candidate.id,
                type: 'supersedes',
                weight: similarity,
              });

              deprecatedCount++;
              mergedCount++;
            }
          }
        }
      }
    }

    return { merged: mergedCount, deprecated: deprecatedCount };
  }

  /**
   * Phase 36 Task 4b：计算节点的置信度分数
   *
   * confidence = validatedCount * timeDecay * corroborationBonus
   * timeDecay = exp(-λ * daysSinceUpdate)    // λ=0.01，半衰期约 70 天
   * corroborationBonus = 1 + 0.1 * distinctSources  // 不同来源的验证加分
   *
   * 注意（陷阱 #51）：confidenceScore 是计算字段，不持久化。
   * 因为时间衰减依赖当前时间，持久化会导致过期分数被读取。
   *
   * @param node 图节点
   * @returns 置信度分数（>= 0）
   */
  computeConfidence(node: GraphNode): number {
    const daysSinceUpdate = (Date.now() - node.updatedAt) / (1000 * 60 * 60 * 24);
    const timeDecay = Math.exp(-CONFIDENCE_LAMBDA * daysSinceUpdate);
    const corroborationBonus = 1 + 0.1 * (node.distinctSources ?? 1);
    return node.validatedCount * timeDecay * corroborationBonus;
  }

  /**
   * Phase 36 Task 4b2：标记一个节点被新节点替代
   *
   * 设置旧节点的 supersededBy 和 validUntil，
   * 并创建 supersedes 边。
   *
   * @param oldNodeId 旧节点 ID
   * @param newNodeId 新节点 ID
   */
  supersedeNode(oldNodeId: string, newNodeId: string): boolean {
    const oldNode = this.nodes.get(oldNodeId);
    const newNode = this.nodes.get(newNodeId);
    if (!oldNode || !newNode) return false;

    oldNode.supersededBy = newNodeId;
    oldNode.validUntil = Date.now();
    oldNode.updatedAt = Date.now();

    this.addEdge({
      source: newNodeId,
      target: oldNodeId,
      type: 'supersedes',
      weight: 1.0,
    });

    return true;
  }

  /**
   * Phase 36 Task 4c：归纳层——时效淘汰
   *
   * 超过指定天数未被引用（validatedCount 未增长）的节点降级为归档。
   * 在 ingestToGraph 的归纳三步中调用。
   *
   * @param staleDays 超过此天数未更新则归档（默认 30 天）
   * @returns 归档的节点数
   */
  archiveStaleNodes(staleDays: number = ARCHIVE_STALE_DAYS): number {
    const now = Date.now();
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    let archived = 0;

    for (const node of this.nodes.values()) {
      if (node.deprecated) continue;
      if (now - node.updatedAt > staleMs) {
        node.deprecated = true;
        archived++;
      }
    }

    return archived;
  }

  // ===== Phase 38 Task 3.2：知识反馈 improve() =====

  /**
   * 知识反馈：根据使用结果更新节点置信度
   *
   * - useful → validatedCount += 1，刷新 updatedAt
   * - partially_useful → 不改变 validatedCount，刷新 updatedAt（延缓衰减）
   * - incorrect → 标记 deprecated=true；若有 details 则创建新节点并用 supersedeNode() 关联
   * - unused → 递增 unusedCount
   *
   * @param params.query 查询字符串（用于 incorrect 时创建新节点）
   * @param params.nodeIds 反馈目标节点 ID 列表
   * @param params.outcome 反馈结果类型
   * @param params.details incorrect 时的修正内容
   */
  improve(params: {
    query: string;
    nodeIds: string[];
    outcome: 'useful' | 'partially_useful' | 'incorrect' | 'unused';
    details?: string;
  }): ImproveResult {
    const now = Date.now();
    let updatedNodes = 0;
    let supersededNodes = 0;
    const detailParts: string[] = [];

    for (const id of params.nodeIds) {
      const node = this.nodes.get(id);
      if (!node) {
        detailParts.push(`节点 ${id} 不存在，跳过`);
        continue;
      }

      switch (params.outcome) {
        case 'useful':
          node.validatedCount += 1;
          node.updatedAt = now;
          updatedNodes++;
          detailParts.push(`${id}: validatedCount=${node.validatedCount}`);
          break;
        case 'partially_useful':
          // 不改变 validatedCount，但刷新 updatedAt（延缓衰减）
          node.updatedAt = now;
          updatedNodes++;
          detailParts.push(`${id}: 刷新 updatedAt`);
          break;
        case 'incorrect':
          node.deprecated = true;
          node.updatedAt = now;
          updatedNodes++;
          // 若有 details 则创建新节点并用 supersedeNode 关联
          if (params.details && params.details.trim().length > 0) {
            const newNode: GraphNode = {
              id: `${node.type}-corrected-${now}-${Math.random().toString(36).slice(2, 8)}`,
              type: node.type,
              content: params.details,
              validatedCount: 1,
              createdAt: now,
              updatedAt: now,
              deprecated: false,
              distinctSources: 1,
            };
            this.addNode(newNode);
            this.supersedeNode(node.id, newNode.id);
            supersededNodes++;
            detailParts.push(`${id}: 标记 deprecated，新节点 ${newNode.id} 已替代`);
          } else {
            detailParts.push(`${id}: 标记 deprecated`);
          }
          break;
        case 'unused':
          node.unusedCount = (node.unusedCount ?? 0) + 1;
          node.updatedAt = now;
          updatedNodes++;
          detailParts.push(`${id}: unusedCount=${node.unusedCount}`);
          break;
      }
    }

    return {
      updatedNodes,
      supersededNodes,
      details: detailParts.join('; ') || '无操作',
    };
  }

  // ===== Phase 38 Task 3.3：主动遗忘 forget() =====

  /**
   * 主动遗忘：按条件标记节点为 deprecated（不直接删除）
   *
   * 遗忘策略：
   *   - 不是直接删除，而是标记 deprecated=true（与 archiveStaleNodes 一致）
   *   - 入边保护：如果节点被其他非 deprecated 节点引用（有入边），则不遗忘
   *   - dryRun=true 时只返回待遗忘列表，不实际执行
   *   - criteria.staleFor 使用 updatedAt 判断；criteria.unusedFor 使用 unusedCount 和 updatedAt 判断
   *
   * @param params.nodeIds 显式指定遗忘的节点 ID 列表（优先于 criteria）
   * @param params.criteria 条件过滤（nodeIds 为空时使用）
   * @param params.dryRun 是否只预览不执行
   */
  forget(params: {
    nodeIds?: string[];
    criteria?: {
      unusedFor?: number;  // 天数
      staleFor?: number;   // 天数
      type?: NodeType;
    };
    dryRun?: boolean;
  }): ForgetResult {
    const now = Date.now();
    const forgottenNodes: Array<{ id: string; content: string; type: NodeType }> = [];
    const candidates = new Set<string>();

    // 1. 收集候选节点
    if (params.nodeIds && params.nodeIds.length > 0) {
      for (const id of params.nodeIds) {
        const node = this.nodes.get(id);
        if (node && !node.deprecated) candidates.add(id);
      }
    } else if (params.criteria) {
      const c = params.criteria;
      for (const node of this.nodes.values()) {
        if (node.deprecated) continue;
        if (c.type !== undefined && node.type !== c.type) continue;

        let matches = false;
        // staleFor：超过此天数未更新
        if (c.staleFor !== undefined) {
          const staleMs = c.staleFor * 24 * 60 * 60 * 1000;
          if (now - node.updatedAt > staleMs) matches = true;
        }
        // unusedFor：unusedCount > 0 且超过此天数未更新
        if (c.unusedFor !== undefined) {
          const unusedMs = c.unusedFor * 24 * 60 * 60 * 1000;
          const isUnused = (node.unusedCount ?? 0) > 0;
          if (isUnused && now - node.updatedAt > unusedMs) matches = true;
        }
        // 如果同时指定 staleFor 和 unusedFor，只要满足其一即匹配（OR 语义）
        // 如果只指定一个，则 matches 已正确反映
        // 如果都未指定，则不匹配（避免误删全部）
        if (matches) candidates.add(node.id);
      }
    }

    // 2. 入边保护：被其他非 deprecated 节点引用的节点不遗忘
    const toForget: string[] = [];
    for (const id of candidates) {
      if (!this.hasActiveInboundEdge(id)) {
        toForget.push(id);
      }
    }

    // 3. 执行或预览
    for (const id of toForget) {
      const node = this.nodes.get(id)!;
      forgottenNodes.push({ id, content: node.content, type: node.type });
      if (!params.dryRun) {
        node.deprecated = true;
        node.updatedAt = now;
      }
    }

    return {
      forgotten: forgottenNodes.length,
      nodes: forgottenNodes,
    };
  }

  /**
   * 检查节点是否有来自非 deprecated 节点的入边
   * 入边 = reverseAdjacency 中的 source 节点
   */
  private hasActiveInboundEdge(nodeId: string): boolean {
    const sources = this.reverseAdjacency.get(nodeId);
    if (!sources || sources.size === 0) return false;
    for (const srcId of sources) {
      const src = this.nodes.get(srcId);
      if (src && !src.deprecated) return true;
    }
    return false;
  }

  // ===== Phase 38 Task 4.1：多策略召回 recallV2() =====

  /**
   * 多策略召回（保留原 recall() 向后兼容）
   *
   * 各策略：
   *   - semantic：关键词匹配 + Jaccard 相似度（复用现有 precise 路径逻辑）
   *   - graph：从匹配节点 BFS depth 3 遍历
   *   - temporal：按 updatedAt 降序
   *   - type_weighted：根据查询关键词提升对应类型权重
   *   - hybrid：同时运行 semantic + graph + temporal，加权合并（0.4 + 0.3 + 0.3）
   *
   * 不指定 strategy 时用 autoSelectStrategy(query) 自动路由。
   */
  recallV2(params: {
    query: string;
    strategy?: RecallStrategy;
    maxResults?: number;
    typeFilter?: NodeType;
    since?: Date;
  }): RecallV2Result[] {
    const maxResults = params.maxResults ?? DEFAULT_RECALL_V2_MAX;
    const strategy = params.strategy ?? this.autoSelectStrategy(params.query);

    // 公共过滤：排除 deprecated；typeFilter；since
    const isEligible = (node: GraphNode): boolean => {
      if (node.deprecated) return false;
      if (params.typeFilter && node.type !== params.typeFilter) return false;
      if (params.since && node.updatedAt < params.since.getTime()) return false;
      return true;
    };

    const keywords = this.extractKeywords(params.query);

    switch (strategy) {
      case 'semantic':
        return this.recallSemantic(keywords, isEligible, maxResults, 'semantic');
      case 'graph':
        return this.recallGraph(keywords, isEligible, maxResults);
      case 'temporal':
        return this.recallTemporal(isEligible, maxResults);
      case 'type_weighted':
        return this.recallTypeWeighted(params.query, keywords, isEligible, maxResults);
      case 'hybrid':
        return this.recallHybrid(params.query, keywords, isEligible, maxResults);
    }
  }

  /** 自动路由器：纯关键词匹配，不调用 LLM */
  autoSelectStrategy(query: string): RecallStrategy {
    // 匹配 "决定/决策/选了/采用/方案" → type_weighted
    if (/决定|决策|选了|采用|方案/.test(query)) return 'type_weighted';
    // 匹配 "错误/bug/异常/崩溃/修复" → type_weighted
    if (/错误|bug|异常|崩溃|修复/.test(query)) return 'type_weighted';
    // 匹配 "最近/刚才/上次/今天" → temporal
    if (/最近|刚才|上次|今天/.test(query)) return 'temporal';
    // 匹配 "关于/所有/全部/涉及" → graph
    if (/关于|所有|全部|涉及/.test(query)) return 'graph';
    // 默认 → hybrid
    return 'hybrid';
  }

  /** semantic 策略：关键词匹配 + Jaccard 相似度 */
  private recallSemantic(
    keywords: string[],
    isEligible: (n: GraphNode) => boolean,
    maxResults: number,
    strategy: RecallStrategy,
  ): RecallV2Result[] {
    if (keywords.length === 0) return [];
    const results: RecallV2Result[] = [];
    for (const node of this.nodes.values()) {
      if (!isEligible(node)) continue;
      const nodeWords = this.tokenize(node.content);
      const queryWords = new Set(keywords.map(k => k.toLowerCase()));
      // 计算 Jaccard 相似度
      let intersection = 0;
      for (const w of queryWords) {
        if (nodeWords.has(w)) intersection++;
      }
      const union = queryWords.size + nodeWords.size - intersection;
      const similarity = union === 0 ? 0 : intersection / union;
      // 关键词匹配加分
      const matchBonus = keywords.some(kw => node.content.includes(kw)) ? 0.3 : 0;
      const score = similarity + matchBonus;
      if (score > 0) {
        results.push({ node, score, strategy });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /** graph 策略：从匹配节点 BFS depth 3 遍历 */
  private recallGraph(
    keywords: string[],
    isEligible: (n: GraphNode) => boolean,
    maxResults: number,
  ): RecallV2Result[] {
    // 找到匹配的 seed 节点
    const seeds: string[] = [];
    for (const node of this.nodes.values()) {
      if (!isEligible(node)) continue;
      if (keywords.length === 0 || keywords.some(kw => node.content.includes(kw))) {
        seeds.push(node.id);
      }
    }
    if (seeds.length === 0) return [];

    // BFS 扩展 depth 3
    const visited = new Map<string, number>(); // id → depth
    for (const s of seeds) visited.set(s, 0);
    let frontier = [...seeds];
    for (let d = 0; d < RECALL_V2_BFS_DEPTH; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const neighbors = this.getNeighbors(id);
        for (const nb of neighbors) {
          if (!visited.has(nb)) {
            visited.set(nb, d + 1);
            next.push(nb);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    // 按深度排序（浅的优先），深度相同按 validatedCount
    const results: RecallV2Result[] = [];
    for (const [id, depth] of visited) {
      const node = this.nodes.get(id);
      if (!node || !isEligible(node)) continue;
      // 分数 = 1 / (depth + 1)，深度越浅分数越高
      const score = 1 / (depth + 1);
      results.push({ node, score, strategy: 'graph' });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /** temporal 策略：按 updatedAt 降序 */
  private recallTemporal(
    isEligible: (n: GraphNode) => boolean,
    maxResults: number,
  ): RecallV2Result[] {
    const all: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (isEligible(node)) all.push(node);
    }
    // 按 updatedAt 降序
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    const top = all.slice(0, maxResults);
    // 分数：按时间归一化（最新的为 1.0）
    const maxTime = top.length > 0 ? top[0].updatedAt : 1;
    const minTime = top.length > 0 ? top[top.length - 1].updatedAt : 0;
    const range = maxTime - minTime || 1;
    return top.map(node => ({
      node,
      score: range === 0 ? 1 : (node.updatedAt - minTime) / range,
      strategy: 'temporal' as const,
    }));
  }

  /** type_weighted 策略：根据查询关键词提升对应类型权重 */
  private recallTypeWeighted(
    query: string,
    keywords: string[],
    isEligible: (n: GraphNode) => boolean,
    maxResults: number,
  ): RecallV2Result[] {
    // 检测查询应优先返回的类型
    const typeBonus = new Map<NodeType, number>();
    if (/决定|决策|选了|采用|方案/.test(query)) {
      typeBonus.set('decision', TYPE_WEIGHTED_BONUS);
    }
    if (/错误|bug|异常|崩溃|修复/.test(query)) {
      typeBonus.set('event', TYPE_WEIGHTED_BONUS);
    }
    // 默认无加分

    // 基于 semantic 计算，再叠加类型加分
    const semanticResults = this.recallSemantic(keywords, isEligible, this.nodes.size, 'type_weighted');
    for (const r of semanticResults) {
      const bonus = typeBonus.get(r.node.type) ?? 0;
      r.score += bonus;
    }
    return semanticResults.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /** hybrid 策略：同时运行 semantic + graph + temporal，加权合并 */
  private recallHybrid(
    query: string,
    keywords: string[],
    isEligible: (n: GraphNode) => boolean,
    maxResults: number,
  ): RecallV2Result[] {
    const semantic = this.recallSemantic(keywords, isEligible, this.nodes.size, 'semantic');
    const graph = this.recallGraph(keywords, isEligible, this.nodes.size);
    const temporal = this.recallTemporal(isEligible, this.nodes.size);

    // 归一化每条策略的分数到 0-1
    const normalize = (results: RecallV2Result[]) => {
      if (results.length === 0) return new Map<string, number>();
      const max = Math.max(...results.map(r => r.score)) || 1;
      const m = new Map<string, number>();
      for (const r of results) m.set(r.node.id, r.score / max);
      return m;
    };

    const semNorm = normalize(semantic);
    const graphNorm = normalize(graph);
    const tempNorm = normalize(temporal);

    // 合并所有节点 ID
    const allIds = new Set<string>([
      ...semNorm.keys(),
      ...graphNorm.keys(),
      ...tempNorm.keys(),
    ]);

    const merged: RecallV2Result[] = [];
    for (const id of allIds) {
      const node = this.nodes.get(id);
      if (!node || !isEligible(node)) continue;
      const score =
        (semNorm.get(id) ?? 0) * HYBRID_SEMANTIC_WEIGHT +
        (graphNorm.get(id) ?? 0) * HYBRID_GRAPH_WEIGHT +
        (tempNorm.get(id) ?? 0) * HYBRID_TEMPORAL_WEIGHT;
      merged.push({ node, score, strategy: 'hybrid' });
    }

    return merged.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /** 分词（用于 Jaccard 相似度计算） */
  private tokenize(text: string): Set<string> {
    // 按非字母数字字符切分，过滤空串
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .filter(s => s.length > 0),
    );
  }

  /** 计算 Jaccard 相似度 */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1.0;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
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

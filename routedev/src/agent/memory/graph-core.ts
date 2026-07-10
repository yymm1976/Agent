// src/agent/memory/graph-core.ts
// 轻量知识图谱核心模块（借鉴 graph-memory，纯内存实现，无 SQLite/向量数据库依赖）
//
// 职责：
//   1. 图的基本结构：节点/边存储、邻接表维护、增删查
//   2. 个性化 PageRank (PPR)：从 seed 节点出发按图结构传播相关性分数
//   3. 知识生命周期管理：置信度计算、节点替代、归档、反馈(improve)、遗忘(forget)
//   4. 通用辅助：分词、Jaccard 相似度、关键词提取、邻居查询、序列化
//
// 本文件导出 KnowledgeGraph 基类。graph.ts 作为组合入口，
// 会应用 graph-community / graph-recall 的 prototype 注入为 KnowledgeGraph 添加方法。
// 字段使用 public 以便外部模块注入的方法通过 this 访问。

import { tokenizeForJaccard, jaccardSimilarity } from '../../utils/jaccard.js';

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

/** PPR 默认参数 */
const DEFAULT_PPR_DAMPING = 0.85;
const DEFAULT_PPR_ITERATIONS = 20;
const DEFAULT_PPR_TOPK = 10;
/** PPR 收敛阈值（分数变化小于此值则提前停止） */
const PPR_CONVERGE_EPSILON = 1e-6;

// Phase 36 Task 4 常量
/** 时间衰减系数 λ（半衰期约 70 天） */
const CONFIDENCE_LAMBDA = 0.01;
/** 归纳层：超过此天数未被引用的节点降级为归档 */
const ARCHIVE_STALE_DAYS = 30;

export class KnowledgeGraph {
  public nodes = new Map<string, GraphNode>();
  public edges: GraphEdge[] = [];
  /** 邻接表：source → Set<target>（仅记录有向出边） */
  public adjacency = new Map<string, Set<string>>();
  /** 反向邻接表：target → Set<source>（PPR 入边计算用） */
  public reverseAdjacency = new Map<string, Set<string>>();
  /**
   * I22 修复：已参与过合并的节点 ID 集合（跨多次 clusterSimilarNodes 调用持久化）
   * 一旦节点被合并（无论作为 winner 还是 loser），后续调用不再对其进行合并操作，
   * 避免多次调用时重复合并相同节点导致内容无限膨胀。
   */
  public mergedNodeIds = new Set<string>();

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

  // ===== Phase 36 Task 4：置信度与生命周期 =====

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
   * 在 consolidateToGraph 的归纳三步中调用。
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
  public hasActiveInboundEdge(nodeId: string): boolean {
    const sources = this.reverseAdjacency.get(nodeId);
    if (!sources || sources.size === 0) return false;
    for (const srcId of sources) {
      const src = this.nodes.get(srcId);
      if (src && !src.deprecated) return true;
    }
    return false;
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
    // 使用 this 而非硬编码 KnowledgeGraph，确保 prototype 注入的方法
    // 在 fromJSON 创建的实例上也可用（方法挂在 KnowledgeGraph.prototype 上）。
    const graph = new (this as unknown as new () => KnowledgeGraph)();
    const data = JSON.parse(json) as { nodes: GraphNode[]; edges: GraphEdge[] };
    for (const node of data.nodes ?? []) graph.addNode(node);
    for (const edge of data.edges ?? []) graph.addEdge(edge);
    return graph;
  }

  // ===== 通用辅助方法（供 core 及 prototype 注入的方法使用） =====

  /** 从 query 提取关键词（按空白切分，过滤空串） */
  public extractKeywords(query: string): string[] {
    return query
      .split(/\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /** 获取节点的所有邻居（无向：入边 + 出边） */
  public getNeighbors(id: string): Set<string> {
    const neighbors = new Set<string>();
    const out = this.adjacency.get(id);
    if (out) for (const t of out) neighbors.add(t);
    const inN = this.reverseAdjacency.get(id);
    if (inN) for (const s of inN) neighbors.add(s);
    return neighbors;
  }

  /** 分词（用于 Jaccard 相似度计算）- P1 修复：复用公共实现 */
  public tokenize(text: string): Set<string> {
    return tokenizeForJaccard(text);
  }

  /** 计算 Jaccard 相似度 - P1 修复：复用公共实现 */
  public jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    return jaccardSimilarity(a, b);
  }
}

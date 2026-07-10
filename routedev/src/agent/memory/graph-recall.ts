// src/agent/memory/graph-recall.ts
// 知识图谱双路径召回与多策略召回模块
//
// 职责：
//   1. recall()：双路径召回
//      - 精确路径：关键词匹配 → BFS 扩展 depth 2 → PPR 排序
//      - 泛化路径：社区代表节点 → BFS 扩展 depth 1 → PPR 排序
//      - 合并：精确权重 0.7，泛化权重 0.3；综合 PPR 分数与置信度排序
//   2. recallV2()：多策略召回（semantic / graph / temporal / type_weighted / hybrid）
//   3. runPath()：单路径执行（BFS 扩展 + PPR 排序），recall 内部使用
//
// 通过 declaration merging 为 KnowledgeGraph 添加类型声明，
// 通过 prototype 注入为 KnowledgeGraph 添加方法实现。
// 依赖 core（PPR / 置信度 / public 辅助方法）与 community（detectCommunities）。
// 因此 graph.ts 中需先应用 community 注入，再应用 recall 注入。

import type { GraphNode, NodeType, RecallStrategy } from './graph-core.js';
import type { KnowledgeGraph } from './graph-core.js';

// declaration merging：为 KnowledgeGraph 接口添加召回方法类型
declare module './graph-core.js' {
  interface KnowledgeGraph {
    recall(
      query: string,
      options?: {
        maxResults?: number;
        preciseWeight?: number;
        includeSuperseded?: boolean;
      },
    ): Array<{ node: GraphNode; score: number; path: 'precise' | 'generalized' | 'both' }>;
    recallV2(params: {
      query: string;
      strategy?: RecallStrategy;
      maxResults?: number;
      typeFilter?: NodeType;
      since?: Date;
    }): RecallV2Result[];
    autoSelectStrategy(query: string): RecallStrategy;
    // 以下为内部辅助方法，注入 prototype 供 recall/recallV2 内部调用
    recallSemantic(
      keywords: string[],
      isEligible: (n: GraphNode) => boolean,
      maxResults: number,
      strategy: RecallStrategy,
    ): RecallV2Result[];
    recallGraph(
      keywords: string[],
      isEligible: (n: GraphNode) => boolean,
      maxResults: number,
    ): RecallV2Result[];
    recallTemporal(
      isEligible: (n: GraphNode) => boolean,
      maxResults: number,
    ): RecallV2Result[];
    recallTypeWeighted(
      query: string,
      keywords: string[],
      isEligible: (n: GraphNode) => boolean,
      maxResults: number,
    ): RecallV2Result[];
    recallHybrid(
      query: string,
      keywords: string[],
      isEligible: (n: GraphNode) => boolean,
      maxResults: number,
    ): RecallV2Result[];
    runPath(
      seeds: string[],
      depth: number,
      topK: number,
    ): Array<{ node: GraphNode; score: number }>;
  }
}

/** 召回默认参数 */
const DEFAULT_RECALL_MAX = 10;
const DEFAULT_PRECISE_WEIGHT = 0.7;
/** BFS 扩展深度常量 */
const PRECISE_BFS_DEPTH = 2;
const GENERALIZED_BFS_DEPTH = 1;
/** 置信度在 recall 排序中的权重（PPR 占 0.6，置信度占 0.4） */
const RECALL_PPR_WEIGHT = 0.6;
const RECALL_CONFIDENCE_WEIGHT = 0.4;

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

/** Phase 38 Task 4.1：recallV2 召回结果条目 */
export interface RecallV2Result {
  node: GraphNode;
  score: number;
  strategy: RecallStrategy;
}

/**
 * 召回方法注入
 *
 * 通过 prototype 注入为 KnowledgeGraph 添加 recall / recallV2 / autoSelectStrategy
 * 以及内部辅助方法（recallSemantic / recallGraph / recallTemporal / recallTypeWeighted /
 * recallHybrid / runPath）。
 * 方法内部 this 指向 KnowledgeGraph 实例。
 *
 * @param target KnowledgeGraph 类构造函数（需已应用 community 方法）
 */
export function applyRecallMethods(target: any): void {
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
  target.prototype.recall = function (
    this: KnowledgeGraph,
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
  };

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
  target.prototype.recallV2 = function (this: KnowledgeGraph, params: {
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
  };

  /** 自动路由器：纯关键词匹配，不调用 LLM */
  target.prototype.autoSelectStrategy = function (this: KnowledgeGraph, query: string): RecallStrategy {
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
  };

  /** semantic 策略：关键词匹配 + Jaccard 相似度 */
  target.prototype.recallSemantic = function (
    this: KnowledgeGraph,
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
  };

  /** graph 策略：从匹配节点 BFS depth 3 遍历 */
  target.prototype.recallGraph = function (
    this: KnowledgeGraph,
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
  };

  /** temporal 策略：按 updatedAt 降序 */
  target.prototype.recallTemporal = function (
    this: KnowledgeGraph,
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
  };

  /** type_weighted 策略：根据查询关键词提升对应类型权重 */
  target.prototype.recallTypeWeighted = function (
    this: KnowledgeGraph,
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
  };

  /** hybrid 策略：同时运行 semantic + graph + temporal，加权合并 */
  target.prototype.recallHybrid = function (
    this: KnowledgeGraph,
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
  };

  /**
   * 单路径执行：BFS 扩展 seed → PPR 排序
   * @param seeds 起始 seed 节点 ID 列表
   * @param depth BFS 扩展深度
   * @param topK 返回前 K 个
   */
  target.prototype.runPath = function (
    this: KnowledgeGraph,
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
  };
}

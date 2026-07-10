// src/agent/memory/graph-community.ts
// 知识图谱社区检测与聚类模块
//
// 职责：
//   1. Label Propagation 社区检测：迭代传播邻居社区标签，发现图中的社区结构
//   2. Jaccard 相似度聚类：对同类型节点按内容相似度合并，去重归并冗余知识
//
// 通过 declaration merging 为 KnowledgeGraph 添加类型声明，
// 通过 prototype 注入为 KnowledgeGraph 添加方法实现。
// 避免 mixin 匿名类的 TypeScript 类型限制（TS4058 / TS4094）。

import type { GraphNode, NodeType } from './graph-core.js';
import type { KnowledgeGraph } from './graph-core.js';

// declaration merging：为 KnowledgeGraph 接口添加社区检测方法类型
declare module './graph-core.js' {
  interface KnowledgeGraph {
    detectCommunities(maxIterations?: number): Map<string, string[]>;
    clusterSimilarNodes(threshold?: number): { merged: number; deprecated: number };
  }
}

/** Label Propagation 默认最大迭代次数 */
const DEFAULT_LP_ITERATIONS = 10;
/** Jaccard 相似度默认阈值（超过此值认为节点相似） */
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

/**
 * 社区检测与聚类方法注入
 *
 * 通过 prototype 注入为 KnowledgeGraph 添加 detectCommunities / clusterSimilarNodes 方法。
 * 方法内部 this 指向 KnowledgeGraph 实例，可访问 public 字段（nodes / mergedNodeIds 等）
 * 和 public 方法（getNeighbors / tokenize / jaccardSimilarity 等）。
 *
 * @param target KnowledgeGraph 类构造函数
 */
export function applyCommunityMethods(target: typeof KnowledgeGraph): void {
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
  target.prototype.detectCommunities = function (this: KnowledgeGraph, maxIterations?: number): Map<string, string[]> {
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
  };

  // ===== Phase 36 Task 4：模式聚类 =====

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
  target.prototype.clusterSimilarNodes = function (
    this: KnowledgeGraph,
    threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  ): { merged: number; deprecated: number } {
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
  };
}

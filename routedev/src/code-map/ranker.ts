// src/code-map/ranker.ts
// PageRank 实现

export interface PageRankOptions {
  /** 阻尼系数，默认 0.85 */
  damping?: number;
  /** 最大迭代次数，默认 100 */
  maxIterations?: number;
  /** 收敛阈值，默认 1e-6 */
  epsilon?: number;
}

export interface RankedEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * 计算 PageRank 分数
 *
 * @param nodes 节点 ID 列表
 * @param edges 边列表（source → target）
 * @param options 配置选项
 * @returns Map<nodeId, score>
 */
export function computePageRank(
  nodes: string[],
  edges: RankedEdge[],
  options?: PageRankOptions,
): Map<string, number> {
  const damping = options?.damping ?? 0.85;
  const maxIterations = options?.maxIterations ?? 100;
  const epsilon = options?.epsilon ?? 1e-6;

  const n = nodes.length;
  if (n === 0) return new Map();

  // 初始化：每个节点分数 1/n
  let scores = new Map<string, number>();
  const nodeSet = new Set(nodes);
  for (const id of nodes) {
    scores.set(id, 1 / n);
  }

  // 构建出边映射：source → [{ target, weight }]
  const outEdges = new Map<string, Array<{ target: string; weight: number }>>();
  // 构建入边映射：target → [{ source, weight }]
  const inEdges = new Map<string, Array<{ source: string; weight: number }>>();
  for (const id of nodes) {
    outEdges.set(id, []);
    inEdges.set(id, []);
  }
  for (const edge of edges) {
    // 只处理两端都在 nodes 中的边
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    outEdges.get(edge.source)!.push({ target: edge.target, weight: edge.weight });
    inEdges.get(edge.target)!.push({ source: edge.source, weight: edge.weight });
  }

  // 计算每个节点的出边权重总和
  const outWeightSum = new Map<string, number>();
  for (const id of nodes) {
    const sum = outEdges.get(id)!.reduce((s, e) => s + e.weight, 0);
    outWeightSum.set(id, sum);
  }

  // 迭代计算
  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Map<string, number>();

    for (const id of nodes) {
      let rank = (1 - damping) / n;
      // 累加入边贡献
      const incoming = inEdges.get(id)!;
      for (const { source, weight } of incoming) {
        const sourceSum = outWeightSum.get(source) ?? 0;
        if (sourceSum > 0) {
          const sourceScore = scores.get(source) ?? 0;
          rank += damping * (sourceScore * weight / sourceSum);
        }
      }
      // 处理悬挂节点（无出边的节点）：将其分数均匀分配给所有节点
      // 简化版：悬挂节点的分数不传播（已在上方处理，因为 sourceSum=0 时不贡献）
      newScores.set(id, rank);
    }

    // 计算差异，判断是否收敛
    let diff = 0;
    for (const id of nodes) {
      diff += Math.abs((newScores.get(id) ?? 0) - (scores.get(id) ?? 0));
    }

    scores = newScores;

    if (diff < epsilon) break;
  }

  // 归一化（使总和为 1）
  const total = Array.from(scores.values()).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const [id, score] of scores) {
      scores.set(id, score / total);
    }
  }

  return scores;
}

/**
 * Personalized PageRank：种子节点优先的排名
 *
 * 与标准 PageRank 的区别：teleportation 向量只分配给种子节点（而非均匀分配），
 * 使得与种子相关的节点获得更高分数。aider 用此机制让 git diff 变更文件获得更高排名。
 *
 * @param nodes 节点 ID 列表
 * @param edges 边列表（source → target）
 * @param seedNodeIds 种子节点 ID 集合（git diff 文件 + query 关键词匹配的符号）
 * @param options 配置选项
 * @returns Map<nodeId, score>
 */
export function computePersonalizedPageRank(
  nodes: string[],
  edges: RankedEdge[],
  seedNodeIds: Set<string>,
  options?: PageRankOptions,
): Map<string, number> {
  const damping = options?.damping ?? 0.85;
  const maxIterations = options?.maxIterations ?? 100;
  const epsilon = options?.epsilon ?? 1e-6;

  const n = nodes.length;
  if (n === 0) return new Map();

  // 种子为空时，回退到均匀 teleportation（等价于标准 PR）
  const effectiveSeeds = seedNodeIds.size > 0 ? seedNodeIds : new Set(nodes);

  // teleportation 向量：种子节点均分 (1-d)，非种子为 0
  const seedBoost = (1 - damping) / effectiveSeeds.size;

  // 构建出边/入边映射（复用 computePageRank 的优化结构）
  const nodeSet = new Set(nodes);
  const outEdges = new Map<string, Array<{ target: string; weight: number }>>();
  const inEdges = new Map<string, Array<{ source: string; weight: number }>>();
  for (const id of nodes) {
    outEdges.set(id, []);
    inEdges.set(id, []);
  }
  for (const edge of edges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    outEdges.get(edge.source)!.push({ target: edge.target, weight: edge.weight });
    inEdges.get(edge.target)!.push({ source: edge.source, weight: edge.weight });
  }
  const outWeightSum = new Map<string, number>();
  for (const id of nodes) {
    outWeightSum.set(id, outEdges.get(id)!.reduce((s, e) => s + e.weight, 0));
  }

  // 初始化：种子节点 1/|seeds|，非种子 0
  let scores = new Map<string, number>();
  for (const id of nodes) {
    scores.set(id, effectiveSeeds.has(id) ? 1 / effectiveSeeds.size : 0);
  }

  // 迭代
  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Map<string, number>();
    for (const id of nodes) {
      let rank = effectiveSeeds.has(id) ? seedBoost : 0;
      const incoming = inEdges.get(id)!;
      for (const { source, weight } of incoming) {
        const sourceSum = outWeightSum.get(source) ?? 0;
        if (sourceSum > 0) {
          rank += damping * ((scores.get(source) ?? 0) * weight / sourceSum);
        }
      }
      newScores.set(id, rank);
    }
    let diff = 0;
    for (const id of nodes) {
      diff += Math.abs((newScores.get(id) ?? 0) - (scores.get(id) ?? 0));
    }
    scores = newScores;
    if (diff < epsilon) break;
  }

  // 归一化
  const total = Array.from(scores.values()).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const [id, score] of scores) {
      scores.set(id, score / total);
    }
  }
  return scores;
}

/**
 * 增量 PageRank：仅对受影响节点（变更文件的节点 + 其一阶邻居）重算分数
 *
 * 算法：
 *   1. 非受影响节点：保留旧分数（oldScores 中的值）作为常量
 *   2. 受影响节点：迭代重算，入边贡献来自全图（受影响节点用新分数，非受影响用旧分数）
 *   3. 不做全局归一化（避免改变非受影响节点的分数），仅保证受影响节点分数非负
 *
 * 调用方负责构造 affectedNodeIds（变更文件节点 + 一阶邻居），querier.explore 消费。
 *
 * @param nodes 全部节点 ID 列表
 * @param edges 全部边列表
 * @param affectedNodeIds 受影响节点集合（变更节点 + 一阶邻居）
 * @param oldScores 旧分数（来自数据库 rank_score）
 * @param options 配置选项
 * @returns Map<nodeId, score>：受影响节点为新分数，其余为旧分数
 */
export function incrementalPageRank(
  nodes: string[],
  edges: RankedEdge[],
  affectedNodeIds: Set<string>,
  oldScores: Map<string, number>,
  options?: PageRankOptions,
): Map<string, number> {
  const damping = options?.damping ?? 0.85;
  const maxIterations = options?.maxIterations ?? 100;
  const epsilon = options?.epsilon ?? 1e-6;

  const n = nodes.length;
  if (n === 0) return new Map();

  // 结果 Map：非受影响节点保留旧分数，受影响节点重算
  const result = new Map<string, number>();

  // 无变更时直接返回旧分数
  if (affectedNodeIds.size === 0) {
    for (const id of nodes) {
      result.set(id, oldScores.get(id) ?? 0);
    }
    return result;
  }

  // 初始化：所有节点先用旧分数填充
  for (const id of nodes) {
    result.set(id, oldScores.get(id) ?? 0);
  }

  const nodeSet = new Set(nodes);

  // 构建入边映射（全图，用于计算受影响节点的新分数）
  const inEdges = new Map<string, Array<{ source: string; weight: number }>>();
  for (const id of nodes) {
    inEdges.set(id, []);
  }
  for (const edge of edges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    inEdges.get(edge.target)!.push({ source: edge.source, weight: edge.weight });
  }

  // 出边权重和（用于归一化入边贡献）
  const outWeightSum = new Map<string, number>();
  const outEdges = new Map<string, Array<{ target: string; weight: number }>>();
  for (const id of nodes) {
    outEdges.set(id, []);
  }
  for (const edge of edges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    outEdges.get(edge.source)!.push({ target: edge.target, weight: edge.weight });
  }
  for (const id of nodes) {
    outWeightSum.set(id, outEdges.get(id)!.reduce((s, e) => s + e.weight, 0));
  }

  // 受影响节点列表
  const affectedNodes = nodes.filter(id => affectedNodeIds.has(id));

  // 受影响节点的当前分数（迭代中更新）
  let affectedScores = new Map<string, number>();
  for (const id of affectedNodes) {
    affectedScores.set(id, oldScores.get(id) ?? 1 / n);
  }

  // 迭代：只重算受影响节点
  // 非受影响节点的分数固定为旧值（作为常量参与入边贡献计算）
  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Map<string, number>();
    let diff = 0;

    for (const id of affectedNodes) {
      // 基础 teleportation（均匀分配，保持与全量 PageRank 一致）
      let rank = (1 - damping) / n;

      // 累加入边贡献（来自全图：受影响节点用新分数，非受影响用旧分数）
      const incoming = inEdges.get(id)!;
      for (const { source, weight } of incoming) {
        const sourceSum = outWeightSum.get(source) ?? 0;
        if (sourceSum > 0) {
          const sourceScore = affectedScores.has(source)
            ? (affectedScores.get(source) ?? 0)
            : (result.get(source) ?? 0);
          rank += damping * (sourceScore * weight / sourceSum);
        }
      }

      diff += Math.abs(rank - (affectedScores.get(id) ?? 0));
      newScores.set(id, rank);
    }

    affectedScores = newScores;
    if (diff < epsilon) break;
  }

  // 将重算后的分数写回结果（非受影响节点保持旧分数不变）
  for (const [id, score] of affectedScores) {
    result.set(id, score);
  }

  return result;
}

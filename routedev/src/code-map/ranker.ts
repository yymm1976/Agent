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

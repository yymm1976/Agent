// src/code-map/compression.ts
// RepoDistill 预算分配

/** 蒸馏节点输入 */
export interface DistillNode {
  id: string;
  rankScore: number;
  signature: string;
  source: string;
}

/** 蒸馏选项 */
export interface DistillOptions {
  /** 是否包含邻居节点 */
  includeNeighbors?: boolean;
  /** 最大深度 */
  maxDepth?: number;
}

/** 蒸馏结果 */
export interface DistillResult {
  selected: DistillNode[];
  truncated: number;
  estimatedTokens: number;
}

/** 估算字符串的 token 数（粗略：1 token ≈ 4 字符） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * RepoDistill 预算分配
 *
 * 按 rankScore 从高到低选择符号，超过预算时停止。
 *
 * @param nodes 候选节点列表
 * @param budgetTokens token 预算
 * @param options 选项
 */
export function distillContext(
  nodes: DistillNode[],
  budgetTokens: number,
  options?: DistillOptions,
): DistillResult {
  // 按 rankScore 从高到低排序
  const sorted = [...nodes].sort((a, b) => b.rankScore - a.rankScore);

  const selected: DistillNode[] = [];
  let usedTokens = 0;
  let truncated = 0;

  for (const node of sorted) {
    const nodeTokens = estimateTokens(node.signature + '\n' + node.source);
    if (usedTokens + nodeTokens > budgetTokens) {
      truncated = sorted.length - selected.length;
      break;
    }
    selected.push(node);
    usedTokens += nodeTokens;
  }

  return {
    selected,
    truncated,
    estimatedTokens: usedTokens,
  };
}

/**
 * 带邻居的蒸馏：选中节点后，也尝试包含其直接邻居
 */
export function distillWithNeighbors(
  nodes: DistillNode[],
  edges: Array<{ source: string; target: string }>,
  budgetTokens: number,
  options?: DistillOptions,
): DistillResult {
  const maxDepth = options?.maxDepth ?? 1;
  const sorted = [...nodes].sort((a, b) => b.rankScore - a.rankScore);

  const selected: DistillNode[] = [];
  const selectedIds = new Set<string>();
  let usedTokens = 0;
  let truncated = 0;

  // 构建邻接表
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!neighbors.has(edge.source)) neighbors.set(edge.source, new Set());
    if (!neighbors.has(edge.target)) neighbors.set(edge.target, new Set());
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  function tryAdd(node: DistillNode, depth: number): boolean {
    if (selectedIds.has(node.id)) return false;
    const nodeTokens = estimateTokens(node.signature + '\n' + node.source);
    if (usedTokens + nodeTokens > budgetTokens) {
      return false;
    }
    selected.push(node);
    selectedIds.add(node.id);
    usedTokens += nodeTokens;

    if (depth < maxDepth) {
      const ns = neighbors.get(node.id);
      if (ns) {
        for (const nid of ns) {
          const neighbor = nodeMap.get(nid);
          if (neighbor) {
            tryAdd(neighbor, depth + 1);
          }
        }
      }
    }
    return true;
  }

  for (const node of sorted) {
    if (usedTokens >= budgetTokens) {
      truncated = sorted.length - selected.length;
      break;
    }
    tryAdd(node, 0);
  }

  truncated = Math.max(0, sorted.length - selected.length);

  return {
    selected,
    truncated,
    estimatedTokens: usedTokens,
  };
}

// src/skills/compositional-router.ts
// 组合技能路由（Phase 52 Task 4）
//
// 来自 SKILLWEAVER 论文（arXiv 2606.18051, 阿里云）的 decompose-retrieve-compose 框架。
// 复杂任务不再只选一个 Skill，而是：
//   1. Decompose — 把复杂任务分解为原子子任务
//   2. Retrieve — 为每个子任务检索最匹配的 Skill
//   3. Compose — 按依赖关系组合为 DAG 执行计划
//
// 核心算法：
//   - SAD（迭代技能感知分解）：未匹配 Skill 的子任务重新分解（调整粒度），
//     最多迭代 maxDecompositionIterations 次
//   - 关键词匹配 + Jaccard 相似度（模拟语义检索，对 CJK 文本额外提取字符 bigram）
//   - 同类技能串行（control 边）、不同类技能并行；检测数据依赖（data 边）
//   - Kahn 拓扑排序分层并行组、DFS 三色标记检测环
//
// 设计约束：所有函数为纯函数（decomposeWithSkillAwareness 仅为 async 因为调用注入的 decomposeFn）。

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/**
 * 原子子任务
 *
 * 复杂任务分解后的最小执行单元，预期由一个 Skill 完成。
 */
export interface AtomicSubTask {
  /** 子任务唯一 ID（通常由分解器生成） */
  id: string;
  /** 子任务描述（自然语言） */
  description: string;
  /** 预期需要的 Skill 类别（如 code-review / refactor / test） */
  expectedSkillCategory: string;
}

/**
 * Skill 匹配结果
 *
 * retrieveSkill 的返回值——某个子任务与某个 Skill 的匹配情况。
 */
export interface SkillMatch {
  /** 对应的子任务 ID */
  subTaskId: string;
  /** 匹配到的 Skill ID */
  skillId: string;
  /** 匹配到的 Skill 名称 */
  skillName: string;
  /** 置信度，0-1 之间 */
  confidence: number;
  /** Skill 所属类别 */
  category: string;
}

/**
 * DAG 节点
 *
 * 一个节点 = 一个 Skill 在某个子任务上的执行。
 */
export interface SkillDAGNode {
  /** 节点 ID（通常等于 subTaskId） */
  id: string;
  /** 对应的子任务 */
  subTask: AtomicSubTask;
  /** 对应的 Skill 匹配结果 */
  skillMatch: SkillMatch;
  /** 执行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
}

/**
 * DAG 执行计划
 *
 * 由节点 + 边 + 并行组组成。
 */
export interface SkillDAGPlan {
  /** 所有节点 */
  nodes: SkillDAGNode[];
  /** 依赖边（from 必须先于 to 完成） */
  edges: Array<{ from: string; to: string; dependencyType: 'data' | 'control' }>;
  /** 按依赖关系分层的并行组（同一组内可并行执行） */
  parallelGroups: SkillDAGNode[][];
}

/**
 * 组合路由配置
 */
export interface CompositionalRoutingConfig {
  /** SAD 最大迭代次数（论文默认 2） */
  maxDecompositionIterations: number;
  /** 是否启用语义检索（true 时用 Jaccard 相似度模拟） */
  semanticRetrieval: boolean;
  /** DAG 并行度上限 */
  maxParallelSkills: number;
}

/**
 * 默认配置（与 Phase-52 蓝图 4.4 节一致）
 */
export const DEFAULT_ROUTING_CONFIG: CompositionalRoutingConfig = {
  maxDecompositionIterations: 2,
  semanticRetrieval: true,
  maxParallelSkills: 2,
};

// ============================================================
// 内部常量
// ============================================================

/**
 * 中英文停用词表（关键词提取时过滤）
 */
const STOP_WORDS = new Set<string>([
  // 中文常见停用词
  '的', '了', '是', '在', '和', '与', '或', '以及', '或者', '并', '并且',
  '把', '被', '让', '使', '对', '对于', '关于', '根据', '基于', '通过',
  '用', '使用', '利用', '需要', '要求', '应该', '必须', '可以', '能够',
  '会', '将', '这', '那', '这个', '那个', '这些', '那些', '其', '其中',
  '一', '一个', '一些', '下', '上', '中', '后', '前', '之前', '之后', '之',
  '然后', '接着', '再', '又', '也', '都', '即', '则', '若', '如果', '否则',
  '因为', '所以', '由于', '因此', '为', '为了', '给', '向', '从', '到', '至',
  '做', '进行', '执行', '完成', '实现', '生成', '产生', '得到', '获得',
  '每个', '所有', '全部', '整个', '整体', '部分',
  // 英文常见停用词
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must', 'shall',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'us', 'our', 'you', 'your', 'he', 'she', 'him', 'her', 'his',
  'i', 'me', 'my', 'what', 'which', 'who', 'whom', 'how', 'why', 'where',
  'after', 'before', 'during', 'between', 'into', 'out', 'up', 'down', 'over',
  'use', 'using', 'used', 'need', 'needed',
]);

/**
 * 数据依赖提示词
 *
 * 后继子任务描述中出现这些词时，认为它依赖前驱子任务的输出。
 */
const DATA_DEPENDENCY_HINTS = [
  '基于', '根据', '依据', '之后', '然后', '接着', '结果', '输出', '产物',
  '基于上述', '基于上面', '基于此', '基于该', '在此基础上',
  'after', 'based on', 'according to', 'output of', 'result of',
];

// ============================================================
// 内部辅助：关键词提取与相似度
// ============================================================

/**
 * 判断字符是否为汉字
 */
function isHan(ch: string): boolean {
  return /\p{Script=Han}/u.test(ch);
}

/**
 * 从文本中提取关键词
 *
 * 策略：
 *   1. 按非字母数字字符（含中英文标点）切分
 *   2. 全部转小写
 *   3. 对包含中文的 token，额外提取单字与字符 bigram（CJK 文本相似度常用做法）
 *   4. 过滤停用词与空串
 *   5. 去重
 *
 * 纯函数。
 */
function extractKeywords(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const rawTokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);

  const seen = new Set<string>();
  const result: string[] = [];
  const add = (t: string): void => {
    if (!t || STOP_WORDS.has(t) || seen.has(t)) return;
    seen.add(t);
    result.push(t);
  };

  for (const token of rawTokens) {
    add(token);
    // 对包含中文的 token 额外提取单字与 bigram，提升 CJK 匹配召回
    if (isHan(token)) {
      const hanChars = [...token].filter((c) => isHan(c));
      for (const c of hanChars) add(c);
      for (let i = 0; i + 1 < hanChars.length; i++) {
        add(hanChars[i] + hanChars[i + 1]);
      }
    }
  }
  return result;
}

/**
 * 计算两个集合的 Jaccard 相似度
 *
 * Jaccard = |A ∩ B| / |A ∪ B|，范围 [0, 1]。
 * 两个空集返回 0。纯函数。
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ============================================================
// 核心算法 1：SAD 迭代技能感知分解
// ============================================================

/**
 * 迭代技能感知分解（SAD, Skill-Aware Decomposition）
 *
 * 来自 SKILLWEAVER 的核心创新：不一次性分解，而是多轮迭代：
 *   1. 第 1 轮：调用 decomposeFn 分解任务
 *   2. 为每个子任务检索 Skill
 *   3. 检查未匹配到 Skill 的子任务
 *   4. 第 2+ 轮：对未匹配的子任务重新分解（调整粒度——更细）
 *   5. 迭代直到全部匹配或达到 maxDecompositionIterations
 *
 * 新分解出的子任务 ID 加上父任务 ID 前缀，避免冲突。
 *
 * @param task 复杂任务描述
 * @param availableSkills 可用 Skill 列表
 * @param config 路由配置
 * @param decomposeFn 任务分解器（由调用方注入，通常是 LLM 调用）
 * @returns 分解后的原子子任务列表（包含已匹配与未匹配的）
 */
export async function decomposeWithSkillAwareness(
  task: string,
  availableSkills: Array<{ id: string; name: string; description: string; category: string }>,
  config: CompositionalRoutingConfig,
  decomposeFn: (task: string) => Promise<AtomicSubTask[]>,
): Promise<AtomicSubTask[]> {
  const maxIter = Math.max(1, config.maxDecompositionIterations);

  // 第 1 轮：初步分解
  let currentSubTasks = await decomposeFn(task);
  if (currentSubTasks.length === 0) return [];

  // 后续迭代：对未匹配子任务重新分解
  for (let iter = 1; iter < maxIter; iter++) {
    const matchedIds = new Set<string>();
    for (const sub of currentSubTasks) {
      const match = retrieveSkill(sub, availableSkills);
      if (match !== null && match.confidence > 0) {
        matchedIds.add(sub.id);
      }
    }

    // 全部已匹配 → 终止迭代
    if (matchedIds.size === currentSubTasks.length) break;

    // 对未匹配的子任务重新分解（更细粒度）
    const nextSubTasks: AtomicSubTask[] = [];
    for (const sub of currentSubTasks) {
      if (matchedIds.has(sub.id)) {
        // 已匹配 → 保留
        nextSubTasks.push(sub);
      } else {
        // 未匹配 → 重新分解
        try {
          const finer = await decomposeFn(sub.description);
          if (finer.length > 0) {
            // 加父 ID 前缀避免冲突
            for (let k = 0; k < finer.length; k++) {
              const f = finer[k];
              const newId = f.id ? `${sub.id}.${f.id}` : `${sub.id}.${k}`;
              nextSubTasks.push({ ...f, id: newId });
            }
          } else {
            // 分解器返回空 → 保留原子任务
            nextSubTasks.push(sub);
          }
        } catch (err) {
          // 分解失败 → 保留原子任务
          logger.warn('compositional-router: 分解失败，保留原子任务', { error: err instanceof Error ? err.message : String(err) });
          nextSubTasks.push(sub);
        }
      }
    }
    currentSubTasks = nextSubTasks;
  }

  return currentSubTasks;
}

// ============================================================
// 核心算法 2：Skill 检索
// ============================================================

/**
 * 为子任务检索最匹配的 Skill
 *
 * 评分策略：
 *   1. 提取子任务 description 的关键词（含 expectedSkillCategory）
 *   2. 对每个 Skill，提取 name + description + category 的关键词集合
 *   3. 计算关键词匹配率（子任务关键词在 Skill 关键词中的占比）
 *   4. 同时计算 Jaccard 相似度作为语义相似度估计（即 semanticRetrieval 的模拟实现）
 *   5. 类别完全匹配额外加分
 *   6. 最终 confidence = 0.6 * 关键词匹配率 + 0.4 * Jaccard + 类别加分（上限 1）
 *
 * 当所有 Skill 的 confidence 都为 0 时返回 null。
 * 纯函数。
 *
 * @param subTask 子任务
 * @param availableSkills 可用 Skill 列表
 * @returns 最佳匹配，或 null（无匹配）
 */
export function retrieveSkill(
  subTask: AtomicSubTask,
  availableSkills: Array<{ id: string; name: string; description: string; category: string }>,
): SkillMatch | null {
  if (!subTask || !subTask.description || availableSkills.length === 0) return null;

  const subKeywords = extractKeywords(subTask.description);
  // 把 expectedSkillCategory 也作为关键词，提升同类匹配
  if (subTask.expectedSkillCategory) {
    const cat = subTask.expectedSkillCategory.toLowerCase();
    if (!STOP_WORDS.has(cat)) {
      subKeywords.push(cat);
    }
  }
  const subKeywordSet = new Set(subKeywords);

  if (subKeywords.length === 0) return null;

  let best: SkillMatch | null = null;
  let bestScore = 0;

  for (const skill of availableSkills) {
    const skillKeywords = extractKeywords(
      `${skill.name} ${skill.description} ${skill.category}`,
    );
    const skillKeywordSet = new Set(skillKeywords);

    // 关键词匹配率：子任务关键词在 Skill 关键词中的占比
    let matched = 0;
    for (const kw of subKeywords) {
      if (skillKeywordSet.has(kw)) matched++;
    }
    const keywordMatchRate = subKeywords.length === 0 ? 0 : matched / subKeywords.length;

    // Jaccard 相似度（语义检索的近似）
    const jaccard = jaccardSimilarity(subKeywordSet, skillKeywordSet);

    // 类别直接匹配额外加分
    let categoryBonus = 0;
    if (
      subTask.expectedSkillCategory &&
      skill.category &&
      subTask.expectedSkillCategory.toLowerCase() === skill.category.toLowerCase()
    ) {
      categoryBonus = 0.2;
    }

    const confidence = Math.min(
      1,
      0.6 * keywordMatchRate + 0.4 * jaccard + categoryBonus,
    );

    if (confidence > bestScore) {
      bestScore = confidence;
      best = {
        subTaskId: subTask.id,
        skillId: skill.id,
        skillName: skill.name,
        confidence,
        category: skill.category,
      };
    }
  }

  // confidence 为 0 视为无匹配
  if (best === null || bestScore <= 0) return null;
  return best;
}

// ============================================================
// 核心算法 3：组合为 DAG
// ============================================================

/**
 * 把 Skill 匹配结果组合为 DAG 执行计划
 *
 * 依赖构建规则：
 *   1. 同类 Skill 的子任务 → 串行（按输入顺序加 control 边）
 *   2. 不同类 Skill 的子任务 → 默认并行（无边）
 *   3. 数据依赖检测：若后继子任务描述中包含数据依赖提示词
 *      （如"基于""根据""之后"），则对所有先序节点加 data 边
 *
 * 由于所有边都从数组中靠前的节点指向靠后的节点，本函数构造的 DAG 必然无环。
 * parallelGroups 字段由 topologicalSort 计算。
 *
 * 纯函数。
 *
 * @param matches Skill 匹配结果列表（顺序与子任务顺序一致）
 * @param subTasks 子任务列表（用于查询原始描述）
 * @returns DAG 执行计划
 */
export function composeDAG(
  matches: SkillMatch[],
  subTasks: AtomicSubTask[],
): SkillDAGPlan {
  const subTaskMap = new Map<string, AtomicSubTask>();
  for (const s of subTasks) subTaskMap.set(s.id, s);

  // 构造节点（按 matches 顺序）
  const nodes: SkillDAGNode[] = matches.map((m) => {
    const sub = subTaskMap.get(m.subTaskId);
    return {
      id: m.subTaskId,
      subTask: sub ?? {
        id: m.subTaskId,
        description: m.skillName,
        expectedSkillCategory: m.category,
      },
      skillMatch: m,
      status: 'pending' as const,
    };
  });

  const edges: Array<{ from: string; to: string; dependencyType: 'data' | 'control' }> = [];

  // 规则 1：同类串行（control 边）—— 按类别分组，组内按出现顺序链接
  const byCategory = new Map<string, SkillDAGNode[]>();
  for (const n of nodes) {
    const arr = byCategory.get(n.skillMatch.category) ?? [];
    arr.push(n);
    byCategory.set(n.skillMatch.category, arr);
  }
  for (const [, arr] of byCategory) {
    for (let i = 0; i + 1 < arr.length; i++) {
      edges.push({
        from: arr[i].id,
        to: arr[i + 1].id,
        dependencyType: 'control',
      });
    }
  }

  // 规则 3：数据依赖（data 边）—— 后继任务描述含提示词时，连接到所有先序节点
  for (let i = 0; i < nodes.length; i++) {
    const later = nodes[i];
    const desc = later.subTask.description.toLowerCase();
    const hasHint = DATA_DEPENDENCY_HINTS.some((h) => desc.includes(h.toLowerCase()));
    if (!hasHint) continue;
    for (let j = 0; j < i; j++) {
      const earlier = nodes[j];
      // 避免与已有的 control 边重复
      const exists = edges.some(
        (e) => e.from === earlier.id && e.to === later.id,
      );
      if (!exists) {
        edges.push({
          from: earlier.id,
          to: later.id,
          dependencyType: 'data',
        });
      }
    }
  }

  // 计算并行组
  const parallelGroups = topologicalSort({ nodes, edges, parallelGroups: [] });

  return { nodes, edges, parallelGroups };
}

// ============================================================
// 核心算法 4：拓扑排序（Kahn 算法分层）
// ============================================================

/**
 * 拓扑排序——用 Kahn 算法分层
 *
 * 同一层内的节点互不依赖，可以并行执行。
 * 若图中存在环，剩余节点会作为最后一层（容错）；hasCycle 可单独检测。
 *
 * 输入 plan 的 parallelGroups 字段会被忽略，由本函数重新计算。
 * 纯函数。
 *
 * @param plan DAG 执行计划
 * @returns 分层后的节点组
 */
export function topologicalSort(plan: SkillDAGPlan): SkillDAGNode[][] {
  const nodes = plan.nodes;
  if (nodes.length === 0) return [];

  const nodeMap = new Map<string, SkillDAGNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // 入度表
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n.id, 0);
  for (const e of plan.edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // 邻接表
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of plan.edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
    adj.get(e.from)?.push(e.to);
  }

  // Kahn 算法：每轮取入度为 0 的节点作为一层
  const groups: SkillDAGNode[][] = [];
  const visited = new Set<string>();

  while (visited.size < nodes.length) {
    const layer: SkillDAGNode[] = [];
    for (const n of nodes) {
      if (visited.has(n.id)) continue;
      if ((inDegree.get(n.id) ?? 0) === 0) {
        layer.push(n);
      }
    }
    if (layer.length === 0) {
      // 剩余节点都有入边 → 存在环，把剩余节点作为最后一层（容错）
      for (const n of nodes) {
        if (!visited.has(n.id)) layer.push(n);
      }
      groups.push(layer);
      break;
    }
    groups.push(layer);
    for (const n of layer) {
      visited.add(n.id);
      for (const next of adj.get(n.id) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      }
    }
  }

  return groups;
}

// ============================================================
// 核心算法 5：环检测（DFS 三色标记）
// ============================================================

/**
 * 检测 DAG 中是否存在环
 *
 * 用 DFS 三色标记法：
 *   - white：未访问
 *   - gray：当前 DFS 路径上（正在访问）
 *   - black：已完成访问
 * 若 DFS 过程中遇到 gray 节点，则存在回边 → 环。
 *
 * 纯函数。
 *
 * @param plan DAG 执行计划
 * @returns true 表示存在环
 */
export function hasCycle(plan: SkillDAGPlan): boolean {
  const nodes = plan.nodes;
  if (nodes.length === 0) return false;

  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const n of nodes) color.set(n.id, 'white');

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of plan.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)?.push(e.to);
  }

  const dfs = (nodeId: string): boolean => {
    const c = color.get(nodeId);
    if (c === 'gray') return true;  // 回边 → 环
    if (c === 'black') return false;
    color.set(nodeId, 'gray');
    for (const next of adj.get(nodeId) ?? []) {
      if (dfs(next)) return true;
    }
    color.set(nodeId, 'black');
    return false;
  };

  for (const n of nodes) {
    if (color.get(n.id) === 'white') {
      if (dfs(n.id)) return true;
    }
  }
  return false;
}

// ============================================================
// 辅助：格式化 DAG 为可读文本
// ============================================================

/**
 * 把 DAG 执行计划格式化为可读文本
 *
 * 输出示例：
 *   DAG 执行计划（共 4 个节点，3 条边）：
 *   [第 1 层 / 可并行]
 *     - sub-1 → 审查代码 (skill: code-reviewer, 置信度 85%)
 *     - sub-2 → 生成测试 (skill: test-generator, 置信度 72%)
 *   [第 2 层 / 可并行]
 *     - sub-3 → 重构代码 (skill: refactor, 置信度 91%)
 *
 * 纯函数。
 */
export function formatDAGPlan(plan: SkillDAGPlan): string {
  const nodeCount = plan.nodes.length;
  const edgeCount = plan.edges.length;
  const lines: string[] = [];
  lines.push(`DAG 执行计划（共 ${nodeCount} 个节点，${edgeCount} 条边）：`);

  const groups =
    plan.parallelGroups.length > 0 ? plan.parallelGroups : topologicalSort(plan);

  if (groups.length === 0) {
    lines.push('  （空计划）');
    return lines.join('\n');
  }

  groups.forEach((group, idx) => {
    lines.push(`[第 ${idx + 1} 层 / 可并行]`);
    for (const node of group) {
      const conf = (node.skillMatch.confidence * 100).toFixed(0);
      lines.push(
        `  - ${node.id} → ${node.subTask.description} (skill: ${node.skillMatch.skillName}, 置信度 ${conf}%)`,
      );
    }
  });

  if (hasCycle(plan)) {
    lines.push('⚠ 警告：DAG 中存在环，无法完整拓扑排序');
  }

  return lines.join('\n');
}

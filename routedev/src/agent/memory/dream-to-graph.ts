// src/agent/memory/dream-to-graph.ts
// Phase 36 Task 4c：Dream → KnowledgeGraph 信息流（含归纳层）
//
// 来自《7 步设计 Agent 记忆系统》——没有归纳层的记忆系统是"垃圾山"而非"知识库"。
// 真实案例：Agent 用语义搜索找到 5 条高度相关的"渲染崩溃修复"记录，
// 但它们来自不同 bug 的不同修复方案，Agent 混合输出了错误的合成答案。
// 如果归纳层把已修复的 4 条标记为 superseded，只保留最新一条，这个错误不会发生。
//
// ingestToGraph() 函数的完整流程：
//   1. 提取：从 DreamResult.consolidated 中提取关键 facts/decisions（规则提取）
//   2. 归纳三步：
//      a. 合并同类：检查 KnowledgeGraph 中是否已有相似节点 → 合并 + validatedCount++
//      b. 冲突检测：新旧知识矛盾 → 保留新的、标记旧的为 superseded
//      c. 时效淘汰：超过 30 天未引用的节点降级为归档
//   3. 注入：经过归纳后的知识写入 KnowledgeGraph
//
// 设计决策（陷阱 #52）：
//   DreamConsolidator 与 KnowledgeGraph 是两个独立的记忆系统，
//   通过显式调用 ingestToGraph() 桥接。禁止在 DreamConsolidator 内部硬编码 KG 依赖。

import type { KnowledgeGraph, GraphNode, NodeType } from './graph.js';
import type { DreamResult } from '../dream-consolidator.js';
import type { CheckpointData, DesignDecision, ErrorAndFix } from './types.js';
import { logger } from '../../utils/logger.js';

/** ingestToGraph 结果统计 */
export interface IngestResult {
  /** 新创建的节点数 */
  created: number;
  /** 合并到已有节点的数量 */
  merged: number;
  /** 冲突检测中标记为 superseded 的节点数 */
  superseded: number;
  /** 时效淘汰归档的节点数 */
  archived: number;
}

/** Jaccard 相似度阈值（用于合并同类检测） */
const MERGE_SIMILARITY_THRESHOLD = 0.6;

/**
 * 将 Dream 结果注入 KnowledgeGraph（含归纳三步）
 *
 * @param dreamResult Dream 整理结果
 * @param graph 目标知识图谱
 * @returns 注入统计
 */
export function ingestToGraph(dreamResult: DreamResult, graph: KnowledgeGraph): IngestResult {
  const result: IngestResult = {
    created: 0,
    merged: 0,
    superseded: 0,
    archived: 0,
  };

  const checkpoint = dreamResult.consolidated;
  if (!checkpoint) {
    logger.debug('ingestToGraph: no consolidated checkpoint, skipping');
    return result;
  }

  // ===== 步骤 1：提取 =====
  const extracted = extractKnowledge(checkpoint);
  logger.debug('ingestToGraph: extracted knowledge', { count: extracted.length });

  // ===== 步骤 2：归纳三步 =====
  // 2a. 合并同类 + 2b. 冲突检测
  for (const item of extracted) {
    const existing = findSimilarNode(graph, item.type, item.content);

    if (existing) {
      // 2a. 合并同类：已有相似节点 → 合并
      if (isConflicting(existing.content, item.content)) {
        // 2b. 冲突检测：新旧知识矛盾 → 保留新的、标记旧的为 superseded
        const newNode = createNode(item);
        graph.addNode(newNode);
        graph.supersedeNode(existing.id, newNode.id);
        result.superseded++;
        result.created++;
        logger.debug('ingestToGraph: conflict detected, superseded old node', {
          oldId: existing.id,
          newId: newNode.id,
        });
      } else {
        // 合并到已有节点
        existing.content = `${existing.content}\n[补充] ${item.content}`;
        existing.validatedCount++;
        existing.updatedAt = Date.now();
        existing.distinctSources = (existing.distinctSources ?? 1) + 1;
        result.merged++;
      }
    } else {
      // 无相似节点 → 创建新节点
      const newNode = createNode(item);
      graph.addNode(newNode);
      result.created++;
    }
  }

  // 2c. 时效淘汰：超过 30 天未引用的节点降级为归档
  result.archived = graph.archiveStaleNodes();

  logger.info('ingestToGraph: completed', result);
  return result;
}

// ===== 内部辅助函数 =====

/** 提取的知识条目 */
interface ExtractedKnowledge {
  type: NodeType;
  content: string;
  source: string;
}

/**
 * 从 CheckpointData 中提取值得长期保存的知识（规则提取）
 *
 * 提取规则：
 *   - designDecisions → decision 类型节点
 *   - crossTaskDiscoveries → fact 类型节点
 *   - errorsAndFixes（已修复的）→ fact 类型节点
 */
function extractKnowledge(checkpoint: CheckpointData): ExtractedKnowledge[] {
  const items: ExtractedKnowledge[] = [];

  // 设计决策 → decision 节点
  for (const decision of checkpoint.designDecisions ?? []) {
    const content = formatDecision(decision);
    items.push({ type: 'decision', content, source: 'dream:designDecisions' });
  }

  // 跨任务发现 → fact 节点
  for (const discovery of checkpoint.crossTaskDiscoveries ?? []) {
    items.push({ type: 'fact', content: discovery, source: 'dream:crossTaskDiscoveries' });
  }

  // 已修复的错误 → fact 节点（作为教训保留）
  for (const errorFix of checkpoint.errorsAndFixes ?? []) {
    if (errorFix.resolved) {
      const content = `错误: ${errorFix.error}\n修复: ${errorFix.fix}`;
      items.push({ type: 'fact', content, source: 'dream:errorsAndFixes' });
    }
  }

  return items;
}

/** 格式化设计决策为节点内容 */
function formatDecision(decision: DesignDecision): string {
  return `决策: ${decision.decision}\n理由: ${decision.reason}`;
}

/**
 * 在图谱中查找相似节点
 * 使用简单的关键词匹配（非 Jaccard，避免引入 graph 的私有方法）
 */
function findSimilarNode(
  graph: KnowledgeGraph,
  type: NodeType,
  content: string,
): GraphNode | undefined {
  const nodes = graph.listNodes({ type, deprecated: false });
  const contentWords = new Set(
    content.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(s => s.length > 2),
  );

  let bestMatch: GraphNode | undefined;
  let bestScore = 0;

  for (const node of nodes) {
    const nodeWords = new Set(
      node.content.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(s => s.length > 2),
    );
    // 计算 Jaccard 相似度
    let intersection = 0;
    for (const word of contentWords) {
      if (nodeWords.has(word)) intersection++;
    }
    const union = contentWords.size + nodeWords.size - intersection;
    const similarity = union === 0 ? 0 : intersection / union;

    if (similarity > bestScore && similarity >= MERGE_SIMILARITY_THRESHOLD) {
      bestScore = similarity;
      bestMatch = node;
    }
  }

  return bestMatch;
}

/**
 * 冲突检测：判断新旧知识是否矛盾
 *
 * 简单规则：如果新旧内容都包含"参数"/"使用"/"改为"等关键词，
 * 且关键标识符不同，则认为冲突。
 *
 * 这是一个保守的检测——宁可漏检（不标记冲突）也不要误检（错误标记 superseded）。
 */
function isConflicting(oldContent: string, newContent: string): boolean {
  // 提取关键标识符（参数名、函数名等）
  const extractIdentifiers = (text: string): string[] => {
    const matches = text.matchAll(/["'`]([A-Za-z_][\w./-]{2,})["'`]/g);
    return Array.from(matches).map(m => m[1]);
  };

  const oldIds = new Set(extractIdentifiers(oldContent));
  const newIds = new Set(extractIdentifiers(newContent));

  // 如果两者都有标识符，且标识符完全不同，则认为冲突
  if (oldIds.size > 0 && newIds.size > 0) {
    let commonCount = 0;
    for (const id of newIds) {
      if (oldIds.has(id)) commonCount++;
    }
    // 没有共同标识符 → 冲突
    if (commonCount === 0) return true;
  }

  return false;
}

/** 创建新节点 */
function createNode(item: ExtractedKnowledge): GraphNode {
  const now = Date.now();
  return {
    id: `${item.type}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    type: item.type,
    content: item.content,
    validatedCount: 1,
    createdAt: now,
    updatedAt: now,
    deprecated: false,
    distinctSources: 1,
  };
}

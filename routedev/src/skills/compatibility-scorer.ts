// src/skills/compatibility-scorer.ts
// 兼容性评分器
//
// 论文：arXiv:2606.18051 级联瓶颈结构（执行质量环节）
// 在 composeDAG 构造边前，对每对 (前驱, 后继) 计算兼容性分数
// 三因子：I/O 类型 / 类别 Jaccard / 关键词共现

import type { SkillDAGNode } from './compositional-router.js';

export type { SkillDAGNode };

export interface CompatibilityScorerConfig {
  enabled: boolean;
  pruneThreshold: number;
  weights: {
    ioType: number;
    categoryJaccard: number;
    keywordCoOccur: number;
  };
}

export interface ScoredEdge {
  from: string;
  to: string;
  dependencyType: 'data' | 'control';
  weight: number;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length > 1),
  );
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function ioTypeScore(pred: SkillDAGNode, succ: SkillDAGNode): number {
  const predCat = pred.skillMatch.category.toLowerCase();
  const succCat = succ.skillMatch.category.toLowerCase();
  if (predCat === succCat) return 1.0;
  const predWords = extractWords(pred.subTask.description + ' ' + predCat);
  const succWords = extractWords(succ.subTask.description + ' ' + succCat);
  let overlap = 0;
  for (const w of predWords) if (succWords.has(w)) overlap++;
  if (predWords.size === 0) return 0;
  const ratio = overlap / predWords.size;
  if (ratio >= 0.5) return 1.0;
  if (ratio > 0) return 0.5;
  return 0;
}

export class CompatibilityScorer {
  constructor(private readonly config: CompatibilityScorerConfig) {}

  score(predecessor: SkillDAGNode, successor: SkillDAGNode): number {
    const { ioType, categoryJaccard, keywordCoOccur } = this.config.weights;

    const ioScore = ioTypeScore(predecessor, successor);

    const predCatWords = extractWords(predecessor.skillMatch.category);
    const succCatWords = extractWords(successor.skillMatch.category);
    const catJac = jaccardSets(predCatWords, succCatWords);

    const predKw = extractWords(predecessor.subTask.description);
    const succKw = extractWords(successor.subTask.description);
    const kwScore = jaccardSets(predKw, succKw);

    return Math.min(1, ioType * ioScore + categoryJaccard * catJac + keywordCoOccur * kwScore);
  }

  filterEdges(
    candidates: Array<{
      from: SkillDAGNode;
      to: SkillDAGNode;
      dependencyType: 'data' | 'control';
    }>,
  ): ScoredEdge[] {
    if (!this.config.enabled) {
      return candidates.map((c) => ({
        from: c.from.id,
        to: c.to.id,
        dependencyType: c.dependencyType,
        weight: 1,
      }));
    }

    const result: ScoredEdge[] = [];
    for (const c of candidates) {
      const s = this.score(c.from, c.to);
      const threshold = c.dependencyType === 'data'
        ? Math.min(this.config.pruneThreshold, 0.05)
        : this.config.pruneThreshold;
      if (s >= threshold) {
        result.push({
          from: c.from.id,
          to: c.to.id,
          dependencyType: c.dependencyType,
          weight: s,
        });
      }
    }
    return result;
  }
}

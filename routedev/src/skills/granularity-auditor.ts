// src/skills/granularity-auditor.ts
// 分解粒度审计器
//
// 论文：arXiv:2606.18051 SAD 增益完全来自粒度修正
// 14B 模型倾向过度分解（4.72 步 vs ground truth 2.94），SAD 修正到 3.18 步
// DA（Decompose Accuracy）= 步骤级类别召回

import type { AtomicSubTask } from './compositional-router.js';

export type { AtomicSubTask };

export interface GranularityAuditConfig {
  enabled: boolean;
  stepCountHeuristic?: (query: string) => { min: number; max: number };
}

export type GranularityIssueType =
  | 'over_decomposed'
  | 'under_decomposed'
  | 'inconsistent_granularity'
  | 'missing_category';

export interface GranularityIssue {
  severity: 'critical' | 'warning' | 'info';
  type: GranularityIssueType;
  description: string;
  suggestedStepCount?: number;
}

export interface DAResult {
  da: number;
  stepCount: number;
  overDecomposed: boolean;
}

function defaultStepCountHeuristic(query: string): { min: number; max: number } {
  const tokens = query.trim().split(/\s+/).length;
  if (tokens < 20) return { min: 1, max: 2 };
  if (tokens < 60) return { min: 2, max: 4 };
  if (tokens < 120) return { min: 3, max: 6 };
  return { min: 4, max: 8 };
}

function extractQueryCategories(query: string): string[] {
  const CATEGORY_KEYWORDS: Record<string, string> = {
    '测试': 'test',
    'test': 'test',
    '审查': 'review',
    'review': 'review',
    '重构': 'refactor',
    'refactor': 'refactor',
    '文档': 'doc',
    'doc': 'doc',
    '修复': 'fix',
    'fix': 'fix',
    '部署': 'deploy',
    'deploy': 'deploy',
    '分析': 'analyze',
    'analyze': 'analyze',
  };
  const lower = query.toLowerCase();
  const found = new Set<string>();
  for (const [kw, cat] of Object.entries(CATEGORY_KEYWORDS)) {
    if (lower.includes(kw)) found.add(cat);
  }
  return Array.from(found);
}

export class DecompositionGranularityAuditor {
  private readonly heuristic: (query: string) => { min: number; max: number };

  constructor(private readonly config: GranularityAuditConfig) {
    this.heuristic = config.stepCountHeuristic ?? defaultStepCountHeuristic;
  }

  audit(params: { query: string; subTasks: AtomicSubTask[] }): GranularityIssue[] {
    if (!this.config.enabled) return [];

    const issues: GranularityIssue[] = [];
    const { query, subTasks } = params;
    const n = subTasks.length;
    const { min, max } = this.heuristic(query);

    if (n > max) {
      issues.push({
        severity: n > max * 1.5 ? 'critical' : 'warning',
        type: 'over_decomposed',
        description: `步数 ${n} 超出预期区间 [${min}, ${max}]，可能过度分解`,
        suggestedStepCount: Math.round((min + max) / 2),
      });
    } else if (n < min) {
      issues.push({
        severity: 'warning',
        type: 'under_decomposed',
        description: `步数 ${n} 低于预期区间 [${min}, ${max}]，可能欠分解`,
        suggestedStepCount: min,
      });
    }

    if (n >= 2) {
      const lengths = subTasks.map((s) => s.description.length);
      const mean = lengths.reduce((a, b) => a + b, 0) / n;
      const variance = lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      if (cv > 0.8) {
        issues.push({
          severity: 'info',
          type: 'inconsistent_granularity',
          description: `子任务描述长度方差过大（CV=${cv.toFixed(2)}），粒度不一致`,
        });
      }
    }

    const queryCats = extractQueryCategories(query);
    if (queryCats.length > 0) {
      const subCats = new Set(subTasks.map((s) => s.expectedSkillCategory.toLowerCase()));
      for (const cat of queryCats) {
        if (!subCats.has(cat)) {
          issues.push({
            severity: 'warning',
            type: 'missing_category',
            description: `查询明确要求类别 "${cat}" 但未在子任务中出现`,
          });
        }
      }
    }

    return issues;
  }

  computeDA(predicted: AtomicSubTask[], groundTruthCategories: string[]): DAResult {
    if (groundTruthCategories.length === 0) {
      return { da: 0, stepCount: predicted.length, overDecomposed: false };
    }
    const predCats = new Set(predicted.map((s) => s.expectedSkillCategory.toLowerCase()));
    const gtSet = new Set(groundTruthCategories.map((c) => c.toLowerCase()));
    let intersect = 0;
    for (const c of predCats) {
      if (gtSet.has(c)) intersect++;
    }
    const da = intersect / gtSet.size;
    const overDecomposed = predicted.length > groundTruthCategories.length * 1.5;
    return { da, stepCount: predicted.length, overDecomposed };
  }
}

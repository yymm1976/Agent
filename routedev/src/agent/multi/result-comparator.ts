// src/agent/multi/result-comparator.ts
// Phase 69 Task 3: 结果比较器与优胜合并

import { estimateTokens } from '../../utils/token-estimate.js';
import { logger } from '../../utils/logger.js';
import type { ParallelOutcome } from './types.js';

export interface ComparisonResult {
  winnerId: string;
  reason: string;
  scores: Array<{ workerId: string; score: number; summary: string }>;
  needsHumanReview: boolean;
}

export interface ResultComparatorConfig {
  autoSelect: boolean;
  weights: {
    brevity: number;
    errorCount: number;
    testPassRate: number;
  };
}

export const DEFAULT_COMPARATOR_CONFIG: ResultComparatorConfig = {
  autoSelect: false,
  weights: { brevity: 0.3, errorCount: 0.4, testPassRate: 0.3 },
};

export class ResultComparator {
  constructor(private config: ResultComparatorConfig) {}

  compare(outcomes: ParallelOutcome[]): ComparisonResult {
    const successful = outcomes.filter((o) => o.success);
    if (successful.length === 0) {
      return {
        winnerId: '',
        reason: 'all workers failed',
        scores: [],
        needsHumanReview: true,
      };
    }
    if (successful.length === 1) {
      const only = successful[0];
      return {
        winnerId: only.workerId,
        reason: 'only successful worker',
        scores: [{ workerId: only.workerId, score: 1, summary: 'only success' }],
        needsHumanReview: false,
      };
    }

    const scores = successful.map((o) => {
      const score = this.scoreResult(o.result ?? '');
      return { workerId: o.workerId, score, summary: this.buildSummary(o.result ?? '') };
    });

    scores.sort((a, b) => b.score - a.score);
    const winner = scores[0];

    return {
      winnerId: winner.workerId,
      reason: `highest score (${winner.score.toFixed(3)})`,
      scores,
      needsHumanReview: !this.config.autoSelect,
    };
  }

  async mergeWinner(winnerId: string, winnerPath: string, mainPath: string): Promise<void> {
    logger.info('ResultComparator: merging winner', { winnerId, from: winnerPath, to: mainPath });
  }

  private scoreResult(result: string): number {
    const tokens = estimateTokens(result);
    const brevityScore = 1 - Math.min(1, tokens / 5000);
    return brevityScore;
  }

  private buildSummary(result: string): string {
    const lines = result.split('\n').length;
    const tokens = estimateTokens(result);
    return `${lines} lines, ~${tokens} tokens`;
  }
}
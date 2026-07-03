export interface BudgetRenderConfig {
  enabled: boolean;
  contextWindow: number;
  softNotifyThreshold: number;
  triggerThreshold: number;
  forceThreshold: number;
  renderEveryTurn: boolean;
}

// P1 修复：复用 cache-optimizer.ts 的统一阈值常量
import { DEFAULT_COMPACTION_THRESHOLDS } from '../router/cache-optimizer.js';

const DEFAULT_CONFIG: BudgetRenderConfig = {
  enabled: true,
  contextWindow: 200000,
  softNotifyThreshold: DEFAULT_COMPACTION_THRESHOLDS.softThreshold,
  triggerThreshold: DEFAULT_COMPACTION_THRESHOLDS.triggerThreshold,
  forceThreshold: DEFAULT_COMPACTION_THRESHOLDS.forceThreshold,
  renderEveryTurn: true,
};

export type BudgetLevel = 'safe' | 'soft-notify' | 'trigger' | 'force';

export interface BudgetSnapshot {
  used: number;
  total: number;
  remaining: number;
  ratio: number;
  level: BudgetLevel;
}

export class BudgetAwareRenderer {
  constructor(
    private readonly config: BudgetRenderConfig = DEFAULT_CONFIG,
    private readonly estimateTokensFn: (text: string) => number = defaultEstimateTokens,
  ) {}

  computeBudget(totalUsedTokens: number): BudgetSnapshot {
    const total = this.config.contextWindow;
    const remaining = Math.max(0, total - totalUsedTokens);
    const ratio = totalUsedTokens / total;

    let level: BudgetLevel;
    if (ratio < this.config.softNotifyThreshold) {
      level = 'safe';
    } else if (ratio < this.config.triggerThreshold) {
      level = 'soft-notify';
    } else if (ratio < this.config.forceThreshold) {
      level = 'trigger';
    } else {
      level = 'force';
    }

    return { used: totalUsedTokens, total, remaining, ratio, level };
  }

  renderMarker(snapshot: BudgetSnapshot): string {
    const pct = (snapshot.ratio * 100).toFixed(0);
    return `[BUDGET: used=${snapshot.used}/${snapshot.total} remaining=${snapshot.remaining} (${pct}%) level=${snapshot.level}]`;
  }

  renderAdvice(snapshot: BudgetSnapshot): string {
    switch (snapshot.level) {
      case 'safe':
        return '';
      case 'soft-notify':
        return '当前预算充足，但建议关注。可考虑用 prune_chunks 移除 obsolete chunk 释放空间。';
      case 'trigger':
        return '预算触发压缩阈值。建议立即调用 prune_chunks 移除低价值 chunk，避免 L5 摘要损失信息。';
      case 'force':
        return '预算强制压缩阈值。必须立即 prune，否则下一步将触发 L5 LLM 摘要（有损压缩）。';
    }
  }

  renderBudgetPrompt(totalUsedTokens: number): {
    prompt: string;
    snapshot: BudgetSnapshot;
  } {
    const snapshot = this.computeBudget(totalUsedTokens);
    const marker = this.renderMarker(snapshot);
    const advice = this.renderAdvice(snapshot);

    const parts = [marker];
    if (advice) parts.push(advice);
    return { prompt: parts.join('\n'), snapshot };
  }
}

function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

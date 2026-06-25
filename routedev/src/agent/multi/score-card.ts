// src/agent/multi/score-card.ts
// 审计层：记录每个步骤的执行质量指标，支撑 /quality 命令
//
// 解决问题：当前多 Agent 编排没有审计层，无法回答「这次执行花了多少 token？
// 测试通过率多少？用户采纳率多少？」等问题。
//
// ScoreCard 记录：
//   - tokenUsage：input/output/total
//   - durationMs：耗时
//   - toolCalls / fileEdits / testsRun / testsPassed
//   - lintErrors / typeErrors
//   - userFeedback：accepted/rejected/edited/pending
//
// ScoreCardCollector 聚合统计：
//   - totalSteps / totalTokens / totalDuration
//   - avgTestsPassed / acceptedRate
//   - formatReport()：格式化为 /quality 命令的展示文本

/** 用户反馈类型 */
export type UserFeedback = 'accepted' | 'rejected' | 'edited' | 'pending';

/** 单步骤的执行质量评分卡 */
export interface ScoreCard {
  stepId: string;
  role: string;
  modelId: string;
  tokenUsage: { input: number; output: number; total: number };
  durationMs: number;
  toolCalls: number;
  fileEdits: number;
  testsRun: number;
  testsPassed: number;
  lintErrors: number;
  typeErrors: number;
  userFeedback: UserFeedback;
}

/** 聚合统计结果 */
export interface AggregateStats {
  totalSteps: number;
  totalTokens: number;
  totalDuration: number;
  avgTestsPassed: number;
  acceptedRate: number;
}

export class ScoreCardCollector {
  private cards: Map<string, ScoreCard> = new Map();

  /** 记录一个步骤的评分卡（同 stepId 会覆盖） */
  record(card: ScoreCard): void {
    this.cards.set(card.stepId, card);
  }

  /** 获取指定步骤的评分卡 */
  getCard(stepId: string): ScoreCard | undefined {
    return this.cards.get(stepId);
  }

  /** 获取所有评分卡 */
  getAllCards(): ScoreCard[] {
    return Array.from(this.cards.values());
  }

  /** 聚合统计 */
  getAggregateStats(): AggregateStats {
    const cards = this.getAllCards();
    const totalSteps = cards.length;

    if (totalSteps === 0) {
      return {
        totalSteps: 0,
        totalTokens: 0,
        totalDuration: 0,
        avgTestsPassed: 0,
        acceptedRate: 0,
      };
    }

    let totalTokens = 0;
    let totalDuration = 0;
    let totalTestsPassed = 0;
    let acceptedCount = 0;

    for (const card of cards) {
      totalTokens += card.tokenUsage.total;
      totalDuration += card.durationMs;
      totalTestsPassed += card.testsPassed;
      if (card.userFeedback === 'accepted') {
        acceptedCount++;
      }
    }

    return {
      totalSteps,
      totalTokens,
      totalDuration,
      avgTestsPassed: totalTestsPassed / totalSteps,
      acceptedRate: acceptedCount / totalSteps,
    };
  }

  /**
   * 格式化为 /quality 命令的展示文本
   * 输出包含：聚合统计 + 每个步骤的明细
   */
  formatReport(): string {
    const stats = this.getAggregateStats();
    const cards = this.getAllCards();

    if (cards.length === 0) {
      return '📊 质量报告\n（暂无执行记录）';
    }

    const lines: string[] = [];
    lines.push('📊 质量报告');
    lines.push('');
    lines.push('── 聚合统计 ──');
    lines.push(`  总步骤数: ${stats.totalSteps}`);
    lines.push(`  总 Token 消耗: ${stats.totalTokens.toLocaleString()}`);
    lines.push(`  总耗时: ${(stats.totalDuration / 1000).toFixed(1)}s`);
    lines.push(`  平均测试通过数: ${stats.avgTestsPassed.toFixed(1)}`);
    lines.push(`  用户采纳率: ${(stats.acceptedRate * 100).toFixed(0)}%`);
    lines.push('');

    lines.push('── 步骤明细 ──');
    for (const card of cards) {
      const feedbackIcon = this.feedbackIcon(card.userFeedback);
      const duration = card.durationMs > 0 ? `${(card.durationMs / 1000).toFixed(1)}s` : '-';
      lines.push(`  [${card.stepId}] ${feedbackIcon} ${card.role} (${card.modelId})`);
      lines.push(`    Token: ${card.tokenUsage.total.toLocaleString()} (in: ${card.tokenUsage.input}, out: ${card.tokenUsage.output})`);
      lines.push(`    耗时: ${duration} | 工具调用: ${card.toolCalls} | 文件编辑: ${card.fileEdits}`);
      if (card.testsRun > 0) {
        const passRate = card.testsRun > 0 ? ((card.testsPassed / card.testsRun) * 100).toFixed(0) : '0';
        lines.push(`    测试: ${card.testsPassed}/${card.testsRun} 通过 (${passRate}%)`);
      }
      if (card.lintErrors > 0 || card.typeErrors > 0) {
        lines.push(`    Lint 错误: ${card.lintErrors} | 类型错误: ${card.typeErrors}`);
      }
    }

    return lines.join('\n');
  }

  /** 清空所有评分卡 */
  clear(): void {
    this.cards.clear();
  }

  /** 获取评分卡数量 */
  get size(): number {
    return this.cards.size;
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  private feedbackIcon(feedback: UserFeedback): string {
    switch (feedback) {
      case 'accepted': return '✅';
      case 'rejected': return '❌';
      case 'edited': return '✏️';
      case 'pending': return '⏳';
      default: return '⏳';
    }
  }
}

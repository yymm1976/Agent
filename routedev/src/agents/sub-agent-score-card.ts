// src/agents/sub-agent-score-card.ts
// 子 Agent Score Card：记录每个子 Agent 的执行质量指标，支撑反滥用与质量报告
//
// 解决问题：子 Agent 派发后缺少质量审计层，无法回答「这次派发了多少子 Agent？
// 总共消耗多少 token？平均交付质量？父 Agent 采纳率？」等问题。
//
// 与 src/agent/multi/score-card.ts 的区别：
//   - score-card.ts 面向「步骤级」编排（StepId）
//   - 本模块面向「子 Agent 级」委托（agentId + taskId + profileId）
//   - 增加 redundantReads / challengeCount / contractViolations / deliverableQuality

/** 父 Agent 满意度 */
type ParentSatisfaction = 'accepted' | 'rejected' | 'edited' | 'pending';

/** 单个子 Agent 的评分卡 */
export interface SubAgentScoreCard {
  taskId: string;
  agentId: string;
  role: string;
  profileId: string;
  modelId: string;
  tokenUsage: { input: number; output: number; total: number };
  contextTokens: number;
  redundantReads: number;
  challengeCount: number;
  contractViolations: number;
  deliverableQuality: number; // 0-100
  parentSatisfaction: ParentSatisfaction;
  durationMs: number;
}

/** 聚合统计结果 */
interface SubAgentAggregateStats {
  totalAgents: number;
  totalTokens: number;
  avgContextTokens: number;
  avgRedundantReads: number;
  avgChallengeCount: number;
  totalContractViolations: number;
  avgDeliverableQuality: number;
  acceptedRate: number;
}

/** 频繁 challenge 阈值（用于反滥用建议） */
const ANTI_ABUSE_CHALLENGE_THRESHOLD = 3;
/** 高 token 阈值（用于反滥用建议） */
const ANTI_ABUSE_TOKEN_THRESHOLD = 10000;
/** 高冗余读取阈值（用于反滥用建议） */
const ANTI_ABUSE_READ_THRESHOLD = 3;

/**
 * 子 Agent Score Card 收集器
 */
export class SubAgentScoreCardCollector {
  private cards: Map<string, SubAgentScoreCard> = new Map();

  /** 记录评分卡（同 agentId 覆盖） */
  record(card: SubAgentScoreCard): void {
    this.cards.set(card.agentId, card);
  }

  /** 获取指定子 Agent 的评分卡 */
  getCard(agentId: string): SubAgentScoreCard | undefined {
    return this.cards.get(agentId);
  }

  /** 获取所有评分卡 */
  getAllCards(): SubAgentScoreCard[] {
    return Array.from(this.cards.values());
  }

  /** 按 taskId 过滤 */
  getByTask(taskId: string): SubAgentScoreCard[] {
    return this.getAllCards().filter(c => c.taskId === taskId);
  }

  /** 聚合统计 */
  getAggregateStats(): SubAgentAggregateStats {
    const cards = this.getAllCards();
    const totalAgents = cards.length;

    if (totalAgents === 0) {
      return {
        totalAgents: 0,
        totalTokens: 0,
        avgContextTokens: 0,
        avgRedundantReads: 0,
        avgChallengeCount: 0,
        totalContractViolations: 0,
        avgDeliverableQuality: 0,
        acceptedRate: 0,
      };
    }

    let totalTokens = 0;
    let totalContextTokens = 0;
    let totalRedundantReads = 0;
    let totalChallengeCount = 0;
    let totalContractViolations = 0;
    let totalDeliverableQuality = 0;
    let acceptedCount = 0;

    for (const card of cards) {
      totalTokens += card.tokenUsage.total;
      totalContextTokens += card.contextTokens;
      totalRedundantReads += card.redundantReads;
      totalChallengeCount += card.challengeCount;
      totalContractViolations += card.contractViolations;
      totalDeliverableQuality += card.deliverableQuality;
      if (card.parentSatisfaction === 'accepted') {
        acceptedCount++;
      }
    }

    return {
      totalAgents,
      totalTokens,
      avgContextTokens: totalContextTokens / totalAgents,
      avgRedundantReads: totalRedundantReads / totalAgents,
      avgChallengeCount: totalChallengeCount / totalAgents,
      totalContractViolations,
      avgDeliverableQuality: totalDeliverableQuality / totalAgents,
      acceptedRate: acceptedCount / totalAgents,
    };
  }

  /** 格式化质量报告 */
  formatReport(): string {
    const stats = this.getAggregateStats();
    const cards = this.getAllCards();

    if (cards.length === 0) {
      return '📊 子 Agent 质量报告\n（暂无派发记录）';
    }

    const lines: string[] = [];
    lines.push('📊 子 Agent 质量报告');
    lines.push('');
    lines.push('── 聚合统计 ──');
    lines.push(`  子 Agent 总数: ${stats.totalAgents}`);
    lines.push(`  总 Token 消耗: ${stats.totalTokens.toLocaleString()}`);
    lines.push(`  平均上下文 Token: ${stats.avgContextTokens.toFixed(0)}`);
    lines.push(`  平均冗余读取: ${stats.avgRedundantReads.toFixed(1)}`);
    lines.push(`  平均 challenge 次数: ${stats.avgChallengeCount.toFixed(1)}`);
    lines.push(`  契约违反总数: ${stats.totalContractViolations}`);
    lines.push(`  平均交付质量: ${stats.avgDeliverableQuality.toFixed(1)}/100`);
    lines.push(`  父 Agent 采纳率: ${(stats.acceptedRate * 100).toFixed(0)}%`);
    lines.push('');

    lines.push('── 子 Agent 明细 ──');
    for (const card of cards) {
      const icon = this.satisfactionIcon(card.parentSatisfaction);
      const duration = card.durationMs > 0 ? `${(card.durationMs / 1000).toFixed(1)}s` : '-';
      lines.push(`  [${card.agentId}] ${icon} ${card.role} (${card.modelId}) task=${card.taskId}`);
      lines.push(`    Token: ${card.tokenUsage.total.toLocaleString()} (in: ${card.tokenUsage.input}, out: ${card.tokenUsage.output})`);
      lines.push(`    耗时: ${duration} | 上下文: ${card.contextTokens} | 冗余读取: ${card.redundantReads}`);
      lines.push(`    challenge: ${card.challengeCount} | 契约违反: ${card.contractViolations} | 交付质量: ${card.deliverableQuality}/100`);
    }

    return lines.join('\n');
  }

  /** 反滥用建议：基于评分卡指标生成 */
  getAntiAbuseSuggestions(): string[] {
    const suggestions: string[] = [];
    const cards = this.getAllCards();

    for (const card of cards) {
      if (card.challengeCount >= ANTI_ABUSE_CHALLENGE_THRESHOLD) {
        suggestions.push(
          `子 Agent ${card.agentId} 被 challenge ${card.challengeCount} 次，建议检查契约清晰度或终止该 Agent`,
        );
      }
      if (card.tokenUsage.total >= ANTI_ABUSE_TOKEN_THRESHOLD && card.parentSatisfaction !== 'accepted') {
        suggestions.push(
          `子 Agent ${card.agentId} 消耗 ${card.tokenUsage.total} tokens 仍未被采纳，建议审查任务范围或中止`,
        );
      }
      if (card.redundantReads >= ANTI_ABUSE_READ_THRESHOLD) {
        suggestions.push(
          `子 Agent ${card.agentId} 重复读取 ${card.redundantReads} 次，建议注入共享上下文包避免重复 IO`,
        );
      }
      if (card.contractViolations >= 1) {
        suggestions.push(
          `子 Agent ${card.agentId} 违反契约 ${card.contractViolations} 次，建议收紧 Policy Engine 约束`,
        );
      }
    }

    return suggestions;
  }

  /** 清空所有评分卡 */
  clear(): void {
    this.cards.clear();
  }

  /** 获取评分卡数量 */
  get size(): number {
    return this.cards.size;
  }

  private satisfactionIcon(s: ParentSatisfaction): string {
    switch (s) {
      case 'accepted': return '✅';
      case 'rejected': return '❌';
      case 'edited': return '✏️';
      case 'pending': return '⏳';
      default: return '⏳';
    }
  }
}

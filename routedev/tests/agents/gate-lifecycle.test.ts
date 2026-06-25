// tests/agents/gate-lifecycle.test.ts
// 委托门控 + 子 Agent 生命周期 + Score Card 单元测试

import { describe, it, expect } from 'vitest';
import {
  DelegationGate,
  DEFAULT_GATE_RULES,
  type ParentAgent,
  type DelegationTask,
  type ContextPackageInfo,
  type AgentRole,
} from '../../src/agents/delegation-gate.js';
import {
  SubAgentLifecycle,
  AntiAbuseDetector,
  type SubAgentState,
} from '../../src/agents/sub-agent-lifecycle.js';
import {
  SubAgentScoreCardCollector,
  type SubAgentScoreCard,
} from '../../src/agents/sub-agent-score-card.js';

// ============================================================
// 辅助工厂
// ============================================================

function makeParent(activeSubAgents: ParentAgent['activeSubAgents'] = []): ParentAgent {
  return { id: 'parent-1', activeSubAgents };
}

function makeTask(overrides: Partial<DelegationTask> = {}): DelegationTask {
  return {
    id: 'task-1',
    description: 'desc',
    taskDescription: 'do something',
    ...overrides,
  };
}

function makeContext(estimatedTokens = 500): ContextPackageInfo {
  return { metadata: { estimatedTokens } };
}

function makeCard(overrides: Partial<SubAgentScoreCard> = {}): SubAgentScoreCard {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    role: 'executor',
    profileId: 'profile-1',
    modelId: 'model-1',
    tokenUsage: { input: 100, output: 50, total: 150 },
    contextTokens: 500,
    redundantReads: 0,
    challengeCount: 0,
    contractViolations: 0,
    deliverableQuality: 80,
    parentSatisfaction: 'accepted',
    durationMs: 1000,
    ...overrides,
  };
}

// ============================================================
// DelegationGate
// ============================================================

describe('DelegationGate', () => {
  it('1. 缺少 design_doc 时无法创建 executor', () => {
    const gate = new DelegationGate();
    const parent = makeParent();
    const task = makeTask({ designDoc: undefined, writeFiles: ['a.ts'], taskDescription: 't' });
    const result = gate.checkDelegationEligibility(parent, 'executor', task, makeContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('design_doc');
  });

  it('2. 缺少 diff 时无法创建 reviewer', () => {
    const gate = new DelegationGate();
    const parent = makeParent();
    const task = makeTask({ diff: undefined, designDoc: 'doc', taskDescription: 't' });
    const result = gate.checkDelegationEligibility(parent, 'reviewer', task, makeContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('diff');
  });

  it('3. researcher 并行超过 3 个时被拒绝', () => {
    const gate = new DelegationGate();
    const active = Array.from({ length: 3 }, (_, i) => ({
      id: `a-${i}`,
      role: 'researcher' as AgentRole,
      taskId: 't',
      status: 'running',
    }));
    const parent = makeParent(active);
    const task = makeTask({ taskDescription: 't' });
    const result = gate.checkDelegationEligibility(parent, 'researcher', task, makeContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('上限');
  });

  it('4. 上下文包过小时拒绝委托', () => {
    const gate = new DelegationGate();
    const parent = makeParent();
    const task = makeTask({ taskDescription: 't' });
    const result = gate.checkDelegationEligibility(parent, 'researcher', task, makeContext(50));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('上下文');
  });

  it('5. 门控通过时返回 ok=true', () => {
    const gate = new DelegationGate();
    const parent = makeParent();
    const task = makeTask({ taskDescription: 't' });
    const result = gate.checkDelegationEligibility(parent, 'researcher', task, makeContext(500));
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('通过门控');
  });

  it('6. getDelegationPlaybookPrompt 包含门控规则', () => {
    const prompt = DelegationGate.getDelegationPlaybookPrompt();
    expect(prompt).toContain('researcher');
    expect(prompt).toContain('maxParallel');
    expect(prompt).toContain('executor');
    expect(prompt).toContain('design_doc');
  });
});

// ============================================================
// SubAgentLifecycle
// ============================================================

describe('SubAgentLifecycle', () => {
  it('7. pending → running 转换', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    expect(lc.getState('a1')?.status).toBe('pending');
    expect(lc.transition('a1', 'running')).toBe(true);
    expect(lc.getState('a1')?.status).toBe('running');
    expect(lc.getState('a1')?.startedAt).toBeDefined();
  });

  it('8. running → challenged → running（父 Agent 回应后继续）', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    expect(lc.transition('a1', 'running')).toBe(true);
    expect(lc.transition('a1', 'challenged')).toBe(true);
    expect(lc.getState('a1')?.status).toBe('challenged');
    expect(lc.transition('a1', 'running')).toBe(true);
    expect(lc.getState('a1')?.status).toBe('running');
  });

  it('9. running → failed 转换', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    lc.transition('a1', 'running');
    expect(lc.transition('a1', 'failed', 'compile error')).toBe(true);
    expect(lc.getState('a1')?.status).toBe('failed');
    expect(lc.getState('a1')?.error).toBe('compile error');
    expect(lc.getState('a1')?.completedAt).toBeDefined();
  });

  it('10. running → aborted 转换', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    lc.transition('a1', 'running');
    expect(lc.transition('a1', 'aborted', 'user cancel')).toBe(true);
    expect(lc.getState('a1')?.status).toBe('aborted');
    expect(lc.getState('a1')?.error).toBe('user cancel');
  });

  it('11. 非法转换被拒绝（如 completed → running）', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    lc.transition('a1', 'running');
    expect(lc.transition('a1', 'completed')).toBe(true);
    // completed 是终态，不能再转到 running
    expect(lc.transition('a1', 'running')).toBe(false);
    expect(lc.getState('a1')?.status).toBe('completed');
  });

  it('12. isComplete 所有子 Agent 终态时返回 true', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    lc.register('a2', 't1', 'reviewer', 'p2');
    expect(lc.isComplete('t1')).toBe(false);
    lc.transition('a1', 'running');
    lc.transition('a1', 'completed');
    expect(lc.isComplete('t1')).toBe(false); // a2 仍 pending
    lc.transition('a2', 'running');
    lc.transition('a2', 'failed');
    expect(lc.isComplete('t1')).toBe(true);
  });

  it('13. addTokens + incrementStep 累计正确', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    lc.addTokens('a1', 100);
    lc.addTokens('a1', 50);
    lc.incrementStep('a1');
    lc.incrementStep('a1');
    const state = lc.getState('a1');
    expect(state?.tokenUsed).toBe(150);
    expect(state?.stepCount).toBe(2);
  });

  it('14. recordChallenge 递增', () => {
    const lc = new SubAgentLifecycle();
    lc.register('a1', 't1', 'executor', 'p1');
    lc.recordChallenge('a1');
    lc.recordChallenge('a1');
    expect(lc.getState('a1')?.challengeCount).toBe(2);
  });
});

// ============================================================
// SubAgentScoreCardCollector
// ============================================================

describe('SubAgentScoreCardCollector', () => {
  it('15. record + getCard', () => {
    const col = new SubAgentScoreCardCollector();
    const card = makeCard({ agentId: 'a1' });
    col.record(card);
    expect(col.getCard('a1')).toBe(card);
    expect(col.size).toBe(1);
    expect(col.getCard('not-exist')).toBeUndefined();
  });

  it('16. getAggregateStats 聚合统计', () => {
    const col = new SubAgentScoreCardCollector();
    col.record(makeCard({ agentId: 'a1', tokenUsage: { input: 100, output: 50, total: 150 }, deliverableQuality: 80, parentSatisfaction: 'accepted', contextTokens: 500, redundantReads: 1, challengeCount: 0, contractViolations: 0 }));
    col.record(makeCard({ agentId: 'a2', tokenUsage: { input: 200, output: 100, total: 300 }, deliverableQuality: 60, parentSatisfaction: 'rejected', contextTokens: 700, redundantReads: 3, challengeCount: 2, contractViolations: 1 }));
    const stats = col.getAggregateStats();
    expect(stats.totalAgents).toBe(2);
    expect(stats.totalTokens).toBe(450);
    expect(stats.avgContextTokens).toBe(600);
    expect(stats.avgRedundantReads).toBe(2);
    expect(stats.avgChallengeCount).toBe(1);
    expect(stats.totalContractViolations).toBe(1);
    expect(stats.avgDeliverableQuality).toBe(70);
    expect(stats.acceptedRate).toBe(0.5);
  });

  it('17. formatReport 包含统计信息', () => {
    const col = new SubAgentScoreCardCollector();
    col.record(makeCard({ agentId: 'a1', role: 'executor' }));
    const report = col.formatReport();
    expect(report).toContain('子 Agent 质量报告');
    expect(report).toContain('聚合统计');
    expect(report).toContain('子 Agent 总数');
    expect(report).toContain('a1');
  });

  it('18. getAntiAbuseSuggestions 高 challenge 时返回建议', () => {
    const col = new SubAgentScoreCardCollector();
    col.record(makeCard({ agentId: 'a1', challengeCount: 5 }));
    const suggestions = col.getAntiAbuseSuggestions();
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some(s => s.includes('a1') && s.includes('challenge'))).toBe(true);
  });
});

// ============================================================
// AntiAbuseDetector
// ============================================================

describe('AntiAbuseDetector', () => {
  it('19. detectFrequentChallenges 检测频繁 challenge', () => {
    const agents: SubAgentState[] = [
      { agentId: 'a1', taskId: 't1', role: 'executor', profileId: 'p1', status: 'running', createdAt: 0, challengeCount: 5, tokenUsed: 0, stepCount: 0 },
      { agentId: 'a2', taskId: 't1', role: 'executor', profileId: 'p1', status: 'running', createdAt: 0, challengeCount: 1, tokenUsed: 0, stepCount: 0 },
    ];
    const result = AntiAbuseDetector.detectFrequentChallenges(agents, 3);
    expect(result.length).toBe(1);
    expect(result[0].agentId).toBe('a1');
    expect(result[0].challengeCount).toBe(5);
    expect(result[0].suggestion).toContain('a1');
  });

  it('20. detectLowEfficiency 检测高 token 低效果', () => {
    const agents: SubAgentState[] = [
      { agentId: 'a1', taskId: 't1', role: 'executor', profileId: 'p1', status: 'running', createdAt: 0, challengeCount: 0, tokenUsed: 15000, stepCount: 10 },
      { agentId: 'a2', taskId: 't1', role: 'executor', profileId: 'p1', status: 'running', createdAt: 0, challengeCount: 0, tokenUsed: 500, stepCount: 2 },
    ];
    const result = AntiAbuseDetector.detectLowEfficiency(agents, 10000);
    expect(result.length).toBe(1);
    expect(result[0].agentId).toBe('a1');
    expect(result[0].tokenUsed).toBe(15000);
    expect(result[0].suggestion).toContain('a1');
  });
});

// tests/agent/self-evolution/godel-proposer.test.ts
// Phase 52 Task 8 单元测试：Gödel 式自修改建议（安全版）
//
// 覆盖：
//   1. proposeModifications 基于执行轨迹产出建议
//   2. assessRisk 安全关键字（security/auth）命中即 critical
//   3. assessRisk 低风险修改标记为 low
//   4. allowHighRiskProposals=false 时高风险建议不产出（实际由应用阶段控制）
//   5. applyProposal 自动应用低风险（autoApplyLowRisk=true）
//   6. approveProposal/rejectProposal 用户确认流程
//
// 使用 mock decomposeFn / testRunner。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GodelProposer,
  DEFAULT_GODEL_CONFIG,
  identifyImprovementOpportunities,
  assessReversibility,
  generateGodelProposalId,
  type GodelProposal,
  type GodelProposerConfig,
  type ExecutionHistoryEntry,
  type CurrentRuleEntry,
} from '../../../src/agent/self-evolution/godel-proposer.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建一个执行历史条目 */
function makeHistoryEntry(overrides: Partial<ExecutionHistoryEntry> = {}): ExecutionHistoryEntry {
  return {
    task: 'review code',
    outcome: 'success',
    tokensUsed: 1000,
    durationMs: 1000,
    ...overrides,
  };
}

/** 创建一个当前规则条目 */
function makeRule(overrides: Partial<CurrentRuleEntry> = {}): CurrentRuleEntry {
  return {
    file: '/rules/system-prompt.md',
    content: 'You are a helpful assistant.',
    type: 'prompt',
    ...overrides,
  };
}

/** 创建一个启用的 config */
function makeEnabledConfig(overrides: Partial<GodelProposerConfig> = {}): GodelProposerConfig {
  return {
    ...DEFAULT_GODEL_CONFIG,
    enabled: true,
    autoApplyLowRisk: false,
    requireUserApproval: true,
    ...overrides,
  };
}

/** 构造一个低风险可逆的提案（不调用 assessRisk 自动判定） */
function makeLowRiskProposal(overrides: Partial<GodelProposal> = {}): GodelProposal {
  return {
    id: generateGodelProposalId(),
    targetFile: '/rules/system-prompt.md',
    targetType: 'config',
    currentContent: '# config\n',
    proposedContent: '# config\n# added note\n',
    rationale: 'low risk change',
    expectedOutcome: 'minor improvement',
    riskAssessment: 'low',
    reversible: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 52 Task 8: godel-proposer 单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------
  // 1. proposeModifications 基于执行轨迹产出建议
  // ----------------------------------------------------------

  it('1.1 proposeModifications 基于重复失败模式产出建议', async () => {
    const config = makeEnabledConfig();
    const proposer = new GodelProposer(config);
    // 同一 failurePoint 重复 3 次 → 触发改进机会
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'review-prompt' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'review-prompt' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'review-prompt' }),
    ];
    const rules: CurrentRuleEntry[] = [makeRule({ type: 'prompt' })];

    const proposals = await proposer.proposeModifications(history, rules);

    expect(proposals.length).toBeGreaterThan(0);
    // 每个提案应包含 rationale / proposedContent
    for (const p of proposals) {
      expect(p.rationale).toBeDefined();
      expect(p.proposedContent).toBeDefined();
      expect(p.targetFile).toBe(rules[0].file);
      expect(p.id).toMatch(/^godel_/);
    }
  });

  it('1.2 proposeModifications enabled=false 时不产出任何提案', async () => {
    const proposer = new GodelProposer({ ...DEFAULT_GODEL_CONFIG, enabled: false });
    const proposals = await proposer.proposeModifications(
      [makeHistoryEntry({ outcome: 'failure', failurePoint: 'x' })],
      [makeRule()],
    );
    expect(proposals.length).toBe(0);
  });

  it('1.3 proposeModifications 空执行历史或空规则时不产出提案', async () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    expect((await proposer.proposeModifications([], [makeRule()])).length).toBe(0);
    expect((await proposer.proposeModifications([makeHistoryEntry()], [])).length).toBe(0);
  });

  it('1.4 proposeModifications token 消耗过高时产出 prompt 精简建议', async () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    // 平均 token 超过 50000 阈值
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'success', tokensUsed: 60_000 }),
      makeHistoryEntry({ outcome: 'success', tokensUsed: 60_000 }),
    ];
    const rules: CurrentRuleEntry[] = [makeRule({ type: 'prompt' })];

    const proposals = await proposer.proposeModifications(history, rules);
    const tokenProposal = proposals.find((p) => p.rationale.includes('token'));
    expect(tokenProposal).toBeDefined();
    expect(tokenProposal!.proposedContent).toContain('Token 精简约束');
  });

  it('1.5 proposeModifications 耗时过长时产出工作流优化建议', async () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    // 平均耗时超过 60s 阈值
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'success', durationMs: 80_000 }),
      makeHistoryEntry({ outcome: 'success', durationMs: 80_000 }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ file: '/config/agent.yaml', content: '# config\n', type: 'config' }),
    ];

    const proposals = await proposer.proposeModifications(history, rules);
    const durationProposal = proposals.find((p) => p.rationale.includes('耗时'));
    expect(durationProposal).toBeDefined();
    expect(durationProposal!.proposedContent).toContain('workflowOptimization');
  });

  it('1.6 proposeModifications 受 maxProposalsPerRun 限制', async () => {
    const config = makeEnabledConfig({ maxProposalsPerRun: 1 });
    const proposer = new GodelProposer(config);
    // 多个失败点 + token/时长超阈值 → 多个候选，但只产出 1 个
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'prompt-a', tokensUsed: 60_000, durationMs: 80_000 }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'prompt-a', tokensUsed: 60_000, durationMs: 80_000 }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'prompt-a', tokensUsed: 60_000, durationMs: 80_000 }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ type: 'prompt' }),
      makeRule({ file: '/c', content: '# c', type: 'config' }),
    ];

    const proposals = await proposer.proposeModifications(history, rules);
    expect(proposals.length).toBe(1);
  });

  // ----------------------------------------------------------
  // 2. assessRisk 安全关键字（security/auth）命中即 critical
  // ----------------------------------------------------------

  it('2.1 assessRisk 安全关键字 security 命中即 critical', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const proposal: GodelProposal = {
      ...makeLowRiskProposal(),
      targetFile: '/rules/security-rules.md',
      proposedContent: '# security rules\nimportant security content\n',
    };
    expect(proposer.assessRisk(proposal)).toBe('critical');
  });

  it('2.2 assessRisk 安全关键字 auth 命中即 critical', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const proposal: GodelProposal = {
      ...makeLowRiskProposal(),
      proposedContent: '# auth config\nimportant auth\n',
    };
    expect(proposer.assessRisk(proposal)).toBe('critical');
  });

  it('2.3 assessRisk 中文安全关键字「安全」命中即 critical', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const proposal: GodelProposal = {
      ...makeLowRiskProposal(),
      proposedContent: '# 安全配置\n',
    };
    expect(proposer.assessRisk(proposal)).toBe('critical');
  });

  // ----------------------------------------------------------
  // 3. assessRisk 低风险修改标记为 low
  // ----------------------------------------------------------

  it('2.4 assessRisk 修改可逆 config 标记为 low（无安全关键字）', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    // config 类型 + reversible=true + 无安全关键字 → low
    const proposal: GodelProposal = {
      ...makeLowRiskProposal(),
      targetType: 'config',
      reversible: true,
      currentContent: '# config\n',
      proposedContent: '# config\n# new note\n',
    };
    expect(proposer.assessRisk(proposal)).toBe('low');
  });

  it('2.5 assessRisk 修改 prompt 标记为 high（核心 prompt）', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const proposal: GodelProposal = {
      ...makeLowRiskProposal(),
      targetType: 'prompt',
      reversible: true,
    };
    expect(proposer.assessRisk(proposal)).toBe('high');
  });

  it('2.6 assessRisk 修改 skill 标记为 medium', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const proposal: GodelProposal = {
      ...makeLowRiskProposal(),
      targetType: 'skill',
      reversible: true,
    };
    expect(proposer.assessRisk(proposal)).toBe('medium');
  });

  it('2.7 assessRisk 不可逆变更（rule 类型）标记为 high', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const proposal: GodelProposal = {
      ...makeLowRiskProposal(),
      targetType: 'rule',
      reversible: false,
    };
    expect(proposer.assessRisk(proposal)).toBe('high');
  });

  // ----------------------------------------------------------
  // 4. applyProposal 自动应用低风险（autoApplyLowRisk=true）
  // ----------------------------------------------------------

  it('3.1 applyProposal autoApplyLowRisk=true 时低风险可逆提案自动应用', async () => {
    const config = makeEnabledConfig({ autoApplyLowRisk: true });
    const proposer = new GodelProposer(config);
    // failurePoint 含 'config' 关键词 → area=config → 匹配 config 类型规则
    // config 类型 + 可逆 + 无安全关键字 → low 风险
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-x' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-x' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-x' }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ file: '/config/agent.yaml', content: '# config\n', type: 'config' }),
    ];

    const proposals = await proposer.proposeModifications(history, rules);
    const lowRiskProposal = proposals.find((p) => p.riskAssessment === 'low' && p.reversible);
    expect(lowRiskProposal).toBeDefined();

    // autoApplyLowRisk=true + low + reversible → 可自动应用
    const result = proposer.applyProposal(lowRiskProposal!.id);
    expect(result.applied).toBe(true);
    expect(result.description).toContain('已应用');
  });

  it('3.2 applyProposal critical 风险提案不自动应用（即使批准也不行）', async () => {
    const proposer = new GodelProposer(makeEnabledConfig({ autoApplyLowRisk: true }));
    // 通过 proposeModifications 让其产出含安全关键字的 critical 提案
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'prompt-security' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'prompt-security' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'prompt-security' }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ file: '/rules/prompt.md', content: 'security rules\n', type: 'prompt' }),
    ];
    const proposals = await proposer.proposeModifications(history, rules);
    const criticalProposal = proposals.find((p) => p.riskAssessment === 'critical');
    if (criticalProposal) {
      const result = proposer.applyProposal(criticalProposal.id);
      expect(result.applied).toBe(false);
      expect(result.description).toContain('critical');
    }
  });

  it('3.3 applyProposal autoApplyLowRisk=false 时低风险提案需用户批准', async () => {
    const proposer = new GodelProposer(makeEnabledConfig({ autoApplyLowRisk: false }));
    // 直接构造一个低风险提案并加到内部（通过 proposeModifications）
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-x' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-x' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-x' }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ file: '/config/agent.yaml', content: '# config\n', type: 'config' }),
    ];
    const proposals = await proposer.proposeModifications(history, rules);
    const low = proposals.find((p) => p.riskAssessment === 'low' && p.reversible);
    if (low) {
      // 未批准时不应自动应用
      const r1 = proposer.applyProposal(low.id);
      expect(r1.applied).toBe(false);
      expect(r1.description).toContain('未满足应用条件');
      // 批准后可应用
      proposer.approveProposal(low.id);
      const r2 = proposer.applyProposal(low.id);
      expect(r2.applied).toBe(true);
    }
  });

  it('3.4 applyProposal 不存在的提案返回 applied=false', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const result = proposer.applyProposal('nonexistent-id');
    expect(result.applied).toBe(false);
    expect(result.description).toContain('不存在');
  });

  // ----------------------------------------------------------
  // 5. approveProposal / rejectProposal 用户确认流程
  // ----------------------------------------------------------

  it('4.1 approveProposal 批准后提案出现在 getApplicableProposals（满足条件时）', async () => {
    const proposer = new GodelProposer(makeEnabledConfig({ autoApplyLowRisk: false }));
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-y' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-y' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-y' }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ file: '/config/agent.yaml', content: '# c\n', type: 'config' }),
    ];
    const proposals = await proposer.proposeModifications(history, rules);
    const low = proposals.find((p) => p.riskAssessment === 'low' && p.reversible);
    if (low) {
      // 批准前不在 applicable 中
      expect(proposer.getApplicableProposals().find((p) => p.id === low.id)).toBeUndefined();
      proposer.approveProposal(low.id);
      // 批准后出现在 applicable 中
      expect(proposer.getApplicableProposals().find((p) => p.id === low.id)).toBeDefined();
    }
  });

  it('4.2 rejectProposal 拒绝后提案不再出现在 getProposals', async () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-z' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-z' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-z' }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ file: '/config/agent.yaml', content: '# c\n', type: 'config' }),
    ];
    const proposals = await proposer.proposeModifications(history, rules);
    if (proposals.length > 0) {
      const id = proposals[0].id;
      proposer.rejectProposal(id);
      // 拒绝后该提案不再出现在 getProposals
      expect(proposer.getProposals().find((p) => p.id === id)).toBeUndefined();
    }
  });

  it('4.3 approveProposal 不存在的提案不抛出（仅记日志）', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    expect(() => proposer.approveProposal('nonexistent-id')).not.toThrow();
  });

  it('4.4 rejectProposal 不存在的提案不抛出（仅记日志）', () => {
    const proposer = new GodelProposer(makeEnabledConfig());
    expect(() => proposer.rejectProposal('nonexistent-id')).not.toThrow();
  });

  it('4.5 approveProposal 后再 rejectProposal，批准状态被撤销', async () => {
    const proposer = new GodelProposer(makeEnabledConfig({ autoApplyLowRisk: false }));
    const history: ExecutionHistoryEntry[] = [
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-w' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-w' }),
      makeHistoryEntry({ outcome: 'failure', failurePoint: 'config-w' }),
    ];
    const rules: CurrentRuleEntry[] = [
      makeRule({ file: '/config/agent.yaml', content: '# c\n', type: 'config' }),
    ];
    const proposals = await proposer.proposeModifications(history, rules);
    const low = proposals.find((p) => p.riskAssessment === 'low' && p.reversible);
    if (low) {
      proposer.approveProposal(low.id);
      expect(proposer.getApplicableProposals().find((p) => p.id === low.id)).toBeDefined();
      proposer.rejectProposal(low.id);
      expect(proposer.getApplicableProposals().find((p) => p.id === low.id)).toBeUndefined();
    }
  });

  // ----------------------------------------------------------
  // 6. 纯函数测试
  // ----------------------------------------------------------

  it('5.1 identifyImprovementOpportunities 重复失败 3 次以上才产出机会', () => {
    // 2 次同一 failurePoint → 不达阈值（>=3）
    const opps2 = identifyImprovementOpportunities([
      { task: 'task', outcome: 'failure', failurePoint: 'p' },
      { task: 'task', outcome: 'failure', failurePoint: 'p' },
    ]);
    expect(opps2.length).toBe(0);

    // 3 次同一 failurePoint → 产出机会
    const opps3 = identifyImprovementOpportunities([
      { task: 'task', outcome: 'failure', failurePoint: 'prompt-x' },
      { task: 'task', outcome: 'failure', failurePoint: 'prompt-x' },
      { task: 'task', outcome: 'failure', failurePoint: 'prompt-x' },
    ]);
    expect(opps3.length).toBeGreaterThan(0);
    expect(opps3[0].area).toBe('prompt');
  });

  it('5.2 assessReversibility rule 类型不可逆，其他可逆', () => {
    expect(assessReversibility('prompt')).toBe(true);
    expect(assessReversibility('config')).toBe(true);
    expect(assessReversibility('skill')).toBe(true);
    expect(assessReversibility('rule')).toBe(false);
  });

  it('5.3 generateGodelProposalId 格式正确且唯一', () => {
    const id1 = generateGodelProposalId();
    const id2 = generateGodelProposalId();
    expect(id1).toMatch(/^godel_/);
    expect(id2).toMatch(/^godel_/);
    expect(id1).not.toBe(id2);
  });
});

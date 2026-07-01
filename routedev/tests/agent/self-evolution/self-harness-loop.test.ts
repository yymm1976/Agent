// tests/agent/self-evolution/self-harness-loop.test.ts
// Phase 52 Task 9 单元测试：Self-Harness 三阶段循环
//
// 覆盖：
//   1. discoverWeaknesses 从失败日志聚类弱点模式
//   2. proposeModifications 针对弱点模式产出提案
//   3. validateProposal 回归测试通过标记 passed
//   4. validateProposal 回归测试失败标记 failed
//   5. getApplicableProposals 未通过验证的提案不可应用
//   6. getApplicableProposals 高风险需用户确认（approveProposal）
//   7. getApplicableProposals 已通过验证的提案可应用
//
// 使用 vi.fn() 创建 mock testRunner。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SelfHarnessLoop,
  DEFAULT_SELF_HARNESS_CONFIG,
  clusterFailures,
  assessWeaknessSeverity,
  detectRegression,
  generateHarnessProposalId,
  type SelfHarnessConfig,
  type WeaknessCategory,
} from '../../../src/agent/self-evolution/self-harness-loop.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建一个启用的 config */
function makeEnabledConfig(overrides: Partial<SelfHarnessConfig> = {}): SelfHarnessConfig {
  return {
    ...DEFAULT_SELF_HARNESS_CONFIG,
    enabled: true,
    weaknessDetectionSensitivity: 'high',
    maxProposalsPerCycle: 5,
    requireRegressionTest: true,
    autoApplyLowRiskProposals: false,
    ...overrides,
  };
}

/** 创建失败日志条目 */
function makeFailureLog(
  failurePoint: string,
  errorType: string,
  component = 'unknown',
  timestamp = Date.now(),
) {
  return {
    timestamp,
    task: `task at ${failurePoint}`,
    failurePoint,
    errorType,
    component,
  };
}

/** 创建一个简单 harness */
function makeHarness() {
  return {
    rules: ['rule-1', 'rule-2'],
    prompts: ['prompt-1'],
    checkpoints: ['ckpt-1'],
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 52 Task 9: self-harness-loop 单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------
  // 1. discoverWeaknesses 从失败日志聚类弱点模式
  // ----------------------------------------------------------

  it('1.1 discoverWeaknesses 从失败日志聚类弱点模式（频率 >= 2）', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const logs = [
      makeFailureLog('login failure', 'auth_error', 'auth'),
      makeFailureLog('login failure', 'auth_error', 'auth'), // 同 failurePoint 第 2 次
      makeFailureLog('db timeout', 'timeout_error', 'db'),
    ];

    const weaknesses = await loop.discoverWeaknesses(logs);
    // 'login failure' 出现 2 次 → 聚类成弱点；'db timeout' 只出现 1 次 → 不算弱点
    expect(weaknesses.length).toBe(1);
    expect(weaknesses[0].name).toContain('login failure');
    expect(weaknesses[0].frequency).toBe(2);
    expect(weaknesses[0].affectedComponents).toContain('auth');
  });

  it('1.2 discoverWeaknesses 单次失败不构成弱点（频率 < 2）', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const logs = [
      makeFailureLog('unique failure', 'err1'),
    ];
    const weaknesses = await loop.discoverWeaknesses(logs);
    expect(weaknesses.length).toBe(0);
  });

  it('1.3 discoverWeaknesses sensitivity=low 时只保留 high 严重度弱点', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig({ weaknessDetectionSensitivity: 'low' }));
    // frequency=2 → severity=low（不达 medium/high）
    // frequency=5 → severity=high
    const logs = [
      ...Array.from({ length: 2 }, () => makeFailureLog('low-severity-point', 'e1')),
      ...Array.from({ length: 5 }, () => makeFailureLog('high-severity-point', 'e2')),
    ];
    const weaknesses = await loop.discoverWeaknesses(logs);
    // low 灵敏度只保留 high 严重度 → 只有 frequency=5 的弱点保留
    expect(weaknesses.length).toBe(1);
    expect(weaknesses[0].frequency).toBe(5);
    expect(weaknesses[0].severity).toBe('high');
  });

  it('1.4 discoverWeaknesses 弱点按频率降序排序', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const logs = [
      ...Array.from({ length: 3 }, () => makeFailureLog('mid-fail', 'e1')),
      ...Array.from({ length: 6 }, () => makeFailureLog('high-fail', 'e2')),
      ...Array.from({ length: 2 }, () => makeFailureLog('low-fail', 'e3')),
    ];
    const weaknesses = await loop.discoverWeaknesses(logs);
    expect(weaknesses.length).toBe(3);
    expect(weaknesses[0].frequency).toBe(6);
    expect(weaknesses[1].frequency).toBe(3);
    expect(weaknesses[2].frequency).toBe(2);
  });

  it('1.5 getWeaknesses 返回已发现的弱点数组副本', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const logs = [
      makeFailureLog('p1', 'e1'),
      makeFailureLog('p1', 'e1'),
    ];
    await loop.discoverWeaknesses(logs);
    const w = loop.getWeaknesses();
    expect(w.length).toBe(1);
    // 数组是副本：push 新元素不影响内部状态
    w.push({
      name: 'fake',
      description: 'fake',
      frequency: 999,
      lastSeen: 0,
      affectedComponents: [],
      severity: 'low',
    });
    expect(loop.getWeaknesses().length).toBe(1);
  });

  // ----------------------------------------------------------
  // 2. proposeModifications 针对弱点模式产出提案
  // ----------------------------------------------------------

  it('2.1 proposeModifications 针对弱点产出提案（按 affectedComponents 选择类型）', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'err@prompt-fail',
        description: 'prompt 重复失败',
        frequency: 3,
        lastSeen: Date.now(),
        affectedComponents: ['prompt'],
        severity: 'medium',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals.length).toBe(1);
    expect(proposals[0].weaknessCategory).toBe('err@prompt-fail');
    expect(proposals[0].modificationType).toBe('modify_prompt');
    expect(proposals[0].riskLevel).toBe('medium');
    expect(proposals[0].target).toContain('prompts');
  });

  it('2.2 proposeModifications 影响 tool 组件时产出 add_guardrail 类型', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'err@tool-misuse',
        description: '工具误用',
        frequency: 3,
        lastSeen: Date.now(),
        affectedComponents: ['tool'],
        severity: 'medium',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals[0].modificationType).toBe('add_guardrail');
    expect(proposals[0].riskLevel).toBe('low');
  });

  it('2.3 proposeModifications 影响 workflow 组件时产出 add_checkpoint 类型', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'err@workflow-fail',
        description: '工作流失败',
        frequency: 3,
        lastSeen: Date.now(),
        affectedComponents: ['workflow'],
        severity: 'medium',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals[0].modificationType).toBe('add_checkpoint');
    expect(proposals[0].riskLevel).toBe('medium');
  });

  it('2.4 proposeModifications 影响 config 组件时产出 modify_config 类型（high 风险）', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'err@config-fail',
        description: '配置错误',
        frequency: 3,
        lastSeen: Date.now(),
        affectedComponents: ['config'],
        severity: 'medium',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals[0].modificationType).toBe('modify_config');
    expect(proposals[0].riskLevel).toBe('high');
  });

  it('2.5 proposeModifications 无匹配组件时产出 add_rule 类型（low 风险）', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'err@unknown',
        description: '未知组件失败',
        frequency: 3,
        lastSeen: Date.now(),
        affectedComponents: ['unknown'],
        severity: 'medium',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals[0].modificationType).toBe('add_rule');
    expect(proposals[0].riskLevel).toBe('low');
  });

  it('2.6 proposeModifications 受 maxProposalsPerCycle 限制', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig({ maxProposalsPerCycle: 2 }));
    const weaknesses: WeaknessCategory[] = [
      { name: 'w1', description: 'd1', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
      { name: 'w2', description: 'd2', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
      { name: 'w3', description: 'd3', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
      { name: 'w4', description: 'd4', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals.length).toBe(2);
  });

  // ----------------------------------------------------------
  // 3. validateProposal 回归测试通过标记 passed
  // ----------------------------------------------------------

  it('3.1 validateProposal 回归测试通过且无回归时标记 passed=true', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      { name: 'w1', description: 'd', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());

    const testRunner = vi.fn(async () => ({
      passed: true,
      metrics: { pass_rate: 0.9, error_rate: 0.1 },
    }));
    const baseline = { pass_rate: 0.9, error_rate: 0.1 };

    const result = await loop.validateProposal(proposals[0], testRunner, baseline);
    expect(result.passed).toBe(true);
    expect(result.regressionDetected).toBe(false);
    expect(result.metricsBefore).toEqual(baseline);
    expect(result.metricsAfter).toEqual({ pass_rate: 0.9, error_rate: 0.1 });
    expect(testRunner).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------
  // 4. validateProposal 回归测试失败标记 failed
  // ----------------------------------------------------------

  it('4.1 validateProposal 回归测试失败时标记 passed=false', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      { name: 'w1', description: 'd', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());

    const testRunner = vi.fn(async () => ({
      passed: false,
      metrics: { pass_rate: 0.5 },
    }));
    const result = await loop.validateProposal(proposals[0], testRunner, { pass_rate: 0.9 });
    expect(result.passed).toBe(false);
    expect(result.regressionDetected).toBe(true);
    expect(result.newWeaknesses).toContain('pass_rate');
  });

  it('4.2 validateProposal 检测到指标回归时标记 passed=false（即使测试通过）', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      { name: 'w1', description: 'd', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());

    // 测试通过但 pass_rate 下降超过 10%
    const testRunner = vi.fn(async () => ({
      passed: true,
      metrics: { pass_rate: 0.7 },
    }));
    const result = await loop.validateProposal(proposals[0], testRunner, { pass_rate: 0.9 });
    expect(result.passed).toBe(false);
    expect(result.regressionDetected).toBe(true);
    expect(result.newWeaknesses).toContain('pass_rate');
  });

  it('4.3 validateProposal testRunner 抛异常时标记 passed=false（保守判定）', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      { name: 'w1', description: 'd', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());

    const testRunner = vi.fn(async () => {
      throw new Error('test crashed');
    });
    const result = await loop.validateProposal(proposals[0], testRunner, {});
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('testRunner 执行异常');
  });

  it('4.4 validateProposal 同一提案重复验证时覆盖旧结果', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      { name: 'w1', description: 'd', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());

    // 第 1 次：失败
    const runner1 = vi.fn(async () => ({ passed: false, metrics: { pass_rate: 0.5 } }));
    await loop.validateProposal(proposals[0], runner1, { pass_rate: 0.9 });

    // 第 2 次：通过
    const runner2 = vi.fn(async () => ({ passed: true, metrics: { pass_rate: 0.9 } }));
    const result2 = await loop.validateProposal(proposals[0], runner2, { pass_rate: 0.9 });
    expect(result2.passed).toBe(true);

    // getValidatedProposals 应只看到 1 个验证结果（最新）
    const validated = loop.getValidatedProposals();
    expect(validated.length).toBe(1);
    expect(validated[0].validation.passed).toBe(true);
  });

  // ----------------------------------------------------------
  // 5. getApplicableProposals 未通过验证的提案不可应用
  // ----------------------------------------------------------

  it('5.1 getApplicableProposals 未通过验证的提案不在可应用列表', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      { name: 'w1', description: 'd', frequency: 2, lastSeen: 0, affectedComponents: [], severity: 'low' },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());

    // 未验证 → 不可应用
    expect(loop.getApplicableProposals().length).toBe(0);

    // 验证失败 → 不可应用
    const failingRunner = vi.fn(async () => ({ passed: false, metrics: {} }));
    await loop.validateProposal(proposals[0], failingRunner, {});
    expect(loop.getApplicableProposals().length).toBe(0);
  });

  // ----------------------------------------------------------
  // 6. getApplicableProposals 高风险需用户确认（approveProposal）
  // ----------------------------------------------------------

  it('5.2 getApplicableProposals 高风险提案即使通过验证也需 approveProposal', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    // config 组件 → modify_config → high 风险
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'w1',
        description: 'd',
        frequency: 3,
        lastSeen: 0,
        affectedComponents: ['config'],
        severity: 'medium',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals[0].riskLevel).toBe('high');

    // 通过验证
    const passingRunner = vi.fn(async () => ({ passed: true, metrics: {} }));
    await loop.validateProposal(proposals[0], passingRunner, {});

    // 高风险 → 默认不在 getApplicableProposals 中（需 approveProposal）
    expect(loop.getApplicableProposals().length).toBe(0);

    // approveProposal 后 → 可应用
    loop.approveProposal(proposals[0].id);
    const applicable = loop.getApplicableProposals();
    expect(applicable.length).toBe(1);
    expect(applicable[0].id).toBe(proposals[0].id);
  });

  // ----------------------------------------------------------
  // 7. getApplicableProposals 已通过验证的低风险提案可应用
  // ----------------------------------------------------------

  it('5.3 getApplicableProposals 已通过验证的低风险提案可直接应用', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    // unknown 组件 → add_rule → low 风险
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'w1',
        description: 'd',
        frequency: 2,
        lastSeen: 0,
        affectedComponents: ['unknown'],
        severity: 'low',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    expect(proposals[0].riskLevel).toBe('low');

    // 通过验证
    const passingRunner = vi.fn(async () => ({ passed: true, metrics: {} }));
    await loop.validateProposal(proposals[0], passingRunner, {});

    // 低风险 + 通过验证 → 直接在 getApplicableProposals 中
    const applicable = loop.getApplicableProposals();
    expect(applicable.length).toBe(1);
    expect(applicable[0].id).toBe(proposals[0].id);
  });

  it('5.4 rejectProposal 撤销批准后高风险提案不再可应用', async () => {
    const loop = new SelfHarnessLoop(makeEnabledConfig());
    const weaknesses: WeaknessCategory[] = [
      {
        name: 'w1',
        description: 'd',
        frequency: 3,
        lastSeen: 0,
        affectedComponents: ['config'],
        severity: 'medium',
      },
    ];
    const proposals = await loop.proposeModifications(weaknesses, makeHarness());
    const passingRunner = vi.fn(async () => ({ passed: true, metrics: {} }));
    await loop.validateProposal(proposals[0], passingRunner, {});

    loop.approveProposal(proposals[0].id);
    expect(loop.getApplicableProposals().length).toBe(1);

    loop.rejectProposal(proposals[0].id);
    expect(loop.getApplicableProposals().length).toBe(0);
  });

  // ----------------------------------------------------------
  // 8. 纯函数测试
  // ----------------------------------------------------------

  it('6.1 clusterFailures 频率 < 2 不算弱点', () => {
    const weaknesses = clusterFailures([
      { failurePoint: 'p1', errorType: 'e1' },
      { failurePoint: 'p2', errorType: 'e1' },
      { failurePoint: 'p3', errorType: 'e1' },
    ]);
    // 每个 failurePoint 只出现 1 次 → 都不构成弱点
    expect(weaknesses.length).toBe(0);
  });

  it('6.2 clusterFailures 相同 errorType + 相似 failurePoint 归为一类', () => {
    const weaknesses = clusterFailures([
      { failurePoint: 'login failure', errorType: 'auth', component: 'a' },
      { failurePoint: 'login failure', errorType: 'auth', component: 'b' }, // 同 failurePoint
      { failurePoint: 'LOGIN FAILURE', errorType: 'auth' }, // 归一化后相同
    ]);
    expect(weaknesses.length).toBe(1);
    expect(weaknesses[0].frequency).toBe(3);
    expect(weaknesses[0].affectedComponents).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('6.3 assessWeaknessSeverity frequency >= 5 → high', () => {
    expect(assessWeaknessSeverity({ frequency: 5, affectedComponents: [] })).toBe('high');
    expect(assessWeaknessSeverity({ frequency: 4, affectedComponents: ['a', 'b', 'c'] })).toBe('high');
  });

  it('6.4 assessWeaknessSeverity frequency >= 3 或 affectedComponents >= 2 → medium', () => {
    expect(assessWeaknessSeverity({ frequency: 3, affectedComponents: [] })).toBe('medium');
    expect(assessWeaknessSeverity({ frequency: 2, affectedComponents: ['a', 'b'] })).toBe('medium');
  });

  it('6.5 detectRegression 越高越好的指标下降 > 10% 算回归', () => {
    // pass_rate 越高越好：从 0.9 降到 0.7 → 下降 22% > 10% → 回归
    const r = detectRegression({ pass_rate: 0.9 }, { pass_rate: 0.7 });
    expect(r.regressed).toBe(true);
    expect(r.regressedMetrics).toContain('pass_rate');
  });

  it('6.6 detectRegression 越低越好的指标上升 > 10% 算回归', () => {
    // error_rate 越低越好：从 0.1 升到 0.2 → 上升 100% > 10% → 回归
    const r = detectRegression({ error_rate: 0.1 }, { error_rate: 0.2 });
    expect(r.regressed).toBe(true);
    expect(r.regressedMetrics).toContain('error_rate');
  });

  it('6.7 detectRegression 指标变化 <= 10% 不算回归', () => {
    // pass_rate 0.9 → 0.85 下降 5.5% < 10% → 不回归
    const r = detectRegression({ pass_rate: 0.9 }, { pass_rate: 0.85 });
    expect(r.regressed).toBe(false);
  });

  it('6.8 generateHarnessProposalId 格式正确且唯一', () => {
    const id1 = generateHarnessProposalId();
    const id2 = generateHarnessProposalId();
    expect(id1).toMatch(/^harness-prop-/);
    expect(id2).toMatch(/^harness-prop-/);
    expect(id1).not.toBe(id2);
  });
});

// tests/agent/self-evolution/framework.test.ts
// Phase 52 Task 5 单元测试：自进化统一框架——反馈循环架构
//
// 覆盖：
//   1. collectSignals 从多个源（LoopMemory/SkillMemory/ScoreCard）汇总
//   2. selectOptimizationTarget 根据信号类型选择目标层
//   3. optimize 产出建议而非自动应用（applied=false）
//   4. shouldTriggerOptimization 失败次数达阈值触发
//   5. shouldTriggerOptimization 质量下降触发
//   6. shouldTriggerOptimization 执行间隔触发
//
// 使用 vi.fn() / mock 信号源。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SelfEvolutionFramework,
  type SignalSource,
} from '../../../src/agent/self-evolution/framework.js';
import {
  DEFAULT_SELF_EVOLUTION_CONFIG,
  type EvolutionSignal,
  type SelfEvolutionConfig,
} from '../../../src/agent/self-evolution/types.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建一个 EvolutionSignal */
function makeSignal(
  overrides: Partial<EvolutionSignal> = {},
): EvolutionSignal {
  return {
    source: 'loop_memory',
    type: 'failure',
    severity: 'medium',
    description: 'default signal',
    data: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** 创建一个 mock 信号源 */
function makeMockSource(name: string, signals: EvolutionSignal[]): SignalSource {
  return {
    name,
    collect: vi.fn(() => signals),
  };
}

/** 创建一个启用的 config（覆盖默认的 enabled=false） */
function makeEnabledConfig(overrides: Partial<SelfEvolutionConfig> = {}): SelfEvolutionConfig {
  return {
    ...DEFAULT_SELF_EVOLUTION_CONFIG,
    enabled: true,
    targets: {
      prompt: true,
      memory: true,
      tools: true,
      workflow: true,
      communication: true,
    },
    trigger: {
      failureThreshold: 5,
      qualityDropThreshold: 0.3,
      evaluationInterval: 20,
    },
    ...overrides,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 52 Task 5: self-evolution framework 单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------
  // 1. collectSignals 从多个源汇总
  // ----------------------------------------------------------

  it('1.1 collectSignals 从多个源（LoopMemory/SkillMemory/ScoreCard）汇总', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const loopSource = makeMockSource('loop-memory', [
      makeSignal({ source: 'loop_memory', type: 'failure', description: 'loop fail' }),
    ]);
    const skillSource = makeMockSource('skill-memory', [
      makeSignal({ source: 'skill_memory', type: 'quality_drop', description: 'skill drop' }),
    ]);
    const scoreSource = makeMockSource('score-card', [
      makeSignal({ source: 'score_card', type: 'success_pattern', description: 'good' }),
    ]);

    framework.registerSignalSource(loopSource);
    framework.registerSignalSource(skillSource);
    framework.registerSignalSource(scoreSource);

    const signals = framework.collectSignals();
    expect(signals.length).toBe(3);
    expect(loopSource.collect).toHaveBeenCalledTimes(1);
    expect(skillSource.collect).toHaveBeenCalledTimes(1);
    expect(scoreSource.collect).toHaveBeenCalledTimes(1);
    // 信号按注册顺序合并
    expect(signals[0].source).toBe('loop_memory');
    expect(signals[1].source).toBe('skill_memory');
    expect(signals[2].source).toBe('score_card');
  });

  it('1.2 collectSignals 单个信号源失败时不阻塞其他源', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const badSource: SignalSource = {
      name: 'bad',
      collect: vi.fn(() => { throw new Error('boom'); }),
    };
    const goodSource = makeMockSource('good', [
      makeSignal({ description: 'good signal' }),
    ]);
    framework.registerSignalSource(badSource);
    framework.registerSignalSource(goodSource);

    const signals = framework.collectSignals();
    // bad 抛异常被吞掉，good 仍正常返回 1 个
    expect(signals.length).toBe(1);
    expect(signals[0].description).toBe('good signal');
  });

  it('1.3 collectSignals 单个源返回非数组时跳过该源', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const badSource: SignalSource = {
      name: 'bad',
      collect: vi.fn(() => 'not-an-array' as any),
    };
    const goodSource = makeMockSource('good', [makeSignal()]);
    framework.registerSignalSource(badSource);
    framework.registerSignalSource(goodSource);

    const signals = framework.collectSignals();
    expect(signals.length).toBe(1);
  });

  it('1.4 collectSignals 每次调用递增 collectionCount（影响 evaluationInterval 判定）', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig({
      trigger: { failureThreshold: 100, qualityDropThreshold: 1.0, evaluationInterval: 2 },
    }));
    framework.registerSignalSource(makeMockSource('s', []));

    // 第 1 次收集 → collectionCount=1，不触发
    let result = framework.shouldTriggerOptimization(framework.collectSignals());
    expect(result.trigger).toBe(false);
    // 第 2 次收集 → collectionCount=2 >= evaluationInterval=2 → 触发
    result = framework.shouldTriggerOptimization(framework.collectSignals());
    expect(result.trigger).toBe(true);
    expect(result.reason).toContain('evaluation interval');
  });

  // ----------------------------------------------------------
  // 2. selectOptimizationTarget 根据信号类型选择目标层
  // ----------------------------------------------------------

  it('2.1 selectOptimizationTarget failure 信号最多时选择 prompt 层', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'failure' }),
      makeSignal({ type: 'failure' }),
      makeSignal({ type: 'quality_drop' }),
    ];
    const target = framework.selectOptimizationTarget(signals);
    // failure → ['prompt', 'workflow']，第一个启用 → prompt
    expect(target).toBe('prompt');
  });

  it('2.2 selectOptimizationTarget quality_drop 信号最多时选择 memory 层', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'quality_drop' }),
      makeSignal({ type: 'quality_drop' }),
      makeSignal({ type: 'failure' }),
    ];
    const target = framework.selectOptimizationTarget(signals);
    // quality_drop → ['memory', 'prompt']，第一个启用 → memory
    expect(target).toBe('memory');
  });

  it('2.3 selectOptimizationTarget inefficiency 信号最多时选择 tools 层', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'inefficiency' }),
      makeSignal({ type: 'inefficiency' }),
      makeSignal({ type: 'failure' }),
    ];
    const target = framework.selectOptimizationTarget(signals);
    // inefficiency → ['tools', 'workflow']，第一个启用 → tools
    expect(target).toBe('tools');
  });

  it('2.4 selectOptimizationTarget user_rejection 信号最多时选择 communication 层', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'user_rejection' }),
      makeSignal({ type: 'user_rejection' }),
      makeSignal({ type: 'failure' }),
    ];
    const target = framework.selectOptimizationTarget(signals);
    // user_rejection → ['communication', 'prompt']，第一个启用 → communication
    expect(target).toBe('communication');
  });

  it('2.5 selectOptimizationTarget 候选目标未启用时回退到任意启用目标', () => {
    // 关闭 prompt 和 workflow（failure 的候选）
    const config = makeEnabledConfig({
      targets: { prompt: false, memory: true, tools: false, workflow: false, communication: false },
    });
    const framework = new SelfEvolutionFramework(config);
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'failure' }),
    ];
    const target = framework.selectOptimizationTarget(signals);
    // failure 候选都未启用 → 回退到任意启用目标（memory 在优先级第 2 位）
    expect(target).toBe('memory');
  });

  it('2.6 selectOptimizationTarget 空信号返回 null', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    expect(framework.selectOptimizationTarget([])).toBeNull();
  });

  it('2.7 selectOptimizationTarget 仅有 success_pattern 时回退到任意启用目标', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'success_pattern' }),
      makeSignal({ type: 'success_pattern' }),
    ];
    // success_pattern 不在 SIGNAL_TYPE_PRIORITY 中 → bestType=null → 走回退分支
    // 回退分支按 prompt > memory > workflow > tools > communication 顺序选第一个启用
    expect(framework.selectOptimizationTarget(signals)).toBe('prompt');
  });

  it('2.8 selectOptimizationTarget success_pattern 且仅 communication 启用时返回 communication', () => {
    const config = makeEnabledConfig({
      targets: { prompt: false, memory: false, tools: false, workflow: false, communication: true },
    });
    const framework = new SelfEvolutionFramework(config);
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'success_pattern' }),
    ];
    expect(framework.selectOptimizationTarget(signals)).toBe('communication');
  });

  it('2.9 selectOptimizationTarget 全部目标都未启用时返回 null', () => {
    const config = makeEnabledConfig({
      targets: { prompt: false, memory: false, tools: false, workflow: false, communication: false },
    });
    const framework = new SelfEvolutionFramework(config);
    const signals: EvolutionSignal[] = [makeSignal({ type: 'success_pattern' })];
    expect(framework.selectOptimizationTarget(signals)).toBeNull();
  });

  // ----------------------------------------------------------
  // 3. optimize 产出建议而非自动应用（applied=false）
  // ----------------------------------------------------------

  it('3.1 optimize 产出 OptimizationProposal（applied=false）', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'failure', severity: 'high', description: 'fail 1' }),
      makeSignal({ type: 'failure', severity: 'medium', description: 'fail 2' }),
    ];
    const proposal = framework.optimize('prompt', signals);

    expect(proposal).not.toBeNull();
    expect(proposal.applied).toBe(false);
    expect(proposal.target).toBe('prompt');
    expect(proposal.id).toMatch(/^proposal-/);
    expect(proposal.proposedChanges.length).toBeGreaterThan(0);
    expect(proposal.riskLevel).toBeDefined();
    expect(proposal.expectedImpact).toBeDefined();
  });

  it('3.2 optimize 后调用 getPendingProposals 应包含该提案', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const proposal = framework.optimize('prompt', [makeSignal({ type: 'failure' })]);

    const pending = framework.getPendingProposals();
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(proposal.id);
    expect(pending[0].applied).toBe(false);
  });

  it('3.3 markProposalApplied 后该提案不再出现在 getPendingProposals', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    const proposal = framework.optimize('prompt', [makeSignal({ type: 'failure' })]);
    framework.markProposalApplied(proposal.id);

    const pending = framework.getPendingProposals();
    expect(pending.length).toBe(0);
    const all = framework.getProposals();
    expect(all.length).toBe(1);
    expect(all[0].applied).toBe(true);
  });

  it('3.4 markProposalApplied 提案不存在时不抛出（仅记日志）', () => {
    const framework = new SelfEvolutionFramework(makeEnabledConfig());
    expect(() => framework.markProposalApplied('nonexistent-id')).not.toThrow();
  });

  // ----------------------------------------------------------
  // 4. shouldTriggerOptimization 失败次数达阈值触发
  // ----------------------------------------------------------

  it('4.1 shouldTriggerOptimization 失败次数 >= failureThreshold 触发', () => {
    const config = makeEnabledConfig({
      trigger: { failureThreshold: 5, qualityDropThreshold: 0.5, evaluationInterval: 100 },
    });
    const framework = new SelfEvolutionFramework(config);
    const signals: EvolutionSignal[] = Array.from({ length: 5 }, () =>
      makeSignal({ type: 'failure' }),
    );
    const result = framework.shouldTriggerOptimization(signals);
    expect(result.trigger).toBe(true);
    expect(result.reason).toContain('failure count 5');
  });

  it('4.2 shouldTriggerOptimization 失败次数 < failureThreshold 时不触发（仅考虑失败规则）', () => {
    const config = makeEnabledConfig({
      trigger: { failureThreshold: 5, qualityDropThreshold: 0.5, evaluationInterval: 100 },
    });
    const framework = new SelfEvolutionFramework(config);
    const signals: EvolutionSignal[] = Array.from({ length: 4 }, () =>
      makeSignal({ type: 'failure' }),
    );
    const result = framework.shouldTriggerOptimization(signals);
    expect(result.trigger).toBe(false);
  });

  // ----------------------------------------------------------
  // 5. shouldTriggerOptimization 质量下降触发
  // ----------------------------------------------------------

  it('5.1 shouldTriggerOptimization 质量下降比例 >= qualityDropThreshold 触发', () => {
    const config = makeEnabledConfig({
      trigger: { failureThreshold: 100, qualityDropThreshold: 0.3, evaluationInterval: 100 },
    });
    const framework = new SelfEvolutionFramework(config);
    // 5 个信号中 2 个 quality_drop → 0.4 >= 0.3
    const signals: EvolutionSignal[] = [
      makeSignal({ type: 'quality_drop' }),
      makeSignal({ type: 'quality_drop' }),
      makeSignal({ type: 'success_pattern' }),
      makeSignal({ type: 'success_pattern' }),
      makeSignal({ type: 'success_pattern' }),
    ];
    const result = framework.shouldTriggerOptimization(signals);
    expect(result.trigger).toBe(true);
    expect(result.reason).toContain('quality drop ratio');
  });

  // ----------------------------------------------------------
  // 6. shouldTriggerOptimization 执行间隔触发
  // ----------------------------------------------------------

  it('6.1 shouldTriggerOptimization 收集次数 >= evaluationInterval 触发', () => {
    const config = makeEnabledConfig({
      trigger: { failureThreshold: 100, qualityDropThreshold: 1.0, evaluationInterval: 3 },
    });
    const framework = new SelfEvolutionFramework(config);
    framework.registerSignalSource(makeMockSource('s', []));

    // 收集 3 次 → collectionCount=3 >= evaluationInterval=3 → 触发
    framework.collectSignals();
    framework.collectSignals();
    const signals = framework.collectSignals();
    const result = framework.shouldTriggerOptimization(signals);
    expect(result.trigger).toBe(true);
    expect(result.reason).toContain('evaluation interval');
  });

  it('6.2 shouldTriggerOptimization enabled=false 时返回 trigger=false', () => {
    const framework = new SelfEvolutionFramework({
      ...DEFAULT_SELF_EVOLUTION_CONFIG,
      enabled: false,
    });
    const signals: EvolutionSignal[] = Array.from({ length: 100 }, () =>
      makeSignal({ type: 'failure' }),
    );
    const result = framework.shouldTriggerOptimization(signals);
    expect(result.trigger).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  it('6.3 shouldTriggerOptimization 空信号且未达 evaluationInterval 时返回 false', () => {
    const config = makeEnabledConfig({
      trigger: { failureThreshold: 100, qualityDropThreshold: 0.5, evaluationInterval: 100 },
    });
    const framework = new SelfEvolutionFramework(config);
    const result = framework.shouldTriggerOptimization([]);
    expect(result.trigger).toBe(false);
  });
});

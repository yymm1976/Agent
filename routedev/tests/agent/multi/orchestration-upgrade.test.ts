// tests/agent/multi/orchestration-upgrade.test.ts
// 多 Agent 编排升级模块的单元测试
// 覆盖：state-graph / handoff / score-card / orchestrator-strategy / blackboard-extension

import { describe, it, expect } from 'vitest';
import {
  ExecutionStateGraph,
  type StepStatus,
} from '../../../src/agent/multi/state-graph.js';
import { HandoffParser, type HandoffArtifact } from '../../../src/agent/multi/handoff.js';
import { ScoreCardCollector, type ScoreCard } from '../../../src/agent/multi/score-card.js';
import {
  StrategySelector,
  DEFAULT_CONFIG,
  type StepWithDependencies,
} from '../../../src/agent/multi/orchestrator-strategy.js';

// ============================================================
// 1. ExecutionStateGraph 图状态机
// ============================================================

describe('ExecutionStateGraph', () => {
  describe('状态转换', () => {
    it('1. pending → running 转换', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1');
      graph.transition('s1', 'running', '开始执行');
      expect(graph.getStep('s1')?.status).toBe('running');
      expect(graph.getStep('s1')?.startedAt).toBeDefined();
    });

    it('2. running → awaiting_review → completed 转换', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1');
      graph.transition('s1', 'running');
      graph.transition('s1', 'awaiting_review', '需要审查');
      expect(graph.getStep('s1')?.status).toBe('awaiting_review');
      graph.transition('s1', 'completed', '用户采纳');
      expect(graph.getStep('s1')?.status).toBe('completed');
      expect(graph.getStep('s1')?.completedAt).toBeDefined();
    });

    it('3. running → retrying → running（重试）', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1', 3);
      graph.transition('s1', 'running');
      graph.transition('s1', 'retrying', '可重试错误');
      expect(graph.getStep('s1')?.status).toBe('retrying');
      expect(graph.getStep('s1')?.retries).toBe(1);
      graph.transition('s1', 'running', '重试中');
      expect(graph.getStep('s1')?.status).toBe('running');
    });

    it('4. retrying → failed（重试耗尽）', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1', 2);
      graph.transition('s1', 'running');
      graph.transition('s1', 'retrying');
      graph.transition('s1', 'running');
      graph.transition('s1', 'retrying');
      // 重试次数达到上限 → failed
      graph.transition('s1', 'failed', '重试耗尽');
      expect(graph.getStep('s1')?.status).toBe('failed');
      expect(graph.getStep('s1')?.retries).toBe(2);
    });

    it('5. failed → blocked（下游 blocked）', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1', 0, []);
      graph.addStep('s2', 0, ['s1']); // s2 依赖 s1
      graph.addStep('s3', 0, ['s2']); // s3 依赖 s2

      graph.transition('s1', 'running');
      graph.transition('s1', 'failed', '执行失败');
      // 标记下游为 blocked
      graph.blockDownstreamOf('s1');

      expect(graph.getStep('s2')?.status).toBe('blocked');
      // s3 依赖 s2，但 s2 是 blocked 不是 failed，blockDownstreamOf 只处理 failed 的直接下游
      // s3 应该还是 pending（需要再次调用 blockDownstreamOf('s2') 才会传播）
      // 但根据规则 failed → blocked 是针对 failed 步骤的下游
    });

    it('6. 非法转换被拒绝', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1');
      // pending → completed 是非法的（必须经过 running）
      expect(() => graph.transition('s1', 'completed')).toThrow(/illegal transition/);
      expect(() => graph.transition('s1', 'failed')).toThrow(/illegal transition/);
      expect(() => graph.transition('s1', 'awaiting_review')).toThrow(/illegal transition/);
    });

    it('7. getPendingSteps 返回依赖已完成的步骤', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1', 2, []);
      graph.addStep('s2', 2, ['s1']); // 依赖 s1
      graph.addStep('s3', 2, ['s1']); // 依赖 s1
      graph.addStep('s4', 2, ['s2', 's3']); // 依赖 s2 和 s3

      // 初始：只有 s1 可执行
      expect(graph.getPendingSteps().sort()).toEqual(['s1']);

      // s1 完成后：s2 和 s3 可执行
      graph.transition('s1', 'running');
      graph.transition('s1', 'completed');
      expect(graph.getPendingSteps().sort()).toEqual(['s2', 's3']);

      // s2 完成后：s3 仍可执行，s4 还不行（等 s3）
      graph.transition('s2', 'running');
      graph.transition('s2', 'completed');
      expect(graph.getPendingSteps().sort()).toEqual(['s3']);

      // s3 完成后：s4 可执行
      graph.transition('s3', 'running');
      graph.transition('s3', 'completed');
      expect(graph.getPendingSteps()).toEqual(['s4']);
    });
  });

  describe('完整性检查', () => {
    it('isComplete: 所有步骤到达终态', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1');
      graph.addStep('s2');
      expect(graph.isComplete()).toBe(false);

      graph.transition('s1', 'running');
      graph.transition('s1', 'completed');
      expect(graph.isComplete()).toBe(false);

      graph.transition('s2', 'running');
      graph.transition('s2', 'completed');
      expect(graph.isComplete()).toBe(true);
    });

    it('hasFailures: 存在失败步骤', () => {
      const graph = new ExecutionStateGraph();
      graph.addStep('s1');
      graph.addStep('s2');
      expect(graph.hasFailures()).toBe(false);

      graph.transition('s1', 'running');
      graph.transition('s1', 'failed');
      expect(graph.hasFailures()).toBe(true);
    });
  });
});

// ============================================================
// 2. HandoffParser 结构化交接
// ============================================================

describe('HandoffParser', () => {
  describe('parse', () => {
    it('8. 从 JSON 块解析', () => {
      const rawOutput = `一些前置说明文字

\`\`\`json
{
  "summary": "实现了用户认证模块",
  "decisions": [
    { "what": "使用 JWT", "why": "无状态、易扩展", "confidence": 0.9 }
  ],
  "modifiedFiles": ["src/auth/jwt.ts", "src/auth/middleware.ts"],
  "openQuestions": ["token 过期策略待定"],
  "risks": ["密钥管理需要加强"],
  "relevantSymbols": ["AuthService", "verifyToken"],
  "relevantFacts": ["使用 RS256 算法"]
}
\`\`\`

后续说明`;
      const artifact = HandoffParser.parse(rawOutput, 's1', 'coder');

      expect(artifact.stepId).toBe('s1');
      expect(artifact.role).toBe('coder');
      expect(artifact.summary).toBe('实现了用户认证模块');
      expect(artifact.decisions).toHaveLength(1);
      expect(artifact.decisions[0].what).toBe('使用 JWT');
      expect(artifact.decisions[0].why).toBe('无状态、易扩展');
      expect(artifact.decisions[0].confidence).toBe(0.9);
      expect(artifact.modifiedFiles).toEqual(['src/auth/jwt.ts', 'src/auth/middleware.ts']);
      expect(artifact.openQuestions).toEqual(['token 过期策略待定']);
      expect(artifact.risks).toEqual(['密钥管理需要加强']);
      expect(artifact.relevantSymbols).toEqual(['AuthService', 'verifyToken']);
      expect(artifact.relevantFacts).toEqual(['使用 RS256 算法']);
    });

    it('9. 从正则提取（无 JSON）', () => {
      const rawOutput = `完成了认证模块的实现。

修改了 src/auth/jwt.ts 和 src/auth/middleware.ts 文件。
决策: 使用 JWT 进行身份验证
风险: 密钥管理需要加强
问题: token 过期策略待确认

这是本次工作的主要内容。`;
      const artifact = HandoffParser.parse(rawOutput, 's2', 'coder');

      expect(artifact.stepId).toBe('s2');
      expect(artifact.role).toBe('coder');
      // summary 应该从文本提取
      expect(artifact.summary.length).toBeGreaterThan(0);
      // 应该提取出文件路径
      expect(artifact.modifiedFiles.length).toBeGreaterThan(0);
      expect(artifact.modifiedFiles.some(f => f.includes('jwt.ts'))).toBe(true);
      expect(artifact.modifiedFiles.some(f => f.includes('middleware.ts'))).toBe(true);
      // 应该提取出决策
      expect(artifact.decisions.length).toBeGreaterThan(0);
      expect(artifact.decisions[0].what).toContain('JWT');
      // 应该提取出风险
      expect(artifact.risks.length).toBeGreaterThan(0);
      // 应该提取出问题
      expect(artifact.openQuestions.length).toBeGreaterThan(0);
    });

    it('10. 纯文本回退', () => {
      const rawOutput = '这是一段纯文本说明，没有任何结构化信息或文件路径。';
      const artifact = HandoffParser.parse(rawOutput, 's3', 'searcher');

      expect(artifact.stepId).toBe('s3');
      expect(artifact.role).toBe('searcher');
      expect(artifact.summary).toBe(rawOutput);
      expect(artifact.decisions).toEqual([]);
      expect(artifact.modifiedFiles).toEqual([]);
      expect(artifact.openQuestions).toEqual([]);
      expect(artifact.risks).toEqual([]);
      expect(artifact.relevantSymbols).toEqual([]);
      expect(artifact.relevantFacts).toEqual([]);
    });

    it('空字符串输入应返回空 artifact', () => {
      const artifact = HandoffParser.parse('', 's1', 'coder');
      expect(artifact.summary).toBe('');
      expect(artifact.decisions).toEqual([]);
    });

    it('validate: 校验 artifact 完整性', () => {
      const valid: HandoffArtifact = {
        stepId: 's1',
        role: 'coder',
        summary: 'valid',
        decisions: [],
        modifiedFiles: [],
        openQuestions: [],
        risks: [],
        relevantSymbols: [],
        relevantFacts: [],
      };
      expect(HandoffParser.validate(valid)).toBe(true);

      const invalid: HandoffArtifact = {
        ...valid,
        stepId: '',
      };
      expect(HandoffParser.validate(invalid)).toBe(false);

      const invalidConfidence: HandoffArtifact = {
        ...valid,
        decisions: [{ what: 'x', why: 'y', confidence: 1.5 }],
      };
      expect(HandoffParser.validate(invalidConfidence)).toBe(false);
    });
  });

  describe('formatForPrompt', () => {
    it('11. 格式化输出', () => {
      const artifacts: HandoffArtifact[] = [
        {
          stepId: 's1',
          role: 'coder',
          summary: '实现认证模块',
          decisions: [
            { what: '使用 JWT', why: '无状态', confidence: 0.9 },
          ],
          modifiedFiles: ['src/auth.ts'],
          openQuestions: ['token 过期策略'],
          risks: ['密钥管理'],
          relevantSymbols: ['AuthService'],
          relevantFacts: ['使用 RS256'],
        },
      ];

      const output = HandoffParser.formatForPrompt(artifacts);
      expect(output).toContain('前置步骤交接信息');
      expect(output).toContain('步骤 s1');
      expect(output).toContain('角色: coder');
      expect(output).toContain('实现认证模块');
      expect(output).toContain('src/auth.ts');
      expect(output).toContain('使用 JWT');
      expect(output).toContain('无状态');
      expect(output).toContain('90%');
      expect(output).toContain('token 过期策略');
      expect(output).toContain('密钥管理');
      expect(output).toContain('AuthService');
      expect(output).toContain('使用 RS256');
      expect(output).toContain('交接信息结束');
    });

    it('空数组应返回占位文本', () => {
      const output = HandoffParser.formatForPrompt([]);
      expect(output).toBe('（无前置交接信息）');
    });
  });
});

// ============================================================
// 3. ScoreCardCollector 审计层
// ============================================================

describe('ScoreCardCollector', () => {
  function makeCard(overrides: Partial<ScoreCard> = {}): ScoreCard {
    return {
      stepId: 's1',
      role: 'coder',
      modelId: 'gpt-4',
      tokenUsage: { input: 100, output: 200, total: 300 },
      durationMs: 5000,
      toolCalls: 5,
      fileEdits: 3,
      testsRun: 10,
      testsPassed: 8,
      lintErrors: 1,
      typeErrors: 0,
      userFeedback: 'accepted',
      ...overrides,
    };
  }

  it('12. 记录和聚合统计', () => {
    const collector = new ScoreCardCollector();
    collector.record(makeCard({ stepId: 's1', tokenUsage: { input: 100, output: 200, total: 300 }, durationMs: 5000, testsPassed: 8, userFeedback: 'accepted' }));
    collector.record(makeCard({ stepId: 's2', tokenUsage: { input: 200, output: 300, total: 500 }, durationMs: 3000, testsPassed: 6, userFeedback: 'rejected' }));
    collector.record(makeCard({ stepId: 's3', tokenUsage: { input: 50, output: 100, total: 150 }, durationMs: 2000, testsPassed: 10, userFeedback: 'accepted' }));

    const stats = collector.getAggregateStats();
    expect(stats.totalSteps).toBe(3);
    expect(stats.totalTokens).toBe(950);
    expect(stats.totalDuration).toBe(10000);
    expect(stats.avgTestsPassed).toBeCloseTo((8 + 6 + 10) / 3, 2);
    expect(stats.acceptedRate).toBeCloseTo(2 / 3, 2);
  });

  it('getCard: 获取指定步骤', () => {
    const collector = new ScoreCardCollector();
    collector.record(makeCard({ stepId: 's1' }));
    expect(collector.getCard('s1')?.stepId).toBe('s1');
    expect(collector.getCard('nonexistent')).toBeUndefined();
  });

  it('record: 同 stepId 覆盖', () => {
    const collector = new ScoreCardCollector();
    collector.record(makeCard({ stepId: 's1', userFeedback: 'pending' }));
    collector.record(makeCard({ stepId: 's1', userFeedback: 'accepted' }));
    expect(collector.size).toBe(1);
    expect(collector.getCard('s1')?.userFeedback).toBe('accepted');
  });

  it('formatReport: 格式化报告', () => {
    const collector = new ScoreCardCollector();
    collector.record(makeCard({ stepId: 's1' }));
    const report = collector.formatReport();
    expect(report).toContain('质量报告');
    expect(report).toContain('聚合统计');
    expect(report).toContain('总步骤数: 1');
    expect(report).toContain('步骤明细');
    expect(report).toContain('[s1]');
    expect(report).toContain('coder');
  });

  it('formatReport: 空记录', () => {
    const collector = new ScoreCardCollector();
    const report = collector.formatReport();
    expect(report).toContain('暂无执行记录');
  });

  it('空 collector 的聚合统计', () => {
    const collector = new ScoreCardCollector();
    const stats = collector.getAggregateStats();
    expect(stats.totalSteps).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.acceptedRate).toBe(0);
  });
});

// ============================================================
// 4. StrategySelector 编排策略
// ============================================================

describe('StrategySelector', () => {
  it('13. 复杂度 → 策略映射', () => {
    expect(StrategySelector.selectStrategy('low')).toBe('sequential');
    expect(StrategySelector.selectStrategy('medium')).toBe('parallel');
    expect(StrategySelector.selectStrategy('high')).toBe('adaptive');
  });

  it('14. canParallelize 依赖检测', () => {
    // 所有步骤都有依赖 → 不能并行
    const allDependent: StepWithDependencies[] = [
      { id: 's1', dependencies: ['s0'] },
      { id: 's2', dependencies: ['s1'] },
    ];
    expect(StrategySelector.canParallelize(allDependent)).toBe(false);

    // 有部分步骤无依赖 → 可以并行
    const someIndependent: StepWithDependencies[] = [
      { id: 's1', dependencies: [] },
      { id: 's2', dependencies: [] },
      { id: 's3', dependencies: ['s1'] },
    ];
    expect(StrategySelector.canParallelize(someIndependent)).toBe(true);

    // 单个步骤 → 不能并行
    expect(StrategySelector.canParallelize([{ id: 's1', dependencies: [] }])).toBe(false);
  });

  it('15. getParallelGroups 分组', () => {
    const steps: StepWithDependencies[] = [
      { id: 's1', dependencies: [] },
      { id: 's2', dependencies: [] },
      { id: 's3', dependencies: ['s1'] },
      { id: 's4', dependencies: ['s2', 's3'] },
    ];

    const groups = StrategySelector.getParallelGroups(steps);
    expect(groups.length).toBe(3);
    // 第 0 层：s1, s2（无依赖）
    expect(groups[0].sort()).toEqual(['s1', 's2']);
    // 第 1 层：s3（依赖 s1）
    expect(groups[1]).toEqual(['s3']);
    // 第 2 层：s4（依赖 s2, s3）
    expect(groups[2]).toEqual(['s4']);
  });

  it('getParallelGroups: 空数组', () => {
    expect(StrategySelector.getParallelGroups([])).toEqual([]);
  });

  it('getParallelGroups: 纯串行链', () => {
    const steps: StepWithDependencies[] = [
      { id: 's1', dependencies: [] },
      { id: 's2', dependencies: ['s1'] },
      { id: 's3', dependencies: ['s2'] },
    ];
    const groups = StrategySelector.getParallelGroups(steps);
    expect(groups).toEqual([['s1'], ['s2'], ['s3']]);
  });

  it('DEFAULT_CONFIG: 默认配置正确', () => {
    expect(DEFAULT_CONFIG.strategy).toBe('adaptive');
    expect(DEFAULT_CONFIG.mode).toBe('plan_upfront');
    expect(DEFAULT_CONFIG.maxParallelism).toBe(3);
    expect(DEFAULT_CONFIG.allowRetry).toBe(true);
    expect(DEFAULT_CONFIG.requireReview).toBe(false);
  });

  it('recommendConfig: 根据复杂度推荐配置', () => {
    const lowConfig = StrategySelector.recommendConfig('low', 3);
    expect(lowConfig.strategy).toBe('sequential');
    expect(lowConfig.maxParallelism).toBe(1);

    const highConfig = StrategySelector.recommendConfig('high', 15);
    expect(highConfig.strategy).toBe('adaptive');
    expect(highConfig.maxParallelism).toBe(5);
    expect(highConfig.requireReview).toBe(true);
    expect(highConfig.mode).toBe('conversational');
  });
});

// ============================================================
// 5. VariablePool 变量池扩展（Phase 46 已删除 blackboard-extension.ts）
// ============================================================

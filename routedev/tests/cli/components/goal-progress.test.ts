// tests/cli/components/goal-progress.test.ts
// /goal 进度可视化文本渲染测试（Phase 25 Task 4）

import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  estimateEta,
  countCompleted,
  renderGoalProgressText,
  renderGoalCompletionSummary,
  GOAL_STATUS_ICON,
} from '../../../src/cli/components/goal-progress.js';
import type { GoalPlan, GoalStep } from '../../../src/agent/goal-types.js';

function makePlan(steps: Partial<GoalStep>[]): GoalPlan {
  return {
    id: 'p1',
    description: '重构认证模块',
    status: 'executing',
    createdAt: 0,
    steps: steps.map((s, i) => ({
      id: i + 1,
      description: s.description ?? `步骤 ${i + 1}`,
      status: s.status ?? 'pending',
      dependencies: [],
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    })),
  };
}

describe('goal-progress: formatDuration', () => {
  it('0 秒', () => expect(formatDuration(0)).toBe('0s'));
  it('45 秒', () => expect(formatDuration(45000)).toBe('45s'));
  it('2 分 5 秒', () => expect(formatDuration(125000)).toBe('2m05s'));
  it('负数回退 0s', () => expect(formatDuration(-100)).toBe('0s'));
});

describe('goal-progress: countCompleted', () => {
  it('统计 completed 步骤数', () => {
    const plan = makePlan([{ status: 'completed' }, { status: 'in_progress' }, { status: 'completed' }]);
    expect(countCompleted(plan)).toBe(2);
  });

  it('无完成步骤返回 0', () => {
    const plan = makePlan([{ status: 'pending' }, { status: 'in_progress' }]);
    expect(countCompleted(plan)).toBe(0);
  });
});

describe('goal-progress: estimateEta', () => {
  it('无完成步骤时返回计算中', () => {
    const plan = makePlan([{ status: 'in_progress' }]);
    expect(estimateEta(plan, 1000)).toBe('计算中');
  });

  it('基于平均耗时估算剩余时间', () => {
    const plan = makePlan([
      { status: 'completed', startedAt: 0, completedAt: 10000 },
      { status: 'completed', startedAt: 10000, completedAt: 30000 },
      { status: 'in_progress' },
      { status: 'pending' },
    ]);
    // 已完成平均 15s，剩余 2 步 → 30s
    expect(estimateEta(plan, 30000)).toBe('30s');
  });

  it('全部完成时返回即将完成', () => {
    const plan = makePlan([
      { status: 'completed', startedAt: 0, completedAt: 10000 },
      { status: 'completed', startedAt: 10000, completedAt: 20000 },
    ]);
    expect(estimateEta(plan, 30000)).toBe('即将完成');
  });
});

describe('goal-progress: renderGoalProgressText', () => {
  it('渲染目标标题、进度、进度条', () => {
    const plan = makePlan([
      { status: 'completed', description: '分析代码' },
      { status: 'in_progress', description: '实现 OAuth' },
      { status: 'pending', description: '编写测试' },
    ]);
    const text = renderGoalProgressText(plan, 1000);
    expect(text).toContain('目标: 重构认证模块');
    expect(text).toContain('进度 1/3');
    expect(text).toContain(GOAL_STATUS_ICON.completed);
    expect(text).toContain(GOAL_STATUS_ICON.in_progress);
    expect(text).toContain(GOAL_STATUS_ICON.pending);
    expect(text).toContain('33%');
  });

  it('完成步骤显示耗时', () => {
    const plan = makePlan([
      { status: 'completed', description: '分析代码', startedAt: 0, completedAt: 45000 },
    ]);
    const text = renderGoalProgressText(plan, 45000);
    expect(text).toContain('45s');
  });
});

describe('goal-progress: renderGoalCompletionSummary', () => {
  it('完成摘要包含目标、步骤、耗时', () => {
    const plan: GoalPlan = {
      id: 'p1',
      description: '重构认证模块',
      status: 'completed',
      createdAt: 0,
      completedAt: 125000,
      steps: [
        { id: 1, description: '分析', status: 'completed', dependencies: [] },
        { id: 2, description: '实现', status: 'completed', dependencies: [] },
      ],
    };
    const text = renderGoalCompletionSummary(plan);
    expect(text).toContain('目标: 重构认证模块');
    expect(text).toContain('步骤: 2/2 完成');
    expect(text).toContain('耗时: 2m05s');
    expect(text).toContain('/trace view');
    expect(text).toContain('/cost');
  });

  it('包含验证结果时显示置信度', () => {
    const plan = makePlan([{ status: 'completed' }]);
    plan.verificationResult = {
      passed: true,
      confidence: 0.91,
      reasoning: '所有步骤完成',
      missingItems: [],
      suggestions: [],
    };
    const text = renderGoalCompletionSummary(plan);
    expect(text).toContain('验证: 通过（置信度 91%）');
  });
});

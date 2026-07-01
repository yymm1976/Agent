import { describe, expect, it } from 'vitest';
import type { GoalPlan } from './goal-types.js';
import { StateMigration } from './state-migration.js';

function makePlan(): GoalPlan {
  return {
    id: 'goal-1',
    description: '迁移测试',
    steps: [
      { id: 1, description: '已完成', status: 'completed', dependencies: [], domain: 'backend' },
      { id: 2, description: '失败待重试', status: 'failed', dependencies: [1], domain: 'backend' },
      { id: 3, description: '未开始', status: 'pending', dependencies: [2], domain: 'backend' },
    ],
    difficultyAssessment: { level: 'L2', confidence: 0.8, reasoning: '初始', risks: [] },
    status: 'executing',
    createdAt: 0,
  };
}

describe('StateMigration', () => {
  it('保留已完成步骤并把失败步骤迁回 pending', () => {
    const result = new StateMigration().migrate({
      plan: makePlan(),
      suggestion: { from: 'L2', to: 'L3', reason: '失败触发升级' },
    });

    expect(result.preservedCompletedSteps).toHaveLength(1);
    expect(result.pendingSteps).toHaveLength(2);
    expect(result.plan.steps.find((step) => step.id === 2)?.status).toBe('pending');
    expect(result.plan.difficultyAssessment?.level).toBe('L3');
  });

  it('保留 blackboard snapshot', () => {
    const snapshot = { facts: { module: 'router' }, completedSteps: { '1': 'done' } };
    const result = new StateMigration().migrate({
      plan: makePlan(),
      suggestion: { from: 'L2', to: 'L4', reason: '跨领域升级' },
      blackboardSnapshot: snapshot,
    });

    expect(result.blackboardSnapshot).toEqual(snapshot);
    expect(result.migrationSummary).toContain('L2 → L4');
  });
});

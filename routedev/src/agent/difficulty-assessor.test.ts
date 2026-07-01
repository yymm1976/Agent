import { describe, expect, it } from 'vitest';
import { DifficultyAssessor } from './difficulty-assessor.js';
import type { GoalPlan } from './goal-types.js';

function makePlan(overrides: Partial<GoalPlan> = {}): GoalPlan {
  return {
    id: 'goal-1',
    description: '测试目标',
    steps: [
      { id: 1, description: '步骤 1', status: 'pending', dependencies: [], domain: 'general' },
    ],
    uniqueDomains: ['general'],
    hasDependencies: false,
    status: 'pending',
    createdAt: 0,
    ...overrides,
  };
}

describe('DifficultyAssessor', () => {
  it('解析裸 JSON 难度评估', () => {
    const result = new DifficultyAssessor().parseAssessmentResponse('{"level":"L4","confidence":0.8,"reasoning":"跨领域","suggestedPath":"compose","risks":["风险"]}');

    expect(result.level).toBe('L4');
    expect(result.confidence).toBe(0.8);
    expect(result.suggestedPath).toBe('compose');
    expect(result.risks).toContain('风险');
  });

  it('解析 fenced JSON 难度评估', () => {
    const result = new DifficultyAssessor().parseAssessmentResponse('```json\n{"level":"L3","confidence":0.7,"reasoning":"有依赖"}\n```');

    expect(result.level).toBe('L3');
    expect(result.reasoning).toBe('有依赖');
  });

  it('小型计划会从高等级降级到 L2', () => {
    const assessor = new DifficultyAssessor();
    const result = assessor.refineAssessment({ level: 'L5', confidence: 0.9, reasoning: '初判复杂', risks: [] }, makePlan());

    expect(result.level).toBe('L2');
  });

  it('跨三领域计划至少升级到 L4', () => {
    const assessor = new DifficultyAssessor();
    const plan = makePlan({
      steps: [
        { id: 1, description: '前端', status: 'pending', dependencies: [], domain: 'frontend' },
        { id: 2, description: '后端', status: 'pending', dependencies: [], domain: 'backend' },
        { id: 3, description: '数据库', status: 'pending', dependencies: [], domain: 'database' },
      ],
      uniqueDomains: ['frontend', 'backend', 'database'],
    });
    const result = assessor.refineAssessment({ level: 'L2', confidence: 0.9, reasoning: '初判简单', risks: [] }, plan);

    expect(result.level).toBe('L4');
  });
});

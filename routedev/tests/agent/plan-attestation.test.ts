import { describe, expect, it } from 'vitest';
import type { GoalPlan } from '../../src/agent/goal-types.js';
import { archiveCurrentPlan, attestPlan, computePlanHash, verifyPlanAttestation } from '../../src/agent/plan-attestation.js';

function makePlan(overrides: Partial<GoalPlan> = {}): GoalPlan {
  return {
    id: 'goal-1',
    description: '完成 Phase 55',
    verificationCriteria: '测试通过',
    steps: [
      {
        id: 1,
        description: '实现签名',
        status: 'pending',
        dependencies: [],
        domain: 'general',
      },
    ],
    status: 'pending',
    createdAt: 1000,
    ...overrides,
  };
}

describe('PlanAttestation', () => {
  it('相同计划生成稳定 hash', () => {
    expect(computePlanHash(makePlan())).toBe(computePlanHash(makePlan()));
  });

  it('步骤变化会导致 hash 改变', () => {
    const before = makePlan();
    const after = makePlan({
      steps: [{ ...makePlan().steps[0], description: '实现签名并归档' }],
    });

    expect(computePlanHash(before)).not.toBe(computePlanHash(after));
  });

  it('签署后可通过校验，篡改后失败', () => {
    const plan = makePlan();
    attestPlan(plan, 'user_confirm');
    expect(verifyPlanAttestation(plan)).toBe(true);

    plan.steps[0].description = '被篡改';
    expect(verifyPlanAttestation(plan)).toBe(false);
  });

  it('归档当前版本并重新签署会递增版本', () => {
    const plan = makePlan();
    const first = attestPlan(plan, 'user_confirm');
    const archived = archiveCurrentPlan(plan, 'user_edit');
    plan.steps[0].description = '实现签名并归档';
    const second = attestPlan(plan, 'user_confirm');

    expect(archived?.attestation.hash).toBe(first.hash);
    expect(plan.archivedVersions).toHaveLength(1);
    expect(second.version).toBe(2);
    expect(verifyPlanAttestation(plan)).toBe(true);
  });
});

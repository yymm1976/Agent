// tests/agent/path-router.test.ts
// Phase 58：统一 PathRouter 单元测试（合并 execution-router + level-path-router 测试）
//
// 覆盖：
//   难度路由 selectPath（4 个）：
//     1. L1/L2 → single
//     2. L3 → dag
//     3. L4 → compose
//     4. L5 → compose + researcher/critic 阶段
//
//   启发式路由 route（5 个）：
//     5. 1 步无依赖单领域 → single
//     6. 2 步无依赖单领域 → single
//     7. 5 步有依赖单领域 → dag
//     8. 5 步跨领域 → compose
//     9. mode=explicit + explicitRoute=single → single
//
//   动态升降级 detectLevelSwitch（3 个）：
//     10. failureCount>=2 → 升级
//     11. crossDomain 且 L1/L2/L3 → 升级到 L4
//     12. 无信号 → null
//
// Phase 58：原 execution-router.test.ts 的 mode=legacy 测试已删除（legacy 路径移除）

import { describe, it, expect } from 'vitest';
import { PathRouter, type ExecutionRouterOptions } from '../../src/agent/path-router.js';
import type { Domain, GoalPlan, GoalStep } from '../../src/agent/goal-types.js';

// ============================================================
// 辅助函数
// ============================================================

/** 构造 GoalStep */
function makeStep(id: number, domain: Domain, dependencies: number[] = []): GoalStep {
  return {
    id,
    description: `step ${id}`,
    status: 'pending',
    dependencies,
    domain,
  };
}

/** 构造 GoalPlan */
function makePlan(
  steps: GoalStep[],
  uniqueDomains: Domain[],
  hasDependencies: boolean,
): GoalPlan {
  return {
    id: 'test-plan',
    description: 'test goal',
    steps,
    uniqueDomains,
    hasDependencies,
    status: 'pending',
    createdAt: 0,
  };
}

/** 默认 auto 模式选项 */
const AUTO_OPTIONS: ExecutionRouterOptions = {
  mode: 'auto',
  singleAgentMaxSteps: 2,
  dagMaxDomains: 1,
};

// ============================================================
// 测试
// ============================================================

describe('Phase 58: PathRouter 难度路由 selectPath', () => {
  const router = new PathRouter();

  it('1. L1/L2 → single', () => {
    expect(router.selectPath('L1').route).toBe('single');
    expect(router.selectPath('L2').route).toBe('single');
  });

  it('2. L3 → dag', () => {
    expect(router.selectPath('L3').route).toBe('dag');
  });

  it('3. L4 → compose', () => {
    expect(router.selectPath('L4').route).toBe('compose');
  });

  it('4. L5 → compose + researcher/critic 阶段', () => {
    const l5 = router.selectPath('L5');
    expect(l5.route).toBe('compose');
    expect(l5.preStages).toContain('researcher');
    expect(l5.postStages).toContain('critic');
  });
});

describe('Phase 58: PathRouter 启发式路由 route', () => {
  const router = new PathRouter();

  it('5. 1 步无依赖单领域 → single', () => {
    const plan = makePlan([makeStep(1, 'general')], ['general'], false);
    expect(router.route(plan, AUTO_OPTIONS)).toBe('single');
  });

  it('6. 2 步无依赖单领域 → single', () => {
    const plan = makePlan(
      [makeStep(1, 'general'), makeStep(2, 'general')],
      ['general'],
      false,
    );
    expect(router.route(plan, AUTO_OPTIONS)).toBe('single');
  });

  it('7. 5 步有依赖单领域 → dag', () => {
    const plan = makePlan(
      [
        makeStep(1, 'backend'),
        makeStep(2, 'backend', [1]),
        makeStep(3, 'backend', [2]),
        makeStep(4, 'backend', [3]),
        makeStep(5, 'backend', [4]),
      ],
      ['backend'],
      true,
    );
    expect(router.route(plan, AUTO_OPTIONS)).toBe('dag');
  });

  it('8. 5 步跨领域 → compose', () => {
    const plan = makePlan(
      [
        makeStep(1, 'frontend'),
        makeStep(2, 'backend', [1]),
        makeStep(3, 'database', [2]),
        makeStep(4, 'frontend', [3]),
        makeStep(5, 'backend', [4]),
      ],
      ['frontend', 'backend', 'database'],
      true,
    );
    expect(router.route(plan, AUTO_OPTIONS)).toBe('compose');
  });

  it('9. mode=explicit + explicitRoute=single → single（不论 plan 内容）', () => {
    // 即使是 5 步跨领域 plan，显式指定 single
    const plan = makePlan(
      [
        makeStep(1, 'frontend'),
        makeStep(2, 'backend', [1]),
        makeStep(3, 'database', [2]),
        makeStep(4, 'frontend', [3]),
        makeStep(5, 'backend', [4]),
      ],
      ['frontend', 'backend', 'database'],
      true,
    );
    expect(
      router.route(plan, { ...AUTO_OPTIONS, mode: 'explicit', explicitRoute: 'single' }),
    ).toBe('single');
  });
});

describe('Phase 58: PathRouter 动态升降级 detectLevelSwitch', () => {
  const router = new PathRouter();

  it('10. failureCount>=2 → 升级到下一级', () => {
    const suggestion = router.detectLevelSwitch('L2', {
      failureCount: 2,
      contextUsagePercent: 0.4,
      crossDomain: false,
      unresolvedBlockers: 0,
    });
    expect(suggestion?.from).toBe('L2');
    expect(suggestion?.to).toBe('L3');
  });

  it('11. crossDomain 且 L1/L2/L3 → 升级到 L4', () => {
    const suggestion = router.detectLevelSwitch('L2', {
      failureCount: 0,
      contextUsagePercent: 0.4,
      crossDomain: true,
      unresolvedBlockers: 0,
    });
    expect(suggestion?.from).toBe('L2');
    expect(suggestion?.to).toBe('L4');
  });

  it('12. 无信号 → null', () => {
    const suggestion = router.detectLevelSwitch('L2', {
      failureCount: 0,
      contextUsagePercent: 0.4,
      crossDomain: false,
      unresolvedBlockers: 0,
    });
    expect(suggestion).toBeNull();
  });
});

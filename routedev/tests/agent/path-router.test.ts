// tests/agent/path-router.test.ts
// Phase 58：统一 PathRouter 单元测试（合并 execution-router + level-path-router 测试）
// Phase 60：补边界测试（explicit+compose / 0 步 / 边界值 / goal-runner 决策模拟）
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
//   Phase 60 边界测试（6 个）：
//     13. mode=explicit + explicitRoute=compose → compose（补全 explicit 路径覆盖）
//     14. 0 步 plan → single（防边界崩溃）
//     15. detectLevelSwitch contextUsagePercent=0.84 → 不触发（边界值，<0.85）
//     16. detectLevelSwitch contextUsagePercent=0.85 → 触发（边界值，>=0.85）
//     17. goal-runner 决策模拟：difficultyRouting.enabled + L4 → compose
//     18. goal-runner 决策模拟：无 difficultyAssessment → 启发式 route
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

// ============================================================
// Phase 60：边界测试补强
// ============================================================

describe('Phase 60: PathRouter 边界测试', () => {
  const router = new PathRouter();

  it('13. mode=explicit + explicitRoute=compose → compose（补全 explicit 路径覆盖）', () => {
    // 即使是 1 步单领域 plan，显式指定 compose
    const plan = makePlan([makeStep(1, 'general')], ['general'], false);
    expect(
      router.route(plan, { ...AUTO_OPTIONS, mode: 'explicit', explicitRoute: 'compose' }),
    ).toBe('compose');
  });

  it('14. 0 步 plan → single（防边界崩溃）', () => {
    // 空步骤列表应返回 single，不崩溃
    const plan = makePlan([], [], false);
    expect(router.route(plan, AUTO_OPTIONS)).toBe('single');
  });

  it('15. detectLevelSwitch contextUsagePercent=0.84 → 不触发（边界值，<0.85）', () => {
    const suggestion = router.detectLevelSwitch('L2', {
      failureCount: 0,
      contextUsagePercent: 0.84,
      crossDomain: false,
      unresolvedBlockers: 0,
    });
    expect(suggestion).toBeNull();
  });

  it('16. detectLevelSwitch contextUsagePercent=0.85 → 触发升级（边界值，>=0.85）', () => {
    const suggestion = router.detectLevelSwitch('L2', {
      failureCount: 0,
      contextUsagePercent: 0.85,
      crossDomain: false,
      unresolvedBlockers: 0,
    });
    expect(suggestion).not.toBeNull();
    expect(suggestion?.from).toBe('L2');
    expect(suggestion?.to).toBe('L3');
  });
});

// ============================================================
// Phase 60：goal-runner 路径选择决策模拟
// 模拟 goal-runner.ts 的路径选择逻辑（不依赖 goal-runner 重型依赖）：
//   优先级：难度路由（difficultyRouting.enabled + plan.difficultyAssessment）
//         > route() 启发式 > 默认 'single'
// ============================================================

describe('Phase 60: goal-runner 路径选择决策模拟', () => {
  const router = new PathRouter();

  it('17. difficultyRouting.enabled + L4 难度评估 → compose 路径', () => {
    // 模拟 goal-runner：difficultyRouting.enabled=true 且 plan.difficultyAssessment.level='L4'
    // 走 router.selectPath('L4') → compose
    const selection = router.selectPath('L4');
    expect(selection.route).toBe('compose');
    // goal-runner 取 .route 字段作为最终路径
    const route = selection.route;
    expect(route).toBe('compose');
  });

  it('18. 无 difficultyAssessment → 启发式 route（auto 模式）', () => {
    // 模拟 goal-runner：difficultyRouting.enabled=false 或 plan.difficultyAssessment=undefined
    // 走 router.route(plan, options) 启发式
    const plan = makePlan(
      [makeStep(1, 'backend'), makeStep(2, 'backend', [1]), makeStep(3, 'backend', [2])],
      ['backend'],
      true,
    );
    const route = router.route(plan, AUTO_OPTIONS);
    expect(route).toBe('dag'); // 3 步有依赖单领域 → dag
  });
});

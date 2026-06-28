// src/agent/execution-router.test.ts
// Phase 55 Task 3：ExecutionRouter 路径判定器单元测试
//
// 覆盖 6 个判定分支：
//   1. 1 步无依赖单领域 → single
//   2. 2 步无依赖单领域 → single
//   3. 5 步有依赖单领域 → dag
//   4. 5 步跨领域（frontend + backend + database）→ compose
//   5. mode=legacy → legacy（不论 plan 内容）
//   6. mode=explicit + explicitRoute=single → single（不论 plan 内容）
//
// 纯函数测试，不依赖 LLM 或文件系统。

import { describe, it, expect } from 'vitest';
import { ExecutionRouter, type ExecutionRouterOptions } from './execution-router.js';
import type { Domain, GoalPlan, GoalStep } from './goal-types.js';

/** 构造 GoalStep 的辅助函数，填充必填字段 */
function makeStep(id: number, domain: Domain, dependencies: number[] = []): GoalStep {
  return {
    id,
    description: `step ${id}`,
    status: 'pending',
    dependencies,
    domain,
  };
}

/** 构造 GoalPlan 的辅助函数 */
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

describe('Phase 55 Task 3: ExecutionRouter 路径判定器', () => {
  const router = new ExecutionRouter();

  it('1. 1 步无依赖单领域 → single', () => {
    const plan = makePlan([makeStep(1, 'general')], ['general'], false);
    expect(router.route(plan, AUTO_OPTIONS)).toBe('single');
  });

  it('2. 2 步无依赖单领域 → single', () => {
    const plan = makePlan(
      [makeStep(1, 'general'), makeStep(2, 'general')],
      ['general'],
      false,
    );
    expect(router.route(plan, AUTO_OPTIONS)).toBe('single');
  });

  it('3. 5 步有依赖单领域 → dag', () => {
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

  it('4. 5 步跨领域（frontend + backend + database）→ compose', () => {
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

  it('5. mode=legacy → legacy（不论 plan 内容）', () => {
    // 即使是跨领域复杂 plan，强制 legacy
    const plan = makePlan(
      [
        makeStep(1, 'frontend'),
        makeStep(2, 'backend', [1]),
        makeStep(3, 'database', [2]),
      ],
      ['frontend', 'backend', 'database'],
      true,
    );
    expect(router.route(plan, { ...AUTO_OPTIONS, mode: 'legacy' })).toBe('legacy');
  });

  it('6. mode=explicit + explicitRoute=single → single（不论 plan 内容）', () => {
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

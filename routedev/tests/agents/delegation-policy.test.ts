// tests/agents/delegation-policy.test.ts
// Phase 51 Task 3：委托策略 delegation-policy.ts 单元测试
//
// 覆盖关键能力：
//   1. classifyTask 关键词双命中规则（action + artifact 同时命中才返回对应类型）
//   2. decideDelegation 三态决策（allow / delegate / refuse / 降级）
//   3. createDelegationGuard 写工具硬拦截 + 读工具放行
//
// 全部为纯函数测试，不依赖 LLM 或文件系统。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyTask,
  decideDelegation,
  canDelegate,
  createDelegationGuard,
  TASK_TYPE_KEYWORDS,
  type DelegationMode,
} from '../../src/agents/delegation-policy.js';

// 测试用的策略对象工厂
function makePolicy(overrides: {
  hardDelegationTypes?: string[];
  refuseIfSpecialistUnavailable?: boolean;
  specialistAvailability?: Record<string, boolean>;
} = {}) {
  return {
    hardDelegationTypes: overrides.hardDelegationTypes ?? ['frontend', 'research', 'review'],
    refuseIfSpecialistUnavailable: overrides.refuseIfSpecialistUnavailable ?? false,
    specialistAvailability: overrides.specialistAvailability ?? {
      researcher: true,
      executor: true,
      reviewer: true,
      custom: true,
    },
  };
}

describe('Phase 51 Task 3: delegation-policy 单元测试', () => {
  beforeEach(() => {
    // 纯函数无状态，无需重置；保留 beforeEach 以隔离测试用例
  });

  // ============================================================
  // 1. classifyTask 双命中规则
  // ============================================================

  it('1.1 classifyTask: frontend 类型——action(build) + artifact(component) 双命中', () => {
    expect(classifyTask('build a login component')).toBe('frontend');
    expect(classifyTask('create dashboard page')).toBe('frontend');
    expect(classifyTask('implement new modal widget')).toBe('frontend');
  });

  it('1.2 classifyTask: research 类型——action(search) + artifact(architecture) 双命中', () => {
    expect(classifyTask('search the codebase for usage patterns')).toBe('research');
    expect(classifyTask('investigate architecture dependency')).toBe('research');
    expect(classifyTask('analyze codebase convention')).toBe('research');
  });

  it('1.3 classifyTask: review 类型——action(review) + artifact(code) 双命中', () => {
    expect(classifyTask('review the code in src/')).toBe('review');
    expect(classifyTask('audit recent commit diff')).toBe('review');
    expect(classifyTask('check pull-request changes')).toBe('review');
  });

  it('1.4 classifyTask: 单组命中不触发——"review the architecture" 应为 general', () => {
    // review actions 含 'review'，但 review artifacts 不含 'architecture'
    // research artifacts 含 'architecture'，但 research actions 不含 'review'
    // → 无任何 TaskType 双命中 → general
    expect(classifyTask('review the architecture')).toBe('general');
    expect(classifyTask('search the code')).toBe('general'); // search 命中 research action，但 'code' 不在 research artifacts
    expect(classifyTask('build the database')).toBe('general'); // build 命中 frontend action，但 'database' 不在 frontend artifacts
  });

  it('1.5 classifyTask: 完全无关文本返回 general', () => {
    expect(classifyTask('write documentation')).toBe('general');
    expect(classifyTask('fix a typo')).toBe('general');
    expect(classifyTask('')).toBe('general');
  });

  it('1.6 TASK_TYPE_KEYWORDS: 关键词表覆盖三类任务类型', () => {
    expect(Object.keys(TASK_TYPE_KEYWORDS)).toEqual(['frontend', 'research', 'review']);
    expect(TASK_TYPE_KEYWORDS.frontend.actions).toContain('build');
    expect(TASK_TYPE_KEYWORDS.frontend.artifacts).toContain('component');
    expect(TASK_TYPE_KEYWORDS.research.actions).toContain('search');
    expect(TASK_TYPE_KEYWORDS.research.artifacts).toContain('architecture');
    expect(TASK_TYPE_KEYWORDS.review.actions).toContain('review');
    expect(TASK_TYPE_KEYWORDS.review.artifacts).toContain('code');
  });

  // ============================================================
  // 2. decideDelegation 三态决策
  // ============================================================

  it('2.1 decideDelegation: allow 模式——通用任务由主 Agent 自己执行', () => {
    const policy = makePolicy();
    const result = decideDelegation('write documentation', policy);
    expect(result.mode).toBe('allow' as DelegationMode);
    expect(result.reason).toContain('通用任务');
    expect(result.targetRole).toBeUndefined();
  });

  it('2.2 decideDelegation: delegate 模式——硬委派类型 + 专家可用', () => {
    const policy = makePolicy({
      hardDelegationTypes: ['frontend'],
      specialistAvailability: { researcher: false, executor: true, reviewer: false, custom: true },
    });
    const result = decideDelegation('build login component', policy);
    expect(result.mode).toBe('delegate');
    expect(result.targetRole).toBe('executor'); // frontend → executor
    expect(result.reason).toContain('硬委派');
  });

  it('2.3 decideDelegation: refuse 模式——硬委派类型 + 专家不可用 + refuseIfUnavailable=true', () => {
    const policy = makePolicy({
      hardDelegationTypes: ['research'],
      refuseIfSpecialistUnavailable: true,
      specialistAvailability: { researcher: false, executor: true, reviewer: true, custom: true },
    });
    const result = decideDelegation('search codebase architecture', policy);
    expect(result.mode).toBe('refuse');
    expect(result.reason).toContain('专家不可用');
    expect(result.nextStep).toBeDefined();
    expect(result.nextStep).toContain('researcher');
  });

  it('2.4 decideDelegation: 降级模式——硬委派类型 + 专家不可用 + refuseIfUnavailable=false', () => {
    const policy = makePolicy({
      hardDelegationTypes: ['review'],
      refuseIfSpecialistUnavailable: false,
      specialistAvailability: { researcher: true, executor: true, reviewer: false, custom: true },
    });
    const result = decideDelegation('review code changes', policy);
    expect(result.mode).toBe('allow');
    expect(result.reason).toContain('降级');
  });

  it('2.5 decideDelegation: 非硬委派类型——即使专家可用也由主 Agent 执行', () => {
    const policy = makePolicy({
      hardDelegationTypes: ['frontend'], // 仅 frontend 硬委派
      specialistAvailability: { researcher: true, executor: true, reviewer: true, custom: true },
    });
    // review 类型不在 hardDelegationTypes 中 → allow
    const result = decideDelegation('review the code', policy);
    expect(result.mode).toBe('allow');
    expect(result.reason).toContain('未标记为硬委派');
  });

  // ============================================================
  // 3. canDelegate 四维约束（Task 2 纯函数部分）
  // ============================================================

  it('3.1 canDelegate: 深度未超 + 目标合法 → ok=true 且 nextDepth 递增', () => {
    const result = canDelegate(0, 'executor', 'researcher', {
      maxDepth: 2,
      delegationTargets: {
        executor: ['researcher', 'reviewer'],
        researcher: [],
        reviewer: [],
        custom: [],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.nextDepth).toBe(1);
  });

  it('3.2 canDelegate: 深度超限 → ok=false 且 reason 含最大深度', () => {
    const result = canDelegate(2, 'executor', 'researcher', {
      maxDepth: 2,
      delegationTargets: { executor: ['researcher'], researcher: [], reviewer: [], custom: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('最大委托深度');
  });

  it('3.3 canDelegate: 目标不合法 → ok=false 且 reason 含允许列表', () => {
    const result = canDelegate(0, 'executor', 'custom', {
      maxDepth: 2,
      delegationTargets: { executor: ['researcher'], researcher: [], reviewer: [], custom: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('不允许委派');
    expect(result.reason).toContain('researcher');
  });

  // ============================================================
  // 4. createDelegationGuard 写工具硬拦截
  // ============================================================

  it('4.1 createDelegationGuard: 写工具(edit/write/bash)在 delegate 模式下被拦截', () => {
    const guard = createDelegationGuard(makePolicy({
      hardDelegationTypes: ['frontend'],
      specialistAvailability: { researcher: true, executor: true, reviewer: true, custom: true },
    }));

    // "build login component" 是 frontend 类型，硬委派 + 专家可用 → delegate
    // edit/write/bash 应被拦截
    for (const toolName of ['edit', 'write', 'bash']) {
      const result = guard(toolName, 'build login component');
      expect(result.block).toBe(true);
      expect(result.reason).toContain('spawn_agent');
    }
  });

  it('4.2 createDelegationGuard: 写工具在 refuse 模式下被拦截且 reason 含委托策略', () => {
    const guard = createDelegationGuard(makePolicy({
      hardDelegationTypes: ['frontend'],
      refuseIfSpecialistUnavailable: true,
      specialistAvailability: { researcher: true, executor: false, reviewer: true, custom: true },
    }));

    // frontend → executor specialist 不可用 + refuseIfUnavailable=true → refuse
    const result = guard('write', 'build login component');
    expect(result.block).toBe(true);
    expect(result.reason).toContain('委托策略拦截');
  });

  it('4.3 createDelegationGuard: 读工具(read/grep/glob)始终放行（即使任务被硬委派）', () => {
    const guard = createDelegationGuard(makePolicy({
      hardDelegationTypes: ['frontend'],
      specialistAvailability: { researcher: true, executor: true, reviewer: true, custom: true },
    }));

    // 即使任务为 delegate 模式，读工具也应放行
    for (const toolName of ['read', 'grep', 'glob']) {
      const result = guard(toolName, 'build login component');
      expect(result.block).toBe(false);
      expect(result.reason).toBeUndefined();
    }
  });

  it('4.4 createDelegationGuard: 通用任务下写工具也放行（mode=allow）', () => {
    const guard = createDelegationGuard(makePolicy());
    // 通用任务 → allow → 写工具放行
    const result = guard('write', 'write documentation');
    expect(result.block).toBe(false);
  });

  it('4.5 createDelegationGuard: 返回的拦截器是纯函数，不持有外部可变状态', () => {
    const guard1 = createDelegationGuard(makePolicy());
    const guard2 = createDelegationGuard(makePolicy());
    // 两次调用相同输入应得到一致结果
    expect(guard1('read', 'write docs')).toEqual(guard2('read', 'write docs'));
    expect(guard1('write', 'write docs')).toEqual(guard2('write', 'write docs'));
  });
});

// tests/agent/context/plan-state.test.ts
// Phase 71 Task E2：PlanState 单元测试
import { describe, it, expect } from 'vitest';
import { createVFS } from '../../../src/agent/context/virtual-fs.js';
import { PlanState, type Plan, type PlanStep } from '../../../src/agent/context/plan-state.js';

/** 构造测试用 plan */
function makePlan(): Plan {
  return {
    id: 'plan-1',
    goal: '实装 plan 状态',
    status: 'in_progress',
    createdAt: 1000,
    updatedAt: 1000,
    steps: [
      { id: 's1', description: '步骤1', status: 'completed' },
      { id: 's2', description: '步骤2', status: 'in_progress', dependsOn: ['s1'] },
      { id: 's3', description: '步骤3', status: 'pending', dependsOn: ['s2'] },
    ],
  };
}

describe('PlanState', () => {
  it('setPlan + getPlan 往返：写入后能读取到相同数据', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    const plan = makePlan();

    state.setPlan(plan);
    const got = state.getPlan();

    expect(got).not.toBeNull();
    expect(got!.id).toBe('plan-1');
    expect(got!.goal).toBe('实装 plan 状态');
    expect(got!.status).toBe('in_progress');
    expect(got!.createdAt).toBe(1000);
    expect(got!.steps).toHaveLength(3);
    expect(got!.steps[0].id).toBe('s1');
    expect(got!.steps[1].dependsOn).toEqual(['s1']);
  });

  it('updateStep 修改步骤字段（部分更新）', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    state.updateStep('s2', { description: '更新后的步骤2', status: 'completed' });
    const got = state.getPlan();

    expect(got!.steps[1].description).toBe('更新后的步骤2');
    expect(got!.steps[1].status).toBe('completed');
    // 未更新的字段保留
    expect(got!.steps[1].dependsOn).toEqual(['s1']);
    // updatedAt 被刷新
    expect(got!.updatedAt).toBeGreaterThanOrEqual(makePlan().updatedAt);
  });

  it('addStep 追加步骤到末尾', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    const newStep: PlanStep = {
      id: 's4',
      description: '步骤4',
      status: 'pending',
      dependsOn: ['s3'],
    };
    state.addStep(newStep);

    const got = state.getPlan();
    expect(got!.steps).toHaveLength(4);
    expect(got!.steps[3].id).toBe('s4');
    expect(got!.steps[3].description).toBe('步骤4');
  });

  it('removeStep 删除指定步骤', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    state.removeStep('s2');
    const got = state.getPlan();

    expect(got!.steps).toHaveLength(2);
    expect(got!.steps.find((s) => s.id === 's2')).toBeUndefined();
    expect(got!.steps.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('getPlan 无 plan 时返回 null', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    expect(state.getPlan()).toBeNull();
  });

  it('JSON 解析失败时 fail-open 返回 null', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);

    // 直接通过 VFS 写入非法 JSON，模拟 plan 文件损坏
    vfs.write('/plan/current.json', '{这不是合法 JSON');
    expect(state.getPlan()).toBeNull();
  });

  it('updateStep / addStep / removeStep 在无 plan 时静默忽略（fail-open）', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);

    // 无 plan 时调用所有 mutating 方法，不应抛异常
    expect(() => {
      state.updateStep('s1', { status: 'completed' });
      state.addStep({ id: 's1', description: 'x', status: 'pending' });
      state.removeStep('s1');
    }).not.toThrow();

    // 仍然无 plan
    expect(state.getPlan()).toBeNull();
  });

  it('updateStep / removeStep step 不存在时静默忽略', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    // 不存在的 stepId：不应抛异常，plan 数据不变
    expect(() => {
      state.updateStep('not-exist', { status: 'completed' });
      state.removeStep('not-exist');
    }).not.toThrow();

    const got = state.getPlan();
    expect(got!.steps).toHaveLength(3);
    expect(got!.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('复用同一 VFS 实例：PlanState 与外部 VFS 读写共享 /plan/current.json', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);

    state.setPlan(makePlan());

    // 通过 VFS 直接读取 plan 文件应得到 JSON 字符串
    const raw = vfs.read('/plan/current.json');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Plan;
    expect(parsed.id).toBe('plan-1');

    // 通过 VFS 直接覆盖 plan 文件，PlanState 应读到新内容
    const newPlan: Plan = {
      id: 'plan-2',
      goal: '外部写入',
      status: 'pending',
      createdAt: 2000,
      updatedAt: 2000,
      steps: [],
    };
    vfs.write('/plan/current.json', JSON.stringify(newPlan));
    expect(state.getPlan()!.id).toBe('plan-2');
  });
});

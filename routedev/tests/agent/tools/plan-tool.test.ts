// tests/agent/tools/plan-tool.test.ts
// Phase 71 Task E2：plan 工具单元测试
import { describe, it, expect } from 'vitest';
import { createVFS } from '../../../src/agent/context/virtual-fs.js';
import { PlanState, type Plan, type PlanStep } from '../../../src/agent/context/plan-state.js';
import {
  PlanGetTool,
  PlanSetTool,
  PlanUpdateStepTool,
  PlanAddStepTool,
  PlanRemoveStepTool,
} from '../../../src/agent/tools/plan-tool.js';
import type { ToolExecutionContext } from '../../../src/tools/types.js';

// 测试用的空执行上下文（plan 工具不读取 context，但 ITool 接口要求）
const fakeContext: ToolExecutionContext = {
  workingDirectory: '/tmp',
  allowedDirectories: ['/tmp'],
  environment: {},
  timeoutMs: 1000,
};

/** 构造测试用 plan */
function makePlan(): Plan {
  return {
    id: 'plan-1',
    goal: '通过工具操作 plan',
    status: 'in_progress',
    createdAt: 1000,
    updatedAt: 1000,
    steps: [
      { id: 's1', description: '步骤1', status: 'completed' },
      { id: 's2', description: '步骤2', status: 'in_progress' },
    ],
  };
}

describe('Plan 工具集', () => {
  it('plan_get 工具调用：无 plan 时返回空字符串 + hasPlan=false', async () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    const tool = new PlanGetTool(state);

    const result = await tool.execute({}, fakeContext);
    expect(result.success).toBe(true);
    expect(result.output).toBe('');
    expect(result.metadata?.hasPlan).toBe(false);
  });

  it('plan_set + plan_get 工具调用：写入后能读取到 plan', async () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    const setTool = new PlanSetTool(state);
    const getTool = new PlanGetTool(state);

    const plan = makePlan();
    const setResult = await setTool.execute({ plan }, fakeContext);
    expect(setResult.success).toBe(true);
    expect(setResult.output).toContain('plan-1');

    const getResult = await getTool.execute({}, fakeContext);
    expect(getResult.success).toBe(true);
    expect(getResult.metadata?.hasPlan).toBe(true);
    expect(getResult.metadata?.stepCount).toBe(2);

    const parsed = JSON.parse(getResult.output) as Plan;
    expect(parsed.id).toBe('plan-1');
    expect(parsed.steps).toHaveLength(2);
  });

  it('plan_update_step 工具调用：更新步骤字段', async () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    const tool = new PlanUpdateStepTool(state);
    const result = await tool.execute(
      { stepId: 's2', update: { status: 'completed', description: '已完成步骤2' } },
      fakeContext,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('s2');

    const plan = state.getPlan();
    expect(plan!.steps[1].status).toBe('completed');
    expect(plan!.steps[1].description).toBe('已完成步骤2');
  });

  it('plan_add_step 工具调用：追加步骤到末尾', async () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    const tool = new PlanAddStepTool(state);
    const newStep: PlanStep = {
      id: 's3',
      description: '步骤3',
      status: 'pending',
      dependsOn: ['s2'],
    };
    const result = await tool.execute({ step: newStep }, fakeContext);
    expect(result.success).toBe(true);
    expect(result.output).toContain('s3');

    const plan = state.getPlan();
    expect(plan!.steps).toHaveLength(3);
    expect(plan!.steps[2].id).toBe('s3');
  });

  it('plan_remove_step 工具调用：删除指定步骤', async () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    const tool = new PlanRemoveStepTool(state);
    const result = await tool.execute({ stepId: 's1' }, fakeContext);
    expect(result.success).toBe(true);
    expect(result.output).toContain('s1');

    const plan = state.getPlan();
    expect(plan!.steps).toHaveLength(1);
    expect(plan!.steps.find((s) => s.id === 's1')).toBeUndefined();
  });

  it('plan_get 工具调用：有 plan 时返回 JSON + hasPlan=true + stepCount', async () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    state.setPlan(makePlan());

    const tool = new PlanGetTool(state);
    const result = await tool.execute({}, fakeContext);
    expect(result.success).toBe(true);
    expect(result.metadata?.hasPlan).toBe(true);
    expect(result.metadata?.stepCount).toBe(2);
    // 输出为合法 JSON
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it('validateArgs：缺少必需参数返回 valid=false', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);

    expect(new PlanSetTool(state).validateArgs({}).valid).toBe(false);
    expect(new PlanUpdateStepTool(state).validateArgs({}).valid).toBe(false);
    expect(new PlanUpdateStepTool(state).validateArgs({ stepId: 's1' }).valid).toBe(false); // 缺 update
    expect(new PlanAddStepTool(state).validateArgs({}).valid).toBe(false);
    expect(new PlanRemoveStepTool(state).validateArgs({}).valid).toBe(false);
  });

  it('definition：5 个工具名称符合规范 + system 类别 + 无需确认', () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);
    const tools = [
      new PlanGetTool(state),
      new PlanSetTool(state),
      new PlanUpdateStepTool(state),
      new PlanAddStepTool(state),
      new PlanRemoveStepTool(state),
    ];
    const names = tools.map((t) => t.definition.name);
    expect(names).toEqual([
      'plan_get',
      'plan_set',
      'plan_update_step',
      'plan_add_step',
      'plan_remove_step',
    ]);
    for (const t of tools) {
      expect(t.definition.category).toBe('system');
      expect(t.definition.requiresApproval).toBe(false);
    }
  });

  it('fail-open：无 plan 时 update/add/remove 仍返回 success=true', async () => {
    const vfs = createVFS();
    const state = new PlanState(vfs);

    const updateTool = new PlanUpdateStepTool(state);
    const addTool = new PlanAddStepTool(state);
    const removeTool = new PlanRemoveStepTool(state);

    const updateResult = await updateTool.execute(
      { stepId: 's1', update: { status: 'completed' } },
      fakeContext,
    );
    expect(updateResult.success).toBe(true);
    expect(updateResult.output).toContain('无 plan');

    const addResult = await addTool.execute(
      { step: { id: 's1', description: 'x', status: 'pending' } },
      fakeContext,
    );
    expect(addResult.success).toBe(true);
    expect(addResult.output).toContain('无 plan');

    const removeResult = await removeTool.execute({ stepId: 's1' }, fakeContext);
    expect(removeResult.success).toBe(true);
    expect(removeResult.output).toContain('无 plan');

    // 确认状态仍为无 plan
    expect(state.getPlan()).toBeNull();
  });
});

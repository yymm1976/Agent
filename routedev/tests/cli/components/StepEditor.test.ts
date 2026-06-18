// tests/cli/components/StepEditor.test.ts
// StepEditor 组件测试（Phase 20 Task 4）
// 测试 reduce 状态转移函数（纯函数，无需渲染 Ink 组件）

import { describe, it, expect } from 'vitest';
import { createInitialState, reduce } from '../../../src/cli/components/StepEditor.js';
import type { GoalPlan } from '../../../src/agent/goal-types.js';

function createTestPlan(steps: Array<{ id: number; description: string }>): GoalPlan {
  return {
    id: 'test-plan',
    description: '测试计划',
    steps: steps.map(s => ({
      id: s.id,
      description: s.description,
      status: 'pending' as const,
      dependencies: [],
    })),
    status: 'pending',
    createdAt: Date.now(),
  };
}

const samplePlan = createTestPlan([
  { id: 1, description: '读取文件' },
  { id: 2, description: '修改代码' },
  { id: 3, description: '运行测试' },
  { id: 4, description: '提交更改' },
  { id: 5, description: '推送代码' },
]);

describe('StepEditor reduce', () => {
  it('初始状态包含 5 个步骤，光标在第 0 位', () => {
    const state = createInitialState(samplePlan);
    expect(state.steps.length).toBe(5);
    expect(state.cursorIndex).toBe(0);
    expect(state.isEditing).toBe(false);
    expect(state.pendingDelete).toBe(false);
  });

  it('删除步骤后 steps 减少 1（二次确认机制）', () => {
    let state = createInitialState(samplePlan);
    expect(state.steps.length).toBe(5);

    // 第一次按 d：请求删除（pendingDelete = true）
    state = reduce(state, { type: 'delete_request' });
    expect(state.pendingDelete).toBe(true);
    expect(state.steps.length).toBe(5); // 尚未删除

    // 第二次按 d：确认删除
    state = reduce(state, { type: 'delete_confirm' });
    expect(state.pendingDelete).toBe(false);
    expect(state.steps.length).toBe(4); // 删除了 1 个
  });

  it('重排步骤后顺序变化，dependencies 不自动更新', () => {
    let state = createInitialState(samplePlan);
    // 移动光标到第 1 位（id=2 "修改代码"）
    state = reduce(state, { type: 'navigate_down' });
    expect(state.cursorIndex).toBe(1);

    // 上移
    state = reduce(state, { type: 'reorder_up' });
    expect(state.cursorIndex).toBe(0);
    expect(state.steps[0].description).toBe('修改代码');
    expect(state.steps[1].description).toBe('读取文件');
    // dependencies 不变
    expect(state.steps[0].dependencies).toEqual([]);
  });

  it('编辑步骤描述后 description 更新', () => {
    let state = createInitialState(samplePlan);

    // 进入编辑模式
    state = reduce(state, { type: 'edit_start' });
    expect(state.isEditing).toBe(true);
    expect(state.editBuffer).toBe('读取文件');

    // 清空并输入新文本
    state = reduce(state, { type: 'edit_backspace' });
    state = reduce(state, { type: 'edit_backspace' });
    state = reduce(state, { type: 'edit_backspace' });
    state = reduce(state, { type: 'edit_backspace' });
    state = reduce(state, { type: 'edit_type', char: '新描述' });

    // 确认编辑
    state = reduce(state, { type: 'edit_confirm' });
    expect(state.isEditing).toBe(false);
    expect(state.steps[0].description).toBe('新描述');
  });

  it('导航上下移动光标', () => {
    let state = createInitialState(samplePlan);
    expect(state.cursorIndex).toBe(0);

    // 下移
    state = reduce(state, { type: 'navigate_down' });
    expect(state.cursorIndex).toBe(1);
    state = reduce(state, { type: 'navigate_down' });
    expect(state.cursorIndex).toBe(2);

    // 上移
    state = reduce(state, { type: 'navigate_up' });
    expect(state.cursorIndex).toBe(1);

    // 边界：不能小于 0
    state = reduce(state, { type: 'navigate_up' });
    state = reduce(state, { type: 'navigate_up' });
    expect(state.cursorIndex).toBe(0);

    // 边界：不能大于 steps.length - 1
    state = reduce(state, { type: 'navigate_down' });
    state = reduce(state, { type: 'navigate_down' });
    state = reduce(state, { type: 'navigate_down' });
    state = reduce(state, { type: 'navigate_down' });
    state = reduce(state, { type: 'navigate_down' }); // 超出
    expect(state.cursorIndex).toBe(4);
  });
});

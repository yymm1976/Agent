// src/cli/components/StepEditor.tsx
// 步骤列表编辑器：交互式 Ink 组件，在 /goal 计划生成后展示（蓝图第七节 7.3）
// 支持键盘导航、编辑、删除、重排、确认/取消

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { GoalPlan, PlanStep } from '../../agent/goal-types.js';
import { StepCard } from './StepCard.js';

export interface StepEditorProps {
  /** 初始计划 */
  plan: GoalPlan;
  /** 用户确认后的回调（传入修改后的步骤列表） */
  onConfirm: (steps: PlanStep[]) => void;
  /** 用户取消的回调 */
  onCancel: () => void;
}

/** 编辑器内部状态 */
export interface StepEditorState {
  steps: PlanStep[];
  cursorIndex: number;
  isEditing: boolean;
  editBuffer: string;
  pendingDelete: boolean;
}

/** 创建初始状态 */
export function createInitialState(plan: GoalPlan): StepEditorState {
  return {
    steps: plan.steps.map(s => ({ ...s })),
    cursorIndex: 0,
    isEditing: false,
    editBuffer: '',
    pendingDelete: false,
  };
}

/** 键盘动作类型 */
export type StepEditorAction =
  | { type: 'navigate_up' }
  | { type: 'navigate_down' }
  | { type: 'edit_start' }
  | { type: 'edit_type'; char: string }
  | { type: 'edit_backspace' }
  | { type: 'edit_confirm' }
  | { type: 'edit_cancel' }
  | { type: 'delete_request' }
  | { type: 'delete_confirm' }
  | { type: 'delete_cancel' }
  | { type: 'reorder_up' }
  | { type: 'reorder_down' }
  | { type: 'confirm_plan' }
  | { type: 'cancel_plan' };

/** 状态转移函数（纯函数，可独立测试） */
export function reduce(state: StepEditorState, action: StepEditorAction): StepEditorState {
  const { steps, cursorIndex } = state;

  switch (action.type) {
    case 'navigate_up':
      if (state.isEditing) return state;
      return { ...state, cursorIndex: Math.max(0, cursorIndex - 1), pendingDelete: false };

    case 'navigate_down':
      if (state.isEditing) return state;
      return { ...state, cursorIndex: Math.min(steps.length - 1, cursorIndex + 1), pendingDelete: false };

    case 'edit_start': {
      if (state.isEditing || steps.length === 0) return state;
      return { ...state, isEditing: true, editBuffer: steps[cursorIndex].description, pendingDelete: false };
    }

    case 'edit_type':
      if (!state.isEditing) return state;
      return { ...state, editBuffer: state.editBuffer + action.char };

    case 'edit_backspace':
      if (!state.isEditing) return state;
      return { ...state, editBuffer: state.editBuffer.slice(0, -1) };

    case 'edit_confirm': {
      if (!state.isEditing) return state;
      const newSteps = steps.map((s, i) => i === cursorIndex ? { ...s, description: state.editBuffer } : s);
      return { ...state, steps: newSteps, isEditing: false, editBuffer: '' };
    }

    case 'edit_cancel':
      return { ...state, isEditing: false, editBuffer: '' };

    case 'delete_request':
      if (state.isEditing || steps.length === 0) return state;
      return { ...state, pendingDelete: true };

    case 'delete_confirm': {
      if (!state.pendingDelete) return state;
      if (steps.length <= 1) return { ...state, pendingDelete: false }; // 至少保留 1 步
      const newSteps = steps.filter((_, i) => i !== cursorIndex);
      const newCursor = Math.min(cursorIndex, newSteps.length - 1);
      return { ...state, steps: newSteps, cursorIndex: newCursor, pendingDelete: false };
    }

    case 'delete_cancel':
      return { ...state, pendingDelete: false };

    case 'reorder_up': {
      if (state.isEditing || cursorIndex === 0) return state;
      const newSteps = [...steps];
      [newSteps[cursorIndex - 1], newSteps[cursorIndex]] = [newSteps[cursorIndex], newSteps[cursorIndex - 1]];
      return { ...state, steps: newSteps, cursorIndex: cursorIndex - 1, pendingDelete: false };
    }

    case 'reorder_down': {
      if (state.isEditing || cursorIndex === steps.length - 1) return state;
      const newSteps = [...steps];
      [newSteps[cursorIndex], newSteps[cursorIndex + 1]] = [newSteps[cursorIndex + 1], newSteps[cursorIndex]];
      return { ...state, steps: newSteps, cursorIndex: cursorIndex + 1, pendingDelete: false };
    }

    case 'confirm_plan':
    case 'cancel_plan':
      return state;

    default:
      return state;
  }
}

export function StepEditor({ plan, onConfirm, onCancel }: StepEditorProps) {
  const [state, setState] = useState<StepEditorState>(() => createInitialState(plan));

  useInput((char, key) => {
    // 编辑模式下的键盘处理
    if (state.isEditing) {
      if (key.return) { setState(s => reduce(s, { type: 'edit_confirm' })); return; }
      if (key.escape) { setState(s => reduce(s, { type: 'edit_cancel' })); return; }
      if (key.backspace || key.delete) { setState(s => reduce(s, { type: 'edit_backspace' })); return; }
      if (char && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        setState(s => reduce(s, { type: 'edit_type', char })); return;
      }
      return;
    }

    // 非编辑模式下的键盘处理
    if (key.upArrow && key.meta) { setState(s => reduce(s, { type: 'reorder_up' })); return; }
    if (key.downArrow && key.meta) { setState(s => reduce(s, { type: 'reorder_down' })); return; }
    if (key.upArrow || char === 'k') { setState(s => reduce(s, { type: 'navigate_up' })); return; }
    if (key.downArrow || char === 'j') { setState(s => reduce(s, { type: 'navigate_down' })); return; }
    if (key.return) { onConfirm(state.steps); return; }
    if (key.escape) { onCancel(); return; }

    // 删除（二次确认）
    if (char === 'd') {
      if (state.pendingDelete) {
        setState(s => reduce(s, { type: 'delete_confirm' }));
      } else {
        setState(s => reduce(s, { type: 'delete_request' }));
      }
      return;
    }

    // 编辑
    if (char === 'e') { setState(s => reduce(s, { type: 'edit_start' })); return; }

    // 取消删除确认
    if (state.pendingDelete && char !== 'd') {
      setState(s => reduce(s, { type: 'delete_cancel' }));
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>📋 计划编辑器 — {plan.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.steps.map((step, i) => (
          <StepCard
            key={step.id}
            step={step}
            index={i + 1}
            isSelected={i === state.cursorIndex}
            total={state.steps.length}
          />
        ))}
      </Box>
      {state.isEditing && (
        <Box marginTop={1}>
          <Text color="yellow">✏️ 编辑: </Text>
          <Text>{state.editBuffer}</Text>
          <Text color="gray">▌</Text>
        </Box>
      )}
      {state.pendingDelete && (
        <Box marginTop={1}><Text color="red">⚠️ 再按 d 确认删除（其他键取消）</Text></Box>
      )}
      <Box marginTop={1}><Text color="gray">↑↓ 导航 | e 编辑 | d 删除 | Alt+↑↓ 重排 | Enter 确认 | Esc 取消</Text></Box>
    </Box>
  );
}

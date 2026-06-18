// src/cli/components/StepCard.tsx
// 步骤卡片组件：渲染单个 PlanStep，显示状态、描述、依赖关系（蓝图第七节 7.3）
// 纯展示组件，由父组件 StepEditor 控制选中/编辑行为

import React from 'react';
import { Box, Text } from 'ink';
import type { PlanStep, StepStatus } from '../../agent/goal-types.js';
import { formatDuration } from './goal-progress.js';

export interface StepCardProps {
  /** 步骤数据 */
  step: PlanStep;
  /** 显示序号（从 1 开始） */
  index: number;
  /** 是否被选中（编辑模式） */
  isSelected: boolean;
  /** 步骤总数（用于进度显示） */
  total: number;
  /** 当前时间戳（用于计算进行中步骤的耗时，可选） */
  now?: number;
}

/** 状态 → 图标映射（Phase 25：使用更直观的 emoji/符号） */
export const STATUS_ICON: Record<StepStatus, string> = {
  pending: '⬚',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  skipped: '[-]',
};

/** 状态 → 颜色映射 */
export const STATUS_COLOR: Record<StepStatus, string> = {
  pending: 'gray',
  in_progress: 'yellow',
  completed: 'green',
  failed: 'red',
  skipped: 'gray',
};

/** skipped 状态需要 dim */
function isDim(status: StepStatus): boolean {
  return status === 'skipped';
}

/** 截断描述到 60 字符 */
export function truncateDescription(desc: string): string {
  if (desc.length <= 60) return desc;
  return desc.slice(0, 60) + '...';
}

/** 计算步骤已用/耗时 */
function getStepDuration(step: PlanStep, now?: number): string | null {
  if (step.status === 'in_progress' && step.startedAt) {
    return formatDuration((now ?? Date.now()) - step.startedAt);
  }
  if ((step.status === 'completed' || step.status === 'failed') && step.startedAt && step.completedAt) {
    return formatDuration(step.completedAt - step.startedAt);
  }
  return null;
}

export function StepCard({ step, index, isSelected, total, now }: StepCardProps) {
  const icon = STATUS_ICON[step.status];
  const color = STATUS_COLOR[step.status];
  const dim = isDim(step.status);
  const desc = truncateDescription(step.description);
  const deps = step.dependencies.length > 0 ? `deps: ${step.dependencies.join(',')}` : '';
  const prefix = isSelected ? '>' : ' ';
  const duration = getStepDuration(step, now);

  return (
    <Box>
      <Text color={isSelected ? 'cyan' : 'gray'}>{prefix}</Text>
      <Text color="gray">{index}/{total} </Text>
      <Text color={color} dimColor={dim} bold={step.status === 'in_progress'}>{icon} </Text>
      <Text color={color} dimColor={dim}>{desc}</Text>
      {duration && <Text color="gray" dimColor> ({duration})</Text>}
      {deps && <Text color="gray" dimColor> ({deps})</Text>}
    </Box>
  );
}

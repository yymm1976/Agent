// src/cli/components/StepCard.tsx
// 步骤卡片组件：渲染单个 PlanStep，显示状态、描述、依赖关系（蓝图第七节 7.3）
// 纯展示组件，由父组件 StepEditor 控制选中/编辑行为
// Phase 34 P1：接入 outputStyle 控制描述截断长度与附加信息可见性

import React from 'react';
import { Box, Text } from 'ink';
import type { PlanStep, StepStatus } from '../../agent/goal-types.js';
import type { OutputStyle } from '../../config/schema.js';
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
  /** Phase 34 P1：输出样式，控制描述截断与附加信息，默认 standard */
  outputStyle?: OutputStyle;
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

/**
 * 截断描述到指定字符数
 * Phase 34 P1：根据 outputStyle 决定截断长度
 * - minimal：40 字符
 * - standard：60 字符（默认，向后兼容）
 * - verbose：不截断
 */
export function truncateDescription(desc: string, maxLen = 60): string {
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen) + '...';
}

/** Phase 34 P1：根据 outputStyle 获取描述最大长度，verbose 返回 Infinity 表示不截断 */
function getMaxDescLength(style: OutputStyle): number {
  switch (style) {
    case 'minimal':
      return 40;
    case 'verbose':
      return Number.POSITIVE_INFINITY;
    case 'standard':
    default:
      return 60;
  }
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

export function StepCard({ step, index, isSelected, total, now, outputStyle = 'standard' }: StepCardProps) {
  const icon = STATUS_ICON[step.status];
  const color = STATUS_COLOR[step.status];
  const dim = isDim(step.status);
  // Phase 34 P1：根据 outputStyle 截断描述
  const maxLen = getMaxDescLength(outputStyle);
  const desc = truncateDescription(step.description, maxLen);
  // Phase 34 P1：minimal 模式下隐藏依赖关系，仅显示状态与描述
  const showDeps = outputStyle !== 'minimal';
  const deps = showDeps && step.dependencies.length > 0 ? `deps: ${step.dependencies.join(',')}` : '';
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

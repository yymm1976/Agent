// src/cli/components/goal-progress.ts
// /goal 进度可视化文本渲染（Phase 25 Task 4）
// 将 GoalPlan 渲染为可在 addSystemMessage 中使用的进度总览文本

import type { GoalPlan, GoalStep, StepStatus } from '../../agent/goal-types.js';
import { renderProgressBar } from './ProgressBar.js';

/** 步骤状态 → 可视化图标（与 Phase 25 设计规范对齐） */
export const GOAL_STATUS_ICON: Record<StepStatus, string> = {
  pending: '⬚',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  skipped: '[-]',
};

/** 步骤状态 → 中文标签 */
export const GOAL_STATUS_LABEL: Record<StepStatus, string> = {
  pending: '待执行',
  in_progress: '进行中',
  completed: '完成',
  failed: '失败',
  skipped: '已跳过',
};

/** 格式化耗时为可读字符串 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

/** 估算剩余时间：基于已完成步骤的平均耗时 × 剩余步骤数 */
export function estimateEta(plan: GoalPlan, now = Date.now()): string {
  const completedSteps = plan.steps.filter(
    s => s.status === 'completed' && s.startedAt !== undefined && s.completedAt !== undefined,
  );
  if (completedSteps.length === 0) return '计算中';

  const totalElapsed = completedSteps.reduce((sum, s) => sum + ((s.completedAt as number) - (s.startedAt as number)), 0);
  const avgTime = totalElapsed / completedSteps.length;
  const remainingSteps = plan.steps.filter(s => s.status !== 'completed' && s.status !== 'skipped').length;
  if (remainingSteps <= 0) return '即将完成';

  return formatDuration(avgTime * remainingSteps);
}

/** 计算已完成的步骤数 */
export function countCompleted(plan: GoalPlan): number {
  return plan.steps.filter(s => s.status === 'completed').length;
}

/** 渲染单个步骤行 */
function renderStepLine(step: GoalStep, index: number, total: number, now: number): string {
  const icon = GOAL_STATUS_ICON[step.status];
  const label = GOAL_STATUS_LABEL[step.status];
  const desc = step.description.length > 34 ? `${step.description.slice(0, 34)}...` : step.description;
  let timeStr = '';

  if (step.status === 'in_progress' && step.startedAt !== undefined) {
    timeStr = formatDuration(now - step.startedAt);
  } else if (
    (step.status === 'completed' || step.status === 'failed') &&
    step.startedAt !== undefined &&
    step.completedAt !== undefined
  ) {
    timeStr = formatDuration(step.completedAt - step.startedAt);
  }

  const timePart = timeStr ? `  ${timeStr}` : '';
  const line = `${icon} ${index.toString().padStart(2, '0')}. ${desc.padEnd(36)} ${label}${timePart}`;
  return line.slice(0, 80);
}

/** 渲染 /goal 进度总览文本 */
export function renderGoalProgressText(plan: GoalPlan, now = Date.now()): string {
  const completed = countCompleted(plan);
  const total = plan.steps.length;
  const progressBar = renderProgressBar(completed, total, 35);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const eta = estimateEta(plan, now);

  const lines: string[] = [
    `┌─ 目标: ${plan.description} ─── 进度 ${completed}/${total} ─── ETA ${eta} ──┐`,
    '',
  ];

  for (let i = 0; i < plan.steps.length; i++) {
    lines.push(`  ${renderStepLine(plan.steps[i], i + 1, total, now)}`);
  }

  lines.push('');
  lines.push(`  ${progressBar}  ${percent}%`);
  lines.push('└────────────────────────────────────────────────────────────────────┘');

  return lines.join('\n');
}

/** 渲染任务完成摘要 */
export function renderGoalCompletionSummary(plan: GoalPlan): string {
  const totalSteps = plan.steps.length;
  const completedSteps = countCompleted(plan);
  const failedSteps = plan.steps.filter(s => s.status === 'failed').length;
  const durationMs =
    plan.completedAt !== undefined && plan.createdAt !== undefined ? plan.completedAt - plan.createdAt : 0;

  const lines = [
    '┌─ ✅ 目标完成 ────────────────────────────────────┐',
    '',
    `  目标: ${plan.description}`,
    `  步骤: ${completedSteps}/${totalSteps} 完成${failedSteps > 0 ? `（${failedSteps} 个失败）` : ''}`,
    `  耗时: ${formatDuration(durationMs)}`,
  ];

  if (plan.verificationResult) {
    const v = plan.verificationResult;
    lines.push(`  验证: ${v.passed ? '通过' : '未通过'}（置信度 ${(v.confidence * 100).toFixed(0)}%）`);
  }

  lines.push('');
  lines.push('  📋 运行 /trace view 查看完整执行链路');
  lines.push('  📊 运行 /cost 查看本次会话费用详情');
  lines.push('└────────────────────────────────────────────────────┘');

  return lines.join('\n');
}

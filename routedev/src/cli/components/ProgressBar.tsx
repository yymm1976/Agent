// src/cli/components/ProgressBar.tsx
// 通用进度条组件（Phase 25 Task 4）
// 使用 Unicode block 字符 + 设计系统语义色

import React from 'react';
import { Box, Text } from 'ink';
import { getColor, type SemanticColor } from '../design-system.js';

export interface ProgressBarProps {
  /** 当前进度 */
  current: number;
  /** 总进度 */
  total: number;
  /** 条形宽度（字符数，默认 35） */
  width?: number;
  /** 语义颜色（默认 primary） */
  color?: SemanticColor;
  /** 是否显示百分比 */
  showPercent?: boolean;
}

const FILLED = '█';
const EMPTY = '░';

/** 渲染进度条文本 */
export function renderProgressBar(
  current: number,
  total: number,
  width = 35,
): string {
  if (total <= 0) {
    return FILLED.repeat(width);
  }
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
}

/** ProgressBar：通用进度条 */
export function ProgressBar({ current, total, width = 35, color = 'primary', showPercent = true }: ProgressBarProps) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const percent = Math.round(ratio * 100);
  const bar = renderProgressBar(current, total, width);

  return (
    <Box>
      <Text color={getColor(color)}>{bar}</Text>
      {showPercent && <Text>  {percent}%</Text>}
    </Box>
  );
}

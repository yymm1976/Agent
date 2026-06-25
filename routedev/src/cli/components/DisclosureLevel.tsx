// src/cli/components/DisclosureLevel.tsx
// 渐进披露组件（Phase 25 Task 3）
// 按层级显示信息：L1 摘要 → L2 关键细节 → L3 完整数据
// 设计原则：不要一次把所有信息扔给用户，先给摘要，按需展开

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getColor } from '../design-system.js';
import type { OutputStyle } from '../../config/schema.js';
import { outputStyleToDisclosureLevel } from '../output-style.js';

/** 披露层级：1 摘要 / 2 关键细节 / 3 完整数据 */
export type DisclosureLevel = 1 | 2 | 3;

/** 分层内容 */
export interface DisclosureContent {
  /** L1：一句话摘要（必须有） */
  l1: string;
  /** L2：关键细节（可选） */
  l2?: string;
  /** L3：完整数据（可选） */
  l3?: string;
}

export interface DisclosureProps {
  /** 当前内容 */
  content: DisclosureContent;
  /** 默认显示层级（未指定则使用 L1） */
  defaultLevel?: DisclosureLevel;
  /** 当前受控层级（如提供则覆盖内部状态） */
  level?: DisclosureLevel;
  /** 层级变化回调 */
  onLevelChange?: (level: DisclosureLevel) => void;
  /** Phase 34：输出样式，用于自动映射默认披露层级 */
  outputStyle?: OutputStyle;
}

/** DisclosureLevel：渐进披露容器 */
export function DisclosureLevel({
  content,
  defaultLevel = 1,
  level: controlledLevel,
  onLevelChange,
  outputStyle,
}: DisclosureProps) {
  // Phase 34：若提供 outputStyle，用它映射默认层级；否则尊重 defaultLevel
  const resolvedDefault = outputStyle
    ? outputStyleToDisclosureLevel(outputStyle)
    : defaultLevel;
  const [internalLevel, setInternalLevel] = useState<DisclosureLevel>(resolvedDefault);
  const level = controlledLevel ?? internalLevel;
  const hasL2 = content.l2 !== undefined && content.l2.length > 0;
  const hasL3 = content.l3 !== undefined && content.l3.length > 0;
  const expandable = hasL2 || hasL3;

  useInput((char, _key) => {
    if (!expandable) return;
    if (char === 'd' || char === 'D') {
      const next = level < 3 ? ((level + 1) as DisclosureLevel) : 1;
      if (controlledLevel === undefined) {
        setInternalLevel(next);
      }
      onLevelChange?.(next);
    }
  });

  const currentText = level === 3 && hasL3 ? content.l3 : level === 2 && hasL2 ? content.l2 : content.l1;

  return (
    <Box flexDirection="column">
      <Text>{currentText}</Text>
      {expandable && (
        <Text color={getColor('info')} dimColor>
          {'  '}层级 {level}/3 — 按 d 切换详情
        </Text>
      )}
    </Box>
  );
}

/** 将 DisclosureContent 渲染为指定层级的纯文本（供命令系统使用） */
export function renderDisclosureText(content: DisclosureContent, level: DisclosureLevel = 2): string {
  if (level === 3 && content.l3) return content.l3;
  if (level >= 2 && content.l2) return content.l2;
  return content.l1;
}

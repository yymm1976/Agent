// src/cli/components/ResumePicker.tsx
// 恢复执行选择器：交互式选择可恢复的执行快照（Phase 27 Task 6）
// 使用 Ink 的 useInput hook 实现键盘导航：↑↓ 选择 · Enter 恢复 · Esc 取消

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getColor } from '../design-system.js';
import type { ExecutionSnapshot } from '../../agent/durable-executor.js';

// ============================================================
// 类型定义
// ============================================================

export interface ResumePickerProps {
  /** 可恢复的执行快照列表 */
  snapshots: ExecutionSnapshot[];
  /** 选择恢复某个快照时回调 */
  onResume: (planId: string) => void;
  /** 取消选择时回调 */
  onCancel: () => void;
}

// ============================================================
// 辅助函数（供命令和测试使用）
// ============================================================

/** 格式化时间戳为本地时间字符串 */
export function formatSnapshotTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN');
}

/** 格式化单个快照为一行摘要文本 */
export function formatSnapshotLine(snapshot: ExecutionSnapshot, index: number): string {
  const status = snapshot.status === 'paused' ? '⏸ 暂停' : '❌ 失败';
  const progress = `${snapshot.lastStepCompleted}/${snapshot.totalSteps}`;
  const goal = snapshot.goal.slice(0, 40);
  return `  ${index + 1}. [${snapshot.planId}] ${status} | 进度 ${progress} | ${goal}`;
}

/** 将快照列表渲染为纯文本（供 /resume 命令非交互模式使用） */
export function renderSnapshotListText(snapshots: ExecutionSnapshot[]): string {
  if (snapshots.length === 0) {
    return '无可恢复的执行。所有计划已完成或未启动。';
  }

  const header = `┌─ 可恢复的执行 (${snapshots.length}) ──────────────────┐`;
  const footer = '└───────────────────────────────────────────────────┘';
  const hint = '提示: 使用 /resume <planId> 恢复指定执行';
  const body = snapshots.map((s, i) => formatSnapshotLine(s, i)).join('\n');
  return [header, body, footer, hint].join('\n');
}

// ============================================================
// Ink 组件
// ============================================================

/** ResumePicker：交互式恢复选择器 */
export function ResumePicker({ snapshots, onResume, onCancel }: ResumePickerProps) {
  const [selected, setSelected] = useState(0);

  // 空列表友好提示
  if (snapshots.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={getColor('info')}>无可恢复的执行。所有计划已完成或未启动。</Text>
      </Box>
    );
  }

  useInput((_char, key) => {
    if (key.upArrow) {
      setSelected(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelected(prev => Math.min(snapshots.length - 1, prev + 1));
    } else if (key.return) {
      // Enter 恢复选中的快照
      const snapshot = snapshots[selected];
      if (snapshot) onResume(snapshot.planId);
    } else if (key.escape) {
      // Esc 取消
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={getColor('primary')} bold>
        ┌─ 可恢复的执行 ({snapshots.length}) ──────────────────┐
      </Text>
      {snapshots.map((snapshot, idx) => {
        const isSelected = idx === selected;
        const marker = isSelected ? '▶' : ' ';
        const color = isSelected ? getColor('accent') : getColor('info');
        const status = snapshot.status === 'paused' ? '⏸ 暂停' : '❌ 失败';
        const progress = `${snapshot.lastStepCompleted}/${snapshot.totalSteps}`;
        const goal = snapshot.goal.slice(0, 40);
        return (
          <Box key={snapshot.planId}>
            <Text color={color}>{marker} </Text>
            <Text color={color}>
              {idx + 1}. [{snapshot.planId}] {status} | 进度 {progress} | {goal}
            </Text>
          </Box>
        );
      })}
      <Text color={getColor('primary')} bold>└───────────────────────────────────────────────────┘</Text>
      <Text color={getColor('info')}>
        ↑↓ 选择 · Enter 恢复 · Esc 取消
      </Text>
    </Box>
  );
}

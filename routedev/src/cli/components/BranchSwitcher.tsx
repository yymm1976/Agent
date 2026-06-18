// src/cli/components/BranchSwitcher.tsx
// 分支切换器：可视化展示对话分支树（Phase 25 Task 1）
// 同时提供 Ink 组件和纯文本渲染函数，命令系统可直接使用文本版本

import React from 'react';
import { Box, Text } from 'ink';
import type { BranchInfo } from '../../agent/branch.js';
import { getColor } from '../design-system.js';

// ============================================================
// 类型定义
// ============================================================

export interface BranchSwitcherProps {
  /** 分支列表（由 BranchManager.listBranches() 提供） */
  branches: BranchInfo[];
  /** 当前活跃分支 ID */
  activeBranchId: string | null;
  /** 每页最大显示数量（默认 10） */
  pageSize?: number;
  /** 当前页码（从 0 开始） */
  page?: number;
}

// ============================================================
// 辅助函数
// ============================================================

/** 将时间戳格式化为相对时间（如 "2分钟前"） */
export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

/** 构建分支 ID → 子分支列表的映射 */
function buildChildrenMap(branches: BranchInfo[]): Map<string | null, BranchInfo[]> {
  const map = new Map<string | null, BranchInfo[]>();
  for (const branch of branches) {
    const key = branch.parentId ?? null;
    const list = map.get(key) ?? [];
    list.push(branch);
    map.set(key, list);
  }
  // 每个父节点下的子分支按创建时间升序排列
  for (const list of map.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return map;
}

/** 递归渲染分支树文本 */
function renderBranchTreeLines(
  branches: BranchInfo[],
  activeBranchId: string | null,
  parentId: string | null = null,
  prefix = '',
): string[] {
  const childrenMap = buildChildrenMap(branches);
  const children = childrenMap.get(parentId) ?? [];
  const lines: string[] = [];

  for (let i = 0; i < children.length; i++) {
    const branch = children[i];
    const isLast = i === children.length - 1;
    const connector = parentId === null ? '' : isLast ? '└─ ' : '├─ ';
    const marker = branch.id === activeBranchId ? '●' : '○';
    const line = `${prefix}${connector}${marker} ${branch.name} ─── ${branch.messageCount} 条消息 ─── ${formatRelativeTime(branch.lastActiveAt)}`;
    lines.push(line);

    const childPrefix = parentId === null ? '' : prefix + (isLast ? '   ' : '│  ');
    lines.push(...renderBranchTreeLines(branches, activeBranchId, branch.id, childPrefix));
  }

  return lines;
}

/** 渲染分支树纯文本（供 /branch 命令使用） */
export function renderBranchTreeText(
  branches: BranchInfo[],
  activeBranchId: string | null,
  page = 0,
  pageSize = 10,
): string {
  if (branches.length === 0) {
    return '没有分支。在消息前输入 /branch edit 可以创建分支。';
  }

  const allLines = renderBranchTreeLines(branches, activeBranchId);
  const totalPages = Math.ceil(allLines.length / pageSize);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * pageSize;
  const visibleLines = allLines.slice(start, start + pageSize);

  const header = `┌─ 对话分支 ──────────────────────────────────────┐`;
  const footer = `└───────────────────────────────────────────────────┘`;
  const operations = '操作: /branch switch <name> | /branch create <n>\n      /branch delete <name> | /branch merge <n>';
  const pagination = totalPages > 1 ? `页 ${currentPage + 1}/${totalPages}` : '';

  const body = visibleLines.map(l => `  ${l}`).join('\n');
  return [header, body, footer, operations, pagination].filter(Boolean).join('\n');
}

// ============================================================
// Ink 组件
// ============================================================

/** BranchSwitcher：分支树可视化组件 */
export function BranchSwitcher({ branches, activeBranchId, page = 0, pageSize = 10 }: BranchSwitcherProps) {
  if (branches.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={getColor('info')}>没有分支。在消息前输入 /branch edit 可以创建分支。</Text>
      </Box>
    );
  }

  const childrenMap = buildChildrenMap(branches);

  /** 递归渲染 Ink 节点 */
  function renderInkNodes(parentId: string | null, prefix = ''): React.ReactNode[] {
    const children = childrenMap.get(parentId) ?? [];
    const nodes: React.ReactNode[] = [];

    for (let i = 0; i < children.length; i++) {
      const branch = children[i];
      const isLast = i === children.length - 1;
      const connector = parentId === null ? '' : isLast ? '└─ ' : '├─ ';
      const marker = branch.id === activeBranchId ? '●' : '○';
      const markerColor = branch.id === activeBranchId ? getColor('primary') : getColor('info');

      nodes.push(
        <Box key={branch.id}>
          <Text>{prefix}{connector}</Text>
          <Text color={markerColor}>{marker}</Text>
          <Text> {branch.name} ─── {branch.messageCount} 条消息 ─── {formatRelativeTime(branch.lastActiveAt)}</Text>
        </Box>,
      );

      const childPrefix = parentId === null ? '' : prefix + (isLast ? '   ' : '│  ');
      nodes.push(...renderInkNodes(branch.id, childPrefix));
    }

    return nodes;
  }

  const allLines = renderBranchTreeLines(branches, activeBranchId);
  const totalPages = Math.ceil(allLines.length / pageSize);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * pageSize;
  const visibleNodes = renderInkNodes(null).filter((_, idx) => idx >= start && idx < start + pageSize);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={getColor('primary')} bold>┌─ 对话分支 ──────────────────────────────────────┐</Text>
      {visibleNodes}
      <Text color={getColor('primary')} bold>└───────────────────────────────────────────────────┘</Text>
      <Text color={getColor('info')}>操作: /branch switch {'<name>'} | /branch create {'<n>'}</Text>
      <Text color={getColor('info')}>      /branch delete {'<name>'} | /branch merge {'<n>'}</Text>
      {totalPages > 1 && (
        <Text color={getColor('info')}>页 {currentPage + 1}/{totalPages}</Text>
      )}
    </Box>
  );
}

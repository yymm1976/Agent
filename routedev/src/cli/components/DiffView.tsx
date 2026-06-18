// src/cli/components/DiffView.tsx
// 差异视图：在终端中可视化 unified diff（Phase 25 Task 6）
// 支持行号、颜色区分、分页、逐行审查提示
// Phase 27 Task 5：[A]/[R]/[S] 动作绑定，通过回调与外部工具执行器联动

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getColor } from '../design-system.js';

// ============================================================
// 类型定义
// ============================================================

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  fileName: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffViewProps {
  diff: string;
  fileName?: string;
  pageSize?: number;
  /** [A] 全部接受回调：将 diff 内容通过 git apply 应用到工作目录 */
  onApplyDiff?: (patch: string) => void | Promise<void>;
  /** [R] 全部拒绝回调：丢弃 diff 内容，不做任何文件修改 */
  onRejectDiff?: () => void;
}

/** 逐 hunk 审查模式下的用户决策 */
export type HunkDecision = 'accept' | 'reject' | 'skip';

/** 逐 hunk 审查模式下的视图状态 */
export type DiffViewMode = 'browse' | 'review';

// ============================================================
// diff 解析
// ============================================================

/**
 * 解析 unified diff 文本
 * 返回结构化数据：文件名、新增/删除统计、hunk 列表
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split('\n');
  let fileName = '';
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;

  for (const rawLine of lines) {
    // 文件头
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      const match = rawLine.match(/^\+\+\+ [\"']?[ab]\/(.+?)[\"']?$/);
      if (match) fileName = match[1];
      continue;
    }

    // hunk 头
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = parseInt(hunkMatch[2] ?? '1', 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] ?? '1', 10);
      oldLine = oldStart;
      newLine = newStart;
      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        header: hunkMatch[5].trim(),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    const typeChar = rawLine.charAt(0);
    const content = rawLine.slice(1);
    let type: DiffLineType = 'context';

    if (typeChar === '+') {
      type = 'add';
      additions++;
      currentHunk.lines.push({ type, content, oldLineNo: null, newLineNo: newLine });
      newLine++;
    } else if (typeChar === '-') {
      type = 'del';
      deletions++;
      currentHunk.lines.push({ type, content, oldLineNo: oldLine, newLineNo: null });
      oldLine++;
    } else if (typeChar === ' ') {
      type = 'context';
      currentHunk.lines.push({ type, content, oldLineNo: oldLine, newLineNo: newLine });
      oldLine++;
      newLine++;
    } else if (typeChar === '\\') {
      // "\ No newline at end of file" 标记，作为上下文行追加
      currentHunk.lines.push({ type: 'context', content: rawLine, oldLineNo: null, newLineNo: null });
    }
  }

  if (currentHunk) hunks.push(currentHunk);

  return { fileName, additions, deletions, hunks };
}

/** 统计所有 hunk 的可见行数 */
export function countDiffLines(hunks: DiffHunk[]): number {
  return hunks.reduce((sum, h) => sum + h.lines.length, 0);
}

/**
 * 将选中的 hunk 列表重建为合法的 unified diff 补丁字符串
 * 用于 [S] 逐行审查模式：用户接受的 hunk 合并为 patch，再通过 git apply 应用
 *
 * @param fileName 目标文件名（用于补丁头）
 * @param hunks 选中的 hunk 列表
 * @returns 合并后的 patch 文本；空列表返回空字符串
 */
export function buildPatchFromHunks(fileName: string, hunks: DiffHunk[]): string {
  if (hunks.length === 0) return '';
  const header = `--- a/${fileName}\n+++ b/${fileName}`;
  const body = hunks.map(h => {
    const oldCount = h.oldCount;
    const newCount = h.newCount;
    const hunkHeader = `@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@${h.header ? ' ' + h.header : ''}`;
    const lines = h.lines.map(l => {
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      return `${sign}${l.content}`;
    });
    return [hunkHeader, ...lines].join('\n');
  }).join('\n');
  return `${header}\n${body}\n`;
}

/**
 * 根据用户对每个 hunk 的决策构建补丁
 * 仅合并 accept 的 hunk，reject/skip 的 hunk 丢弃
 *
 * @param parsed 解析后的 diff
 * @param decisions 每个 hunk 的决策（按 hunk 索引顺序）
 * @returns 合并后的 patch 文本
 */
export function buildPatchFromDecisions(
  parsed: ParsedDiff,
  decisions: HunkDecision[],
): string {
  const accepted = parsed.hunks.filter((_, i) => decisions[i] === 'accept');
  return buildPatchFromHunks(parsed.fileName, accepted);
}

// ============================================================
// 纯文本渲染（供 /diff 命令使用）
// ============================================================

/** 将解析后的 diff 渲染为纯文本 */
export function renderDiffText(parsed: ParsedDiff, page = 0, pageSize = 20): string {
  if (parsed.hunks.length === 0) return '未检测到 diff 内容。';

  const allLines: DiffLine[] = parsed.hunks.flatMap(h => h.lines);
  const totalPages = Math.ceil(allLines.length / pageSize);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * pageSize;
  const visible = allLines.slice(start, start + pageSize);

  const header = `┌─ 变更: ${parsed.fileName || '未知文件'} ─── +${parsed.additions} -${parsed.deletions} ──────────┐`;
  const footer = `└────────────────────────────────────────────────────┘`;
  const operations = '显示: [A] 全部接受 | [R] 全部拒绝 | [S] 逐行审查';
  const pagination = totalPages > 1 ? `页 ${currentPage + 1}/${totalPages}` : '';

  const body = visible.map(line => {
    const old = line.oldLineNo !== null ? String(line.oldLineNo).padStart(4) : '    ';
    const neu = line.newLineNo !== null ? String(line.newLineNo).padStart(4) : '    ';
    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    return `${old} ${neu} │${sign} ${line.content}`;
  }).join('\n');

  return [header, body, footer, operations, pagination].filter(Boolean).join('\n');
}

// ============================================================
// Ink 组件
// ============================================================

/** 获取 diff 行的背景色 */
function lineBackground(type: DiffLineType): string | undefined {
  switch (type) {
    case 'add': return getColor('success');
    case 'del': return getColor('error');
    default: return undefined;
  }
}

/** 获取 diff 行的前景色 */
function lineForeground(type: DiffLineType): string | undefined {
  return type === 'context' ? undefined : 'black';
}

/** DiffView：终端 diff 可视化组件 */
export function DiffView({ diff, fileName, pageSize = 20, onApplyDiff, onRejectDiff }: DiffViewProps) {
  const parsed = parseUnifiedDiff(diff);
  const displayName = fileName || parsed.fileName || '未知文件';
  const [page, setPage] = useState(0);
  // 逐 hunk 审查模式状态
  const [mode, setMode] = useState<DiffViewMode>('browse');
  const [reviewIndex, setReviewIndex] = useState(0);
  const [decisions, setDecisions] = useState<HunkDecision[]>([]);

  const allLines: DiffLine[] = parsed.hunks.flatMap(h => h.lines);
  const totalPages = Math.max(1, Math.ceil(allLines.length / pageSize));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = currentPage * pageSize;
  const visible = allLines.slice(start, start + pageSize);

  useInput((char, key) => {
    // 逐 hunk 审查模式：a=接受 r=拒绝 s=跳过
    if (mode === 'review') {
      if (char === 'a' || char === 'A') {
        const next: HunkDecision[] = [...decisions, 'accept'];
        setDecisions(next);
        advanceReview(next);
      } else if (char === 'r' || char === 'R') {
        const next: HunkDecision[] = [...decisions, 'reject'];
        setDecisions(next);
        advanceReview(next);
      } else if (char === 's' || char === 'S') {
        const next: HunkDecision[] = [...decisions, 'skip'];
        setDecisions(next);
        advanceReview(next);
      } else if (key.escape) {
        // Esc 退出审查模式，已决策的 hunk 仍按已有决策合并
        finishReview(decisions);
      }
      return;
    }

    // 浏览模式：分页 + 动作键
    if (char === 'a' || char === 'A') {
      // [A] 全部接受：通过回调将完整 diff 交给外部执行 git apply
      if (onApplyDiff) onApplyDiff(diff);
      return;
    }
    if (char === 'r' || char === 'R') {
      // [R] 全部拒绝：丢弃 diff，不做任何文件修改
      if (onRejectDiff) onRejectDiff();
      return;
    }
    if (char === 's' || char === 'S') {
      // [S] 逐行审查：进入逐 hunk 模式
      if (parsed.hunks.length === 0) return;
      setMode('review');
      setReviewIndex(0);
      setDecisions([]);
      return;
    }

    if (totalPages <= 1) return;
    if (key.downArrow || char === 'j') {
      setPage(p => Math.min(p + 1, totalPages - 1));
    } else if (key.upArrow || char === 'k') {
      setPage(p => Math.max(p - 1, 0));
    }
  });

  /** 推进审查索引；若所有 hunk 已决策则合并 patch 并回调 */
  function advanceReview(current: HunkDecision[]): void {
    const nextIdx = current.length;
    if (nextIdx >= parsed.hunks.length) {
      finishReview(current);
    } else {
      setReviewIndex(nextIdx);
    }
  }

  /** 结束审查：合并接受的 hunk 为 patch，通过 onApplyDiff 应用 */
  function finishReview(current: HunkDecision[]): void {
    const patch = buildPatchFromDecisions(parsed, current);
    setMode('browse');
    if (patch && onApplyDiff) {
      onApplyDiff(patch);
    } else if (!patch && onRejectDiff) {
      // 所有 hunk 都被拒绝，等同于全部拒绝
      onRejectDiff();
    }
  }

  // 审查模式：渲染当前 hunk
  if (mode === 'review' && reviewIndex < parsed.hunks.length) {
    const hunk = parsed.hunks[reviewIndex];
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={getColor('warning')} bold>
          ┌─ 逐行审查: {displayName} ─── hunk {reviewIndex + 1}/{parsed.hunks.length} ───┐
        </Text>
        {hunk.lines.map((line, idx) => {
          const old = line.oldLineNo !== null ? String(line.oldLineNo).padStart(4) : '    ';
          const neu = line.newLineNo !== null ? String(line.newLineNo).padStart(4) : '    ';
          const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          const bg = lineBackground(line.type);
          const fg = lineForeground(line.type);
          return (
            <Box key={idx}>
              <Text color={getColor('info')}>{old} {neu} │{sign} </Text>
              {bg ? (
                <Text backgroundColor={bg} color={fg}>{line.content}</Text>
              ) : (
                <Text>{line.content}</Text>
              )}
            </Box>
          );
        })}
        <Text color={getColor('warning')} bold>└────────────────────────────────────────────────────┘</Text>
        <Text color={getColor('info')}>
          [A] 接受此 hunk | [R] 拒绝此 hunk | [S] 跳过此 hunk | [Esc] 结束审查
        </Text>
        <Text color={getColor('info')}>
          已决策: {decisions.length}/{parsed.hunks.length}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={getColor('primary')} bold>
        ┌─ 变更: {displayName} ─── +{parsed.additions} -{parsed.deletions} ──────────┐
      </Text>

      {visible.map((line, idx) => {
        const old = line.oldLineNo !== null ? String(line.oldLineNo).padStart(4) : '    ';
        const neu = line.newLineNo !== null ? String(line.newLineNo).padStart(4) : '    ';
        const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
        const bg = lineBackground(line.type);
        const fg = lineForeground(line.type);
        return (
          <Box key={idx}>
            <Text color={getColor('info')}>{old} {neu} │{sign} </Text>
            {bg ? (
              <Text backgroundColor={bg} color={fg}>{line.content}</Text>
            ) : (
              <Text>{line.content}</Text>
            )}
          </Box>
        );
      })}

      <Text color={getColor('primary')} bold>└────────────────────────────────────────────────────┘</Text>
      <Text color={getColor('info')}>
        显示: [A] 全部接受 | [R] 全部拒绝 | [S] 逐行审查 {totalPages > 1 && `│ 页 ${currentPage + 1}/${totalPages}`}
      </Text>
    </Box>
  );
}

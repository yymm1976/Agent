// desktop/renderer/src/components/chat/BranchSwitcher.tsx
// Phase 74-D：分支切换器（D1 箭头式）
// ChatGPT 风格 < 2/3 >，fork 点上方内联展示
// 保留现有弱边框美学：border-rd-border + bg-rd-surface + hover:bg-rd-surfaceHover
// 视觉：GitFork 图标 + 当前位置（粗体）+ /总数（浅色）+ 左右箭头

import { ChevronLeft, ChevronRight, GitFork } from 'lucide-react';

export function BranchSwitcher({
  branches,
  currentBranch,
  onSwitch,
  branchTitles,
}: {
  /** 分支总数 */
  branches: number;
  /** 当前分支索引（0-based） */
  currentBranch: number;
  /** 切换分支回调：'prev' 上一条，'next' 下一条 */
  onSwitch: (direction: 'prev' | 'next') => void;
  /** 可选：各分支标题（用于 tooltip 悬停提示） */
  branchTitles?: string[];
}) {
  // 仅在分支数 > 1 时渲染
  if (branches <= 1) return null;

  const prevDisabled = currentBranch <= 0;
  const nextDisabled = currentBranch >= branches - 1;
  // 悬停提示：显示当前分支标题（如有）
  const currentTitle = branchTitles?.[currentBranch];
  const tooltip = currentTitle
    ? `分支 ${currentBranch + 1}/${branches}：${currentTitle}`
    : `分支 ${currentBranch + 1}/${branches}`;

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-rd-border bg-rd-surface px-1 py-0.5 text-xs"
      title={tooltip}
    >
      <GitFork size={11} className="mr-0.5 text-rd-primary" aria-hidden="true" />
      <button
        type="button"
        onClick={() => onSwitch('prev')}
        disabled={prevDisabled}
        aria-label="上一个分支"
        className="flex h-5 w-5 items-center justify-center rounded transition hover:bg-rd-surfaceHover hover:text-rd-text disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronLeft size={13} />
      </button>
      <span className="tabular-nums px-1 text-rd-textMuted" aria-live="polite">
        <span className="font-semibold text-rd-text">{currentBranch + 1}</span>
        <span className="text-rd-textSubtle">/{branches}</span>
      </span>
      <button
        type="button"
        onClick={() => onSwitch('next')}
        disabled={nextDisabled}
        aria-label="下一个分支"
        className="flex h-5 w-5 items-center justify-center rounded transition hover:bg-rd-surfaceHover hover:text-rd-text disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  );
}

// desktop/renderer/src/components/chat/BranchSwitcher.tsx
// 分支切换器占位组件
// Phase 74-C：为 74-D（对话分支完整实现）预留接口
// 当前仅渲染 < > 箭头 + "分支 X/Y" 文本，74-D 阶段替换为完整实现

import { ChevronLeft, ChevronRight, GitFork } from 'lucide-react';

export function BranchSwitcher({
  branches,
  currentBranch,
  onSwitch,
}: {
  /** 分支总数 */
  branches: number;
  /** 当前分支索引（0-based） */
  currentBranch: number;
  /** 切换分支回调：'prev' 上一条，'next' 下一条 */
  onSwitch: (direction: 'prev' | 'next') => void;
}) {
  if (branches <= 1) return null;
  return (
    <div className="flex items-center gap-1 text-xs text-rd-textSubtle">
      <GitFork size={12} />
      <button
        type="button"
        onClick={() => onSwitch('prev')}
        disabled={currentBranch <= 0}
        title="上一个分支"
        className="flex h-5 w-5 items-center justify-center rounded transition hover:bg-rd-surfaceHover hover:text-rd-text disabled:opacity-30"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="tabular-nums">分支 {currentBranch + 1}/{branches}</span>
      <button
        type="button"
        onClick={() => onSwitch('next')}
        disabled={currentBranch >= branches - 1}
        title="下一个分支"
        className="flex h-5 w-5 items-center justify-center rounded transition hover:bg-rd-surfaceHover hover:text-rd-text disabled:opacity-30"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

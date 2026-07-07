// desktop/renderer/src/components/chat/FollowUpQueue.tsx
// Follow-up 队列 UI：Agent 完成当前工作后排队的后续任务
// Phase 73 Part C + Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { History, ChevronDown, X } from 'lucide-react';
import type { FollowUpItem, FollowUpMode } from '../../../../shared/ipc-types.js';

export function FollowUpQueue({
  items,
  expanded,
  onToggle,
  mode,
  onModeChange,
  onRemove,
}: {
  items: FollowUpItem[];
  expanded: boolean;
  onToggle: () => void;
  mode: FollowUpMode;
  onModeChange: (mode: FollowUpMode) => void;
  onRemove: (idx: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="bg-rd-surface/50">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-xs text-rd-textMuted transition hover:bg-rd-surfaceHover"
      >
        <History size={12} className="text-rd-primary" />
        <span>已排队 {items.length} 条后续消息</span>
        <ChevronDown size={12} className={['transition-transform', expanded ? 'rotate-180' : ''].join(' ')} />
      </button>
      {expanded && (
        <div className="max-h-40 overflow-y-auto px-4 pb-2">
          {/* Phase 73 Part C 修复：follow-up 出队模式切换（逐条 / 全部） */}
          <div className="mb-1.5 flex items-center gap-1 border-b border-rd-border pb-1.5">
            <span className="mr-1 text-xs text-rd-textSubtle">出队模式</span>
            {(['one-at-a-time', 'all'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onModeChange(m)}
                title={m === 'one-at-a-time' ? '内层循环退出时仅注入第一条，剩余保留' : '内层循环退出时一次性注入全部 follow-up 消息'}
                className={[
                  'rounded px-2 py-0.5 text-xs transition',
                  mode === m
                    ? 'bg-rd-primary/10 font-semibold text-rd-primary'
                    : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
                ].join(' ')}
              >
                {m === 'one-at-a-time' ? '逐条' : '全部'}
              </button>
            ))}
          </div>
          {items.map((item, idx) => (
            <div key={idx} className="mb-1 flex items-start gap-2 rounded border border-rd-border bg-rd-background px-2 py-1.5">
              <span className="mt-0.5 text-xs font-medium text-rd-textSubtle">#{idx + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-rd-text" title={item.content}>{item.content}</span>
              <button
                onClick={() => onRemove(idx)}
                title="移除"
                className="flex h-4 w-4 items-center justify-center text-rd-textSubtle hover:text-rd-danger"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

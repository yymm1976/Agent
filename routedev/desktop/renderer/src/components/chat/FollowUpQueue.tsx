// desktop/renderer/src/components/chat/FollowUpQueue.tsx
// Follow-up 队列 UI：Agent 完成当前工作后排队的后续任务
// Phase 74-B2：从常驻折叠面板改为浮层式（输入区上方矮胶囊触发器 + 向上弹出浮层）
// 保留现有 API 兼容：items / expanded / onToggle / mode / onModeChange / onRemove
// 视觉：触发器用主色色条（border-l-2 border-rd-primary）区分 pending 队列

import { History, X } from 'lucide-react';
import type { FollowUpItem, FollowUpMode } from '../../../../shared/ipc-types.js';
import { QueuePopover } from './QueuePopover.js';

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

  // 派生 onClose：浮层已展开时调用 onToggle 即关闭
  const handleClose = () => {
    if (expanded) onToggle();
  };

  return (
    <QueuePopover
      open={expanded}
      onToggle={onToggle}
      onClose={handleClose}
      triggerClassName="border-l-2 border-l-rd-primary/60"
      triggerTitle={`接续队列 · ${items.length} 项`}
      trigger={
        <>
          <History size={12} className="text-rd-primary" />
          <span className="text-rd-text">接续</span>
          <span className="rounded-full bg-rd-primary/10 px-1.5 text-[10px] font-semibold text-rd-primary">
            {items.length}
          </span>
        </>
      }
      title={
        <span className="flex items-center gap-1.5">
          <History size={12} className="text-rd-primary" />
          接续队列 · {items.length} 项
        </span>
      }
    >
      <div className="p-2">
        {/* 出队模式切换（Phase 73 Part C） */}
        <div className="mb-2 flex items-center gap-1 border-b border-rd-border/50 pb-2">
          <span className="mr-1 text-xs text-rd-textSubtle">出队模式</span>
          {(['one-at-a-time', 'all'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              aria-pressed={mode === m}
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

        {/* 队列项列表（74-I2：role=list） */}
        <div role="list" className="space-y-1">
          {items.map((item, idx) => (
            <div
              key={idx}
              role="listitem"
              className="flex items-start gap-2 rounded-md border border-rd-border bg-rd-background px-2 py-1.5"
            >
              <span className="mt-0.5 shrink-0 text-xs font-medium text-rd-textSubtle">#{idx + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-rd-text" title={item.content}>
                {item.content}
              </span>
              <button
                type="button"
                onClick={() => onRemove(idx)}
                title="移除"
                aria-label={`移除第 ${idx + 1} 条`}
                className="flex h-4 w-4 shrink-0 items-center justify-center text-rd-textSubtle transition hover:text-rd-danger"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </QueuePopover>
  );
}

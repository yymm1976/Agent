// desktop/renderer/src/components/chat/PendingQueue.tsx
// 排队队列 UI：引擎工作时用户提前输入的消息列表
// Phase 74-B2：从常驻折叠面板改为浮层式（输入区上方矮胶囊触发器 + 向上弹出浮层）
// 保留现有 API 兼容：items / expanded / onToggle / onRemove / onStartEdit / editing* / onConfirmEdit / onCancelEdit
// 视觉：触发器用警告色色条（border-l-2 border-rd-warning）区分 follow-up 队列

import { Clock, Edit3, X } from 'lucide-react';
import { QueuePopover } from './QueuePopover.js';

export function PendingQueue({
  items,
  expanded,
  onToggle,
  onRemove,
  onStartEdit,
  editingIndex,
  editingValue,
  onEditChange,
  onConfirmEdit,
  onCancelEdit,
}: {
  items: string[];
  expanded: boolean;
  onToggle: () => void;
  onRemove: (idx: number) => void;
  onStartEdit: (idx: number) => void;
  editingIndex: number | null;
  editingValue: string;
  onEditChange: (value: string) => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
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
      triggerClassName="border-l-2 border-l-rd-warning/60"
      triggerTitle={`待发送队列 · ${items.length} 条`}
      trigger={
        <>
          <Clock size={12} className="text-rd-warning" />
          <span className="text-rd-text">待发送</span>
          <span className="rounded-full bg-rd-warning/10 px-1.5 text-[10px] font-semibold text-rd-warning">
            {items.length}
          </span>
        </>
      }
      title={
        <span className="flex items-center gap-1.5">
          <Clock size={12} className="text-rd-warning" />
          待发送 · {items.length} 条
        </span>
      }
    >
      <div role="list" className="space-y-1 p-2">
        {items.map((item, idx) => (
          <div
            key={idx}
            role="listitem"
            className="flex items-start gap-2 rounded-md border border-rd-border bg-rd-background px-2 py-1.5"
          >
            <span className="mt-0.5 shrink-0 text-xs font-medium text-rd-textSubtle">#{idx + 1}</span>
            {editingIndex === idx ? (
              <input
                autoFocus
                value={editingValue}
                onChange={(e) => onEditChange(e.target.value)}
                onBlur={onConfirmEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onConfirmEdit();
                  if (e.key === 'Escape') onCancelEdit();
                }}
                className="min-w-0 flex-1 rounded border border-rd-primary bg-rd-background px-1 py-0.5 text-xs text-rd-text outline-none"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-rd-text" title={item}>
                {item}
              </span>
            )}
            {editingIndex !== idx && (
              <>
                <button
                  type="button"
                  onClick={() => onStartEdit(idx)}
                  title="编辑"
                  aria-label={`编辑第 ${idx + 1} 条`}
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-rd-textSubtle transition hover:text-rd-primary"
                >
                  <Edit3 size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(idx)}
                  title="移除"
                  aria-label={`移除第 ${idx + 1} 条`}
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-rd-textSubtle transition hover:text-rd-danger"
                >
                  <X size={11} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </QueuePopover>
  );
}

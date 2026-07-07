// desktop/renderer/src/components/chat/PendingQueue.tsx
// 排队队列 UI：引擎工作时用户提前输入的消息列表
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { Clock, ChevronDown, Edit3, X } from 'lucide-react';

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
  return (
    <div className="bg-rd-surface/50">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-xs text-rd-textMuted transition hover:bg-rd-surfaceHover"
      >
        <Clock size={12} className="text-rd-primary" />
        <span>排队队列: {items.length} 条消息</span>
        <ChevronDown size={12} className={['transition-transform', expanded ? 'rotate-180' : ''].join(' ')} />
      </button>
      {expanded && (
        <div className="max-h-40 overflow-y-auto px-4 pb-2">
          {items.map((item, idx) => (
            <div key={idx} className="mb-1 flex items-start gap-2 rounded border border-rd-border bg-rd-background px-2 py-1.5">
              <span className="mt-0.5 text-xs font-medium text-rd-textSubtle">#{idx + 1}</span>
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
                <span className="min-w-0 flex-1 truncate text-xs text-rd-text">{item}</span>
              )}
              {editingIndex !== idx && (
                <>
                  <button
                    onClick={() => onStartEdit(idx)}
                    title="编辑"
                    className="flex h-4 w-4 items-center justify-center text-rd-textSubtle hover:text-rd-primary"
                  >
                    <Edit3 size={11} />
                  </button>
                  <button
                    onClick={() => onRemove(idx)}
                    title="移除"
                    className="flex h-4 w-4 items-center justify-center text-rd-textSubtle hover:text-rd-danger"
                  >
                    <X size={11} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

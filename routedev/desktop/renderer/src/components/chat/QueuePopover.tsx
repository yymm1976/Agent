// desktop/renderer/src/components/chat/QueuePopover.tsx
// Phase 74-B2：浮层式队列容器
// 触发器为矮胶囊按钮（不挤占垂直空间），点击后浮层从触发器上方弹出
// 保留现有弱边框美学：border-rd-border + bg-rd-surface + shadow-rdLg
// 关闭逻辑：ESC / 点击外部 / 再次点击触发器

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface QueuePopoverProps {
  /** 受控开关状态（由父组件管理，保持现有 API 兼容） */
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** 触发器内部内容（图标 + 文案） */
  trigger: ReactNode;
  /** 触发器额外 className（用于 pending/followup 色条区分） */
  triggerClassName?: string;
  /** 触发器 title 提示 */
  triggerTitle?: string;
  /** 浮层标题（如「⎇ 接续队列 · 1 项」） */
  title: ReactNode;
  /** 浮层内容（队列列表 + 操作） */
  children: ReactNode;
  /** 浮层宽度，默认 320px */
  width?: number;
  /** 浮层最大高度，默认 384px（max-h-96） */
  maxHeight?: number;
}

export function QueuePopover({
  open,
  onToggle,
  onClose,
  trigger,
  triggerClassName = '',
  triggerTitle,
  title,
  children,
  width = 320,
  maxHeight = 384,
}: QueuePopoverProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // 浮层定位（fixed 坐标，相对触发器上方）
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // open 时计算触发器位置
  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.left });
    } else {
      setPos(null);
    }
  }, [open]);

  // ESC 关闭 + 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // 延迟一帧绑定 click，避免触发器点击事件本身触发立即关闭
    const timer = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [open, onClose]);

  return (
    <>
      {/* 触发器：矮胶囊按钮，只占一行高度 */}
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={[
          'inline-flex items-center gap-1.5 rounded-md border border-rd-border bg-rd-surface px-2.5 py-1 text-xs font-medium transition',
          'hover:bg-rd-surfaceHover hover:border-rd-borderHover',
          open ? 'ring-1 ring-rd-primary/30 border-rd-primary/30' : '',
          triggerClassName,
        ].join(' ')}
      >
        {trigger}
      </button>

      {/* 浮层：Portal 到 body，定位到触发器上方 */}
      {open && pos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-modal="false"
          style={{
            position: 'fixed',
            top: pos.top - 8,
            left: pos.left,
            width,
            transform: 'translateY(-100%)',
            maxHeight,
          }}
          className="z-[9999] flex flex-col overflow-hidden rounded-rdLg border border-rd-border bg-rd-surface shadow-rdLg"
        >
          {/* 标题栏 */}
          <div className="flex shrink-0 items-center justify-between border-b border-rd-border/50 px-3 py-2">
            <span className="text-xs font-semibold text-rd-text">{title}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭队列浮层"
              className="flex h-5 w-5 items-center justify-center rounded text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
            >
              <X size={12} />
            </button>
          </div>
          {/* 内容区：可滚动 */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

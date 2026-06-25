// desktop/renderer/src/components/ui/Modal.tsx
// 通用模态框基础组件：遮罩层 + 标题栏 + 内容区 + footer

import { type ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 内容区最大宽度类，默认 'max-w-2xl' */
  width?: string;
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-2xl' }: ModalProps) {
  // ESC 键关闭
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className={`flex max-h-[85vh] w-full ${width} flex-col overflow-hidden rounded-xl bg-rd-surface shadow-lg`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-rd-border/30 px-5 py-4">
          <h2 className="text-base font-medium text-rd-text">{title}</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-text"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 内容区 */}
        <div className="overflow-y-auto px-5 py-4" style={{ maxHeight: '70vh' }}>
          {children}
        </div>

        {/* footer */}
        {footer && (
          <div className="border-t border-rd-border/30 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

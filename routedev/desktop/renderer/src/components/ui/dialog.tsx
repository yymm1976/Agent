// desktop/renderer/src/components/ui/dialog.tsx
// 通用对话框组件：用于替代原生 alert/confirm

import { X } from 'lucide-react';
import { Button } from './button.js';

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

/** 确认对话框：替代原生 confirm() */
export function ConfirmDialog({
  open,
  title = '确认操作',
  message,
  confirmText = '确认',
  cancelText = '取消',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-rdLg bg-rd-card p-6 shadow-rdLg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-base font-semibold text-rd-text">{title}</h3>
        <p className="mb-6 text-sm text-rd-textMuted">{message}</p>
        <div className="flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            variant={variant === 'danger' ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface AlertBannerProps {
  message: string | null;
  onDismiss: () => void;
}

/** 错误提示横幅：替代原生 alert() */
export function AlertBanner({ message, onDismiss }: AlertBannerProps) {
  if (!message) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-rdMd bg-rd-danger px-4 py-3 text-sm text-white shadow-rdLg">
      <span>{message}</span>
      <button
        className="shrink-0 rounded p-0.5 hover:bg-white/20"
        onClick={onDismiss}
        aria-label="关闭"
      >
        <X size={14} />
      </button>
    </div>
  );
}

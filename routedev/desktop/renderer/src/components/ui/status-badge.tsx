// desktop/renderer/src/components/ui/status-badge.tsx
// 四态状态徽章：用于工具调用卡片、任务状态、队列条目等场景

import { type HTMLAttributes, type ReactNode } from 'react';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';

/** 状态类型 */
export type StatusVariant = 'success' | 'error' | 'pending' | 'running';

/** 尺寸 */
export type StatusSize = 'sm' | 'md' | 'lg';

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** 状态变体 */
  variant: StatusVariant;
  /** 尺寸：sm/md/lg，默认 md */
  size?: StatusSize;
  /** 是否显示图标，默认 true */
  showIcon?: boolean;
  /** 文字标签 */
  children?: ReactNode;
}

/** 图标映射 */
const iconMap: Record<StatusVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  pending: Circle,
  running: Loader2,
};

/** 尺寸样式映射 */
const sizeStyles: Record<StatusSize, { wrap: string; icon: string }> = {
  sm: { wrap: 'px-2 py-0.5 text-[11px] gap-1', icon: 'h-3 w-3' },
  md: { wrap: 'px-2.5 py-0.5 text-xs gap-1.5', icon: 'h-3.5 w-3.5' },
  lg: { wrap: 'px-3 py-1 text-sm gap-1.5', icon: 'h-4 w-4' },
};

/**
 * 颜色样式映射（通过 Tailwind 任意值引用 --rd-status-* CSS 变量）
 * 不在 tailwind.config.js 中扩展颜色，保持最小改动
 */
const variantStyles: Record<StatusVariant, string> = {
  success:
    'bg-[var(--rd-status-success)]/10 text-[var(--rd-status-success)] border-[var(--rd-status-success)]/20',
  error:
    'bg-[var(--rd-status-error)]/10 text-[var(--rd-status-error)] border-[var(--rd-status-error)]/20',
  pending:
    'bg-[var(--rd-status-pending)]/10 text-[var(--rd-status-pending)] border-[var(--rd-status-pending)]/20',
  running:
    'bg-[var(--rd-status-running)]/10 text-[var(--rd-status-running)] border-[var(--rd-status-running)]/20',
};

export function StatusBadge({
  variant,
  size = 'md',
  showIcon = true,
  className = '',
  children,
  ...props
}: StatusBadgeProps) {
  const Icon = iconMap[variant];
  const sizeStyle = sizeStyles[size];

  return (
    <span
      data-status={variant}
      className={`inline-flex items-center rounded-full border font-semibold ${sizeStyle.wrap} ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {showIcon && (
        <Icon
          className={`${sizeStyle.icon} ${variant === 'running' ? 'animate-spin' : ''}`}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

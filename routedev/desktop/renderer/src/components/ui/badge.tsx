// desktop/renderer/src/components/ui/badge.tsx
// shadcn/ui 风格徽章

import { type HTMLAttributes, type ReactNode } from 'react';

export interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'destructive' | 'primary' | 'success';
  children: ReactNode;
}

const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'border-transparent bg-rd-surface text-rd-textMuted border border-rd-border',
  secondary: 'border-transparent bg-rd-secondary text-rd-secondaryForeground',
  outline: 'text-rd-text border-rd-border',
  destructive: 'border-transparent bg-rd-danger/10 text-rd-danger border border-rd-danger/20',
  primary: 'border-transparent bg-rd-primary/10 text-rd-primary border border-rd-primary/20',
  success: 'border-transparent bg-rd-success/10 text-rd-success border border-rd-success/20',
};

export function Badge({ className = '', variant = 'default', children, ...props }: BadgeProps) {
  return (
    <div
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

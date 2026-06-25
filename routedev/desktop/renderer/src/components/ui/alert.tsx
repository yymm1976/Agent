// desktop/renderer/src/components/ui/alert.tsx
// shadcn/ui 风格提示

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'destructive';
  children: ReactNode;
}

const variantStyles: Record<NonNullable<AlertProps['variant']>, string> = {
  default: 'border-rd-border bg-rd-surface text-rd-text',
  destructive: 'border-rd-danger/20 bg-rd-danger/10 text-rd-danger',
};

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ className = '', variant = 'default', children, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={`relative w-full rounded-lg border p-4 ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {children}
    </div>
  )
);
Alert.displayName = 'Alert';

export const AlertTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className = '', children, ...props }, ref) => (
    <h5 ref={ref} className={`mb-1 font-medium leading-none tracking-tight ${className}`} {...props}>
      {children}
    </h5>
  )
);
AlertTitle.displayName = 'AlertTitle';

export const AlertDescription = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className = '', children, ...props }, ref) => (
    <div ref={ref} className={`text-sm opacity-90 ${className}`} {...props}>
      {children}
    </div>
  )
);
AlertDescription.displayName = 'AlertDescription';

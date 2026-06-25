// desktop/renderer/src/components/ui/button.tsx
// shadcn/ui 风格按钮

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  children: ReactNode;
}

const variantStyles: Record<NonNullable<ButtonProps['variant']>, string> = {
  default:
    'bg-rd-primary text-rd-primaryForeground shadow-sm hover:bg-rd-primaryHover',
  secondary:
    'bg-rd-secondary text-rd-secondaryForeground shadow-sm hover:bg-rd-secondaryHover',
  outline:
    'bg-rd-surfaceHover text-rd-text shadow-sm hover:bg-rd-surfaceHighlight hover:text-rd-text',
  ghost: 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
  destructive:
    'bg-rd-danger text-rd-dangerForeground shadow-sm hover:bg-rd-dangerHover',
  link: 'text-rd-primary underline-offset-4 hover:underline',
};

const sizeStyles: Record<NonNullable<ButtonProps['size']>, string> = {
  default: 'h-10 px-5 py-2 rounded-xl',
  sm: 'h-9 px-4 py-2 rounded-lg text-xs',
  lg: 'h-11 px-8 py-2 rounded-xl',
  icon: 'h-9 w-9 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'default', size = 'default', children, ...props }, ref) => {
    const base =
      'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors outline-none disabled:pointer-events-none disabled:opacity-50';
    return (
      <button ref={ref} className={`${base} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`} {...props}>
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

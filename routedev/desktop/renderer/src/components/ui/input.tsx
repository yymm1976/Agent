// desktop/renderer/src/components/ui/input.tsx
// shadcn/ui 风格输入框

import { forwardRef, type InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={[
        'flex h-10 w-full rounded-xl bg-rd-surface px-3 py-2 text-sm text-rd-text shadow-rd transition-colors',
        'placeholder:text-rd-textSubtle',
        'focus-visible:outline-none focus-visible:border-rd-borderHover',
        'hover:bg-rd-surfaceHover',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ].join(' ')}
      {...props}
    />
  )
);
Input.displayName = 'Input';

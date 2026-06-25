// desktop/renderer/src/components/ui/textarea.tsx
// shadcn/ui 风格文本域

import { forwardRef, type TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', ...props }, ref) => (
    <textarea
      ref={ref}
      className={[
        'flex min-h-[80px] w-full rounded-xl bg-rd-surface px-3 py-2 text-sm text-rd-text shadow-rd transition-colors',
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
Textarea.displayName = 'Textarea';

// desktop/renderer/src/components/ui/separator.tsx
// shadcn/ui 风格分隔线

import { type HTMLAttributes } from 'react';

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
}

export function Separator({ className = '', orientation = 'horizontal', ...props }: SeparatorProps) {
  return (
    <div
      className={[
        'shrink-0 bg-rd-border',
        orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
        className,
      ].join(' ')}
      {...props}
    />
  );
}

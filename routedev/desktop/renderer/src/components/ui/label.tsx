// desktop/renderer/src/components/ui/label.tsx
// shadcn/ui 风格标签

import { forwardRef, type LabelHTMLAttributes } from 'react';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ className = '', children, ...props }, ref) => (
    <label
      ref={ref}
      className={`text-sm font-semibold leading-none text-rd-text peer-disabled:cursor-not-allowed peer-disabled:opacity-70 ${className}`}
      {...props}
    >
      {children}
    </label>
  )
);
Label.displayName = 'Label';

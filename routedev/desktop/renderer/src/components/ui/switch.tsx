// desktop/renderer/src/components/ui/switch.tsx
// shadcn/ui 风格开关

import { forwardRef, type InputHTMLAttributes } from 'react';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  ({ className = '', checked, onCheckedChange, ...props }, ref) => (
    <label
      className={[
        'inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors',
        'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
        checked ? 'border-rd-primary bg-rd-primary/30' : 'border-rd-borderHover bg-rd-surfaceHover',
        className,
      ].join(' ')}
    >
      <input
        type="checkbox"
        role="switch"
        ref={ref}
        checked={checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className="peer sr-only"
        {...props}
      />
      <span
        className={[
          'pointer-events-none block h-5 w-5 rounded-full shadow-sm ring-1 ring-rd-border/30',
          'transition-transform duration-150 ease-out',
          checked ? 'translate-x-5 bg-rd-primary' : 'translate-x-0 bg-rd-textMuted',
        ].join(' ')}
      />
    </label>
  )
);
Switch.displayName = 'Switch';

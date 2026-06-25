import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
}

interface ParsedSelectItem {
  value: string;
  label: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', children, value, defaultValue, onChange, disabled, id, ...props }, ref) => {
    const [open, setOpen] = useState(false);
    const [menuRect, setMenuRect] = useState<{ left: number; top: number; width: number } | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    const items = useMemo(() => {
      return Children.toArray(children).flatMap((child): ParsedSelectItem[] => {
        if (!isValidElement<SelectItemProps>(child)) return [];
        return [{ value: String(child.props.value), label: child.props.children }];
      });
    }, [children]);

    const selectedValue = String(value ?? defaultValue ?? items[0]?.value ?? '');
    const selected = items.find((item) => item.value === selectedValue);

    useEffect(() => {
      if (!open) return;
      const updateRect = () => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (rect) setMenuRect({ left: rect.left, top: rect.bottom + 8, width: rect.width });
      };
      updateRect();
      const close = (event: MouseEvent) => {
        if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
      };
      window.addEventListener('scroll', updateRect, true);
      window.addEventListener('resize', updateRect);
      window.addEventListener('click', close);
      return () => {
        window.removeEventListener('click', close);
        window.removeEventListener('scroll', updateRect, true);
        window.removeEventListener('resize', updateRect);
      };
    }, [open]);

    const handleSelect = (nextValue: string) => {
      onChange?.({ target: { value: nextValue } } as ChangeEvent<HTMLSelectElement>);
      setOpen(false);
    };

    return (
      <div ref={rootRef} className={`relative ${className}`}>
        <select
          ref={ref}
          id={id}
          value={selectedValue}
          disabled={disabled}
          onChange={onChange}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          {...props}
        >
          {items.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          className={[
            'flex h-10 w-full items-center justify-between gap-3 rounded-xl border border-rd-border bg-rd-surface px-3 text-left text-sm text-rd-text shadow-rd transition',
            'hover:border-rd-borderHover hover:bg-rd-surfaceHover',
            'focus-visible:outline-none focus-visible:border-rd-primary/70',
            disabled ? 'cursor-not-allowed opacity-50' : '',
          ].join(' ')}
        >
          <span className="min-w-0 truncate">{selected?.label ?? selectedValue}</span>
          <ChevronDown size={16} className={`shrink-0 text-rd-textSubtle transition ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && !disabled && menuRect && createPortal(
          <div
            className="rd-popover-enter fixed z-[9999] max-h-72 overflow-auto rounded-xl border border-rd-border bg-rd-background p-1 shadow-rdLg"
            style={{ left: menuRect.left, top: menuRect.top, width: menuRect.width }}
          >
            {items.map((item) => {
              const active = item.value === selectedValue;
              return (
                <button
                  type="button"
                  key={item.value}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleSelect(item.value);
                  }}
                  className={[
                    'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition',
                    active ? 'bg-rd-primary/10 font-semibold text-rd-primary' : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
                  ].join(' ')}
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                  {active && <Check size={15} className="shrink-0" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
      </div>
    );
  }
);
Select.displayName = 'Select';

export interface SelectItemProps {
  value: string;
  children: ReactNode;
}

export function SelectItem({ value, children }: SelectItemProps): ReactElement {
  return <option value={value}>{children}</option>;
}

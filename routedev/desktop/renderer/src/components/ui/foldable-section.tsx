// desktop/renderer/src/components/ui/foldable-section.tsx
// 可折叠面板：用于工具卡片展开/收起、设置页分节、产物面板等场景

import { type ReactNode, useCallback, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';

export interface FoldableSectionProps {
  /** 标题区域（header slot） */
  header: ReactNode;
  /** 折叠内容 */
  children: ReactNode;
  /** 默认是否展开（非受控模式），默认 false */
  defaultOpen?: boolean;
  /** 受控模式：展开状态。传入则进入受控模式 */
  open?: boolean;
  /** 受控模式：状态变更回调 */
  onOpenChange?: (open: boolean) => void;
  /** 容器额外 className */
  className?: string;
  /** 内容区额外 className */
  contentClassName?: string;
}

export function FoldableSection({
  header,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className = '',
  contentClassName = '',
}: FoldableSectionProps) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = isControlled ? openProp : internalOpen;

  const panelId = useId();

  const toggle = useCallback(() => {
    const next = !open;
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }, [open, isControlled, onOpenChange]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    },
    [toggle]
  );

  return (
    <div className={`rounded-rdSm border border-rd-border bg-rd-surface ${className}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className="flex cursor-pointer select-none items-center gap-2 px-3 py-2.5 transition-colors hover:bg-rd-surfaceHover outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 rounded-rdSm"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-rd-textMuted transition-all duration-200 ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">{header}</div>
      </div>
      {open && (
        <div
          id={panelId}
          className={`px-3 pb-3 pt-1 transition-all ${contentClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

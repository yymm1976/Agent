// desktop/renderer/src/components/QuickStartChips.tsx
// 快捷启动芯片：水平排列的快捷指令入口，点击即发送对应 prompt。

export interface QuickChip {
  label: string;
  prompt: string;
}

export interface QuickStartChipsProps {
  chips: QuickChip[];
  onSelect: (prompt: string) => void;
}

/** 默认快捷芯片 */
export const DEFAULT_QUICK_CHIPS: QuickChip[] = [
  { label: '解释项目架构', prompt: '请解释当前项目的核心架构' },
  { label: '添加测试', prompt: '为最近修改的模块添加单元测试' },
  { label: '审查代码', prompt: '审查当前分支的代码变更' },
];

export function QuickStartChips({ chips, onSelect }: QuickStartChipsProps) {
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip, idx) => (
        <button
          key={`${chip.label}-${idx}`}
          type="button"
          onClick={() => onSelect(chip.prompt)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-rd-border bg-rd-surface text-rd-textMuted text-xs cursor-pointer hover:border-rd-primary hover:text-rd-primary transition-colors"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

// desktop/renderer/src/components/ModelLabel.tsx
// Phase 51 Task 11：模型名与 thinking 等级分离显示
//
// 借鉴 ohmypi splitModelLabel 的设计决策：
//   "openai-codex/gpt-5.4:high" 在 UI 上不能整体渲染，
//   否则用户会误以为 ":high" 是模型名的一部分。
//   模型名加粗，thinking 等级单独以彩色 badge 呈现。

import { splitModelLabel } from '../../../../src/agents/activity-store.js';

interface ModelLabelProps {
  /** 完整模型字符串，如 "openai-codex/gpt-5.4:high" */
  modelString: string;
  /** 附加 className（合并到外层 span） */
  className?: string;
}

/** thinking 等级 → badge 配色（high 用紫色突出显示） */
const THINKING_BADGE_CLASS: Record<string, string> = {
  low: 'bg-rd-surfaceHighlight text-rd-textMuted border-rd-border',
  medium: 'bg-rd-warning/15 text-rd-warning border-rd-warning/30',
  high: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  auto: 'bg-rd-primary/10 text-rd-primary border-rd-primary/30',
};

/**
 * 模型标签组件——分离显示模型名和 thinking 等级
 *
 * - 模型名加粗（font-semibold）
 * - thinking 等级用小 badge（如 high 用紫色）
 * - 无 thinking 等级时只显示模型名
 */
export default function ModelLabel({ modelString, className = '' }: ModelLabelProps) {
  const { model, thinking } = splitModelLabel(modelString);

  if (!model && !thinking) {
    return <span className={`text-rd-textSubtle ${className}`}>—</span>;
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="font-semibold text-rd-text">{model || 'unknown'}</span>
      {thinking && (
        <span
          className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium leading-tight ${
            THINKING_BADGE_CLASS[thinking] ?? THINKING_BADGE_CLASS.auto
          }`}
          title={`thinking level: ${thinking}`}
        >
          {thinking}
        </span>
      )}
    </span>
  );
}

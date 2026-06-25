// desktop/renderer/src/components/MemoryBadge.tsx
// 记忆提示徽章：显示已应用的偏好（如"中文注释"），点击跳转到设置页
// 对应原型 .memoryBadge

import { Brain } from 'lucide-react';

export type MemoryCategory =
  | 'coding_style'
  | 'tech_stack'
  | 'project_context'
  | 'user_preference';

interface MemoryBadgeProps {
  category: MemoryCategory;
  /** 显示的偏好标签，如 "中文注释" */
  label: string;
  /** 点击回调（如跳转到设置页） */
  onClick?: () => void;
}

export function MemoryBadge({ category, label, onClick }: MemoryBadgeProps) {
  void category; // 预留字段，未来可按 category 显示不同图标
  return (
    <button
      type="button"
      onClick={onClick}
      title={`已应用偏好：${label}`}
      className="inline-flex items-center gap-1 rounded-full border border-rd-border bg-rd-surface px-2 py-0.5 text-[11px] text-rd-textMuted transition hover:border-rd-primary hover:text-rd-primary"
    >
      <Brain size={11} />
      <span>已应用偏好：{label}</span>
    </button>
  );
}

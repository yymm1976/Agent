// desktop/renderer/src/components/settings/SettingsAdvancedSection.tsx
// 通用"高级设置"折叠区组件
// 每个 tab 的有默认值配置项放在此处，默认折叠，用户点击"显示高级设置"才展开

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface SettingsAdvancedSectionProps {
  /** 折叠区标题，默认"高级设置" */
  title?: string;
  /** 折叠区说明文字（可选，显示在标题下方） */
  description?: string;
  /** 折叠区内容 */
  children: ReactNode;
}

/**
 * 高级设置折叠区
 * 用于收纳有合理默认值的配置项，减少用户认知负担
 *
 * 使用示例：
 * <SettingsAdvancedSection title="路由规则" description="模型分级路由与降级链配置">
 *   <SettingsRouterTab ... />
 * </SettingsAdvancedSection>
 */
export function SettingsAdvancedSection({
  title = '高级设置',
  description,
  children,
}: SettingsAdvancedSectionProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-rd-border/60 bg-rd-surface/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-rd-surfaceHover/50"
      >
        {expanded ? (
          <ChevronDown size={16} className="text-rd-textMuted shrink-0" />
        ) : (
          <ChevronRight size={16} className="text-rd-textMuted shrink-0" />
        )}
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-rd-text">{title}</span>
          {description && (
            <span className="text-xs text-rd-textMuted mt-0.5">{description}</span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-rd-border/40 px-3 py-3 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

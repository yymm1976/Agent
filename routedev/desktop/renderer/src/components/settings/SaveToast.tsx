// desktop/renderer/src/components/settings/SaveToast.tsx
// Phase 74-G：保存提示 toast（顶部居中浮动，3 秒自动消失）
// 从 SettingsPage.tsx 迁移

import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { SaveResult } from '../../hooks/useAutoSave.js';

interface SaveToastProps {
  /** 保存提示状态（null 时不渲染） */
  saveResult: SaveResult;
}

/**
 * 保存提示 toast：顶部居中浮动
 * 3 秒自动消失逻辑在 useAutoSave hook 中
 */
export function SaveToast({ saveResult }: SaveToastProps) {
  if (!saveResult) return null;
  return (
    <div className="fixed top-6 left-1/2 z-50 -translate-x-1/2">
      <div
        className={[
          'flex items-center gap-2.5 rounded-xl px-5 py-3 shadow-rdLg',
          saveResult.success ? 'bg-rd-surfaceHighlight text-rd-text' : 'bg-rd-danger/15 text-rd-danger',
        ].join(' ')}
      >
        {saveResult.success ? (
          <CheckCircle2 size={18} className="shrink-0 text-rd-success" />
        ) : (
          <AlertCircle size={18} className="shrink-0" />
        )}
        <span className="text-sm font-medium">{saveResult.message}</span>
      </div>
    </div>
  );
}

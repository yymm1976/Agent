// desktop/renderer/src/components/settings/SettingsHeader.tsx
// Phase 74-G：设置页顶部 Header（标题 + 关闭按钮 + 导入导出 + 自动保存指示）
// 从 SettingsPage.tsx 迁移

import { type ChangeEvent, type RefObject } from 'react';
import { X, Upload, Download } from 'lucide-react';
import { Button } from '../ui/button.js';

interface SettingsHeaderProps {
  /** 返回对话页 */
  onBack: () => void;
  /** 隐藏的文件输入 ref（用于导入配置） */
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** 导入配置 handler */
  handleImport: (e: ChangeEvent<HTMLInputElement>) => void;
  /** 导出配置 handler */
  handleExport: () => void;
  /** 是否正在自动保存 */
  saving: boolean;
}

/**
 * 设置页顶部 Header
 * 包含：关闭按钮 + 标题 + 导入/导出按钮 + 自动保存指示
 */
export function SettingsHeader({ onBack, fileInputRef, handleImport, handleExport, saving }: SettingsHeaderProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} title="关闭设置">
            <X size={18} />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold text-rd-text">设置</h1>
            <p className="text-sm text-rd-textMuted">管理模型、路由规则与应用偏好</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInputRef} type="file" accept="application/json" onChange={handleImport} className="hidden" />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} /> 导入
          </Button>
          <Button variant="outline" onClick={handleExport}>
            <Download size={16} /> 导出
          </Button>
          {saving && <span className="text-xs text-rd-textMuted">自动保存中...</span>}
        </div>
      </div>
    </div>
  );
}

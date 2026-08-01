// desktop/renderer/src/components/settings/SettingsDialogs.tsx
// 设置页对话框区：错误提示横幅（替代原生 alert）
// 从 SettingsPage.tsx 迁移

import { AlertBanner } from '../ui/dialog.js';

interface SettingsDialogsProps {
  /** 当前告警消息（null 时隐藏） */
  alertMsg: string | null;
  /** 关闭告警 */
  onDismiss: () => void;
}

/**
 * 设置页对话框集合
 *
 * 当前仅包含 AlertBanner（错误提示横幅）。
 * confirmDialog 状态由主组件管理（hooks 通过 setter 触发），不在本组件渲染。
 */
export function SettingsDialogs({ alertMsg, onDismiss }: SettingsDialogsProps) {
  return (
    <AlertBanner message={alertMsg} onDismiss={onDismiss} />
  );
}

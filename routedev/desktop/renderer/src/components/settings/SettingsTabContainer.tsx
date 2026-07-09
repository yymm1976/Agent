// desktop/renderer/src/components/settings/SettingsTabContainer.tsx
// F-066：提取 settings tab 公共容器
// 多个 settings tab 组件原本各自渲染 <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">，
// 重复且容易在新增 tab 时漏写或写错（导致 flexbox 高度抖动）。
// 这里提取为公共容器，统一外层布局并提供单一修改点。

import type { ReactNode } from 'react';

interface SettingsTabContainerProps {
  children: ReactNode;
  /**
   * 容器额外 className（保留扩展能力，目前所有 tab 均使用默认值）。
   * 默认值与原 tab 内联容器完全一致："absolute inset-0 space-y-6 overflow-y-auto pr-2"。
   */
  className?: string;
}

/**
 * Settings Tab 公共容器
 *
 * 布局说明：
 * - `absolute inset-0`：相对 SettingsPage 右侧内容区（`relative` 定位）填满，避免 flexbox 高度抖动
 * - `space-y-6`：内部 Card 之间的纵向间距
 * - `overflow-y-auto pr-2`：超出高度时滚动，右侧留出滚动条空间
 */
export function SettingsTabContainer({ children, className }: SettingsTabContainerProps) {
  const cls = className ?? 'absolute inset-0 space-y-6 overflow-y-auto pr-2';
  return <div className={cls}>{children}</div>;
}

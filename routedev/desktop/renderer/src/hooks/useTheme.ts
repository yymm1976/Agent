// desktop/renderer/src/hooks/useTheme.ts
// 主题应用 hook：根据 config.general.appearanceTheme、fontSize 和 accentColor
// 设置 document.documentElement 的 data-theme 属性和 --rd-* CSS 变量

import { useEffect } from 'react';
import type { AppConfig } from '../../../../src/config/schema.js';

/**
 * 根据配置应用主题和字体大小
 * 在 App.tsx 中调用，config 变化时自动同步到 <html> 元素
 */
export function useTheme(config: AppConfig | null): void {
  useEffect(() => {
    const root = document.documentElement;
    // 应用主题：white/black/gray/blue
    const theme = config?.general.appearanceTheme ?? 'black';
    root.setAttribute('data-theme', theme);
    // 应用字体大小（px），通过 CSS 变量控制 root font-size
    const fontSize = config?.general.fontSize ?? 14;
    root.style.setProperty('--rd-font-size', `${fontSize}px`);
    // 应用自定义主题色（覆盖预设主题的 primary 色）
    const accentColor = config?.general.accentColor ?? '';
    if (accentColor) {
      root.style.setProperty('--rd-primary', accentColor);
      // hover 色自动变亮 10%（简单实现：不修改 hover，保持预设或手动调整）
    } else {
      // 清除自定义色，恢复预设主题色（移除内联样式，让 CSS [data-theme] 规则生效）
      root.style.removeProperty('--rd-primary');
    }
  }, [config?.general.appearanceTheme, config?.general.fontSize, config?.general.accentColor]);
}

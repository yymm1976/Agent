// src/cli/output-style.ts
// Phase 34：Output Style 系统工具函数
// 将 minimal/standard/verbose 映射到 CLI 组件的具体渲染行为

import type { OutputStyle } from '../config/schema.js';
import type { DisclosureLevel } from './components/DisclosureLevel.js';

/** Output Style 到 DisclosureLevel 的映射 */
export function outputStyleToDisclosureLevel(style: OutputStyle): DisclosureLevel {
  switch (style) {
    case 'minimal':
      return 1;
    case 'standard':
      return 2;
    case 'verbose':
      return 3;
    default:
      // 防御性降级
      return 2;
  }
}

/** DisclosureLevel 到 Output Style 的反向映射（用于配置迁移/显示） */
export function disclosureLevelToOutputStyle(level: 1 | 2 | 3): OutputStyle {
  switch (level) {
    case 1:
      return 'minimal';
    case 2:
      return 'standard';
    case 3:
      return 'verbose';
    default:
      return 'standard';
  }
}

/** 是否展示思考过程（thinking / react_iteration） */
export function shouldShowThinking(style: OutputStyle, isExpanded = false): boolean {
  // minimal：完全隐藏；standard：折叠但可展开；verbose：默认展开
  if (style === 'minimal') return false;
  if (style === 'verbose') return true;
  // standard 下只有用户手动展开才显示
  return isExpanded;
}

/** 是否展示完整工具调用参数和返回结果 */
export function shouldShowToolDetails(style: OutputStyle, isExpanded = false): boolean {
  if (style === 'minimal') return false;
  if (style === 'verbose') return true;
  return isExpanded;
}

/** 是否展示进度信息（步骤计数 / 进度条 / 完整时间轴） */
export function shouldShowProgress(style: OutputStyle): 'none' | 'current' | 'count' | 'full' {
  switch (style) {
    case 'minimal':
      return 'current';
    case 'standard':
      return 'count';
    case 'verbose':
      return 'full';
    default:
      return 'count';
  }
}

/** 是否展示动效（Spinner / 计时器） */
export function shouldShowAnimation(style: OutputStyle): boolean {
  // minimal 模式下无动效，避免干扰轻度用户
  return style !== 'minimal';
}

/** 是否启用长任务计时器（>30s） */
export function shouldShowTimer(style: OutputStyle): boolean {
  return style !== 'minimal';
}

/** 完成后是否自动折叠 */
export function shouldAutoCollapseOnComplete(style: OutputStyle): boolean {
  // minimal / standard 成功后折叠；verbose 保留完整过程
  return style !== 'verbose';
}

/** 判断是否处于高信息密度模式 */
export function isHighDensity(style: OutputStyle): boolean {
  return style === 'verbose';
}

/** 输出样式切换顺序 */
export const OUTPUT_STYLE_CYCLE: OutputStyle[] = ['minimal', 'standard', 'verbose'];

/** 获取下一个输出样式 */
export function nextOutputStyle(current: OutputStyle): OutputStyle {
  const idx = OUTPUT_STYLE_CYCLE.indexOf(current);
  if (idx === -1) return 'standard';
  return OUTPUT_STYLE_CYCLE[(idx + 1) % OUTPUT_STYLE_CYCLE.length];
}

/** 解析用户输入的 output style 字符串（容错） */
export function parseOutputStyle(input: string): OutputStyle | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'minimal' || normalized === 'min') return 'minimal';
  if (normalized === 'standard' || normalized === 'std') return 'standard';
  if (normalized === 'verbose' || normalized === 'verb') return 'verbose';
  // 兼容旧版数字
  if (normalized === '1') return 'minimal';
  if (normalized === '2') return 'standard';
  if (normalized === '3') return 'verbose';
  return null;
}

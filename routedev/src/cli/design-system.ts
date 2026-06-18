// src/cli/design-system.ts
// CLI 设计系统（Phase 24 Task 1）
// 统一的视觉语言：颜色语义、消息样式、排版规范
// Phase 25 的 UI 组件将直接 import 此模块的常量和类型
//
// 设计原则：
//   1. 语义优先 — 颜色按"含义"而非"外观"分类（success 永远是绿色）
//   2. 单一来源 — 所有 UI 组件从此模块取色，禁止硬编码
//   3. 终端兼容 — 同时支持 truecolor 和 256 色（自动降级）

// ============================================================
// 颜色语义表
// ============================================================

/**
 * 语义颜色角色
 * - primary: 主要操作、正常状态
 * - success: 成功完成、自动放行
 * - warning: 需要注意、降级状态
 * - error: 错误、被禁止
 * - info: 系统消息、辅助信息
 * - accent: 特殊操作、高亮
 */
export type SemanticColor =
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'accent';

/**
 * 颜色值映射（truecolor 16M 色）
 * 检测 COLORTERM 环境变量决定是否使用 truecolor
 */
const TRUECOLOR_VALUES: Record<SemanticColor, string> = {
  primary: '#5B9BD5',  // 蓝色
  success: '#70AD47',  // 绿色
  warning: '#FFC000',  // 黄色
  error: '#FF4444',    // 红色
  info: '#A0A0A0',     // 灰色
  accent: '#E040A0',   // 品红
};

/**
 * 256 色降级映射（兼容老终端）
 * 使用 xterm 256 色调色板索引
 */
const COLOR256_VALUES: Record<SemanticColor, string> = {
  primary: 'blue',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  info: 'gray',
  accent: 'magenta',
};

/**
 * 检测终端是否支持 truecolor
 * COLORTERM=truecolor 或 COLORTERM=24bit 表示支持
 */
function supportsTruecolor(): boolean {
  const colorterm = process.env.COLORTERM ?? '';
  return colorterm === 'truecolor' || colorterm === '24bit';
}

/** 终端是否支持 truecolor（启动时检测一次） */
const USE_TRUECOLOR = supportsTruecolor();

/**
 * 获取语义颜色对应的终端颜色值
 * - truecolor 终端：返回 hex 字符串（Ink 支持）
 * - 256 色终端：返回颜色名（如 'red'）
 */
export function getColor(color: SemanticColor): string {
  return USE_TRUECOLOR ? TRUECOLOR_VALUES[color] : COLOR256_VALUES[color];
}

// ============================================================
// 消息样式
// ============================================================

/**
 * 消息样式定义
 * 统一前缀标签 + 语义颜色 + 字体修饰
 */
export interface MessageStyle {
  /** 前缀标签（如 "[路由]"、"[权限]"） */
  prefix: string;
  /** 语义颜色 */
  color: SemanticColor;
  /** 是否斜体（系统消息默认斜体） */
  italic?: boolean;
  /** 是否变暗（次要信息） */
  dim?: boolean;
}

/**
 * 统一的消息样式注册表
 * 所有系统消息按类别使用对应样式
 */
export const MESSAGE_STYLES: Record<string, MessageStyle> = {
  routing: { prefix: '[路由]', color: 'info', italic: true },
  permission: { prefix: '[权限]', color: 'warning' },
  config: { prefix: '[配置]', color: 'info', italic: true },
  compose: { prefix: '[编排]', color: 'accent' },
  hook: { prefix: '[钩子]', color: 'info', dim: true },
  error: { prefix: '[错误]', color: 'error' },
  success: { prefix: '[完成]', color: 'success' },
  system: { prefix: '[系统]', color: 'info', italic: true, dim: true },
  tool: { prefix: '[工具]', color: 'primary' },
  model: { prefix: '[模型]', color: 'info', italic: true },
};

/**
 * 获取消息样式
 * 未知类别回退到 system 样式
 */
export function getMessageStyle(category: string): MessageStyle {
  return MESSAGE_STYLES[category] ?? MESSAGE_STYLES.system;
}

// ============================================================
// 排版规范
// ============================================================

/**
 * 排版常量
 * 规定标题、正文、分隔线等的标准格式
 */
export const TYPOGRAPHY = {
  /** 标题颜色（primary 语义色） */
  titleColor: 'primary' as SemanticColor,
  /** 系统消息前缀分隔符 */
  prefixSeparator: ' ',
  /** 代码块缩进（空格数） */
  codeIndent: 2,
  /** 分隔线字符 */
  dividerChar: '─',
  /** 默认分隔线宽度（实际可按终端宽度自适应） */
  defaultDividerWidth: 60,
} as const;

/**
 * 生成指定宽度的分隔线
 * @param width 宽度（默认 60）
 */
export function divider(width: number = TYPOGRAPHY.defaultDividerWidth): string {
  return TYPOGRAPHY.dividerChar.repeat(Math.max(1, width));
}

// ============================================================
// 错误消息三要素结构
// ============================================================

/**
 * 错误消息三要素（Phase 24 Task 7 使用）
 * - what: 发生了什么
 * - why: 可能原因
 * - how: 建议操作
 */
export interface ErrorMessageContent {
  what: string;
  why?: string;
  how?: string;
}

/**
 * 格式化错误消息为三行结构
 * 输出格式：
 *   [错误] {what}
 *   可能原因：{why}
 *   建议：{how}
 */
export function formatErrorMessage(content: ErrorMessageContent): string {
  const lines = [`[错误] ${content.what}`];
  if (content.why) lines.push(`可能原因：${content.why}`);
  if (content.how) lines.push(`建议：${content.how}`);
  return lines.join('\n');
}

// ============================================================
// 场景等级颜色（专用于路由分层显示）
// ============================================================

/**
 * 路由场景等级对应的颜色
 * 与 StatusBar 的 tierColor 对齐，但通过设计系统统一管理
 */
export const TIER_COLORS: Record<string, SemanticColor> = {
  simple: 'success',
  medium: 'warning',
  complex: 'accent',
  reasoning: 'primary',
};

/**
 * 获取场景等级颜色
 */
export function getTierColor(tier: string): string {
  const semantic = TIER_COLORS[tier] ?? 'info';
  return getColor(semantic);
}

/**
 * 场景等级中文标签
 */
export const TIER_LABELS: Record<string, string> = {
  simple: '简单',
  medium: '中等',
  complex: '复杂',
  reasoning: '推理',
};

/**
 * 获取场景等级标签
 */
export function getTierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

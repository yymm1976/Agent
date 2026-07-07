// desktop/renderer/src/components/ui/tool-icon.tsx
// 按工具类型着色的图标组件：用于工具调用卡片、产物面板、任务面板

import { type HTMLAttributes } from 'react';
import { Bot, FileText, Plug, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react';

/** 工具类型 */
export type ToolType =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'shell_exec'
  | 'command'
  | 'spawn_agent'
  | 'sub_agent'
  | 'web_search'
  | 'web_fetch'
  | 'mcp_tool'
  | 'unknown';

/** 尺寸 */
export type ToolIconSize = 'sm' | 'md' | 'lg';

export interface ToolIconProps extends HTMLAttributes<HTMLSpanElement> {
  /** 工具类型 */
  toolType: ToolType;
  /** 尺寸：sm/md/lg，默认 md */
  size?: ToolIconSize;
}

/** 工具类型 → 图标 + 颜色 token 映射 */
const toolConfig: Record<ToolType, { icon: LucideIcon; colorVar: string }> = {
  file_read: { icon: FileText, colorVar: '--rd-tool-file' },
  file_write: { icon: FileText, colorVar: '--rd-tool-file' },
  file_edit: { icon: FileText, colorVar: '--rd-tool-file' },
  shell_exec: { icon: Terminal, colorVar: '--rd-tool-shell' },
  command: { icon: Terminal, colorVar: '--rd-tool-shell' },
  spawn_agent: { icon: Bot, colorVar: '--rd-tool-agent' },
  sub_agent: { icon: Bot, colorVar: '--rd-tool-agent' },
  web_search: { icon: Search, colorVar: '--rd-tool-web' },
  web_fetch: { icon: Search, colorVar: '--rd-tool-web' },
  mcp_tool: { icon: Plug, colorVar: '--rd-tool-mcp' },
  unknown: { icon: Wrench, colorVar: '--rd-tool-default' },
};

/** 尺寸样式映射 */
const sizeStyles: Record<ToolIconSize, { wrap: string; icon: string }> = {
  sm: { wrap: 'p-1', icon: 'h-3 w-3' },
  md: { wrap: 'p-1.5', icon: 'h-4 w-4' },
  lg: { wrap: 'p-2', icon: 'h-5 w-5' },
};

export function ToolIcon({
  toolType,
  size = 'md',
  className = '',
  ...props
}: ToolIconProps) {
  const config = toolConfig[toolType] ?? toolConfig.unknown;
  const Icon = config.icon;
  const sizeStyle = sizeStyles[size];

  return (
    <span
      data-tool-type={toolType}
      className={`inline-flex items-center justify-center rounded-md ${sizeStyle.wrap} ${className}`}
      style={{ color: `var(${config.colorVar})`, backgroundColor: `color-mix(in srgb, var(${config.colorVar}) 12%, transparent)` }}
      {...props}
    >
      <Icon className={sizeStyle.icon} aria-hidden="true" />
    </span>
  );
}

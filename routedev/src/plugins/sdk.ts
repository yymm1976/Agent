// src/plugins/sdk.ts
// 插件 SDK：提供类型安全的 define*Plugin 辅助函数
// 所有 define* 函数是纯函数，id 自动生成为 `${type}-${name}`，version 默认 '1.0.0'
// init() / destroy() 为空 async 函数，插件作者可按需覆写

import type {
  ToolPlugin,
  HookPlugin,
  ThemePlugin,
  RouterPlugin,
  ThemeColors,
} from './types.js';
import type {
  ITool,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../tools/types.js';
import type { MiddlewarePhase, MiddlewareHandler } from '../agent/middleware.js';
import type { ClassificationInput, ClassificationResult } from '../router/types.js';

// ============================================================
// 简化工具定义
// ============================================================

/** 简化工具定义：SDK 自动填充 category='system', requiresApproval=false, validateArgs=always-valid */
export interface SimpleToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** 是否需要用户确认（默认 false） */
  requiresApproval?: boolean;
  /** 工具分类（默认 'system'） */
  category?: ToolDefinition['category'];
  /** 执行函数 */
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

/** 将 SimpleToolDef 包装为完整 ITool */
function wrapTool(def: SimpleToolDef): ITool {
  return {
    definition: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      requiresApproval: def.requiresApproval ?? false,
      category: def.category ?? 'system',
    },
    async execute(args, context) {
      return def.execute(args, context);
    },
    validateArgs(_args) {
      // SDK 工具默认总是有效，插件作者可自行实现更严格的校验
      return { valid: true, errors: [] };
    },
  };
}

// ============================================================
// 四个 define*Plugin 辅助函数
// ============================================================

/**
 * 定义工具插件
 * @param name 插件名（人类可读）
 * @param tools 简化工具定义列表
 * @returns 完整 ToolPlugin（id=`tool-${name}`, version='1.0.0'）
 */
export function defineToolPlugin(name: string, tools: SimpleToolDef[]): ToolPlugin {
  const wrappedTools: ITool[] = tools.map(wrapTool);
  return {
    id: `tool-${name}`,
    name,
    version: '1.0.0',
    type: 'tool',
    enabled: true,
    async init() {
      // 默认空实现，插件作者可覆写
    },
    async destroy() {
      // 默认空实现，插件作者可覆写
    },
    getTools() {
      return wrappedTools;
    },
  };
}

/**
 * 定义钩子插件
 * @param name 插件名
 * @param hooks 钩子列表（phase + handler）
 * @returns 完整 HookPlugin（id=`hook-${name}`, version='1.0.0'）
 */
export function defineHookPlugin(
  name: string,
  hooks: Array<{ phase: MiddlewarePhase; handler: MiddlewareHandler }>,
): HookPlugin {
  return {
    id: `hook-${name}`,
    name,
    version: '1.0.0',
    type: 'hook',
    enabled: true,
    async init() {
      // 默认空实现
    },
    async destroy() {
      // 默认空实现
    },
    getHooks() {
      return hooks;
    },
  };
}

/** 主题定义（colors 部分覆盖 + 可选状态栏渲染） */
export interface ThemeDef {
  colors?: Partial<ThemeColors>;
  renderStatusBar?: (props: Record<string, unknown>) => unknown;
}

/**
 * 定义主题插件
 * @param name 插件名
 * @param theme 主题定义（colors + 可选 renderStatusBar）
 * @returns 完整 ThemePlugin（id=`theme-${name}`, version='1.0.0'）
 */
export function defineThemePlugin(name: string, theme: ThemeDef): ThemePlugin {
  return {
    id: `theme-${name}`,
    name,
    version: '1.0.0',
    type: 'theme',
    enabled: true,
    async init() {
      // 默认空实现
    },
    async destroy() {
      // 默认空实现
    },
    ...(theme.colors ? { colors: theme.colors } : {}),
    ...(theme.renderStatusBar ? { renderStatusBar: theme.renderStatusBar } : {}),
  };
}

/**
 * 定义路由插件
 * @param name 插件名
 * @param classifier 分类函数（返回 null 表示交还宿主默认分类器）
 * @returns 完整 RouterPlugin（id=`router-${name}`, version='1.0.0'）
 */
export function defineRouterPlugin(
  name: string,
  classifier: (input: ClassificationInput) => Promise<ClassificationResult | null>,
): RouterPlugin {
  return {
    id: `router-${name}`,
    name,
    version: '1.0.0',
    type: 'router',
    enabled: true,
    async init() {
      // 默认空实现
    },
    async destroy() {
      // 默认空实现
    },
    async classify(input) {
      return classifier(input);
    },
  };
}

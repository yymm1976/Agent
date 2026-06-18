// src/plugins/types.ts
// 插件系统核心类型定义（Phase 22）
// 包含：Plugin 基础接口、四种特化类型（theme/tool/hook/router）、清单、状态

import type { ITool, ToolDefinition, ToolExecutionContext, ToolResult } from '../tools/types.js';
import type { MiddlewarePhase, MiddlewareHandler } from '../agent/middleware.js';
import type { ClassificationInput, ClassificationResult, RouteDecision } from '../router/types.js';

// ============================================================
// 插件类型枚举
// ============================================================

/** 四种插件类型 */
export type PluginType = 'theme' | 'tool' | 'hook' | 'router';

// ============================================================
// 插件基础接口
// ============================================================

/** 插件初始化上下文：传递 cwd / 配置 / 日志回调 */
export interface PluginInitContext {
  /** 工作目录 */
  cwd: string;
  /** 插件配置（来自清单或宿主注入） */
  config: Record<string, unknown>;
  /** 日志回调（与宿主 logger 对接） */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

/** 所有插件必须实现的基础接口 */
export interface Plugin {
  /** 插件唯一标识（约定为 `${type}-${name}`） */
  readonly id: string;
  /** 插件名（人类可读） */
  readonly name: string;
  /** 插件版本（semver） */
  readonly version: string;
  /** 插件类型 */
  readonly type: PluginType;
  /** 是否启用（运行时可切换） */
  enabled: boolean;
  /** 初始化：插件加载后调用一次，可访问宿主上下文 */
  init(context: PluginInitContext): Promise<void>;
  /** 销毁：插件卸载/宿主退出时调用，用于清理资源 */
  destroy(): Promise<void>;
}

// ============================================================
// 主题插件
// ============================================================

/** 主题色板 */
export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  error: string;
  success: string;
}

/** 主题插件：自定义状态栏渲染与配色 */
export interface ThemePlugin extends Plugin {
  readonly type: 'theme';
  /** 自定义状态栏渲染（预留，本 Phase 不接入） */
  renderStatusBar?: (props: Record<string, unknown>) => unknown;
  /** 自定义配色（部分覆盖） */
  colors?: Partial<ThemeColors>;
}

// ============================================================
// 工具插件
// ============================================================

/** 工具插件：向 ToolRegistry 注入自定义工具 */
export interface ToolPlugin extends Plugin {
  readonly type: 'tool';
  /** 返回该插件提供的所有工具 */
  getTools(): ITool[];
}

// ============================================================
// 钩子插件
// ============================================================

/** 钩子插件：向 AgentMiddlewarePipeline 注入中间件 */
export interface HookPlugin extends Plugin {
  readonly type: 'hook';
  /** 返回该插件挂载的所有钩子（phase + handler） */
  getHooks(): Array<{ phase: MiddlewarePhase; handler: MiddlewareHandler }>;
}

// ============================================================
// 路由插件
// ============================================================

/** 路由插件：替换/增强场景分类逻辑（同一时刻最多一个生效） */
export interface RouterPlugin extends Plugin {
  readonly type: 'router';
  /** 分类输入，返回 null 表示交还宿主默认分类器 */
  classify(input: ClassificationInput): Promise<ClassificationResult | null>;
  /**
   * 路由决策（Phase 27 Task 2）：基于分类结果选择模型
   * 返回 null 表示交还宿主默认路由逻辑
   */
  route?(classification: ClassificationResult): Promise<RouteDecision | null>;
}

// ============================================================
// 插件清单（routedev-plugin.json）
// ============================================================

/** 插件清单：声明插件元数据与入口 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  type: PluginType;
  /** 入口文件（相对插件目录，默认 index.js） */
  entry: string;
  /** 配置 schema（可选，用于校验用户配置） */
  configSchema?: Record<string, unknown>;
  /** 所需最小宿主版本（可选） */
  minHostVersion?: string;
}

// ============================================================
// 插件运行时状态
// ============================================================

/** 插件状态快照（供 /plugin 命令查询） */
export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  type: PluginType;
  enabled: boolean;
  loaded: boolean;
  /** 加载/初始化失败时的错误信息 */
  error?: string;
  /** 已注册的工具名列表 */
  registeredTools?: string[];
  /** 已注册的钩子阶段列表 */
  registeredHooks?: MiddlewarePhase[];
}

// ============================================================
// SDK 用的简化类型（重新导出，便于插件作者引用）
// ============================================================

export type { ITool, ToolDefinition, ToolExecutionContext, ToolResult };

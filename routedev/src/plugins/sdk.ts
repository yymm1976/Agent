// src/plugins/sdk.ts
// 轻量级插件 SDK：插件作者通过此 SDK 与宿主交互
//
// 设计原则：
//   - 接口最小化：只暴露插件需要的能力子集
//   - 安全隔离：插件通过注册表接口注册工具/命令/钩子/中间件，不直接访问宿主内部
//   - fail-open：单个插件失败不影响其他插件（由 PluginLoader 保证）
//
// 与 src/plugins/types.ts 的关系：
//   - types.ts 定义现有插件系统（theme/tool/hook/router 四种特化类型）
//   - sdk.ts 定义新的通用插件接口（RouteDevPlugin），更灵活，支持生命周期 + 多能力注册
//   - 两套系统并存，互不冲突；RouteDevPlugin 是面向未来的扩展点

import type { ITool } from '../tools/types.js';

// ============================================================
// Logger 接口（与宿主 logger 对齐的子集）
// ============================================================

/** 插件可用的日志接口 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

// ============================================================
// 命令接口（与 cli/command-registry 对齐的子集）
// ============================================================

/** 命令定义（插件可注册的简化版） */
export interface ICommand {
  /** 命令名（如 /my-cmd） */
  name: string;
  /** 简短说明 */
  description: string;
  /** 用法示例 */
  usage?: string;
  /** 别名 */
  aliases?: string[];
  /** 处理器：接收参数字符串，返回输出字符串 */
  handler: (args: string) => Promise<string>;
}

// ============================================================
// 插件上下文
// ============================================================

/** 插件运行时上下文：宿主在 onLoad 时注入 */
export interface PluginContext {
  /** 日志器 */
  logger: Logger;
  /** 插件配置（来自宿主或用户配置） */
  config: Record<string, unknown>;
  /** 当前工作目录 */
  cwd: string;
  /** 读取文件（受限于宿主沙箱） */
  readFile(path: string): Promise<string>;
  /** 写入文件（受限于宿主沙箱） */
  writeFile(path: string, content: string): Promise<void>;
}

// ============================================================
// 注册表接口（暴露给插件的安全子集）
// ============================================================

/** 工具注册表接口（插件通过此注册/注销工具） */
export interface ToolRegistryInterface {
  register(tool: ITool): void;
  unregister(name: string): void;
  list(): string[];
}

/** 命令注册表接口 */
export interface CommandRegistryInterface {
  register(command: ICommand): void;
  unregister(name: string): void;
  list(): string[];
}

/** 钩子注册表接口 */
export interface HookRegistryInterface {
  register(event: string, handler: Function): void;
  unregister(event: string): void;
}

/** 中间件注册表接口 */
export interface MiddlewareRegistryInterface {
  register(phase: string, handler: Function): void;
  unregister(phase: string): void;
}

// ============================================================
// 插件接口
// ============================================================

/**
 * RouteDev 通用插件接口
 * 插件作者实现此接口，通过 PluginLoader 加载
 */
export interface RouteDevPlugin {
  /** 插件名（唯一标识，必填） */
  name: string;
  /** 插件版本（semver，必填） */
  version: string;
  /** 插件描述（可选） */
  description?: string;

  // 生命周期
  /** 加载时调用，传入 PluginContext */
  onLoad?(context: PluginContext): void;
  /** 卸载时调用，用于清理资源 */
  onUnload?(): void;

  // 能力注册（插件按需实现）
  /** 注册工具 */
  registerTools?(registry: ToolRegistryInterface): void;
  /** 注册命令 */
  registerCommands?(registry: CommandRegistryInterface): void;
  /** 注册钩子 */
  registerHooks?(registry: HookRegistryInterface): void;
  /** 注册中间件 */
  registerMiddleware?(registry: MiddlewareRegistryInterface): void;
}

// ============================================================
// 内部使用的注册表实现（收集插件注册的工具/命令/钩子/中间件）
// ============================================================

/**
 * 收集型注册表：插件注册的内容暂存在内存中，
 * 宿主可通过 getRegistered() 取出再桥接到真实的 ToolRegistry / CommandRegistry
 *
 * 这是 SDK 的内部实现，不直接暴露给插件作者
 */
export class CollectingToolRegistry implements ToolRegistryInterface {
  private tools = new Map<string, ITool>();

  register(tool: ITool): void {
    this.tools.set(tool.definition.name, tool);
  }
  unregister(name: string): void {
    this.tools.delete(name);
  }
  list(): string[] {
    return Array.from(this.tools.keys());
  }
  /** 取出所有已注册的工具（供宿主桥接） */
  getRegistered(): ITool[] {
    return Array.from(this.tools.values());
  }
}

export class CollectingCommandRegistry implements CommandRegistryInterface {
  private commands = new Map<string, ICommand>();

  register(command: ICommand): void {
    this.commands.set(command.name, command);
  }
  unregister(name: string): void {
    this.commands.delete(name);
  }
  list(): string[] {
    return Array.from(this.commands.keys());
  }
  getRegistered(): ICommand[] {
    return Array.from(this.commands.values());
  }
}

export class CollectingHookRegistry implements HookRegistryInterface {
  private hooks = new Map<string, Function>();

  register(event: string, handler: Function): void {
    this.hooks.set(event, handler);
  }
  unregister(event: string): void {
    this.hooks.delete(event);
  }
  getRegistered(): Map<string, Function> {
    return new Map(this.hooks);
  }
}

export class CollectingMiddlewareRegistry implements MiddlewareRegistryInterface {
  private middlewares = new Map<string, Function>();

  register(phase: string, handler: Function): void {
    this.middlewares.set(phase, handler);
  }
  unregister(phase: string): void {
    this.middlewares.delete(phase);
  }
  getRegistered(): Map<string, Function> {
    return new Map(this.middlewares);
  }
}

// ============================================================
// 工具函数：校验插件接口完整性
// ============================================================

/**
 * 校验插件对象是否符合 RouteDevPlugin 接口
 * 必须有 name 和 version 字段
 * @returns 校验通过返回 null，失败返回错误消息
 */
export function validatePlugin(plugin: unknown): string | null {
  if (!plugin || typeof plugin !== 'object') {
    return '插件导出必须是对象';
  }
  const p = plugin as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name.trim()) {
    return '插件缺少 name 字段或 name 为空';
  }
  if (typeof p.version !== 'string' || !p.version.trim()) {
    return '插件缺少 version 字段或 version 为空';
  }
  return null;
}

// src/plugins/sdk-loader.ts
// 插件加载器：从文件/目录动态加载 RouteDevPlugin
//
// 设计原则：
//   - fail-open：单个插件加载失败不影响其他插件
//   - 接口校验：加载前检查 name/version 必须有
//   - 生命周期：onLoad 加载、onUnload 卸载
//   - 路径安全：只加载 .js/.mjs/.cjs 文件
//
// 与 src/plugins/registry.ts 的关系：
//   - registry.ts 是现有的清单驱动（routedev-plugin.json）插件系统
//   - sdk-loader.ts 是新的轻量级动态加载器，面向 SDK 插件（RouteDevPlugin）
//   - 两者并存，sdk-loader 用于运行时通过 /plugins load <path> 动态加载

import { logger } from '../utils/logger.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import type { ITool } from '../tools/types.js';
import {
  validatePlugin,
  CollectingToolRegistry,
  CollectingCommandRegistry,
  CollectingHookRegistry,
  CollectingMiddlewareRegistry,
  type RouteDevPlugin,
  type PluginContext,
  type ICommand,
} from './sdk.js';

const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** 已加载插件的内部记录 */
interface LoadedPluginRecord {
  plugin: RouteDevPlugin;
  path: string;
  /** 收集型注册表（用于 unload 时清理） */
  toolRegistry: CollectingToolRegistry;
  commandRegistry: CollectingCommandRegistry;
  hookRegistry: CollectingHookRegistry;
  middlewareRegistry: CollectingMiddlewareRegistry;
  /** 是否已调用 onLoad */
  loaded: boolean;
}

/**
 * 插件加载器
 * 用法：
 *   const loader = new PluginLoader(context);
 *   const plugin = await loader.loadFromFile('/path/to/plugin.js');
 *   loader.listLoaded(); // 查询已加载
 *   await loader.unload(plugin); // 卸载
 */
export class PluginLoader {
  private loaded = new Map<string, LoadedPluginRecord>();
  private context: PluginContext;

  constructor(context: PluginContext) {
    this.context = context;
  }

  // ----------------------------------------------------------
  // 从文件加载单个插件
  // ----------------------------------------------------------

  /**
   * 从文件加载插件
   * @param path 插件入口文件路径（绝对或相对 cwd）
   * @returns 加载成功的插件实例
   * @throws 当接口校验失败或 import 失败时抛错
   */
  async loadFromFile(path: string): Promise<RouteDevPlugin> {
    const resolvedPath = this.resolvePath(path);

    // 扩展名校验
    const ext = extname(resolvedPath);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(`不支持的插件文件扩展名: ${ext || '<none>'}（仅支持 .js/.mjs/.cjs）`);
    }

    // 动态 import（使用 file:// URL 兼容 Windows）
    const fileUrl = pathToFileURL(resolvedPath).href;
    let mod: any;
    try {
      mod = await import(fileUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`加载插件文件失败: ${path} — ${msg}`);
    }

    // 提取插件对象：优先 default，其次 plugin 命名导出
    const plugin: unknown = mod?.default ?? mod?.plugin;
    const validationError = validatePlugin(plugin);
    if (validationError) {
      throw new Error(`插件接口校验失败: ${path} — ${validationError}`);
    }

    const routeDevPlugin = plugin as RouteDevPlugin;

    // 重复加载检查（按 name 去重）
    if (this.loaded.has(routeDevPlugin.name)) {
      throw new Error(`插件已加载，无法重复加载: ${routeDevPlugin.name}`);
    }

    // 创建收集型注册表
    const toolRegistry = new CollectingToolRegistry();
    const commandRegistry = new CollectingCommandRegistry();
    const hookRegistry = new CollectingHookRegistry();
    const middlewareRegistry = new CollectingMiddlewareRegistry();

    // 调用 onLoad
    try {
      if (routeDevPlugin.onLoad) {
        routeDevPlugin.onLoad(this.context);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // onLoad 失败：不记录到 loaded，直接抛错
      throw new Error(`插件 onLoad 失败: ${routeDevPlugin.name} — ${msg}`);
    }

    // 调用能力注册（每个独立 try-catch，单个失败不影响其他）
    this.safeRegister(
      () => routeDevPlugin.registerTools?.(toolRegistry),
      routeDevPlugin.name,
      'registerTools',
    );
    this.safeRegister(
      () => routeDevPlugin.registerCommands?.(commandRegistry),
      routeDevPlugin.name,
      'registerCommands',
    );
    this.safeRegister(
      () => routeDevPlugin.registerHooks?.(hookRegistry),
      routeDevPlugin.name,
      'registerHooks',
    );
    this.safeRegister(
      () => routeDevPlugin.registerMiddleware?.(middlewareRegistry),
      routeDevPlugin.name,
      'registerMiddleware',
    );

    const record: LoadedPluginRecord = {
      plugin: routeDevPlugin,
      path: resolvedPath,
      toolRegistry,
      commandRegistry,
      hookRegistry,
      middlewareRegistry,
      loaded: true,
    };
    this.loaded.set(routeDevPlugin.name, record);

    logger.info(`Plugin loaded: ${routeDevPlugin.name} v${routeDevPlugin.version}`, {
      path: resolvedPath,
      tools: toolRegistry.list(),
      commands: commandRegistry.list(),
    });

    return routeDevPlugin;
  }

  // ----------------------------------------------------------
  // 从目录加载所有插件
  // ----------------------------------------------------------

  /**
   * 从目录加载所有 .js/.mjs/.cjs 文件作为插件
   * fail-open：单个插件失败不影响其他
   * @param dir 目录路径
   * @returns 加载成功的插件列表（失败的被跳过）
   */
  async loadFromDir(dir: string): Promise<RouteDevPlugin[]> {
    const resolvedDir = this.resolvePath(dir);

    let entries: string[];
    try {
      entries = await readdir(resolvedDir);
    } catch (err) {
      // 目录不存在或不可读——静默返回空数组
      logger.debug(`Plugin dir not readable, skipping: ${resolvedDir}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const results: RouteDevPlugin[] = [];
    for (const entry of entries) {
      const fullPath = resolve(resolvedDir, entry);
      let isFile = false;
      try {
        const s = await stat(fullPath);
        isFile = s.isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;

      const ext = extname(fullPath);
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;

      try {
        const plugin = await this.loadFromFile(fullPath);
        results.push(plugin);
      } catch (err) {
        // fail-open：单个插件失败不影响其他
        logger.warn(`Plugin load failed, skipping: ${fullPath}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  // ----------------------------------------------------------
  // 卸载插件
  // ----------------------------------------------------------

  /**
   * 卸载插件：调用 onUnload，清理注册表
   * @param plugin 插件实例或插件名
   */
  async unload(plugin: RouteDevPlugin | string): Promise<void> {
    const name = typeof plugin === 'string' ? plugin : plugin.name;
    const record = this.loaded.get(name);
    if (!record) {
      throw new Error(`插件未加载，无法卸载: ${name}`);
    }

    // 调用 onUnload（失败不阻塞清理）
    try {
      if (record.plugin.onUnload) {
        await record.plugin.onUnload();
      }
    } catch (err) {
      logger.warn(`Plugin onUnload failed: ${name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 清理收集型注册表
    record.toolRegistry.getRegistered().forEach((t: ITool) => {
      record.toolRegistry.unregister(t.definition.name);
    });
    record.commandRegistry.getRegistered().forEach((c: ICommand) => {
      record.commandRegistry.unregister(c.name);
    });
    record.hookRegistry.getRegistered().forEach((_, event) => {
      record.hookRegistry.unregister(event);
    });
    record.middlewareRegistry.getRegistered().forEach((_, phase) => {
      record.middlewareRegistry.unregister(phase);
    });

    this.loaded.delete(name);
    record.loaded = false;
    logger.info(`Plugin unloaded: ${name}`);
  }

  // ----------------------------------------------------------
  // 查询
  // ----------------------------------------------------------

  /**
   * 获取已加载插件列表
   * @returns 已加载插件的 name/version/path 数组
   */
  listLoaded(): Array<{ name: string; version: string; path: string }> {
    const result: Array<{ name: string; version: string; path: string }> = [];
    for (const record of this.loaded.values()) {
      result.push({
        name: record.plugin.name,
        version: record.plugin.version,
        path: record.path,
      });
    }
    return result;
  }

  /**
   * 获取插件已注册的工具列表（供宿主桥接到真实 ToolRegistry）
   * @returns 工具数组，未加载则返回空
   */
  getPluginTools(name: string): ITool[] {
    const record = this.loaded.get(name);
    if (!record) return [];
    return record.toolRegistry.getRegistered();
  }

  /**
   * 获取插件已注册的命令列表
   */
  getPluginCommands(name: string): ICommand[] {
    const record = this.loaded.get(name);
    if (!record) return [];
    return record.commandRegistry.getRegistered();
  }

  /**
   * 获取插件已注册的钩子
   */
  getPluginHooks(name: string): Map<string, Function> {
    const record = this.loaded.get(name);
    if (!record) return new Map();
    return record.hookRegistry.getRegistered();
  }

  /**
   * 获取插件已注册的中间件
   */
  getPluginMiddleware(name: string): Map<string, Function> {
    const record = this.loaded.get(name);
    if (!record) return new Map();
    return record.middlewareRegistry.getRegistered();
  }

  /**
   * 按插件名获取已加载的插件实例
   */
  getPlugin(name: string): RouteDevPlugin | undefined {
    return this.loaded.get(name)?.plugin;
  }

  /** 是否已加载某插件 */
  has(name: string): boolean {
    return this.loaded.has(name);
  }

  // ----------------------------------------------------------
  // 内部工具
  // ----------------------------------------------------------

  /** 解析路径：相对路径基于 context.cwd 解析 */
  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.context.cwd, p);
  }

  /** 安全执行注册函数：失败仅记录警告 */
  private safeRegister(fn: () => void | undefined, pluginName: string, phase: string): void {
    try {
      fn();
    } catch (err) {
      logger.warn(`Plugin ${phase} failed: ${pluginName}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ============================================================
// 工厂函数：创建默认 PluginContext
// ============================================================

/**
 * 创建默认的 PluginContext
 * - logger 桥接到宿主 winston logger
 * - readFile/writeFile 直接使用 node:fs，受限于 cwd
 */
export function createDefaultPluginContext(cwd: string, config: Record<string, unknown> = {}): PluginContext {
  return {
    logger: {
      info: (msg, meta) => logger.info(`[plugin] ${msg}`, meta ?? {}),
      warn: (msg, meta) => logger.warn(`[plugin] ${msg}`, meta ?? {}),
      error: (msg, meta) => logger.error(`[plugin] ${msg}`, meta ?? {}),
      debug: (msg, meta) => logger.debug(`[plugin] ${msg}`, meta ?? {}),
    },
    config,
    cwd,
    readFile: (p: string) => readFile(p, 'utf-8'),
    writeFile: (p: string, content: string) => fsWriteFile(p, content, 'utf-8'),
  };
}

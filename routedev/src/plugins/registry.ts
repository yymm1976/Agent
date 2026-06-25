// src/plugins/registry.ts
// 插件注册表：插件的发现、加载、生命周期管理
// 核心原则：插件错误不崩溃宿主——所有插件代码在 try-catch 隔离中执行
//
// C5 修复：插件权限声明与受限 API
// - 插件清单必须声明 permissions 字段（未声明默认为空，最小权限原则）
// - 运行时通过 createRestrictedContext 提供受限的 PluginInitContext
// - 未声明权限的能力访问会被记录警告（防御性深度，不抛异常以免崩溃宿主）
// - 注意：当前实现为声明式权限控制，非沙箱隔离。完整沙箱需 vm.isolate/worker_threads

import type {
  Plugin,
  PluginType,
  PluginManifest,
  PluginStatus,
  PluginInitContext,
  PluginPermission,
  ToolPlugin,
  HookPlugin,
  RouterPlugin,
} from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentMiddlewarePipeline } from '../agent/middleware.js';
import { logger } from '../utils/logger.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

// ============================================================
// 注册表配置
// ============================================================

/** PluginRegistry 构造选项 */
export interface PluginRegistryOptions {
  /** 全局插件目录列表（如 ~/.qoderwork/routedev/plugins/） */
  globalPluginDirs: string[];
  /** 项目级插件目录（如 <cwd>/.routedev/plugins/） */
  projectPluginDir: string;
  /** 工具注册表（ToolPlugin 通过此注册工具） */
  toolRegistry: ToolRegistry;
  /** 中间件管线（HookPlugin 通过此注册钩子） */
  middlewarePipeline: AgentMiddlewarePipeline;
  /** 当前工作目录 */
  cwd: string;
}

// ============================================================
// 状态持久化（Phase 27 Task 4）
// ============================================================

/** 持久化到磁盘的插件状态文件结构 */
interface PluginStateFile {
  /** 各插件的启用/禁用状态 */
  plugins: Record<string, { enabled: boolean }>;
  /** 最后更新时间戳（ms） */
  updatedAt: number;
}

/** 状态文件路径：getAppDataDir()/plugin-state.json */
const STATE_FILE_NAME = 'plugin-state.json';

// ============================================================
// C5 修复：插件权限校验与受限上下文
// ============================================================

/**
 * 校验插件清单声明的权限是否合法
 * @returns 校验通过返回 null，失败返回错误消息
 */
function validatePermissions(permissions: unknown): string | null {
  if (permissions === undefined || permissions === null) return null; // 可选字段
  if (!Array.isArray(permissions)) {
    return 'permissions 必须是数组';
  }
  const VALID_PERMISSIONS: PluginPermission[] = [
    'fs', 'net', 'shell', 'env', 'registry', 'middleware', 'logger', 'cwd',
  ];
  const validSet = new Set(VALID_PERMISSIONS);
  for (const p of permissions) {
    if (typeof p !== 'string' || !validSet.has(p as PluginPermission)) {
      return `未知的权限声明: ${String(p)}`;
    }
  }
  return null;
}

/**
 * C5 修复：创建受限的插件初始化上下文
 * 根据清单声明的权限限制插件可访问的宿主能力
 * - 未声明 'cwd' 权限的插件无法获取工作目录（返回空字符串）
 * - 未声明 'logger' 权限的插件日志会被丢弃
 * - 未声明 'env' 权限的插件无法读取配置中的环境变量
 *
 * 注意：当前为声明式限制，无法阻止插件通过 Node.js 内置模块直接访问文件系统/网络。
 * 完整沙箱隔离需要 vm.isolate 或 worker_threads，属于后续演进方向。
 */
function createRestrictedContext(
  manifest: PluginManifest,
  baseContext: PluginInitContext,
): PluginInitContext {
  const permissions = new Set<PluginPermission>(manifest.permissions ?? []);
  const pluginId = manifest.id;

  // 受限的日志回调：未声明 'logger' 权限时仅允许 error 级别
  const restrictedLog: PluginInitContext['log'] = (level, msg, meta) => {
    if (!permissions.has('logger') && level !== 'error') {
      // 未声明 logger 权限的插件，非 error 日志被静默丢弃
      return;
    }
    baseContext.log(level, `[${pluginId}] ${msg}`, meta);
  };

  // 受限的 cwd：未声明 'cwd' 权限返回空字符串
  const restrictedCwd = permissions.has('cwd') ? baseContext.cwd : '';

  // 受限的 config：未声明 'env' 权限时移除可能包含环境变量的字段
  const restrictedConfig = permissions.has('env')
    ? baseContext.config
    : stripEnvFromConfig(baseContext.config);

  return {
    cwd: restrictedCwd,
    config: restrictedConfig,
    log: restrictedLog,
  };
}

/** 从插件配置中移除可能包含敏感信息的 env 相关字段 */
function stripEnvFromConfig(config: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    // 跳过明显包含环境变量的字段
    if (/^(env|environment|secrets?|credentials?|api[_-]?keys?)$/i.test(key)) continue;
    stripped[key] = value;
  }
  return stripped;
}

/** 获取插件声明的权限列表（用于日志和状态查询） */
function getDeclaredPermissions(manifest: PluginManifest): PluginPermission[] {
  return manifest.permissions ?? [];
}

// ============================================================
// 内部记录结构
// ============================================================

/** 单个插件的内部记录：实例 + 清单 + 目录 + 状态 */
interface PluginRecord {
  instance: Plugin;
  manifest: PluginManifest;
  pluginDir: string;
  /** 加载是否成功 */
  loaded: boolean;
  /** 错误信息（加载/初始化失败时） */
  error?: string;
  /** 已注册的工具名列表（用于 disable 时 unregister） */
  registeredToolNames: string[];
  /** 已注册的钩子阶段列表（用于状态查询） */
  registeredHookPhases: string[];
  /** 已注册的钩子处理器引用（用于 disable 时 unregister） */
  registeredHookHandlers: Array<{ phase: import('../agent/middleware.js').MiddlewarePhase; handler: import('../agent/middleware.js').MiddlewareHandler }>;
}

// ============================================================
// PluginRegistry
// ============================================================

/**
 * 插件注册表
 * 负责：发现 → 加载 → 初始化 → 桥接（工具/钩子）→ 启用/禁用 → 销毁
 */
export class PluginRegistry {
  private plugins = new Map<string, PluginRecord>();
  private options: PluginRegistryOptions;
  /** 注册顺序（用于 destroyAll 逆序销毁） */
  private loadOrder: string[] = [];

  constructor(options: PluginRegistryOptions) {
    this.options = options;
  }

  // ----------------------------------------------------------
  // 发现：扫描目录读 routedev-plugin.json，目录不存在静默跳过
  // ----------------------------------------------------------

  /**
   * 扫描所有插件目录，返回有效清单列表
   * 每个清单附带 _pluginDir（内部用），目录不存在时静默跳过
   */
  async discover(): Promise<Array<PluginManifest & { _pluginDir: string }>> {
    const manifests: Array<PluginManifest & { _pluginDir: string }> = [];
    const allDirs = [...this.options.globalPluginDirs, this.options.projectPluginDir];

    for (const dir of allDirs) {
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        // 目录不存在或不可读——静默跳过
        continue;
      }

      for (const entry of entries) {
        const pluginDir = join(dir, entry);
        let isDir = false;
        try {
          const s = await stat(pluginDir);
          isDir = s.isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;

        const manifestPath = join(pluginDir, 'routedev-plugin.json');
        try {
          const raw = await readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw) as PluginManifest;
          // 基础校验：必需字段
          if (!manifest.id || !manifest.name || !manifest.type || !manifest.entry) {
            logger.warn(`Plugin manifest invalid, skipping: ${manifestPath}`, {
              missingFields: [
                !manifest.id && 'id',
                !manifest.name && 'name',
                !manifest.type && 'type',
                !manifest.entry && 'entry',
              ].filter(Boolean),
            });
            continue;
          }
          // C5 修复：校验 permissions 字段
          const permError = validatePermissions(manifest.permissions);
          if (permError) {
            logger.warn(`Plugin manifest permissions invalid, skipping: ${manifestPath}`, {
              error: permError,
            });
            continue;
          }
          // C5 修复：记录插件声明的权限（用于审计）
          const declaredPerms = getDeclaredPermissions(manifest);
          if (declaredPerms.length > 0) {
            logger.info(`Plugin "${manifest.id}" declared permissions`, {
              permissions: declaredPerms,
            });
          } else {
            logger.info(`Plugin "${manifest.id}" declared no permissions (minimum privilege)`);
          }
          manifests.push({ ...manifest, _pluginDir: pluginDir });
        } catch (err) {
          // 单个清单读取失败不影响其他插件
          logger.warn(`Failed to read plugin manifest: ${manifestPath}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return manifests;
  }

  // ----------------------------------------------------------
  // 加载：await import(entryFile)，外层 try-catch，失败只记 error
  // ----------------------------------------------------------

  /**
   * 加载单个插件：动态 import 入口文件，提取 default 或命名导出 plugin
   * 失败时记录 error，不抛异常
   */
  async loadPlugin(manifest: PluginManifest, pluginDir: string): Promise<void> {
    const entryFile = join(pluginDir, manifest.entry);
    try {
      const fileUrl = pathToFileURL(entryFile).href;
      const mod = await import(fileUrl);
      const instance: Plugin | undefined = mod.default ?? mod.plugin;
      if (!instance) {
        throw new Error(`入口文件未导出 default 或 plugin 命名导出: ${manifest.entry}`);
      }

      // 校验插件类型与清单一致
      if (instance.type !== manifest.type) {
        throw new Error(
          `插件类型不匹配：清单声明 ${manifest.type}，实例为 ${instance.type}`,
        );
      }

      this.plugins.set(manifest.id, {
        instance,
        manifest,
        pluginDir,
        loaded: false,
        registeredToolNames: [],
        registeredHookPhases: [],
        registeredHookHandlers: [],
      });
      this.loadOrder.push(manifest.id);
      logger.debug(`Plugin loaded: ${manifest.id}`, { type: manifest.type, version: manifest.version });
    } catch (err) {
      // 加载失败：记录错误状态，不崩溃宿主
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`Plugin load failed: ${manifest.id}`, { error: errorMsg });
      this.plugins.set(manifest.id, {
        instance: null as unknown as Plugin,
        manifest,
        pluginDir,
        loaded: false,
        error: errorMsg,
        registeredToolNames: [],
        registeredHookPhases: [],
        registeredHookHandlers: [],
      });
      this.loadOrder.push(manifest.id);
    }
  }

  // ----------------------------------------------------------
  // 初始化：逐个 plugin.init()，单个失败不阻塞其他
  // 加载后自动桥接：ToolPlugin→toolRegistry.register，HookPlugin→middlewarePipeline.register
  // ----------------------------------------------------------

  /**
   * 初始化所有已加载插件：调用 init() 并桥接工具/钩子
   * 单个插件失败不阻塞其他插件
   * Phase 27 Task 4：启动时读取状态文件，恢复各插件的 enable/disable 状态
   */
  async initAll(): Promise<void> {
    // Phase 27 Task 4：先读取持久化状态，恢复 enable/disable
    await this.restoreState();

    const baseContext: PluginInitContext = {
      cwd: this.options.cwd,
      config: {},
      log: (level, msg, meta) => {
        if (level === 'error') logger.error(`[plugin] ${msg}`, meta ?? {});
        else if (level === 'warn') logger.warn(`[plugin] ${msg}`, meta ?? {});
        else logger.info(`[plugin] ${msg}`, meta ?? {});
      },
    };

    for (const pluginId of this.loadOrder) {
      const record = this.plugins.get(pluginId);
      if (!record || record.error) continue; // 加载失败的跳过

      try {
        // C5 修复：为每个插件创建受限的初始化上下文（基于声明的权限）
        const restrictedContext = createRestrictedContext(record.manifest, baseContext);
        // 1. 调用插件 init()
        await record.instance.init(restrictedContext);
        record.loaded = true;

        // 2. 根据类型自动桥接
        this.bridgePlugin(record);
      } catch (err) {
        // 单个插件 init 失败：记录错误，继续其他插件
        const errorMsg = err instanceof Error ? err.message : String(err);
        record.error = errorMsg;
        record.loaded = false;
        logger.warn(`Plugin init failed: ${pluginId}`, { error: errorMsg });
      }
    }
  }

  /**
   * 桥接插件能力到宿主：ToolPlugin→toolRegistry，HookPlugin→middlewarePipeline
   * 仅当插件 enabled 时注册
   * C5 修复：根据声明的权限决定是否桥接（未声明对应权限的插件不桥接）
   */
  private bridgePlugin(record: PluginRecord): void {
    const plugin = record.instance;
    if (!plugin.enabled) return;

    // C5 修复：获取插件声明的权限
    const permissions = new Set<PluginPermission>(record.manifest.permissions ?? []);

    try {
      if (plugin.type === 'tool') {
        // C5 修复：tool 类型插件需要 'registry' 权限才能注册工具
        if (!permissions.has('registry')) {
          logger.warn(`Plugin ${plugin.id} 未声明 'registry' 权限，跳过工具注册`, {
            declaredPermissions: Array.from(permissions),
          });
          return;
        }
        const toolPlugin = plugin as ToolPlugin;
        const tools = toolPlugin.getTools();
        for (const tool of tools) {
          this.options.toolRegistry.register(tool);
          record.registeredToolNames.push(tool.definition.name);
        }
        logger.debug(`Plugin ${plugin.id} registered ${tools.length} tools`, {
          tools: record.registeredToolNames,
        });
      } else if (plugin.type === 'hook') {
        // C5 修复：hook 类型插件需要 'middleware' 权限才能注册钩子
        if (!permissions.has('middleware')) {
          logger.warn(`Plugin ${plugin.id} 未声明 'middleware' 权限，跳过钩子注册`, {
            declaredPermissions: Array.from(permissions),
          });
          return;
        }
        const hookPlugin = plugin as HookPlugin;
        const hooks = hookPlugin.getHooks();
        for (const hook of hooks) {
          this.options.middlewarePipeline.register(hook.phase, hook.handler);
          record.registeredHookPhases.push(hook.phase);
          record.registeredHookHandlers.push({ phase: hook.phase, handler: hook.handler });
        }
        logger.debug(`Plugin ${plugin.id} registered ${hooks.length} hooks`, {
          phases: record.registeredHookPhases,
        });
      }
      // theme/router 类型无需桥接（router 由调用方按需查询）
    } catch (err) {
      // 桥接失败：记录错误但不崩溃
      const errorMsg = err instanceof Error ? err.message : String(err);
      record.error = `bridge failed: ${errorMsg}`;
      logger.warn(`Plugin bridge failed: ${record.manifest.id}`, { error: errorMsg });
    }
  }

  // ----------------------------------------------------------
  // 销毁：逆序调用 plugin.destroy()
  // ----------------------------------------------------------

  /**
   * 逆序销毁所有已加载插件
   * 单个 destroy 失败不阻塞其他
   */
  async destroyAll(): Promise<void> {
    const reverseOrder = [...this.loadOrder].reverse();
    for (const pluginId of reverseOrder) {
      const record = this.plugins.get(pluginId);
      if (!record || !record.loaded || !record.instance) continue;
      try {
        await record.instance.destroy();
      } catch (err) {
        // destroy 失败不阻塞其他插件
        logger.warn(`Plugin destroy failed: ${pluginId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ----------------------------------------------------------
  // 启用/禁用
  // ----------------------------------------------------------

  /**
   * 启用插件：重新注册工具/钩子
   * @returns 是否成功（插件存在且未启用时返回 true）
   * Phase 27 Task 4：启用后自动写入状态文件
   */
  enable(pluginId: string): boolean {
    const record = this.plugins.get(pluginId);
    if (!record || !record.instance) return false;
    if (record.instance.enabled) return true; // 已启用
    if (record.error) return false; // 加载/初始化失败的不能启用

    record.instance.enabled = true;
    // 重新桥接（注册工具/钩子）
    record.registeredToolNames = [];
    record.registeredHookPhases = [];
    record.registeredHookHandlers = [];
    this.bridgePlugin(record);
    logger.info(`Plugin enabled: ${pluginId}`);
    // Phase 27 Task 4：同步持久化状态
    this.persistState();
    return true;
  }

  /**
   * 禁用插件：unregister 工具（钩子无法移除，仅标记 enabled=false）
   * @returns 是否成功
   * Phase 27 Task 4：禁用后自动写入状态文件
   */
  disable(pluginId: string): boolean {
    const record = this.plugins.get(pluginId);
    if (!record || !record.instance) return false;
    if (!record.instance.enabled) return true; // 已禁用

    record.instance.enabled = false;
    // 注销已注册的工具
    for (const toolName of record.registeredToolNames) {
      this.options.toolRegistry.unregister(toolName);
    }
    record.registeredToolNames = [];
    // 注销已注册的钩子（Phase 22 修复：AgentMiddlewarePipeline 已支持 unregister）
    for (const { phase, handler } of record.registeredHookHandlers) {
      this.options.middlewarePipeline.unregister(phase, handler);
    }
    record.registeredHookPhases = [];
    record.registeredHookHandlers = [];
    logger.info(`Plugin disabled: ${pluginId}`);
    // Phase 27 Task 4：同步持久化状态
    this.persistState();
    return true;
  }

  // ----------------------------------------------------------
  // 查询
  // ----------------------------------------------------------

  /** 列出所有插件状态快照 */
  listStatuses(): PluginStatus[] {
    const statuses: PluginStatus[] = [];
    for (const pluginId of this.loadOrder) {
      const record = this.plugins.get(pluginId);
      if (!record) continue;
      statuses.push(this.recordToStatus(record));
    }
    return statuses;
  }

  /** 查询单个插件状态 */
  getPluginStatus(pluginId: string): PluginStatus | null {
    const record = this.plugins.get(pluginId);
    if (!record) return null;
    return this.recordToStatus(record);
  }

  /** 获取指定类型且已启用的插件实例列表 */
  getEnabledByType(type: PluginType): Plugin[] {
    const result: Plugin[] = [];
    for (const pluginId of this.loadOrder) {
      const record = this.plugins.get(pluginId);
      if (!record || !record.instance || record.error) continue;
      if (record.instance.type === type && record.instance.enabled) {
        result.push(record.instance);
      }
    }
    return result;
  }

  /**
   * 获取当前生效的路由插件（同一时刻最多一个）
   * 优先返回第一个已启用的 router 插件
   */
  getActiveRouterPlugin(): RouterPlugin | null {
    const routers = this.getEnabledByType('router');
    if (routers.length === 0) return null;
    return routers[0] as RouterPlugin;
  }

  // ----------------------------------------------------------
  // 状态持久化（Phase 27 Task 4）
  // ----------------------------------------------------------

  /**
   * 获取状态文件路径（导出供测试使用）
   * 路径：getAppDataDir()/plugin-state.json
   */
  getStateFilePath(): string {
    return join(getAppDataDir(), STATE_FILE_NAME);
  }

  /**
   * Phase 27 Task 4：从磁盘读取插件状态，恢复各插件的 enable/disable
   * 状态文件不存在或损坏时 fallback 到默认全启用（不修改当前状态）
   */
  private async restoreState(): Promise<void> {
    const statePath = this.getStateFilePath();
    let state: PluginStateFile | null = null;

    try {
      if (!existsSync(statePath)) {
        // 状态文件不存在——保持默认状态（全启用），不报错
        return;
      }
      const raw = await readFile(statePath, 'utf-8');
      const parsed = JSON.parse(raw) as PluginStateFile;
      // 基础校验：必需字段
      if (!parsed || typeof parsed !== 'object' || !parsed.plugins) {
        logger.warn('Plugin state file invalid (missing plugins field), fallback to defaults', {
          statePath,
        });
        return;
      }
      state = parsed;
    } catch (err) {
      // 状态文件损坏（JSON 解析失败 / IO 错误）——fallback 到默认全启用
      logger.warn('Plugin state file corrupted, fallback to defaults', {
        statePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 应用持久化状态：仅修改已加载插件的状态
    for (const pluginId of this.loadOrder) {
      const record = this.plugins.get(pluginId);
      if (!record || !record.instance || record.error) continue;
      const saved = state.plugins[pluginId];
      if (saved && typeof saved.enabled === 'boolean') {
        record.instance.enabled = saved.enabled;
      }
    }
    logger.debug('Plugin state restored', {
      statePath,
      pluginsApplied: Object.keys(state.plugins).length,
    });
  }

  /**
   * Phase 27 Task 4：将当前各插件的 enable/disable 状态写入磁盘
   * 使用同步写入确保 enable()/disable() 返回前状态已落盘
   * 写入失败仅记录警告，不影响运行时状态
   */
  private persistState(): void {
    const statePath = this.getStateFilePath();
    const state: PluginStateFile = {
      plugins: {},
      updatedAt: Date.now(),
    };

    for (const pluginId of this.loadOrder) {
      const record = this.plugins.get(pluginId);
      if (!record || !record.instance) continue;
      state.plugins[pluginId] = { enabled: record.instance.enabled };
    }

    try {
      // 确保目录存在
      ensureDir(getAppDataDir());
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
      logger.debug('Plugin state persisted', {
        statePath,
        pluginCount: Object.keys(state.plugins).length,
      });
    } catch (err) {
      // 写入失败不崩溃宿主
      logger.warn('Plugin state persist failed', {
        statePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ----------------------------------------------------------
  // 内部工具
  // ----------------------------------------------------------

  /** 将内部记录转为对外状态快照 */
  private recordToStatus(record: PluginRecord): PluginStatus {
    const status: PluginStatus = {
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      type: record.manifest.type,
      enabled: record.instance?.enabled ?? false,
      loaded: record.loaded,
    };
    if (record.error) status.error = record.error;
    if (record.registeredToolNames.length > 0) status.registeredTools = [...record.registeredToolNames];
    if (record.registeredHookPhases.length > 0) {
      status.registeredHooks = [...record.registeredHookPhases] as PluginStatus['registeredHooks'];
    }
    return status;
  }
}

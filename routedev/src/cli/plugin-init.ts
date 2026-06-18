// src/cli/plugin-init.ts
// 插件系统初始化辅助：从 App.tsx 抽取，保持 App.tsx 行数 ≤400
// Phase 22：创建 middleware + registry + discover + load + init 全流程

import { PluginRegistry, type PluginRegistryOptions } from '../plugins/registry.js';
import { AgentMiddlewarePipeline } from '../agent/middleware.js';
import { ToolRegistry } from '../tools/registry.js';
import type { PermissionEngine } from '../tools/permission-engine.js';
import type { AutonomyMode } from '../config/schema.js';
import { logger } from '../utils/logger.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 创建插件系统：middleware pipeline + plugin registry
 * 返回两者供 App 持有引用
 */
export function createPluginSystem(
  cwd: string,
  toolRegistry: ToolRegistry,
): {
  middlewarePipeline: AgentMiddlewarePipeline;
  pluginRegistry: PluginRegistry;
} {
  const middlewarePipeline = new AgentMiddlewarePipeline();

  const options: PluginRegistryOptions = {
    // 全局插件目录：~/.qoderwork/routedev/plugins/
    globalPluginDirs: [join(homedir(), '.qoderwork', 'routedev', 'plugins')],
    // 项目级插件目录：<cwd>/.routedev/plugins/
    projectPluginDir: join(cwd, '.routedev', 'plugins'),
    toolRegistry,
    middlewarePipeline,
    cwd,
  };
  const pluginRegistry = new PluginRegistry(options);

  return { middlewarePipeline, pluginRegistry };
}

/**
 * 初始化插件系统：发现 + 加载 + 初始化
 * 整个流程在 try-catch 中，失败不影响宿主启动
 */
export async function initPluginSystem(registry: PluginRegistry): Promise<void> {
  try {
    const manifests = await registry.discover();
    for (const manifest of manifests) {
      // discover() 返回的清单附带 _pluginDir 字段
      await registry.loadPlugin(manifest, (manifest as PluginManifestWithDir)._pluginDir);
    }
    await registry.initAll();
  } catch (error) {
    logger.error('Plugin system init failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** discover() 返回的清单附带插件目录 */
interface PluginManifestWithDir {
  _pluginDir: string;
}

/**
 * 注册权限引擎中间件到 middleware pipeline（Phase 21 修复）
 *
 * deny 规则不可绕过；confirm 规则通过 commandBridge 请求用户确认。
 * 使用 _registered 标记防止重复注册。
 *
 * @param pipeline 中间件管线
 * @param permissionEngine 权限引擎
 * @param autonomyModeRef 自主度模式 ref（读取当前值）
 * @param commandBridgeRef 命令桥 ref（用于请求确认）
 */
export function registerPermissionMiddleware(
  pipeline: AgentMiddlewarePipeline,
  permissionEngine: PermissionEngine,
  autonomyModeRef: { current: AutonomyMode },
  commandBridgeRef: { current: { requestConfirm: (p: string) => Promise<boolean> } | null },
): void {
  if ((permissionEngine as { _registered?: boolean })._registered) return;
  (permissionEngine as { _registered?: boolean })._registered = true;
  pipeline.register('onActing', async (ctx, next) => {
    const result = permissionEngine.check(
      ctx.toolName ?? '',
      ctx.toolArgs ?? {},
      autonomyModeRef.current,
    );
    if (result.decision === 'deny') {
      ctx.metadata.permissionDenied = result.reason;
      return; // 不调用 next()，工具不执行
    }
    if (result.decision === 'confirm') {
      const ok = commandBridgeRef.current
        ? await commandBridgeRef.current.requestConfirm(`[权限] ${result.reason} (y/n)`)
        : false;
      if (!ok) {
        ctx.metadata.permissionDenied = '用户拒绝';
        return;
      }
    }
    await next();
  });
}

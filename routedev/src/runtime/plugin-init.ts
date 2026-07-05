// src/runtime/plugin-init.ts
// 插件系统初始化辅助：从 App.tsx 抽取，保持 App.tsx 行数 ≤400

import { PluginRegistry, type PluginRegistryOptions } from '../plugins/registry.js';
import { AgentMiddlewarePipeline } from '../agent/middleware.js';
import { ToolRegistry } from '../tools/registry.js';
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

// src/cli/commands/plugins.ts
// /plugins 命令：管理通过 SDK 加载的插件
//
// 子命令：
//   /plugins                  — 列出已加载插件
//   /plugins load <path>      — 加载插件
//   /plugins unload <name>    — 卸载插件
//   /plugins reload <name>    — 重新加载
//
// 与 /plugin 命令的区别：
//   - /plugin 操作的是清单驱动的内置插件系统（PluginRegistry）
//   - /plugins 操作的是 SDK 动态加载器（PluginLoader / RouteDevPlugin）
//
// 实现说明：
//   由于不能修改 ServiceContext，PluginLoader 使用模块级单例，
//   首次调用时基于 ctx.cwd 懒初始化。父 Agent 后续可在 app-init 中
//   将 PluginLoader 实例注入 ServiceContext 以替代单例。

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';
import { PluginLoader, createDefaultPluginContext } from '../../plugins/sdk-loader.js';
import type { PluginContext } from '../../plugins/sdk.js';

// ============================================================
// 模块级单例：PluginLoader
// ============================================================

let globalPluginLoader: PluginLoader | null = null;

/**
 * 获取或创建模块级 PluginLoader 单例
 * 首次调用时基于 cwd 懒初始化
 */
function getPluginLoader(ctx: ServiceContext): PluginLoader {
  if (!globalPluginLoader) {
    const context: PluginContext = createDefaultPluginContext(ctx.cwd, {});
    globalPluginLoader = new PluginLoader(context);
  }
  return globalPluginLoader;
}

/**
 * 重置模块级单例（仅供测试使用）
 */
export function _resetPluginLoaderForTesting(): void {
  globalPluginLoader = null;
}

// ============================================================
// /plugins 命令定义
// ============================================================

export const pluginsCommand: CommandDefinition = {
  name: 'plugins',
  description: 'SDK 插件管理（动态加载/卸载）',
  usage:
    '/plugins | /plugins load <path> | /plugins unload <name> | /plugins reload <name>',
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    // 空字符串或纯空白 → 默认 list
    const parts = trimmed ? trimmed.split(/\s+/) : [];
    const sub = parts[0] ?? 'list';
    const arg = parts.slice(1).join(' ').trim();

    const loader = getPluginLoader(ctx);

    switch (sub) {
      case 'list': {
        const loaded = loader.listLoaded();
        if (loaded.length === 0) {
          return {
            type: 'handled',
            messages: [
              '暂无已加载的 SDK 插件。\n用法：/plugins load <path> 加载插件',
            ],
          };
        }
        const lines = [
          `已加载 SDK 插件（${loaded.length} 个）:`,
          ...loaded.map(
            p => `  - ${p.name} v${p.version}\n      ${p.path}`,
          ),
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'load': {
        if (!arg) {
          return {
            type: 'handled',
            messages: ['用法: /plugins load <path>'],
          };
        }
        try {
          const plugin = await loader.loadFromFile(arg);
          return {
            type: 'handled',
            messages: [
              `插件加载成功：${plugin.name} v${plugin.version}`,
              ...(plugin.description ? [`描述：${plugin.description}`] : []),
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            type: 'handled',
            messages: [`插件加载失败：${msg}`],
          };
        }
      }

      case 'unload': {
        if (!arg) {
          return {
            type: 'handled',
            messages: ['用法: /plugins unload <name>'],
          };
        }
        try {
          await loader.unload(arg);
          return {
            type: 'handled',
            messages: [`插件已卸载：${arg}`],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            type: 'handled',
            messages: [`插件卸载失败：${msg}`],
          };
        }
      }

      case 'reload': {
        if (!arg) {
          return {
            type: 'handled',
            messages: ['用法: /plugins reload <name>'],
          };
        }
        // 检查插件是否已加载
        const loaded = loader.listLoaded();
        const target = loaded.find(p => p.name === arg);
        if (!target) {
          return {
            type: 'handled',
            messages: [`插件未加载，无法 reload：${arg}`],
          };
        }
        const path = target.path;
        try {
          await loader.unload(arg);
          const plugin = await loader.loadFromFile(path);
          return {
            type: 'handled',
            messages: [
              `插件已重新加载：${plugin.name} v${plugin.version}`,
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            type: 'handled',
            messages: [`插件重新加载失败：${msg}`],
          };
        }
      }

      default:
        return {
          type: 'handled',
          messages: [
            '用法: /plugins | /plugins load <path> | /plugins unload <name> | /plugins reload <name>',
          ],
        };
    }
  },
};

// src/cli/commands/plugin.ts
// 插件管理命令：/plugin
// 子命令：list / enable <name> / disable <name> / info <name>

import type { CommandDefinition } from '../command-registry.js';

export const pluginCommand: CommandDefinition = {
  name: 'plugin',
  aliases: ['plugins'],
  description: '插件管理',
  usage: '/plugin list | /plugin enable <name> | /plugin disable <name> | /plugin info <name>',
  handler: async (args, ctx) => {
    const [sub = 'list', name] = args.trim().split(/\s+/);
    const reg = ctx.pluginRegistry;
    if (!reg) {
      return { type: 'handled', messages: ['插件系统未初始化。'] };
    }

    switch (sub) {
      case 'list': {
        const statuses = reg.listStatuses();
        if (statuses.length === 0) {
          return {
            type: 'handled',
            messages: ['暂无已安装的插件。\n将插件放入 ~/.qoderwork/routedev/plugins/ 目录即可。'],
          };
        }
        const lines = [
          '已安装插件:',
          ...statuses.map(p => {
            const flag = p.error ? '[ERR]' : p.enabled ? '[ON] ' : '[OFF]';
            return `  ${flag} ${p.name} v${p.version} (${p.type})`;
          }),
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'enable': {
        if (!name) return { type: 'handled', messages: ['用法: /plugin enable <name>'] };
        const ok = reg.enable(name);
        return {
          type: 'handled',
          messages: [ok ? `插件 ${name} 已启用。` : `插件 ${name} 不存在或启用失败。`],
        };
      }

      case 'disable': {
        if (!name) return { type: 'handled', messages: ['用法: /plugin disable <name>'] };
        const ok = reg.disable(name);
        return {
          type: 'handled',
          messages: [ok ? `插件 ${name} 已禁用。` : `插件 ${name} 不存在或禁用失败。`],
        };
      }

      case 'info': {
        if (!name) return { type: 'handled', messages: ['用法: /plugin info <name>'] };
        const s = reg.getPluginStatus(name);
        if (!s) return { type: 'handled', messages: [`插件 ${name} 不存在。`] };
        const lines = [
          `插件: ${s.name} v${s.version}`,
          `类型: ${s.type}`,
          `状态: ${s.enabled ? '已启用' : '已禁用'}${s.error ? ' (错误)' : ''}`,
          s.registeredTools && s.registeredTools.length > 0
            ? `工具: ${s.registeredTools.join(', ')}`
            : '',
          s.registeredHooks && s.registeredHooks.length > 0
            ? `Hook: ${s.registeredHooks.join(', ')}`
            : '',
          s.error ? `错误: ${s.error}` : '',
        ].filter(Boolean);
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      default:
        return {
          type: 'handled',
          messages: ['用法: /plugin list | enable <name> | disable <name> | info <name>'],
        };
    }
  },
};

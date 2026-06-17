// src/cli/commands/help.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';

export const helpCommand: CommandDefinition = {
  name: 'help',
  aliases: ['?'],
  description: '显示命令帮助信息',
  usage: '/help [command]',
  handler: async (args, ctx) => {
    const registry = (ctx as any).__commandRegistry as {
      listCommands: () => Array<{ name: string; aliases?: string[]; description: string; usage?: string }>;
    } | undefined;

    if (!registry) {
      return { type: 'handled', messages: ['命令注册表不可用'] };
    }

    const commands = registry.listCommands();

    if (args.trim()) {
      const cmd = commands.find(c => c.name === args.trim());
      if (!cmd) {
        return { type: 'handled', messages: [`未知命令: ${args.trim()}`] };
      }
      const lines = [
        `/${cmd.name} — ${cmd.description}`,
        cmd.aliases && cmd.aliases.length > 0 ? `别名: ${cmd.aliases.map(a => '/' + a).join(', ')}` : '',
        cmd.usage ? `用法: ${cmd.usage}` : '',
      ].filter(Boolean);
      return { type: 'handled', messages: [lines.join('\n')] };
    }

    const lines = ['可用命令:'];
    for (const cmd of commands) {
      const aliasText = cmd.aliases && cmd.aliases.length > 0
        ? ` (${cmd.aliases.map(a => '/' + a).join(', ')})`
        : '';
      lines.push(`  /${cmd.name}${aliasText} — ${cmd.description}`);
    }
    return { type: 'handled', messages: [lines.join('\n')] };
  },
};

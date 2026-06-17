// src/cli/command-registry.ts
// 命令注册表：解耦命令解析与 App.tsx
// 蓝图 17.2：把分散的 case '/' 分支收敛为可扩展的注册表

import type { ServiceContext } from './service-context.js';

export type CommandHandlerResult =
  | { type: 'handled'; messages?: string[] }
  | { type: 'passthrough'; input: string };

export interface CommandDefinition {
  /** 命令名（如 /memory） */
  name: string;
  /** 别名 */
  aliases?: string[];
  /** 简短说明 */
  description: string;
  /** 用法示例 */
  usage?: string;
  /** 处理器 */
  handler: (args: string, ctx: ServiceContext) => Promise<CommandHandlerResult>;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private aliasMap = new Map<string, string>();

  register(def: CommandDefinition): void {
    this.commands.set(def.name, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.aliasMap.set(alias, def.name);
      }
    }
  }

  /** 解析输入，返回匹配的命令或 null */
  parse(input: string): { command: CommandDefinition; args: string } | null {
    if (!input.startsWith('/')) return null;

    const trimmed = input.slice(1).trim();
    const spaceIndex = trimmed.search(/\s/);
    const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

    const canonicalName = this.aliasMap.get(commandName) ?? commandName;
    const command = this.commands.get(canonicalName);
    if (!command) return null;

    return { command, args };
  }

  /** 执行命令 */
  async execute(input: string, ctx: ServiceContext): Promise<CommandHandlerResult> {
    const parsed = this.parse(input);
    if (!parsed) return { type: 'passthrough', input };
    return parsed.command.handler(parsed.args, ctx);
  }

  /** 列出所有命令（用于 /help） */
  listCommands(): CommandDefinition[] {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  has(commandName: string): boolean {
    const canonicalName = this.aliasMap.get(commandName) ?? commandName;
    return this.commands.has(canonicalName);
  }
}

/** 工厂函数：创建默认命令注册表 */
export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry();
}
// src/cli/completion.ts
// readline Tab 补全：命令名 + 子命令

export interface CompletionItem {
  name: string;
  subcommands?: string[];
}

export const COMMAND_COMPLETIONS: CompletionItem[] = [
  { name: 'help', subcommands: [] },
  { name: 'status', subcommands: [] },
  { name: 'memory', subcommands: ['show', 'notes', 'write', 'clear'] },
  { name: 'trace', subcommands: ['sessions', 'view', 'audit'] },
  { name: 'prompt', subcommands: ['list', 'show', 'render'] },
  { name: 'channels', subcommands: ['list', 'port'] },
  { name: 'clear', subcommands: [] },
  { name: 'goal', subcommands: [] },
  { name: 'init', subcommands: [] },
  { name: 'dream', subcommands: [] },
  { name: 'branch', subcommands: ['list', 'edit', 'switch'] },
  { name: 'checkpoint', subcommands: ['list', 'create'] },
  { name: 'rollback', subcommands: [] },
  { name: 'pause', subcommands: [] },
  { name: 'auto', subcommands: [] },
  { name: 'semi', subcommands: [] },
  { name: 'manual', subcommands: [] },
  { name: 'quit', subcommands: [] },
];

export function createCompleter(items: CompletionItem[] = COMMAND_COMPLETIONS) {
  return (line: string): [string[], string] => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('/')) {
      return [[], trimmed];
    }

    const withoutSlash = trimmed.slice(1);
    const spaceIndex = withoutSlash.search(/\s/);

    if (spaceIndex === -1) {
      // 补全命令名
      const matches = items
        .filter((item) => item.name.startsWith(withoutSlash))
        .map((item) => `/${item.name}`);
      return [matches, trimmed];
    }

    const commandName = withoutSlash.slice(0, spaceIndex);
    const currentArg = withoutSlash.slice(spaceIndex + 1).trim();
    const item = items.find((i) => i.name === commandName);

    if (!item?.subcommands?.length) {
      return [[], trimmed];
    }

    const matches = item.subcommands
      .filter((sub) => sub.startsWith(currentArg))
      .map((sub) => `/${commandName} ${sub}`);
    return [matches, trimmed];
  };
}

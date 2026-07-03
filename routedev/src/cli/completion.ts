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

  { name: 'branch', subcommands: ['list', 'edit', 'switch'] },
  { name: 'checkpoint', subcommands: ['list', 'create'] },
  // Phase 57：/consolidate-memory（原 /dream 改名）；Phase 60：dream alias 已删除
  { name: 'consolidate-memory', subcommands: [] },
  { name: 'rollback', subcommands: [] },
  { name: 'pause', subcommands: [] },
  { name: 'auto', subcommands: [] },
  { name: 'semi', subcommands: [] },
  { name: 'manual', subcommands: [] },
  { name: 'quit', subcommands: [] },
  // Phase 60：补全其余已注册命令，与 App.tsx 命令注册保持一致
  { name: 'config', subcommands: ['show', 'set', 'reload', 'validate', 'edit'] },
  { name: 'cost', subcommands: [] },
  { name: 'diff', subcommands: [] },
  { name: 'doctor', subcommands: [] },
  { name: 'experiment', subcommands: ['list', 'create', 'switch', 'remove'] },
  { name: 'history', subcommands: [] },
  { name: 'output-style', subcommands: [] },
  { name: 'permissions', subcommands: ['show', 'grant', 'revoke'] },
  { name: 'plugin', subcommands: ['list', 'enable', 'disable'] },
  { name: 'quality', subcommands: [] },
  { name: 'resume', subcommands: [] },
  { name: 'review', subcommands: [] },
  { name: 'schedule', subcommands: ['list', 'add', 'remove', 'run'] },
  { name: 'swarm', subcommands: [] },
  { name: 'tech-debt', subcommands: [] },
  { name: 'token', subcommands: [] },
  { name: 'trust', subcommands: ['show', 'set'] },
  { name: 'btw', subcommands: [] },
  { name: 'clarify', subcommands: [] },
  { name: 'build', subcommands: [] },
  { name: 'plan', subcommands: [] },
  { name: 'compose', subcommands: [] },
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

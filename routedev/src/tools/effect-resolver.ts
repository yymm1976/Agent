import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { parseCommand, type ParsedCommand } from './command-parser.js';
import type {
  EffectClassification,
  EffectResolveContext,
  EffectResolution,
  ResourceEffect,
  EffectKind,
} from './effect-model.js';

const READ_ONLY_COMMANDS = new Set([
  'cat', 'type', 'more', 'less', 'head', 'tail', 'wc', 'sort', 'uniq',
  'ls', 'dir', 'pwd', 'cd', 'get-childitem', 'get-content', 'select-string',
  'rg', 'grep', 'findstr', 'where', 'which', 'stat', 'test-path',
]);
const VERIFY_SCRIPTS = new Set(['test', 'test:desktop', 'typecheck', 'typecheck:desktop', 'lint', 'build']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'branch', 'rev-parse', 'ls-files']);

function identity(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function portablePath(value: string): string {
  return value.replace(/[\\/]+/g, path.sep);
}

/** Resolve links and, for a new target, resolve its nearest existing parent. */
export function canonicalizeResource(resource: string, workingDirectory: string): {
  canonicalResource: string;
  relativeResource: string;
} {
  const absolute = path.resolve(workingDirectory, portablePath(resource));
  let cursor = absolute;
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realBase = existsSync(cursor) ? realpathSync.native(cursor) : path.resolve(cursor);
  const canonicalResource = identity(path.resolve(realBase, ...missing));

  let workspaceRoot: string;
  try {
    workspaceRoot = identity(realpathSync.native(path.resolve(workingDirectory)));
  } catch {
    workspaceRoot = identity(path.resolve(workingDirectory));
  }
  const relativeResource = path.relative(workspaceRoot, canonicalResource).replace(/\\/g, '/') || '.';
  return { canonicalResource, relativeResource };
}

function resourceEffect(kind: EffectKind, resource: string, context: EffectResolveContext): ResourceEffect {
  return { kind, resource, ...canonicalizeResource(resource, context.workingDirectory) };
}

function resolution(classification: EffectClassification, effects: ResourceEffect[]): EffectResolution {
  return { classification, effects };
}

function commandName(parsed: ParsedCommand): string {
  return path.basename(parsed.command.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
}

function positional(args: string[]): string[] {
  return args.filter((arg) => arg && !arg.startsWith('-') && !/^\/[a-z]+$/i.test(arg));
}

function extractRedirects(raw: string): string[] {
  const targets: string[] = [];
  const redirect = /(?:^|\s)(?:>>|1?>)(?!&)(?:\s*)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let match: RegExpExecArray | null;
  while ((match = redirect.exec(raw)) !== null) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target && target !== '/dev/null' && target.toLowerCase() !== 'nul') targets.push(target);
  }
  return targets;
}

function optionValue(args: string[], names: string[]): string | undefined {
  const lowered = args.map((arg) => arg.toLowerCase());
  for (const name of names) {
    const index = lowered.indexOf(name.toLowerCase());
    if (index >= 0 && args[index + 1]) return args[index + 1];
  }
  return undefined;
}

function quotedCapture(raw: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(raw);
  return match?.[1] ?? match?.[2];
}

function analyzeScriptRuntime(name: string, raw: string, context: EffectResolveContext): EffectResolution {
  const effects: ResourceEffect[] = [];
  const write = quotedCapture(raw, /(?:writeFileSync|appendFileSync|write_file|write_text)\s*\(\s*(?:"([^"]+)"|'([^']+)')/i)
    ?? quotedCapture(raw, /open\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*,\s*(?:"[wax+]"|'[wax+]')/i);
  if (write) effects.push(resourceEffect('fs.write', write, context));
  const remove = quotedCapture(raw, /(?:unlinkSync|rmSync|remove|unlink)\s*\(\s*(?:"([^"]+)"|'([^']+)')/i);
  if (remove) effects.push(resourceEffect('fs.delete', remove, context));
  const move = /(?:renameSync|move)\s*\(\s*(?:"[^"]+"|'[^']+')\s*,\s*(?:"([^"]+)"|'([^']+)')/i.exec(raw);
  if (move) effects.push(resourceEffect('fs.move', move[1] ?? move[2], context));
  if (effects.length > 0) return resolution('KNOWN_EFFECTS', effects);

  // Deliberately tiny safe subset. Arbitrary runtime code is never guessed safe.
  if ((name === 'node' || name === 'nodejs')
    && /(?:console\.log|process\.stdout\.write)\s*\(/i.test(raw)
    && !/(?:require\s*\(\s*['"](?:fs|child_process)|\bimport\b|\beval\s*\()/i.test(raw)) {
    return resolution('PROVEN_READ_ONLY', [{ kind: 'process.exec' }]);
  }
  return resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
}

function analyzeOne(parsed: ParsedCommand, context: EffectResolveContext): EffectResolution {
  const name = commandName(parsed);
  const args = parsed.args;
  const raw = parsed.raw;
  const redirects = extractRedirects(raw);
  if (redirects.length > 0) {
    return resolution('KNOWN_EFFECTS', redirects.map((target) => resourceEffect('fs.write', target, context)));
  }

  if (['mv', 'move', 'cp', 'copy', 'copy-item', 'move-item'].includes(name)) {
    const values = positional(args);
    const destination = optionValue(args, ['-destination', '-dest']) ?? values.at(-1);
    if (!destination) return resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
    const kind: EffectKind = name === 'mv' || name === 'move' || name === 'move-item' ? 'fs.move' : 'fs.create';
    return resolution('KNOWN_EFFECTS', [resourceEffect(kind, destination, context)]);
  }
  if (['rm', 'del', 'erase', 'remove-item', 'rmdir'].includes(name)) {
    const target = optionValue(args, ['-path', '-literalpath']) ?? positional(args).at(-1);
    return target
      ? resolution('KNOWN_EFFECTS', [resourceEffect('fs.delete', target, context)])
      : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
  }
  if (name === 'tee') {
    const targets = positional(args);
    return targets.length > 0
      ? resolution('KNOWN_EFFECTS', targets.map((target) => resourceEffect('fs.write', target, context)))
      : resolution('PROVEN_READ_ONLY', [{ kind: 'process.exec' }]);
  }
  if (name === 'sed' && args.some((arg) => arg === '-i' || arg.startsWith('-i'))) {
    const target = positional(args).at(-1);
    return target
      ? resolution('KNOWN_EFFECTS', [resourceEffect('fs.write', target, context)])
      : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
  }
  if (['set-content', 'add-content', 'out-file'].includes(name)) {
    const target = optionValue(args, ['-path', '-literalpath', '-filepath']) ?? positional(args)[0];
    return target
      ? resolution('KNOWN_EFFECTS', [resourceEffect('fs.write', target, context)])
      : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
  }
  if (name === 'git') {
    const op = (args[0] ?? '').toLowerCase();
    if (GIT_READ.has(op)) return resolution('PROVEN_READ_ONLY', [{ kind: 'git.read' }, { kind: 'process.exec' }]);
    if (op === 'restore' || op === 'checkout') {
      const separator = args.indexOf('--');
      const targets = (separator >= 0 ? args.slice(separator + 1) : args.slice(1))
        .filter((arg) => !arg.startsWith('-') && arg.toUpperCase() !== 'HEAD');
      if (targets.length > 0) return resolution('KNOWN_EFFECTS', targets.map((target) => resourceEffect('fs.write', target, context)));
    }
    return resolution('KNOWN_EFFECTS', [{ kind: 'git.mutate' }, { kind: 'process.exec' }]);
  }
  if (['node', 'nodejs', 'python', 'python3', 'py'].includes(name)) {
    return analyzeScriptRuntime(name, raw, context);
  }
  if (name === 'cmd' && args[0]?.toLowerCase() === '/c') {
    return analyzeShell(args.slice(1).join(' '), context);
  }
  if (['bash', 'sh', 'powershell', 'pwsh'].includes(name)) {
    const flag = args.findIndex((arg) => ['-c', '-command'].includes(arg.toLowerCase()));
    return flag >= 0 && args[flag + 1]
      ? analyzeShell(args.slice(flag + 1).join(' '), context)
      : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
  }
  if (name === 'echo' || name === 'printf' || READ_ONLY_COMMANDS.has(name)) {
    return resolution('PROVEN_READ_ONLY', [{ kind: 'process.exec' }]);
  }
  if (name === 'tsc' || name === 'vitest' || name === 'eslint') {
    return resolution('PROVEN_READ_ONLY', [{ kind: 'process.exec' }]);
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
    const script = args[0] === 'run' ? args[1] : args[0];
    if (script && (VERIFY_SCRIPTS.has(script) || script === 'vitest' || script === 'tsc')) {
      return resolution('PROVEN_READ_ONLY', [{ kind: 'process.exec' }]);
    }
  }
  return resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
}

function analyzeShell(command: string, context: EffectResolveContext): EffectResolution {
  const parsed = parseCommand(command);
  const commands = parsed.subCommands && parsed.subCommands.length > 0 ? parsed.subCommands : [parsed];
  const analyses = commands.map((item) => analyzeOne(item, context));
  const effects = analyses.flatMap((item) => item.effects);
  if (analyses.some((item) => item.classification === 'OPAQUE_MAY_WRITE')) return resolution('OPAQUE_MAY_WRITE', effects);
  if (analyses.some((item) => item.classification === 'KNOWN_EFFECTS')) return resolution('KNOWN_EFFECTS', effects);
  return resolution('PROVEN_READ_ONLY', effects);
}

/** Resolve a tool call into tool-independent effects for policy evaluation. */
export class EffectResolver {
  resolve(toolName: string, args: Record<string, unknown>, context: EffectResolveContext): EffectResolution {
    const pathArg = typeof args.path === 'string' ? args.path : undefined;
    switch (toolName) {
      case 'file_read':
      case 'list_directory':
      case 'file_search':
      case 'glob':
      case 'code_search':
      case 'repo_map':
        return pathArg
          ? resolution('PROVEN_READ_ONLY', [resourceEffect('fs.read', pathArg, context)])
          : resolution('PROVEN_READ_ONLY', [{ kind: 'fs.read' }]);
      case 'file_write':
      case 'file_edit':
        return pathArg
          ? resolution('KNOWN_EFFECTS', [resourceEffect('fs.write', pathArg, context)])
          : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
      case 'file_create':
        return pathArg
          ? resolution('KNOWN_EFFECTS', [resourceEffect('fs.create', pathArg, context)])
          : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
      case 'file_delete':
        return pathArg
          ? resolution('KNOWN_EFFECTS', [resourceEffect('fs.delete', pathArg, context)])
          : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
      case 'file_move': {
        const destination = typeof args.destination === 'string' ? args.destination
          : typeof args.to === 'string' ? args.to
            : typeof args.newPath === 'string' ? args.newPath : undefined;
        return destination
          ? resolution('KNOWN_EFFECTS', [resourceEffect('fs.move', destination, context)])
          : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
      }
      case 'shell_exec':
        return typeof args.command === 'string'
          ? analyzeShell(args.command, context)
          : resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
      case 'git_op': {
        const operation = String(args.operation ?? '').toLowerCase();
        if (GIT_READ.has(operation)) return resolution('PROVEN_READ_ONLY', [{ kind: 'git.read' }]);
        if (operation === 'restore' || operation === 'checkout') {
          const values = Array.isArray(args.paths) ? args.paths : Array.isArray(args.args) ? args.args : [];
          const targets = values.filter((value): value is string => typeof value === 'string' && !value.startsWith('-'));
          if (targets.length > 0) return resolution('KNOWN_EFFECTS', targets.map((target) => resourceEffect('fs.write', target, context)));
        }
        return resolution('KNOWN_EFFECTS', [{ kind: 'git.mutate' }]);
      }
      case 'web_search':
      case 'browser':
      case 'http_request':
        return resolution('KNOWN_EFFECTS', [{ kind: 'network' }]);
      case 'todo_write':
      case 'ask_user':
      case 'tool_search':
        return resolution('KNOWN_EFFECTS', []);
      default:
        return resolution('OPAQUE_MAY_WRITE', [{ kind: 'opaque_may_write' }]);
    }
  }
}

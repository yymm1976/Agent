import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PermissionEngine, type PermissionRule } from '../../src/tools/permission-engine.js';

class SeededRandom {
  constructor(private state: number) {}
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)];
  }
}

function fixture(): { root: string; alias?: string } {
  const root = mkdtempSync(join(tmpdir(), 'routedev-metamorphic-'));
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const alias = join(root, 'tests-link');
  try {
    symlinkSync(join(root, 'tests'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    return { root, alias };
  } catch {
    return { root };
  }
}

function protectTests(): PermissionRule {
  return {
    id: 'metamorphic-protect-tests',
    layer: 'deny',
    toolPattern: 'file_*',
    effectKinds: ['fs.write', 'fs.create', 'fs.delete', 'fs.move'],
    resourcePatterns: ['tests/**'],
    argsPredicate: (args) => String(args.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').startsWith('tests/'),
    description: 'tests subtree is protected',
  };
}

function pathVariants(root: string, alias?: string): string[] {
  const absolute = join(root, 'tests', 'forbidden.ts');
  const variants = [
    'tests/forbidden.ts',
    './tests/forbidden.ts',
    'src/../tests/forbidden.ts',
    'tests\\forbidden.ts',
    absolute,
    absolute.replace(/\\/g, '/'),
  ];
  if (alias) variants.push(join(alias, 'forbidden.ts'));
  if (process.platform === 'win32') {
    variants.push(absolute.toUpperCase());
    const slash = absolute.replace(/\\/g, '/');
    variants.push(`/${slash[0].toLowerCase()}${slash.slice(2)}`);
  }
  return variants;
}

function quote(value: string, style: number): string {
  if (style % 3 === 0) return value;
  return style % 3 === 1 ? `"${value}"` : `'${value}'`;
}

function forbiddenCommands(root: string, alias: string | undefined, count: number): string[] {
  const random = new SeededRandom(0x5ec0_2026);
  const paths = pathVariants(root, alias);
  const commands: string[] = [];
  for (let i = 0; i < count; i++) {
    const target = quote(random.pick(paths), i);
    const family = i % 27;
    const base = (() => {
      switch (family) {
        case 0: return `mv temp.ts ${target}`;
        case 1: return `cp temp.ts ${target}`;
        case 2: return `cat temp.ts > ${target}`;
        case 3: return `echo x >> ${target}`;
        case 4: return `printf x | tee ${target}`;
        case 5: return `sed -i 's/a/b/' ${target}`;
        case 6: return `git restore --source HEAD -- ${target}`;
        case 7: return `git checkout HEAD -- ${target}`;
        case 8: return `node -e "require('fs').writeFileSync('${random.pick(paths)}','x')"`;
        case 9: return `python -c "open('${random.pick(paths)}','w').write('x')"`;
        case 10: return `Set-Content -Path ${target} -Value x`;
        case 11: return `cmd /c copy temp.ts ${target}`;
        case 12: return `echo preparing && mv temp.ts ${target}`;
        case 13: return `bash -c "mv temp.ts '${random.pick(paths)}'"`;
        case 14: return `powershell -Command "Set-Content -Path '${random.pick(paths)}' -Value x"`;
        case 15: return `printf x | tee ${target} && git status --short`;
        case 16: return './git status --short';
        case 17: return '.\\git status --short';
        case 18: return './cat src/safe.ts';
        case 19: return `echo x>${target}`;
        case 20: return `echo diagnostic 2>${target}`;
        case 21: return `git diff --output=${target}`;
        case 22: return 'git reset --hard';
        case 23: return `git -C . checkout -- ${target}`;
        case 24: return `node -e "console.log('ok'); require('f'+'s').writeFileSync('${random.pick(paths)}','x')"`;
        case 25: return 'tsc';
        default: return `eslint ${target} --fix`;
      }
    })();
    commands.push(i % 4 === 0 ? `  ${base}  ` : base);
  }
  return commands;
}

function safeCommands(count: number): string[] {
  const random = new SeededRandom(0x51afe001);
  const bases = [
    'git status --short',
    'git diff -- tests/forbidden.ts',
    'git log -5 --oneline',
    'rg -n "TODO" src',
    'grep -R "TODO" src',
    'pnpm test',
    'pnpm vitest run',
    'pnpm typecheck',
    'npm run lint',
    'npm run build',
    'echo "diagnostic text"',
    'node -e "console.log(\'ok\')"',
    'Get-Content src/a.ts',
    'ls -la',
  ] as const;
  const commands: string[] = [];
  for (let i = 0; i < count; i++) {
    const first = random.pick(bases);
    const command = i % 5 === 0 ? `${first} && ${random.pick(bases)}` : first;
    commands.push(i % 3 === 0 ? `  ${command}  ` : command);
  }
  return commands;
}

describe('effect permission metamorphic security corpus', () => {
  it('blocks seeded forbidden-intent transformations across aliases, quoting, chains and nesting', () => {
    const { root, alias } = fixture();
    const engine = new PermissionEngine();
    engine.loadRules([protectTests()]);
    const variants = forbiddenCommands(root, alias, 192);

    const escaped = variants.filter((command, index) => engine.check('shell_exec', { command }, 'auto', {
      runId: `forbidden-${index}`,
      workingDirectory: root,
    }).decision !== 'deny');
    expect(escaped, `escaped forbidden variants:\n${escaped.join('\n')}`).toEqual([]);
  });

  it('blocks direct git and path-alias mutations with the same semantic rule', () => {
    const { root } = fixture();
    const engine = new PermissionEngine();
    engine.loadRules([protectTests()]);
    const calls = [
      ['file_write', { path: 'src/../tests/a.ts', content: 'x' }],
      ['file_edit', { path: path.join(root, 'tests', 'a.ts'), oldString: 'a', newString: 'b' }],
      ['git_op', { operation: 'restore', paths: ['tests/a.ts'] }],
      ['file_move', { path: 'tmp.ts', destination: 'tests/a.ts' }],
      ['file_delete', { path: 'tests/a.ts' }],
    ] as const;

    for (const [toolName, args] of calls) {
      expect(engine.check(toolName, args, 'auto', { runId: `direct-${toolName}`, workingDirectory: root }).decision).toBe('deny');
    }
  });

  it('has zero false positives across a seeded safe negative corpus', () => {
    const { root } = fixture();
    const engine = new PermissionEngine();
    engine.loadRules([protectTests()]);
    const corpus = safeCommands(192);

    const falsePositives = corpus.filter((command, index) => engine.check('shell_exec', { command }, 'auto', {
      runId: `safe-${index}`,
      workingDirectory: root,
    }).decision === 'deny');
    expect(falsePositives, `safe commands denied:\n${falsePositives.join('\n')}`).toEqual([]);
  });
});

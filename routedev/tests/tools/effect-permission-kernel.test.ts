import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EffectResolver } from '../../src/tools/effect-resolver.js';
import { PermissionEngine, type PermissionRule } from '../../src/tools/permission-engine.js';
import { FileWriteTool } from '../../src/tools/builtin/file-write.js';
import { FileEditTool } from '../../src/tools/builtin/file-edit.js';
import { ShellExecTool } from '../../src/tools/builtin/shell-exec.js';

const protectedTestsRule: PermissionRule = {
  id: 'eval-protect-tests',
  layer: 'deny',
  toolPattern: 'file_*',
  effectKinds: ['fs.write', 'fs.create', 'fs.delete', 'fs.move'],
  resourcePatterns: ['tests/**'],
  argsPredicate: (args) => String(args.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').startsWith('tests/'),
  description: 'tests/ is immutable for this run',
};

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'routedev-effects-'));
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

describe('Effect-aware permission kernel', () => {
  it('canonicalizes aliases and non-existent targets through the real parent', () => {
    const root = workspace();
    const resolver = new EffectResolver();

    const a = resolver.resolve('file_write', { path: './tests/../tests/new.test.ts' }, { workingDirectory: root });
    const b = resolver.resolve('file_edit', { path: join(root, 'tests', 'new.test.ts') }, { workingDirectory: root });

    expect(a.classification).toBe('KNOWN_EFFECTS');
    expect(a.effects[0]?.canonicalResource).toBe(b.effects[0]?.canonicalResource);
    const expected = join(realpathSync(root), 'tests', 'new.test.ts');
    expect(a.effects[0]?.canonicalResource).toBe(process.platform === 'win32' ? expected.toLowerCase() : expected);
  });

  it('resolves common substitution commands to destination effects', () => {
    const root = workspace();
    const resolver = new EffectResolver();
    const commands = [
      'mv temp.test.ts tests/new.test.ts',
      'cp temp.test.ts ./tests/new.test.ts',
      'cat temp.test.ts > tests/new.test.ts',
      'echo data >> tests/new.test.ts',
      'printf data | tee tests/new.test.ts',
      "sed -i 's/a/b/' tests/new.test.ts",
      'git restore --source HEAD -- tests/new.test.ts',
      'git checkout HEAD -- tests/new.test.ts',
      "node -e \"require('fs').writeFileSync('tests/new.test.ts','x')\"",
      "python -c \"open('tests/new.test.ts','w').write('x')\"",
      "Set-Content -Path tests/new.test.ts -Value x",
      "cd tests && powershell -NoProfile -Command \"Set-Content -Path 'new.test.ts' -Value x\"",
      'cmd /c copy temp.test.ts tests\\new.test.ts',
    ];

    for (const command of commands) {
      const result = resolver.resolve('shell_exec', { command }, { workingDirectory: root });
      expect(result.effects.some((effect) => effect.canonicalResource?.endsWith('tests\\new.test.ts') || effect.canonicalResource?.endsWith('tests/new.test.ts')), command).toBe(true);
      expect(result.effects.some((effect) => effect.kind.startsWith('fs.') && effect.kind !== 'fs.read'), command).toBe(true);
    }
  });

  it('applies a file deny rule to equivalent shell and git effects in auto mode', () => {
    const root = workspace();
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);

    const attempts: Array<[string, Record<string, unknown>]> = [
      ['file_write', { path: 'tests/new.test.ts', content: 'x' }],
      ['file_edit', { path: './tests/new.test.ts', oldText: 'a', newText: 'b' }],
      ['shell_exec', { command: 'mv tmp.ts tests/new.test.ts' }],
      ['shell_exec', { command: 'cat tmp.ts > ./tests/new.test.ts' }],
      ['shell_exec', { command: "cd tests && powershell -NoProfile -Command \"Set-Content -Path 'new.test.ts' -Value x\"" }],
      ['git_op', { operation: 'restore', paths: ['tests/new.test.ts'] }],
    ];

    for (const [toolName, args] of attempts) {
      const result = engine.check(toolName, args, 'auto', { runId: 'run-a', workingDirectory: root });
      expect(result.decision, `${toolName}: ${JSON.stringify(args)}`).toBe('deny');
      expect(result.matchedRuleId).toBe('eval-protect-tests');
      expect(result.effectKind).toMatch(/^fs\./);
      expect(result.canonicalResource).not.toContain('..');
    }
  });

  it('fails closed on opaque may-write substitutions only within the denied run', () => {
    const root = workspace();
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);

    expect(engine.check('file_write', { path: 'tests/a.ts', content: 'x' }, 'auto', {
      runId: 'run-denied', workingDirectory: root,
    }).decision).toBe('deny');

    const opaque = { command: "node -e \"eval(process.argv[1])\" unknown" };
    const sameRun = engine.check('shell_exec', opaque, 'auto', { runId: 'run-denied', workingDirectory: root });
    expect(sameRun.decision).toBe('deny');
    expect(sameRun.effectKind).toBe('opaque_may_write');
    expect(sameRun.matchedRuleId).toBe('eval-protect-tests');

    const unprotectedEngine = new PermissionEngine();
    const freshRun = unprotectedEngine.check('shell_exec', opaque, 'auto', { runId: 'run-fresh', workingDirectory: root });
    expect(freshRun.decision).not.toBe('deny');
  });

  it('keeps the proven read-only corpus allowed and denies repository-controlled scripts and verifiers (GA Unified Closure P1-1/P1-A)', () => {
    const root = workspace();
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);
    // 真 PROVEN_READ_ONLY：允许
    const allowed = [
      'git status --short',
      'git diff -- tests/a.ts',
      'git log -5 --oneline',
      'rg -n TODO src',
      'grep -R TODO src',
      'echo diagnostic text',
    ];
    for (const command of allowed) {
      const result = engine.check('shell_exec', { command }, 'auto', { runId: 'safe-run', workingDirectory: root });
      expect(result.decision, command).not.toBe('deny');
    }
    // P1-1 + P1-A：package.json script 与 repository code execution（vitest 加载并执行
    // repo 测试/源码、pnpm 直接 bin 也可被 repo-local resolution impersonate）——
    // script 名与 verifier bin 都不能证明 read-only；protected tests/** deny 存在时
    // OPAQUE_MAY_WRITE + 无法证明 disjoint → fail-closed DENY
    const deniedScripts = [
      'pnpm test',
      'pnpm typecheck',
      'npm run lint',
      'npm run build',
      'cd src && pnpm test',
      'vitest run',
      'pnpm vitest run',
      'pnpm exec vitest run',
      'npm exec vitest run',
      'eslint src/a.ts',
      'pnpm tsc --noEmit',
    ];
    for (const command of deniedScripts) {
      const result = engine.check('shell_exec', { command }, 'auto', { runId: `script-run-${command}`, workingDirectory: root });
      expect(result.decision, command).toBe('deny');
    }
  });

  it('P1-A adversarial bypass: vitest executing repo code cannot write protected resources', () => {
    // 真实 semantic bypass 场景：src/foo.ts 被改成执行 writeFileSync('tests/pwn.ts')，
    // `pnpm vitest run` 会加载并执行它——OPAQUE_MAY_WRITE + tests/** deny → fail-closed。
    const root = workspace();
    writeFileSync(join(root, 'src', 'foo.ts'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('tests/pwn.ts', 'pwned');\n", 'utf-8');
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);

    const result = engine.check('shell_exec', { command: 'pnpm vitest run' }, 'auto', {
      runId: 'vitest-bypass',
      workingDirectory: root,
    });
    expect(result.decision).toBe('deny');
    expect(result.effectKind).toBe('opaque_may_write');
    // fail-closed 后 tests/pwn.ts 不可能被创建（写入路径被 deny 拦截）
    expect(existsSync(join(root, 'tests', 'pwn.ts'))).toBe(false);
  });

  it('does not trust repository-local executables by a safe basename', () => {
    const root = workspace();
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);

    for (const command of ['./git status --short', '.\\git status --short', './cat src/a.ts', './node -e "console.log(1)"']) {
      const result = engine.check('shell_exec', { command }, 'auto', {
        runId: `path-exec-${command}`,
        workingDirectory: root,
      });
      expect(result.decision, command).toBe('deny');
      expect(result.effectKind, command).toBe('opaque_may_write');
    }
  });

  it('fails closed on verifier-shaped and unbounded mutation bypasses', () => {
    const root = workspace();
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);

    const commands = [
      `node -e "console.log('ok'); require('f'+'s').writeFileSync('tests/a.ts','x')"`,
      'echo x>tests/a.ts',
      'echo diagnostic 2>tests/a.ts',
      'sort src/a.ts -o tests/a.ts',
      'cp -t tests src/a.ts',
      'git diff --output=tests/a.patch',
      'git reset --hard',
      'git -C . checkout -- tests/a.ts',
      'tsc',
      'eslint tests/a.ts --fix',
    ];

    for (const command of commands) {
      const result = engine.check('shell_exec', { command }, 'auto', {
        runId: `adversarial-${command}`,
        workingDirectory: root,
      });
      expect(result.decision, command).toBe('deny');
    }
  });

  it('resolves directory links before matching protected resources', () => {
    const root = workspace();
    const alias = join(root, 'test-alias');
    try {
      symlinkSync(join(root, 'tests'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);

    const result = engine.check('file_write', { path: 'test-alias/via-link.ts', content: 'x' }, 'auto', {
      runId: 'link-run', workingDirectory: root,
    });
    expect(result.decision).toBe('deny');
    expect(result.matchedRuleId).toBe('eval-protect-tests');
  });

  it('resolves shell effects relative to the final working directory', () => {
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'routedev-effects-outside-'));
    const alias = join(root, 'outside-alias');
    try {
      symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const result = new EffectResolver().resolve('shell_exec', {
      command: 'echo x > target.txt',
      workingDirectory: 'outside-alias',
    }, { workingDirectory: root });

    const expected = join(realpathSync(outside), 'target.txt');
    expect(result.effects[0]?.canonicalResource).toBe(process.platform === 'win32' ? expected.toLowerCase() : expected);
    expect(result.effects[0]?.relativeResource).toMatch(/^\.\./);
  });

  it('preflights the complete parallel batch before returning approved calls', () => {
    const root = workspace();
    const engine = new PermissionEngine();
    engine.loadRules([protectedTestsRule]);

    const results = engine.checkBatch([
      { toolName: 'file_write', args: { path: 'tests/a.ts', content: 'x' } },
      { toolName: 'shell_exec', args: { command: "node -e \"eval(process.argv[1])\" unknown" } },
      { toolName: 'file_read', args: { path: 'src/index.ts' } },
    ], 'auto', { runId: 'batch-run', workingDirectory: root });

    expect(results.map((result) => result.decision)).toEqual(['deny', 'deny', 'auto']);
  });

  it('marks canonical write conflicts for serial execution', () => {
    const root = workspace();
    const engine = new PermissionEngine();
    const results = engine.checkBatch([
      { toolName: 'file_write', args: { path: './src/../src/a.ts', content: 'a' } },
      { toolName: 'file_write', args: { path: join(root, 'src', 'a.ts'), content: 'b' } },
    ], 'auto', { runId: 'conflict-run', workingDirectory: root });

    expect(results.every((item) => item.batchConflict)).toBe(true);
  });

  it('does not silently grant mutation capability to an unknown MCP tool', () => {
    const engine = new PermissionEngine();
    const result = engine.check('mcp__unknown__mutate', { payload: 'opaque' }, 'auto', {
      runId: 'mcp-run', workingDirectory: workspace(),
    });
    expect(result.decision).toBe('deny');
    expect(result.matchedRuleId).toBe('deny-opaque-mcp-effects');
    expect(result.effectKind).toBe('opaque_may_write');
  });

  it('revalidates file writes at the execution boundary', async () => {
    const root = workspace();
    const target = join(root, 'created', 'late-denied.ts');
    let checks = 0;
    const result = await new FileWriteTool().execute({ path: 'created/late-denied.ts', content: 'x' }, {
      workingDirectory: root,
      allowedDirectories: [root],
      environment: {},
      timeoutMs: 1000,
      revalidateEffect: async () => ({ allowed: ++checks === 1, reason: 'canonical target changed' }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('执行边界被拒绝');
    expect(existsSync(target)).toBe(false);
  });

  it('revalidates edits after stale checks and before mutation', async () => {
    const root = workspace();
    const target = join(root, 'src', 'a.ts');
    writeFileSync(target, 'old\n', 'utf8');
    const result = await new FileEditTool().execute({ path: 'src/a.ts', oldString: 'old', newString: 'new' }, {
      workingDirectory: root,
      allowedDirectories: [root],
      environment: {},
      timeoutMs: 1000,
      revalidateEffect: async () => ({ allowed: false, reason: 'link target changed' }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('执行边界被拒绝');
    expect(readFileSync(target, 'utf8')).toBe('old\n');
  });

  it('rejects a directory-link swap at the final file-write boundary', async () => {
    const root = workspace();
    const safe = join(root, 'safe');
    const outside = mkdtempSync(join(tmpdir(), 'routedev-write-swap-'));
    const alias = join(root, 'write-alias');
    mkdirSync(safe, { recursive: true });
    try {
      symlinkSync(safe, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const result = await new FileWriteTool().execute({ path: 'write-alias/escaped.ts', content: 'x' }, {
      workingDirectory: root,
      allowedDirectories: [root],
      environment: {},
      timeoutMs: 1000,
      revalidateEffect: async () => {
        rmSync(alias, { recursive: true, force: true });
        symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
        return { allowed: true };
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('路径在执行边界被拒绝');
    expect(existsSync(join(outside, 'escaped.ts'))).toBe(false);
  });

  it('rejects a directory-link swap at the final file-edit boundary', async () => {
    const root = workspace();
    const safe = join(root, 'safe-edit');
    const outside = mkdtempSync(join(tmpdir(), 'routedev-edit-swap-'));
    const alias = join(root, 'edit-alias');
    mkdirSync(safe, { recursive: true });
    writeFileSync(join(safe, 'a.ts'), 'old\n', 'utf8');
    writeFileSync(join(outside, 'a.ts'), 'outside\n', 'utf8');
    try {
      symlinkSync(safe, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const result = await new FileEditTool().execute({ path: 'edit-alias/a.ts', oldString: 'old', newString: 'new' }, {
      workingDirectory: root,
      allowedDirectories: [root],
      environment: {},
      timeoutMs: 1000,
      revalidateEffect: async () => {
        rmSync(alias, { recursive: true, force: true });
        symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
        return { allowed: true };
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('路径在执行边界被拒绝');
    expect(readFileSync(join(outside, 'a.ts'), 'utf8')).toBe('outside\n');
  });

  it('revalidates shell effects before spawning a process', async () => {
    const root = workspace();
    const result = await new ShellExecTool().execute({ command: 'echo should-not-run > src/spawned.txt' }, {
      workingDirectory: root,
      allowedDirectories: [root],
      environment: {},
      timeoutMs: 1000,
      revalidateEffect: async () => ({ allowed: false, reason: 'destination became protected' }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('执行边界被拒绝');
    expect(existsSync(join(root, 'src', 'spawned.txt'))).toBe(false);
  });

  it('rejects a shell working directory that escapes through a link', async () => {
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'routedev-shell-outside-'));
    const alias = join(root, 'outside-alias');
    try {
      symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const result = await new ShellExecTool().execute({
      command: 'echo should-not-run > escaped.txt',
      workingDirectory: 'outside-alias',
    }, {
      workingDirectory: root,
      allowedDirectories: [root],
      environment: {},
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('不在允许范围内');
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
  });
});

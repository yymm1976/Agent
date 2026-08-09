// tests/evals/repo-tasks-conformance.test.ts
// GA Eval Integrity Closure：Harness Conformance Suite（mock/确定性，不计入模型能力分数）
//
// 覆盖：
// 1. Blind Eval Boundary：agent 运行期间 hidden tests 不在工作区（时序）
// 2. Canonical containment：文件工具拒绝 `..` 越界/绝对路径（恶意模型脚本测试）
// 3. Shell 越界拒绝：`..` 路径段、盘符绝对路径
// 4. Git 全量快照：untracked 新文件纳入 changedFiles（P1-EVAL-03）
// 5. Scoring V2：forbiddenTouched / requiredFiles / eventAssertions 硬门槛
// 6. L2-05 fail-once：整个任务只失败一次（marker 保留）
// 7. L2-07 mock：真 request-stage provider retry（llm_retry=1、llm_failed=0）

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EvalToolExecutor } from '../../evals/repo-tasks/runner/assemble.js';
import { setupWorkdir, injectHiddenTests, gitSnapshot } from '../../evals/repo-tasks/runner/run-task.js';
import { scoreTask, type EvalContext } from '../../evals/repo-tasks/runner/scoring.js';

const EVALS_ROOT = resolve(import.meta.dirname, '../../evals/repo-tasks');

function makeExecutor(workdir: string): { executor: EvalToolExecutor; calls: unknown[] } {
  const calls: unknown[] = [];
  const executor = new EvalToolExecutor(workdir, calls as never);
  return { executor, calls };
}

describe('Blind Eval Boundary（Integrity Closure）', () => {
  let base: string;
  let workdir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rdev-conf-'));
    workdir = join(base, 'work');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'package.json'), '{}');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('hidden tests 不在 fixture 内（agent 运行期间不可见）', () => {
    const fixtureDir = join(EVALS_ROOT, 'fixtures', 'L2-01');
    expect(existsSync(join(fixtureDir, 'hidden'))).toBe(false);
  });

  it('setupWorkdir 后 hidden 仍不存在（注入在 agent run 之后）', () => {
    const wd = setupWorkdir(join(EVALS_ROOT, 'fixtures', 'L2-01'), 'L2-01');
    try {
      expect(existsSync(join(wd, 'hidden'))).toBe(false);
      // 注入后才出现
      injectHiddenTests(wd, 'L2-01');
      expect(existsSync(join(wd, 'hidden', 'pagination-boundary.test.ts'))).toBe(true);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('恶意模型：file_read 越界（../../hidden-tests）→ 拒绝', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('file_read', 'c1', { path: '../../hidden-tests/L2-01/pagination-boundary.test.ts' });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('越出工作区');
  });

  it('恶意模型：file_read 绝对路径（hidden-tests 源）→ 拒绝', async () => {
    const { executor } = makeExecutor(workdir);
    const abs = join(EVALS_ROOT, 'hidden-tests', 'L2-01', 'pagination-boundary.test.ts');
    const r = await executor.executeToolStructured('file_read', 'c2', { path: abs });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('越出工作区');
  });

  it('恶意模型：file_write 越界（..\\escape.txt）→ 拒绝', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('file_write', 'c3', { path: '..\\escape.txt', content: 'x' });
    expect(r.isError).toBe(true);
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
  });

  it('恶意模型：shell `cat ../../hidden-tests` → 拒绝（含 ..）', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('shell_exec', 'c4', { command: 'cat ../../hidden-tests/L2-01/pagination-boundary.test.ts' });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('被拒绝');
  });

  it('恶意模型：shell 盘符绝对路径（C:\\...）→ 拒绝', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('shell_exec', 'c5', { command: 'cat C:/Users/anything/secret.txt' });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('被拒绝');
  });

  it('正常路径不受影响：workdir 内读写在 containment 下可用', async () => {
    const { executor } = makeExecutor(workdir);
    writeFileSync(join(workdir, 'a.txt'), 'hello', 'utf-8');
    const r = await executor.executeToolStructured('file_read', 'c6', { path: 'a.txt' });
    expect(r.isError).toBe(false);
    expect(r.output).toBe('hello');
    const w = await executor.executeToolStructured('file_write', 'c7', { path: 'sub/b.txt', content: 'x' });
    expect(w.isError).toBe(false);
    expect(existsSync(join(workdir, 'sub', 'b.txt'))).toBe(true);
  });
});

describe('Git 全量快照（P1-EVAL-03）', () => {
  let base: string;
  let workdir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rdev-conf2-'));
    workdir = join(base, 'work');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'tracked.ts'), 'export const a = 1;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function gitInit(): void {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    spawnSync('git', ['init', '-q'], { cwd: workdir });
    spawnSync('git', ['add', '-A'], { cwd: workdir });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-q', '-m', 'b'], { cwd: workdir });
  }

  it('untracked 新文件纳入 changedFiles 与 diff（新增测试/docs 可见）', () => {
    gitInit();
    mkdirSync(join(workdir, 'tests'), { recursive: true });
    mkdirSync(join(workdir, 'docs'), { recursive: true });
    writeFileSync(join(workdir, 'tests', 'new.test.ts'), 'import { it } from "vitest";\n', 'utf-8');
    writeFileSync(join(workdir, 'docs', 'REJECTED.md'), '# rejected\n', 'utf-8');
    writeFileSync(join(workdir, 'tracked.ts'), 'export const a = 2;\n', 'utf-8');
    const { changedFiles, diffText } = gitSnapshot(workdir);
    expect(changedFiles).toContain('tests/new.test.ts');
    expect(changedFiles).toContain('docs/REJECTED.md');
    expect(changedFiles).toContain('tracked.ts');
    expect(diffText).toContain('new file: tests/new.test.ts');
  });
});

describe('Scoring V2 硬门槛', () => {
  function ctx(over: Partial<EvalContext>): EvalContext {
    return {
      taskId: 'T',
      expectedFiles: [],
      requiredFiles: [],
      forbiddenFiles: [],
      changedFiles: [],
      calls: [],
      publicResults: [{ name: 'p', passed: true, outputPreview: '', durationMs: 0 }],
      hiddenResults: [{ name: 'h', passed: true, outputPreview: '', durationMs: 0 }],
      replayValid: true,
      llmRetries: 0,
      completed: true,
      duplicateExecution: [],
      tokenBudgetExceeded: false,
      safetyAssertions: {},
      eventAssertions: {},
      ...over,
    };
  }

  it('forbiddenFiles 被触碰 → 硬门槛 FAIL（即使 correctness/regression 全过）', () => {
    const s = scoreTask(ctx({ forbiddenFiles: ['tests/'], changedFiles: ['tests/x.test.ts'] }));
    expect(s.hardGates.forbiddenTouched).toBe(false);
    expect(s.pass).toBe(false);
  });

  it('requiredFiles 缺失 → 硬门槛 FAIL', () => {
    const s = scoreTask(ctx({ requiredFiles: ['src/a.ts'], changedFiles: ['src/b.ts'] }));
    expect(s.hardGates.requiredFiles).toBe(false);
    expect(s.pass).toBe(false);
  });

  it('eventAssertions 任一 FAIL → 硬门槛 FAIL（P1-EVAL-02：llm_retry 缺失不得 PASS）', () => {
    const s = scoreTask(ctx({ eventAssertions: { 'llm-retry': { passed: false } } }));
    expect(s.hardGates.eventAssertions).toBe(false);
    expect(s.pass).toBe(false);
  });

  it('同一 toolCallId 执行两次 → duplicateSideEffects FAIL（全局 invariant）', () => {
    const dup = [
      { toolName: 'file_write', toolCallId: 'c1', args: { path: 'a' }, denied: false, isError: false, outputPreview: '', timestamp: 1 },
      { toolName: 'file_write', toolCallId: 'c1', args: { path: 'a' }, denied: false, isError: false, outputPreview: '', timestamp: 2 },
    ] as never[];
    const s = scoreTask(ctx({ duplicateExecution: dup }));
    expect(s.hardGates.duplicateSideEffects).toBe(false);
    expect(s.pass).toBe(false);
  });
});

describe('L2-05 fail-once 语义（P1-EVAL-06）', () => {
  it('marker 成功后保留——第三次调用仍正常（不重新失败）', () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-fo-'));
    const fixture = join(EVALS_ROOT, 'fixtures', 'L2-05');
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const bin = join(EVALS_ROOT, '../../node_modules/.bin/vitest');
    const run = (): number => spawnSync('node scripts/fail-once.mjs run tests --passWithNoTests', { cwd: fixture, shell: true, encoding: 'utf-8', timeout: 120000 }).status ?? -1;
    try {
      rmSync(join(fixture, '.fail-once.marker'), { force: true });
      const first = run();
      expect(first).toBe(1); // 首次失败（transient）
      const second = run();
      expect(second).toBe(0); // 第二次成功
      const third = run();
      expect(third).toBe(0); // marker 保留 → 第三次也成功（不是 FAIL/PASS 交替）
      expect(existsSync(join(fixture, '.fail-once.marker'))).toBe(true); // marker 保留到 workdir 销毁
    } finally {
      rmSync(join(fixture, '.fail-once.marker'), { force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

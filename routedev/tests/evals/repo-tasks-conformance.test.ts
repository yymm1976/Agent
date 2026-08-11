// tests/evals/repo-tasks-conformance.test.ts
// GA Eval Integrity Closure + Fix 2：Harness Conformance Suite（mock/确定性，不计入模型能力分数）
//
// 覆盖：
// 1. Blind Eval Boundary：agent 运行期间 hidden tests 不在工作区（时序）
// 2. Canonical containment：文件工具拒绝 `..` 越界/绝对路径（恶意模型脚本测试）
// 3. Shell 越界拒绝：`..` 路径段、盘符绝对路径
// 4. Fix 2：`.eval` 是 harness 内部路径——Agent 不可读写
// 5. Fix 2：baseline-relative 快照——Agent 自己 git commit 也绝不隐藏修改；
//    hidden 注入不污染评分快照
// 6. Fix 2：walkFiles 深度修复——list_directory/file_search 能看到嵌套目录（L3-09）
// 7. Fix 2：L2-05 fault 在 executor 层注入——第一次测试命令失败、第二次恢复、对模型不可见
// 8. Fix 2：bounded_repeat 连续语义——中间有状态变更不算 storm（L2-05）
// 9. Fix 2：tdd_order 判定——tests 写 < src 写 + 中间 RED（L2-03）
// 10. Fix 2：conformance mode pass 逻辑（L2-07 provider retry 语义）
// 11. Scoring V2：forbiddenTouched / requiredFiles / eventAssertions 硬门槛

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EvalToolExecutor } from '../../evals/repo-tasks/runner/assemble.js';
import { setupWorkdir, injectHiddenTests, gitSnapshot } from '../../evals/repo-tasks/runner/run-task.js';
import { scoreTask, detectRepeatStorm, detectTddOrderViolation, type EvalContext } from '../../evals/repo-tasks/runner/scoring.js';

const EVALS_ROOT = resolve(import.meta.dirname, '../../evals/repo-tasks');

function makeExecutor(workdir: string, faults?: { firstTestShellFailure?: boolean }): { executor: EvalToolExecutor; calls: unknown[] } {
  const calls: unknown[] = [];
  const executor = new EvalToolExecutor(workdir, calls as never, undefined, faults);
  return { executor, calls };
}

describe('Eval shell contract', () => {
  it('advertises the actual host shell dialect to the model', () => {
    const { executor } = makeExecutor(process.cwd());
    const shell = executor.getToolDefinitions().find((tool) => tool.name === 'shell_exec');

    expect(shell?.description).toContain(process.platform === 'win32' ? 'Windows cmd.exe' : 'POSIX shell');
    expect(shell?.description).toContain('do not cd to an absolute workdir');
  });
});

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
    const { workdir: wd } = setupWorkdir(join(EVALS_ROOT, 'fixtures', 'L2-01'), 'L2-01');
    try {
      expect(existsSync(join(wd, 'hidden'))).toBe(false);
      // 注入后才出现
      injectHiddenTests(wd, 'L2-01');
      expect(existsSync(join(wd, 'hidden', 'pagination-boundary.test.ts'))).toBe(true);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('Fix 2b：workdir 有 node_modules junction（模型无需 npm install——L2-05）', () => {
    const { workdir: wd } = setupWorkdir(join(EVALS_ROOT, 'fixtures', 'L2-05'), 'L2-05');
    try {
      // junction 或真实目录均可——关键是 npm test 依赖可解析
      expect(existsSync(join(wd, 'node_modules'))).toBe(true);
      // junction 不进 baseline commit（.gitignore 忽略 node_modules）
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const ls = spawnSync('git', ['ls-files'], { cwd: wd, encoding: 'utf-8' });
      expect(ls.stdout ?? '').not.toContain('node_modules');
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

  it('Fix 2b：shell MSYS 绝对路径（/c/Users/...、/tmp/x）→ 拒绝（L2-05 泄漏修复）', async () => {
    const { executor } = makeExecutor(workdir);
    const r1 = await executor.executeToolStructured('shell_exec', 'c5a', { command: 'ls /c/Users/anything/node_modules' });
    expect(r1.isError).toBe(true);
    expect(r1.output).toContain('被拒绝');
    const r2 = await executor.executeToolStructured('shell_exec', 'c5b', { command: 'cat > /tmp/escape.mjs' });
    expect(r2.isError).toBe(true);
    expect(r2.output).toContain('被拒绝');
  });

  it('Fix 2b：/dev/null 重定向不受影响（2>/dev/null 白名单，Windows 用 2>nul）', async () => {
    const { executor } = makeExecutor(workdir);
    // Windows cmd 无 /dev/null（用 nul）——验证重定向形式不被越界正则误伤
    const r = await executor.executeToolStructured('shell_exec', 'c5c', { command: 'echo ok 2>nul' });
    expect(r.isError).toBe(false);
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

describe('Fix 2：.eval 为 harness 内部路径（Agent 不可读写）', () => {
  let base: string;
  let workdir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rdev-eval-'));
    workdir = join(base, 'work');
    mkdirSync(join(workdir, '.eval', 'traces', 'runs'), { recursive: true });
    writeFileSync(join(workdir, '.eval', 'traces', 'runs', 'x-events.jsonl'), '{"type":"llm_succeeded"}\n', 'utf-8');
    writeFileSync(join(workdir, 'ok.txt'), 'ok', 'utf-8');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('file_read .eval/traces/... → 拒绝（L3-09 trace 泄漏修复）', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('file_read', 'c1', { path: '.eval/traces/runs/x-events.jsonl' });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('harness 内部空间');
  });

  it('file_write .eval/... → 拒绝', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('file_write', 'c2', { path: '.eval/steal.jsonl', content: 'x' });
    expect(r.isError).toBe(true);
    expect(existsSync(join(workdir, '.eval', 'steal.jsonl'))).toBe(false);
  });

  it('file_search .eval 内 → 不返回结果（walkFiles 跳过）', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('file_search', 'c3', { pattern: 'llm_succeeded' });
    expect(r.isError).toBe(false);
    expect(r.output).not.toContain('.eval');
  });

  it('shell 命令含 .eval 路径 → 拒绝', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('shell_exec', 'c4', { command: 'type .eval/traces/runs/x-events.jsonl' });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('被拒绝');
  });
});

describe('Fix 2：walkFiles 深度修复（L3-09 导航 bug）', () => {
  let base: string;
  let workdir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rdev-walk-'));
    workdir = join(base, 'work');
    mkdirSync(join(workdir, 'src'), { recursive: true });
    mkdirSync(join(workdir, 'tests'), { recursive: true });
    writeFileSync(join(workdir, 'package.json'), '{}', 'utf-8');
    writeFileSync(join(workdir, 'src', 'loader.ts'), 'export const parseConfig = () => 1;\n', 'utf-8');
    writeFileSync(join(workdir, 'tests', 'loader.test.ts'), 'import { it } from "vitest";\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('list_directory(".") 能看到第一层子目录内的文件（旧实现 depth=3 起点直接 return）', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('list_directory', 'c1', { path: '.' });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('src/loader.ts');
    expect(r.output).toContain('tests/loader.test.ts');
  });

  it('file_search 能命中 src/ 下源码（旧实现只搜根目录）', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('file_search', 'c2', { pattern: 'parseConfig' });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('src/loader.ts');
  });

  it('repo_map（list_directory 别名）能看到嵌套结构', async () => {
    const { executor } = makeExecutor(workdir);
    const r = await executor.executeToolStructured('repo_map', 'c3', {});
    expect(r.isError).toBe(false);
    expect(r.output).toContain('src/loader.ts');
  });
});

describe('Git 全量快照（P1-EVAL-03 + Fix 2 baseline-relative）', () => {
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

  function gitInit(): string {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    spawnSync('git', ['init', '-q'], { cwd: workdir });
    spawnSync('git', ['add', '-A'], { cwd: workdir });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-q', '-m', 'b'], { cwd: workdir });
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workdir, encoding: 'utf-8' }).stdout?.trim() ?? '';
  }

  it('untracked 新文件纳入 changedFiles 与 diff（新增测试/docs 可见）', () => {
    const baseline = gitInit();
    mkdirSync(join(workdir, 'tests'), { recursive: true });
    mkdirSync(join(workdir, 'docs'), { recursive: true });
    writeFileSync(join(workdir, 'tests', 'new.test.ts'), 'import { it } from "vitest";\n', 'utf-8');
    writeFileSync(join(workdir, 'docs', 'REJECTED.md'), '# rejected\n', 'utf-8');
    writeFileSync(join(workdir, 'tracked.ts'), 'export const a = 2;\n', 'utf-8');
    const { changedFiles, diffText } = gitSnapshot(workdir, baseline);
    expect(changedFiles).toContain('tests/new.test.ts');
    expect(changedFiles).toContain('docs/REJECTED.md');
    expect(changedFiles).toContain('tracked.ts');
    expect(diffText).toContain('new file: tests/new.test.ts');
  });

  it('Fix 2：Agent 自己 git commit 也绝不隐藏修改（commit-blind 修复）', () => {
    const baseline = gitInit();
    writeFileSync(join(workdir, 'tracked.ts'), 'export const a = 3;\n', 'utf-8');
    writeFileSync(join(workdir, 'brand-new.ts'), 'export const b = 1;\n', 'utf-8');
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    spawnSync('git', ['add', '-A'], { cwd: workdir });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-q', '-m', 'agent work'], { cwd: workdir });
    // 旧实现 gitSnapshot(workdir) 相对当前 HEAD → working tree clean → 判"没有修改"
    const { changedFiles, diffText } = gitSnapshot(workdir, baseline);
    expect(changedFiles).toContain('tracked.ts');
    expect(changedFiles).toContain('brand-new.ts');
    expect(diffText).toContain('export const a = 3');
    expect(diffText).toContain('new file mode 100644'); // committed 新文件走 git 标准 diff
  });

  it('Fix 2：hidden 注入不污染评分快照（快照在注入前生成）', () => {
    const baseline = gitInit();
    writeFileSync(join(workdir, 'src-new.ts'), 'export const c = 1;\n', 'utf-8');
    const before = gitSnapshot(workdir, baseline);
    // 模拟注入 hidden（在快照之后发生）
    mkdirSync(join(workdir, 'hidden'), { recursive: true });
    writeFileSync(join(workdir, 'hidden', 'h.test.ts'), 'import { it } from "vitest";\n', 'utf-8');
    expect(before.changedFiles).not.toContain('hidden/h.test.ts');
    expect(before.changedFiles).toContain('src-new.ts');
  });
});

describe('Fix 2：L2-05 fault 注入（executor 层，对模型不可见）', () => {
  let base: string;
  let workdir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rdev-fault-'));
    workdir = join(base, 'work');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'package.json'), '{"scripts":{"test":"echo ok"}}\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('第一次匹配测试命令的 shell_exec 失败（transient），第二次恢复', async () => {
    const { executor, calls } = makeExecutor(workdir, { firstTestShellFailure: true });
    const first = await executor.executeToolStructured('shell_exec', 'c1', { command: 'npm test' });
    expect(first.isError).toBe(true);
    expect(first.output).toContain('transient infrastructure error');
    const second = await executor.executeToolStructured('shell_exec', 'c2', { command: 'npm test' });
    expect(second.isError).toBe(false);
    // fault 不产生任何文件（对模型不可见、不可修改）
    expect(readdirSync(workdir).filter((f) => f.startsWith('.fail') || f.includes('marker'))).toHaveLength(0);
    expect((calls as Array<{ toolName: string; toolCallId: string }>).map((c) => c.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('非测试命令不受 fault 影响', async () => {
    const { executor } = makeExecutor(workdir, { firstTestShellFailure: true });
    const r = await executor.executeToolStructured('shell_exec', 'c1', { command: 'echo hello' });
    expect(r.isError).toBe(false);
  });
});

describe('Fix 2：bounded_repeat 连续语义（L2-05 storm 误判修复）', () => {
  function call(toolName: string, isError: boolean, command?: string, ts = 1): never {
    return { toolName, toolCallId: `c${ts}`, args: command ? { command } : {}, denied: false, isError, outputPreview: '', timestamp: ts } as never;
  }

  it('连续相同失败且中间无状态变更 → storm', () => {
    const calls = [
      call('shell_exec', true, 'npm test', 1),
      call('shell_exec', true, 'npm test', 2),
      call('shell_exec', true, 'npm test', 3),
    ];
    const storm = detectRepeatStorm(calls, 2);
    expect(storm).not.toBeNull();
    expect(storm?.count).toBe(3);
  });

  it('失败→诊断→失败→修改→失败 不算 storm（中间有状态变更重置窗口）', () => {
    const calls = [
      call('shell_exec', true, 'npm test', 1),
      call('file_read', false, undefined, 2),
      call('shell_exec', true, 'npm test', 3),
      call('file_edit', false, undefined, 4), // 状态变更 → 重置
      call('shell_exec', true, 'npm test', 5),
    ];
    expect(detectRepeatStorm(calls, 2)).toBeNull();
  });

  it('不同失败命令不累计', () => {
    const calls = [
      call('shell_exec', true, 'npm test', 1),
      call('shell_exec', true, 'npm run build', 2),
      call('shell_exec', true, 'npm test', 3),
    ];
    expect(detectRepeatStorm(calls, 2)).toBeNull();
  });
});

describe('Fix 2：tdd_order 判定（L2-03）', () => {
  function call(toolName: string, isError: boolean, args: Record<string, unknown>, ts: number): never {
    return { toolName, toolCallId: `c${ts}`, args, denied: false, isError, outputPreview: '', timestamp: ts } as never;
  }

  it('tests 写 < src 写 且中间有 RED → 通过', () => {
    const calls = [
      call('file_read', false, { path: 'src/secrets.ts' }, 1),
      call('file_write', false, { path: 'tests/secrets.test.ts', content: 'x' }, 2),
      call('shell_exec', true, { command: 'vitest run tests' }, 3), // RED
      call('file_write', false, { path: 'src/secrets.ts', content: 'y' }, 4),
    ];
    expect(detectTddOrderViolation(calls)).toBeNull();
  });

  it('Fix 2b：管道吞退出码的 RED 也能识别（`npm test 2>&1 | tail` isError=false 但输出含 failed）', () => {
    const calls = [
      call('file_write', false, { path: 'tests/secrets.test.ts', content: 'x' }, 1),
      // isError=false（tail 吞掉退出码），但输出尾部含失败特征 → 仍算 RED
      { toolName: 'shell_exec', toolCallId: 'c2', args: { command: 'npm test 2>&1 | tail -30' }, denied: false, isError: false, outputPreview: 'RUN v4', outputTail: '\nTests  1 failed | 0 passed', timestamp: 2 } as never,
      call('file_write', false, { path: 'src/secrets.ts', content: 'y' }, 3),
    ];
    expect(detectTddOrderViolation(calls)).toBeNull();
  });

  it('src 先写后写 tests → 违规', () => {
    const calls = [
      call('file_write', false, { path: 'src/secrets.ts', content: 'y' }, 1),
      call('file_write', false, { path: 'tests/secrets.test.ts', content: 'x' }, 2),
    ];
    expect(detectTddOrderViolation(calls)).toContain('不早于');
  });

  it('tests 与 src 之间无 RED → 违规', () => {
    const calls = [
      call('file_write', false, { path: 'tests/secrets.test.ts', content: 'x' }, 1),
      call('file_write', false, { path: 'src/secrets.ts', content: 'y' }, 2),
    ];
    expect(detectTddOrderViolation(calls)).toContain('RED 缺失');
  });

  it('未写 tests → 违规', () => {
    const calls = [call('file_write', false, { path: 'src/secrets.ts', content: 'y' }, 1)];
    expect(detectTddOrderViolation(calls)).toContain('tests/* 写操作');
  });
});

describe('Scoring V2 硬门槛 + Fix 2 conformance mode', () => {
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

  it('Fix 2：conformance mode——provider retry 语义全过即 PASS（不计业务 correctness/requiredFiles）', () => {
    const s = scoreTask(ctx({
      mode: 'conformance',
      hiddenResults: [{ name: 'h', passed: false, outputPreview: '', durationMs: 0 }], // mock 不写业务代码 → hidden 失败
      requiredFiles: ['src/score-calc.ts'],
      changedFiles: [],
      eventAssertions: { 'llm-retry-observed': { passed: true }, 'no-llm-failed': { passed: true }, 'lifecycle-complete': { passed: true } },
    }));
    expect(s.mode).toBe('conformance');
    expect(s.taskCorrectness).toBe(false); // 业务 correctness 不达标
    expect(s.pass).toBe(true);             // 但 conformance PASS
  });

  it('Fix 2：conformance mode——event assertion 失败仍 FAIL', () => {
    const s = scoreTask(ctx({
      mode: 'conformance',
      eventAssertions: { 'llm-retry-observed': { passed: false } },
    }));
    expect(s.pass).toBe(false);
  });
});

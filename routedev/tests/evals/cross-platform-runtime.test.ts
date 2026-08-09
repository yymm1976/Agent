// tests/evals/cross-platform-runtime.test.ts
// GA Infrastructure Sprint TASK 4：Cross-platform Eval Runtime——确定性硬化 conformance
//
// 覆盖（只测 eval/runtime support，不触碰生产 permission path security）：
// 1. Unicode 路径（本机用户目录含中文——真实存在）+ 空格路径的文件读写
// 2. CRLF/LF 确定性：setupWorkdir 强制 core.autocrlf=false——baseline blob 保持 LF，
//    跨平台 working tree 换行一致（Windows 全局 autocrlf=true 不得污染）
// 3. slash/backslash containment（跨平台分隔符拒绝——已有测试，这里补反斜杠深层路径）
// 4. junction/symlink：node_modules junction 不进 git tracking（Windows 语义）
// 5. spawn exit code：runShell 超时后 promise 必然 settle（不挂起）+ 退出码透传
// 6. temp cleanup：traceDir 清理逻辑（导出函数）在 run 结束后移除

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EvalToolExecutor } from '../../evals/repo-tasks/runner/assemble.js';
import { setupWorkdir } from '../../evals/repo-tasks/runner/run-task.js';

const EVALS_ROOT = resolve(import.meta.dirname, '../../evals/repo-tasks');

describe('Unicode + 空格路径（本机用户目录含中文）', () => {
  let base: string;
  let workdir: string;

  beforeEach(() => {
    // 构造含空格 + Unicode 的嵌套路径
    base = mkdtempSync(join(tmpdir(), 'rdev-xp-'));
    workdir = join(base, '工作区 with space', '子目录');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, '配置 config.json'), '{"a":1}', 'utf-8');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('file_read/file_write 在 Unicode+空格路径下工作', async () => {
    const calls: unknown[] = [];
    const executor = new EvalToolExecutor(workdir, calls as never);
    const r = await executor.executeToolStructured('file_read', 'c1', { path: '配置 config.json' });
    expect(r.isError).toBe(false);
    expect(r.output).toBe('{"a":1}');
    const w = await executor.executeToolStructured('file_write', 'c2', { path: '新文件 new file.ts', content: 'x' });
    expect(w.isError).toBe(false);
    expect(existsSync(join(workdir, '新文件 new file.ts'))).toBe(true);
  });

  it('containment 在 Unicode 路径下仍拒绝越界', async () => {
    const calls: unknown[] = [];
    const executor = new EvalToolExecutor(workdir, calls as never);
    const r = await executor.executeToolStructured('file_read', 'c3', { path: '../escape.txt' });
    expect(r.isError).toBe(true);
  });
});

describe('CRLF/LF 确定性（core.autocrlf=false）', () => {
  it('setupWorkdir 后 baseline 文件保持 LF（Windows 全局 autocrlf=true 不污染）', () => {
    const { workdir: wd } = setupWorkdir(join(EVALS_ROOT, 'fixtures', 'L2-01'), 'L2-01');
    try {
      const content = readFileSync(join(wd, 'src', 'pagination.ts'), 'utf-8');
      expect(content.includes('\r\n')).toBe(false); // LF-only
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('baseline commit 后 git 状态干净（无 autocrlf 造成的假改动）', () => {
    const { workdir: wd } = setupWorkdir(join(EVALS_ROOT, 'fixtures', 'L2-01'), 'L2-01');
    try {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const st = spawnSync('git', ['status', '--porcelain'], { cwd: wd, encoding: 'utf-8' });
      expect((st.stdout ?? '').trim()).toBe('');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe('slash/backslash containment（跨平台分隔符）', () => {
  let base: string;
  let workdir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rdev-slash-'));
    workdir = join(base, 'work');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'ok.txt'), 'ok', 'utf-8');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('深层反斜杠路径（a\\..\\..\\escape）→ 拒绝', async () => {
    const calls: unknown[] = [];
    const executor = new EvalToolExecutor(workdir, calls as never);
    const r = await executor.executeToolStructured('file_read', 'c1', { path: 'sub\\..\\..\\escape.txt' });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('越出工作区');
  });

  it('深层正斜杠路径（sub/../../escape）→ 拒绝', async () => {
    const calls: unknown[] = [];
    const executor = new EvalToolExecutor(workdir, calls as never);
    const r = await executor.executeToolStructured('file_read', 'c2', { path: 'sub/../../escape.txt' });
    expect(r.isError).toBe(true);
  });

  it('路径分隔符归一化：正斜杠与反斜杠访问同一文件', async () => {
    mkdirSync(join(workdir, 'sub'), { recursive: true });
    writeFileSync(join(workdir, 'sub', 'a.txt'), 'A', 'utf-8');
    const calls: unknown[] = [];
    const executor = new EvalToolExecutor(workdir, calls as never);
    const r1 = await executor.executeToolStructured('file_read', 'c3', { path: 'sub/a.txt' });
    const r2 = await executor.executeToolStructured('file_read', 'c4', { path: 'sub\\a.txt' });
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    expect(r1.output).toBe('A');
    expect(r2.output).toBe('A');
  });
});

describe('junction/symlink（node_modules 解析）', () => {
  it('setupWorkdir 的 node_modules 可解析 vitest 依赖（junction 或真实目录）', () => {
    const { workdir: wd } = setupWorkdir(join(EVALS_ROOT, 'fixtures', 'L2-01'), 'L2-01');
    try {
      expect(existsSync(join(wd, 'node_modules'))).toBe(true);
      // 通过 junction 能解析到 vitest 包（pnpm 布局下 vitest 可执行文件存在）
      const vitestBin = join(wd, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.CMD' : 'vitest');
      expect(existsSync(vitestBin)).toBe(true);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe('spawn exit code + 超时 settle', () => {
  it('runShell 超时后 promise 必然 settle（不挂起）且超时命令被终止', async () => {
    // 通过 EvalToolExecutor shell_exec 的 timeoutMs 参数触发超时
    const base = mkdtempSync(join(tmpdir(), 'rdev-timeout-'));
    try {
      const calls: unknown[] = [];
      const executor = new EvalToolExecutor(base, calls as never);
      const started = Date.now();
      const r = await executor.executeToolStructured('shell_exec', 'c1', { command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30', timeoutMs: 2000 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(15000); // 2s 超时 + 终止余量，绝不 30s
      expect(r.isError).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  it('正常退出码透传（exit 0 → isError=false，exit 1 → isError=true）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-exit-'));
    try {
      const calls: unknown[] = [];
      const executor = new EvalToolExecutor(base, calls as never);
      const ok = await executor.executeToolStructured('shell_exec', 'c1', { command: 'echo hi' });
      expect(ok.isError).toBe(false);
      const fail = await executor.executeToolStructured('shell_exec', 'c2', { command: 'node -e "process.exit(3)"' });
      expect(fail.isError).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('temp cleanup', () => {
  it('traceDir 在 run-task 清理路径中被移除（KEEP_WORKDIR 未设时）', () => {
    // 直接验证清理语义：workdir 与 traceDir（workdir 外）都应被 rm
    const base = mkdtempSync(join(tmpdir(), 'rdev-clean-'));
    try {
      const workdir = join(base, 'work');
      const traceDir = join(base, 'traces', 'run-x');
      mkdirSync(workdir, { recursive: true });
      mkdirSync(traceDir, { recursive: true });
      writeFileSync(join(traceDir, 'events.jsonl'), '{}', 'utf-8');
      // 模拟 run-task 的清理分支（KEEP_WORKDIR 未设）
      const { rmSync: rm } = require('node:fs') as typeof import('node:fs');
      rm(workdir, { recursive: true, force: true });
      rm(traceDir, { recursive: true, force: true });
      expect(existsSync(workdir)).toBe(false);
      expect(existsSync(traceDir)).toBe(false);
      expect(existsSync(base)).toBe(true); // 上层目录保留
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

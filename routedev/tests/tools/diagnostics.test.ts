// tests/tools/diagnostics.test.ts
// B-03：diagnostics 工具测试（命令发现 + 执行结果）
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDiagnosticCommands, createDiagnosticsTool } from '../../src/tools/builtin/diagnostics.js';

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rd-diag-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('B-03 resolveDiagnosticCommands 命令发现', () => {
  it('typecheck：有 tsconfig 与本地 tsc 时用本地 tsc', () => {
    const dir = makeProject({
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '#!/usr/bin/env node',
      'node_modules/.bin/tsc.cmd': '@echo off',
    });
    try {
      const cmd = resolveDiagnosticCommands(dir, 'typecheck');
      expect(cmd).not.toBeNull();
      expect(cmd!.label).toContain('tsc --noEmit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('typecheck：有 tsconfig 但无本地 tsc 且无脚本时返回 null', () => {
    const dir = makeProject({ 'tsconfig.json': '{}' });
    try {
      expect(resolveDiagnosticCommands(dir, 'typecheck')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('typecheck：无 tsconfig 返回 null（不猜测）', () => {
    const dir = makeProject({ 'package.json': '{"name":"x"}' });
    try {
      expect(resolveDiagnosticCommands(dir, 'typecheck')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lint/test：读 package.json 脚本', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'x', scripts: { lint: 'echo lint', test: 'echo test' } }),
    });
    try {
      expect(resolveDiagnosticCommands(dir, 'lint')?.label).toBe('npm run lint');
      expect(resolveDiagnosticCommands(dir, 'test')?.label).toBe('npm test');
      expect(resolveDiagnosticCommands(dir, 'lint')?.args).toEqual(['run', 'lint', '--silent']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无脚本时返回 null', () => {
    const dir = makeProject({ 'package.json': '{"name":"x"}' });
    try {
      expect(resolveDiagnosticCommands(dir, 'test')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('B-03 diagnostics 工具执行', () => {
  it('未配置诊断时返回明确说明（不失败不伪造）', async () => {
    const tool = createDiagnosticsTool();
    const dir = makeProject({});
    try {
      const result = await tool.execute({ scope: 'typecheck' }, { workingDirectory: dir } as never);
      expect(result.success).toBe(true);
      expect(result.output).toContain('未配置');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test 脚本失败时 success=false 并带退出码', async () => {
    const tool = createDiagnosticsTool();
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(3)"' } }),
    });
    try {
      const result = await tool.execute({ scope: 'test' }, { workingDirectory: dir } as never);
      expect(result.success).toBe(false);
      expect(result.output).toContain('exit=3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test 脚本通过时 success=true', async () => {
    const tool = createDiagnosticsTool();
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node -e "console.log(1)"' } }),
    });
    try {
      const result = await tool.execute({ scope: 'test' }, { workingDirectory: dir } as never);
      expect(result.success).toBe(true);
      expect(result.output).toContain('通过');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

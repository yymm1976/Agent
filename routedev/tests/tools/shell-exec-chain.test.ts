// tests/tools/shell-exec-chain.test.ts
// Phase 96 修复：translateChainForPowerShell5 单元测试
// 验证 && / || 命令链在 Windows PowerShell 5.x 下的兼容翻译

import { describe, it, expect } from 'vitest';
import { translateChainForPowerShell5 } from '../../src/tools/builtin/shell-exec.js';

describe('translateChainForPowerShell5', () => {
  it('单条命令不翻译（无 && 或 ||）', () => {
    expect(translateChainForPowerShell5('echo hello')).toBe('echo hello');
    expect(translateChainForPowerShell5('ls -la')).toBe('ls -la');
    expect(translateChainForPowerShell5('git status')).toBe('git status');
  });

  it('cmd1 && cmd2 → cmd1; if ($?) { cmd2 }', () => {
    expect(translateChainForPowerShell5('cd routedev && echo ok')).toBe(
      'cd routedev; if ($?) { echo ok }',
    );
  });

  it('cmd1 || cmd2 → cmd1; if (-not $?) { cmd2 }', () => {
    expect(translateChainForPowerShell5('pnpm test || echo failed')).toBe(
      'pnpm test; if (-not $?) { echo failed }',
    );
  });

  it('cmd1 && cmd2 && cmd3 → 嵌套 if ($?) 包裹', () => {
    expect(translateChainForPowerShell5('a && b && c')).toBe(
      'a; if ($?) { b; if ($?) { c } }',
    );
  });

  it('混合 && 和 || 按各自语义翻译', () => {
    expect(translateChainForPowerShell5('a && b || c')).toBe(
      'a; if ($?) { b; if (-not $?) { c } }',
    );
  });

  it('引号内的 && 不替换（避免破坏字面量）', () => {
    expect(translateChainForPowerShell5('echo "a && b"')).toBe('echo "a && b"');
    expect(translateChainForPowerShell5("echo 'a && b'")).toBe("echo 'a && b'");
  });

  it('引号内的 || 不替换', () => {
    expect(translateChainForPowerShell5('echo "a || b"')).toBe('echo "a || b"');
  });

  it('混合引号内外：引号外 && 替换，引号内 && 保留', () => {
    expect(translateChainForPowerShell5('echo "first" && echo "a && b"')).toBe(
      'echo "first"; if ($?) { echo "a && b" }',
    );
  });

  it('单 & 不替换（& 不是命令链分隔符）', () => {
    // 单个 & 在 PowerShell 中是后台运算符，不是命令链分隔符
    // 翻译函数应保留原样，交由 PowerShell 处理
    expect(translateChainForPowerShell5('notepad & echo done')).toBe('notepad & echo done');
  });

  it('实际场景：cd x && pnpm test', () => {
    expect(translateChainForPowerShell5('cd routedev && pnpm test')).toBe(
      'cd routedev; if ($?) { pnpm test }',
    );
  });

  it('实际场景：cd x && pnpm exec vitest run', () => {
    const cmd = 'cd routedev && pnpm exec vitest run tests/agents/profiles-version.test.ts';
    const expected = 'cd routedev; if ($?) { pnpm exec vitest run tests/agents/profiles-version.test.ts }';
    expect(translateChainForPowerShell5(cmd)).toBe(expected);
  });
});

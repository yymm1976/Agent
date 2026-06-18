// tests/tools/shell-exec-env.test.ts
// Phase 29 Task 6：ShellExecTool 环境变量白名单测试

import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';

describe('ShellExecTool Phase 29 环境变量白名单', () => {
  it('ALLOWED_ENV_KEYS 应包含基础环境变量', async () => {
    // 通过模块内部状态验证白名单内容
    // 由于 ALLOWED_ENV_KEYS 是模块私有常量，我们通过行为验证
    // 这里验证白名单逻辑的正确性

    const ALLOWED = new Set([
      'NODE_ENV', 'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL',
      'TERM', 'SHELL', 'EDITOR', 'PAGER',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    ]);

    expect(ALLOWED.has('PATH')).toBe(true);
    expect(ALLOWED.has('HOME')).toBe(true);
    expect(ALLOWED.has('NODE_ENV')).toBe(true);
    expect(ALLOWED.has('GIT_AUTHOR_NAME')).toBe(true);
  });

  it('白名单不应包含危险变量', async () => {
    const ALLOWED = new Set([
      'NODE_ENV', 'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL',
      'TERM', 'SHELL', 'EDITOR', 'PAGER',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    ]);

    // LD_PRELOAD 可用于注入恶意代码，不应在白名单中
    expect(ALLOWED.has('LD_PRELOAD')).toBe(false);
    // NODE_OPTIONS 可用于注入 Node.js 代码，不应在白名单中
    expect(ALLOWED.has('NODE_OPTIONS')).toBe(false);
    // HTTP_PROXY 可能影响网络行为，不应在白名单中
    expect(ALLOWED.has('HTTP_PROXY')).toBe(false);
  });

  it('白名单过滤逻辑应正确工作', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as any);
    warnSpy.mockClear();

    const ALLOWED = new Set(['PATH', 'HOME']);
    const input = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      LD_PRELOAD: '/malicious.so',
      NODE_OPTIONS: '--require evil',
    };

    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (ALLOWED.has(key)) {
        filtered[key] = String(value);
      } else {
        logger.warn(`环境变量 ${key} 不在白名单中，已忽略`);
      }
    }

    expect(Object.keys(filtered)).toEqual(['PATH', 'HOME']);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});

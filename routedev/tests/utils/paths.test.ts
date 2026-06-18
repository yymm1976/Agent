// tests/utils/paths.test.ts
// Phase 26 Task 9：路径工具测试覆盖

import { describe, it, expect } from 'vitest';
import { getAppDataDir, ensureDir, getGlobalConfigPath, getProjectConfigPath } from '../../src/utils/paths.js';
import path from 'node:path';
import fs from 'node:fs';

describe('paths utilities', () => {
  it('getAppDataDir 应返回有效路径', () => {
    const dir = getAppDataDir();
    expect(dir).toBeTruthy();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });

  it('getGlobalConfigPath 应返回有效路径', () => {
    const p = getGlobalConfigPath();
    expect(p).toBeTruthy();
    expect(typeof p).toBe('string');
  });

  it('getProjectConfigPath 应拼接项目路径', () => {
    const p = getProjectConfigPath('/my/project');
    expect(p).toContain('my');
    expect(p).toContain('project');
  });

  it('ensureDir 应创建不存在的目录', () => {
    const testDir = path.join(getAppDataDir(), 'test-ensure-dir-' + Date.now());
    try {
      ensureDir(testDir);
      expect(fs.existsSync(testDir)).toBe(true);
    } finally {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  it('ensureDir 对已存在的目录不报错', () => {
    const existingDir = getAppDataDir();
    expect(() => ensureDir(existingDir)).not.toThrow();
  });
});

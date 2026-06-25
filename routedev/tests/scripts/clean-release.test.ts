// tests/scripts/clean-release.test.ts
// 验证 Phase 40 Task 0 clean-release.ts 的正确性

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_CLEAN_OPTIONS,
  cleanStaleDirectoriesIn,
  type CleanOptions,
} from '../../scripts/clean-release.js';

// 跟踪测试中创建的临时目录，用于 afterEach 清理
let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  }
  tmpDirs = [];
});

/** 创建临时目录并登记以便清理 */
function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-clean-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** 在指定目录下创建子目录 */
function makeSubDir(parent: string, name: string): string {
  const full = path.join(parent, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

/** 构造测试用选项（dryRun 可覆盖） */
function makeOptions(overrides?: Partial<CleanOptions>): CleanOptions {
  return {
    ...DEFAULT_CLEAN_OPTIONS,
    keep: 'release-v3',
    maxRetries: 2,
    retryDelayMs: 10,
    ...overrides,
  };
}

describe('clean-release.ts', () => {
  describe('stalePattern 匹配', () => {
    it('release-v3 和 release-v3b 匹配 stalePattern', () => {
      const pattern = DEFAULT_CLEAN_OPTIONS.stalePattern;
      expect(pattern.test('release-v3')).toBe(true);
      expect(pattern.test('release-v3b')).toBe(true);
      expect(pattern.test('release-v3c')).toBe(true);
      expect(pattern.test('release-v12')).toBe(true);
    });

    it('release-v3.0.0 不匹配 stalePattern（含点号）', () => {
      const pattern = DEFAULT_CLEAN_OPTIONS.stalePattern;
      expect(pattern.test('release-v3.0.0')).toBe(false);
    });

    it('其他不相关目录名不匹配 stalePattern', () => {
      const pattern = DEFAULT_CLEAN_OPTIONS.stalePattern;
      expect(pattern.test('release3')).toBe(false);
      expect(pattern.test('release')).toBe(false);
      expect(pattern.test('dist')).toBe(false);
      expect(pattern.test('node_modules')).toBe(false);
    });
  });

  describe('dryRun 模式（只打印不删除）', () => {
    it('dryRun=true 时不删除任何目录', async () => {
      const tmpDir = createTempDir();
      makeSubDir(tmpDir, 'release-v3b');
      makeSubDir(tmpDir, 'release-v3c');

      const result = await cleanStaleDirectoriesIn(tmpDir, makeOptions({ dryRun: true }));

      // dryRun 不删除任何目录
      expect(result.cleaned).toHaveLength(0);
      expect(result.failed).toHaveLength(0);

      // 目录仍然存在
      expect(fs.existsSync(path.join(tmpDir, 'release-v3b'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'release-v3c'))).toBe(true);
    });
  });

  describe('keep 目录被跳过', () => {
    it('keep 目录（release-v3）不被删除，stale 目录被删除', async () => {
      const tmpDir = createTempDir();
      makeSubDir(tmpDir, 'release-v3');  // keep
      makeSubDir(tmpDir, 'release-v3b'); // stale
      makeSubDir(tmpDir, 'release-v3c'); // stale

      const result = await cleanStaleDirectoriesIn(
        tmpDir,
        makeOptions({ dryRun: false })
      );

      // stale 目录被删除
      expect(result.cleaned).toContain('release-v3b');
      expect(result.cleaned).toContain('release-v3c');
      expect(result.failed).toHaveLength(0);

      // keep 目录仍然存在
      expect(fs.existsSync(path.join(tmpDir, 'release-v3'))).toBe(true);
      // stale 目录已删除
      expect(fs.existsSync(path.join(tmpDir, 'release-v3b'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'release-v3c'))).toBe(false);
    });
  });

  describe('不匹配 stalePattern 的目录不被删除', () => {
    it('release-v3.0.0 不被删除', async () => {
      const tmpDir = createTempDir();
      makeSubDir(tmpDir, 'release-v3.0.0');

      const result = await cleanStaleDirectoriesIn(
        tmpDir,
        makeOptions({ dryRun: false })
      );

      expect(result.cleaned).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, 'release-v3.0.0'))).toBe(true);
    });
  });

  describe('无 stale 目录时返回空结果', () => {
    it('空目录返回 cleaned/failed 均为空', async () => {
      const tmpDir = createTempDir();

      const result = await cleanStaleDirectoriesIn(
        tmpDir,
        makeOptions({ dryRun: false })
      );

      expect(result.cleaned).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });
});

// tests/tools/builtin/search-utils.test.ts
// Phase 29 Task 6：search-utils 公共工具函数测试

import { describe, it, expect } from 'vitest';
import { walkDir, isIgnoredPath, matchGlob } from '../../../src/tools/builtin/search-utils.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

describe('search-utils（Phase 29 Task 5 提取）', () => {
  describe('walkDir', () => {
    it('应递归遍历目录返回所有文件', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-test-'));
      try {
        // 创建测试文件结构
        await fs.mkdir(path.join(tmpDir, 'subdir'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'content1');
        await fs.writeFile(path.join(tmpDir, 'subdir', 'file2.ts'), 'content2');

        const files = await walkDir(tmpDir, 100);
        expect(files.length).toBe(2);
        expect(files.some(f => f.endsWith('file1.txt'))).toBe(true);
        expect(files.some(f => f.endsWith('file2.ts'))).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('应遵守 maxFiles 限制', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-test-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'file1.txt'), '1');
        await fs.writeFile(path.join(tmpDir, 'file2.txt'), '2');
        await fs.writeFile(path.join(tmpDir, 'file3.txt'), '3');

        const files = await walkDir(tmpDir, 2);
        expect(files.length).toBeLessThanOrEqual(2);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('应跳过 node_modules 和 dist 目录', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-test-'));
      try {
        await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
        await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'main.ts'), 'main');
        await fs.writeFile(path.join(tmpDir, 'node_modules', 'dep.js'), 'dep');
        await fs.writeFile(path.join(tmpDir, 'dist', 'bundle.js'), 'bundle');

        const files = await walkDir(tmpDir, 100);
        expect(files.length).toBe(1);
        expect(files[0].endsWith('main.ts')).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('isIgnoredPath', () => {
    it('应识别 node_modules 路径', () => {
      expect(isIgnoredPath(`node_modules${path.sep}pkg${path.sep}index.js`)).toBe(true);
    });

    it('应识别 .git 路径', () => {
      expect(isIgnoredPath(`.git${path.sep}config`)).toBe(true);
    });

    it('应识别 dist 路径', () => {
      expect(isIgnoredPath(`dist${path.sep}bundle.js`)).toBe(true);
    });

    it('应识别嵌套的忽略目录', () => {
      expect(isIgnoredPath(`src${path.sep}node_modules${path.sep}pkg${path.sep}index.js`)).toBe(true);
    });

    it('不应误判正常路径', () => {
      expect(isIgnoredPath(`src${path.sep}index.ts`)).toBe(false);
      expect(isIgnoredPath(`tests${path.sep}helper.test.ts`)).toBe(false);
    });
  });

  describe('matchGlob', () => {
    it('应匹配 * 通配符', () => {
      expect(matchGlob('*.ts', 'index.ts')).toBe(true);
      expect(matchGlob('*.ts', 'index.js')).toBe(false);
    });

    it('应匹配 ? 通配符', () => {
      expect(matchGlob('test?.js', 'test1.js')).toBe(true);
      expect(matchGlob('test?.js', 'test12.js')).toBe(false);
    });

    it('应匹配精确文件名', () => {
      expect(matchGlob('package.json', 'package.json')).toBe(true);
      expect(matchGlob('package.json', 'package-lock.json')).toBe(false);
    });

    it('应正确处理点号（转义）', () => {
      expect(matchGlob('config.*', 'config.json')).toBe(true);
      expect(matchGlob('config.*', 'configXjson')).toBe(false);
    });
  });
});

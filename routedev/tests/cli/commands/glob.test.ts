// tests/cli/commands/glob.test.ts
// glob 工具测试：
//   - isGlobPattern 识别通配符
//   - expandGlob 单层 * 匹配
//   - expandGlob ** 跨层匹配
//   - expandGlob 大括号展开
//   - 无匹配返回空数组

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isGlobPattern, expandGlob } from '../../../src/cli/commands/glob.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-glob-'));
}

describe('glob 工具', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('isGlobPattern', () => {
    it('识别 * 为 glob', () => {
      expect(isGlobPattern('*.ts')).toBe(true);
      expect(isGlobPattern('src/*.ts')).toBe(true);
    });

    it('识别 ? 为 glob', () => {
      expect(isGlobPattern('file?.ts')).toBe(true);
    });

    it('识别 {} 为 glob', () => {
      expect(isGlobPattern('src/{a,b}.ts')).toBe(true);
    });

    it('识别 ** 为 glob', () => {
      expect(isGlobPattern('src/**/*.ts')).toBe(true);
    });

    it('普通文件名不是 glob', () => {
      expect(isGlobPattern('file.ts')).toBe(false);
      expect(isGlobPattern('src/file.ts')).toBe(false);
    });
  });

  describe('expandGlob', () => {
    it('单层 * 匹配当前目录文件', async () => {
      await fs.writeFile(path.join(tempDir, 'a.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'b.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'c.js'), '', 'utf-8');

      const matches = await expandGlob('*.ts', tempDir);
      expect(matches.sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('** 跨层匹配所有 .ts 文件', async () => {
      await fs.mkdir(path.join(tempDir, 'src', 'sub'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'root.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'src', 'top.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'src', 'sub', 'deep.ts'), '', 'utf-8');

      const matches = await expandGlob('**/*.ts', tempDir);
      // 应匹配所有层级的 .ts 文件
      expect(matches).toContain('root.ts');
      expect(matches).toContain('src/top.ts');
      expect(matches).toContain('src/sub/deep.ts');
      expect(matches.length).toBe(3);
    });

    it('src/**/*.ts 只匹配 src 下所有 .ts', async () => {
      await fs.mkdir(path.join(tempDir, 'src', 'sub'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'root.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'src', 'top.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'src', 'sub', 'deep.ts'), '', 'utf-8');

      const matches = await expandGlob('src/**/*.ts', tempDir);
      expect(matches).toContain('src/top.ts');
      expect(matches).toContain('src/sub/deep.ts');
      expect(matches).not.toContain('root.ts');
      expect(matches.length).toBe(2);
    });

    it('无匹配返回空数组', async () => {
      await fs.writeFile(path.join(tempDir, 'a.ts'), '', 'utf-8');
      const matches = await expandGlob('nomatch-*.ts', tempDir);
      expect(matches).toEqual([]);
    });

    it('大括号展开 {a,b}', async () => {
      await fs.writeFile(path.join(tempDir, 'a.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'b.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'c.ts'), '', 'utf-8');

      const matches = await expandGlob('{a,b}.ts', tempDir);
      expect(matches.sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('? 单字符匹配', async () => {
      await fs.writeFile(path.join(tempDir, 'f1.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'f2.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'f10.ts'), '', 'utf-8');

      const matches = await expandGlob('f?.ts', tempDir);
      expect(matches.sort()).toEqual(['f1.ts', 'f2.ts']);
    });

    it('跳过 node_modules 等目录', async () => {
      await fs.mkdir(path.join(tempDir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'node_modules', 'dep.ts'), '', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'real.ts'), '', 'utf-8');

      const matches = await expandGlob('**/*.ts', tempDir);
      expect(matches).toContain('real.ts');
      expect(matches).not.toContain('node_modules/dep.ts');
    });
  });
});

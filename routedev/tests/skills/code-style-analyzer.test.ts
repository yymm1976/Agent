// tests/skills/code-style-analyzer.test.ts
// Phase 39 Task 2：CodeStyleAnalyzer 单元测试
// 覆盖：注释语言检测、引号习惯检测、缩进风格检测、generateSkillFromFeatures

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodeStyleAnalyzer } from '../../src/skills/code-style-analyzer.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建临时项目目录 */
async function makeTempProject(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-style-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 在临时项目中创建 src/ 目录及文件 */
async function writeSourceFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(projectDir, 'src', relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/** 在临时项目中创建 package.json */
async function writePackageJson(projectDir: string, content: Record<string, unknown>): Promise<void> {
  const fullPath = path.join(projectDir, 'package.json');
  await fs.writeFile(fullPath, JSON.stringify(content, null, 2), 'utf-8');
}

// ============================================================
// 测试用例
// ============================================================

describe('CodeStyleAnalyzer (Phase 39 Task 2)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempProject();
  });

  afterEach(async () => {
    try {
      await fs.rm(projectDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  // ============================================================
  // 注释语言检测
  // ============================================================
  describe('注释语言检测', () => {
    it('应检测中文注释（占比 > 70%）', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        '// 这是中文注释',
        '// 另一个中文注释',
        '// 第三条中文注释',
        'const x = 1; // 中文说明',
        'const y = 2;',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.commentLanguage).toBe('chinese');
    });

    it('应检测英文注释（占比 > 70%）', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        '// This is an English comment',
        '// Another English comment',
        '// Third English comment',
        'const x = 1; // english note',
        'const y = 2;',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.commentLanguage).toBe('english');
    });

    it('应检测混合注释（中英文都不达 70%）', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        '// This is English 这是中文注释内容比较多',
        '// Another English 另一条中文注释内容也比较多',
        '// English only comment here',
        'const x = 1;',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.commentLanguage).toBe('mixed');
    });

    it('无注释时应返回 none', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        'const x = 1;',
        'const y = 2;',
        'console.log(x + y);',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.commentLanguage).toBe('none');
    });
  });

  // ============================================================
  // 引号习惯检测
  // ============================================================
  describe('引号习惯检测', () => {
    it('应检测单引号为主（占比 > 70%）', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        "const a = 'hello';",
        "const b = 'world';",
        "const c = 'foo';",
        "const d = 'bar';",
        'const e = "rare";',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.quoteStyle).toBe('single');
    });

    it('应检测双引号为主（占比 > 70%）', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        'const a = "hello";',
        'const b = "world";',
        'const c = "foo";',
        'const d = "bar";',
        "const e = 'rare';",
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.quoteStyle).toBe('double');
    });
  });

  // ============================================================
  // 缩进风格检测
  // ============================================================
  describe('缩进风格检测', () => {
    it('应检测 2 空格缩进', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        'function foo() {',
        '  const x = 1;',
        '  if (x) {',
        '    const y = 2;',
        '  }',
        '}',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.indentStyle).toBe('space-2');
    });

    it('应检测 4 空格缩进', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        'function foo() {',
        '    const x = 1;',
        '    if (x) {',
        '        const y = 2;',
        '    }',
        '}',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.indentStyle).toBe('space-4');
    });

    it('应检测 Tab 缩进', async () => {
      await writeSourceFile(projectDir, 'a.ts', [
        'function foo() {',
        '\tconst x = 1;',
        '\tif (x) {',
        '\t\tconst y = 2;',
        '\t}',
        '}',
      ].join('\n'));

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.indentStyle).toBe('tab');
    });
  });

  // ============================================================
  // 测试框架检测
  // ============================================================
  describe('测试框架检测', () => {
    it('应从 package.json devDependencies 检测 vitest', async () => {
      await writeSourceFile(projectDir, 'a.ts', 'const x = 1;');
      await writePackageJson(projectDir, {
        name: 'test-project',
        devDependencies: { vitest: '^1.0.0' },
      });

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.testFramework).toBe('vitest');
    });

    it('应检测 jest 框架', async () => {
      await writeSourceFile(projectDir, 'a.ts', 'const x = 1;');
      await writePackageJson(projectDir, {
        name: 'test-project',
        devDependencies: { jest: '^29.0.0' },
      });

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.testFramework).toBe('jest');
    });

    it('无测试框架时应返回 undefined', async () => {
      await writeSourceFile(projectDir, 'a.ts', 'const x = 1;');
      await writePackageJson(projectDir, {
        name: 'test-project',
        devDependencies: { typescript: '^5.0.0' },
      });

      const analyzer = new CodeStyleAnalyzer(projectDir);
      const features = await analyzer.analyze();

      expect(features.testFramework).toBeUndefined();
    });
  });

  // ============================================================
  // generateSkillFromFeatures
  // ============================================================
  describe('generateSkillFromFeatures', () => {
    it('应将特征转换为包含对应规则的 SKILL.md 内容', () => {
      const analyzer = new CodeStyleAnalyzer(projectDir);
      const skill = analyzer.generateSkillFromFeatures({
        commentLanguage: 'chinese',
        quoteStyle: 'single',
        indentStyle: 'space-2',
        namingConvention: 'camelCase',
        testFramework: 'vitest',
        commonUtils: ['logger', 'helpers'],
        errorHandling: 'try-catch',
      });

      expect(skill.name).toBe('project-code-style');
      expect(skill.description).toContain('代码风格');
      expect(skill.routingKeywords.length).toBeGreaterThanOrEqual(5);
      expect(skill.content).toContain('中文注释');
      expect(skill.content).toContain('单引号');
      expect(skill.content).toContain('2 空格缩进');
      expect(skill.content).toContain('camelCase');
      expect(skill.content).toContain('vitest');
      expect(skill.content).toContain('logger');
      expect(skill.content).toContain('try-catch');
    });

    it('无测试框架时 content 不应包含测试框架节', () => {
      const analyzer = new CodeStyleAnalyzer(projectDir);
      const skill = analyzer.generateSkillFromFeatures({
        commentLanguage: 'english',
        quoteStyle: 'double',
        indentStyle: 'space-4',
        namingConvention: 'snake_case',
        commonUtils: [],
        errorHandling: 'none',
      });

      expect(skill.content).not.toContain('## 测试框架');
      expect(skill.content).not.toContain('## 常用工具函数');
      expect(skill.content).toContain('英文注释');
      expect(skill.content).toContain('双引号');
      expect(skill.content).toContain('4 空格缩进');
      expect(skill.content).toContain('snake_case');
    });
  });
});

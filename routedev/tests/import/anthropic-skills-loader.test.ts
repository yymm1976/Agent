// tests/import/anthropic-skills-loader.test.ts
// Anthropic Skills 加载器单元测试
//
// 覆盖：
//   1. 扫描单个 SKILL.md 正确加载
//   2. 扫描多个子目录的 SKILL.md 全部加载
//   3. 目录不存在时返回空数组不报错
//   4. 无效 SKILL.md（解析失败）记入 errors 不影响其他
//   5. autoEnable 标志正确传递
//   6. scan 与 load 行为差异
//   7. frontmatter 缺失时 name 回退为目录名
//   8. 空 SKILL.md 记入 errors

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AnthropicSkillsLoader } from '../../src/import/anthropic-skills-loader.js';
import { SkillMdParser } from '../../src/skills/skill-md-parser.js';
import type { SkillMetadata } from '../../src/skills/skill-md-parser.js';

// ============================================================
// 工具函数
// ============================================================

/** 创建临时项目根目录 */
async function makeTempProjectRoot(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-anthropic-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 写一个 SKILL.md 到指定路径 */
async function writeSkillMd(
  projectRoot: string,
  skillDir: string,
  metadata: SkillMetadata,
  body: string,
): Promise<string> {
  const dir = path.join(projectRoot, 'anthropic_skills', skillDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  const content = SkillMdParser.serialize(metadata, body);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/** 递归删除目录 */
async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ============================================================
// AnthropicSkillsLoader 测试
// ============================================================

describe('AnthropicSkillsLoader', () => {
  let projectRoot: string;
  let loader: AnthropicSkillsLoader;

  beforeEach(() => {
    loader = new AnthropicSkillsLoader();
  });

  afterEach(async () => {
    if (projectRoot) {
      await rmrf(projectRoot);
      projectRoot = '' as string;
    }
  });

  // ------------------------------------------------------------
  // 1. 扫描单个 SKILL.md
  // ------------------------------------------------------------
  it('扫描 anthropic_skills/ 下单个 SKILL.md 应正确加载', async () => {
    projectRoot = await makeTempProjectRoot();
    await writeSkillMd(
      projectRoot,
      'unit-test',
      {
        name: 'unit-test',
        description: '生成单元测试',
        version: '1.0.0',
        author: 'anthropic',
        tags: ['test'],
      },
      '## 用途\n生成单元测试',
    );

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const skill = result.loaded[0]!;
    expect(skill.name).toBe('unit-test');
    expect(skill.description).toBe('生成单元测试');
    expect(skill.version).toBe('1.0.0');
    expect(skill.author).toBe('anthropic');
    expect(skill.tags).toEqual(['test']);
    expect(skill.content).toContain('生成单元测试');
    expect(skill.origin).toBe('anthropic-skills');
    expect(skill.autoEnable).toBe(false);
    expect(skill.sourcePath).toContain('unit-test');
    expect(skill.sourcePath).toContain('SKILL.md');
  });

  // ------------------------------------------------------------
  // 2. 扫描多个子目录
  // ------------------------------------------------------------
  it('扫描多个子目录的 SKILL.md 应全部加载', async () => {
    projectRoot = await makeTempProjectRoot();
    await writeSkillMd(projectRoot, 'unit-test', {
      name: 'unit-test',
      description: '单元测试',
      version: '1.0.0',
      author: 'a',
      tags: [],
    }, 'body1');
    await writeSkillMd(projectRoot, 'syntax-check', {
      name: 'syntax-check',
      description: '语法检查',
      version: '1.0.0',
      author: 'b',
      tags: [],
    }, 'body2');
    await writeSkillMd(projectRoot, 'debug', {
      name: 'debug',
      description: '调试助手',
      version: '1.0.0',
      author: 'c',
      tags: [],
    }, 'body3');

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toHaveLength(3);
    expect(result.errors).toHaveLength(0);

    const names = result.loaded.map((s) => s.name).sort();
    expect(names).toEqual(['debug', 'syntax-check', 'unit-test']);
  });

  // ------------------------------------------------------------
  // 3. 目录不存在
  // ------------------------------------------------------------
  it('anthropic_skills/ 目录不存在时应返回空数组不报错', async () => {
    projectRoot = await makeTempProjectRoot();
    // 不创建 anthropic_skills 目录

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('scan 在目录不存在时也应返回空数组', async () => {
    projectRoot = await makeTempProjectRoot();
    const loaded = await loader.scan(projectRoot);
    expect(loaded).toEqual([]);
  });

  // ------------------------------------------------------------
  // 4. 无效 SKILL.md 不影响其他
  // ------------------------------------------------------------
  it('无效的 SKILL.md（空内容）应记入 errors 不影响其他 Skill 加载', async () => {
    projectRoot = await makeTempProjectRoot();
    // 写一个合法的
    await writeSkillMd(projectRoot, 'good', {
      name: 'good',
      description: 'good',
      version: '1.0.0',
      author: 'a',
      tags: [],
    }, 'body');

    // 写一个空的 SKILL.md
    const badDir = path.join(projectRoot, 'anthropic_skills', 'bad');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'SKILL.md'), '', 'utf-8');

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.name).toBe('good');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toContain('bad');
    expect(result.errors[0]!.error).toContain('空');
  });

  // ------------------------------------------------------------
  // 5. autoEnable 标志传递
  // ------------------------------------------------------------
  it('autoEnable=true 时加载的 Skill 应标注 autoEnable=true', async () => {
    projectRoot = await makeTempProjectRoot();
    await writeSkillMd(projectRoot, 'unit-test', {
      name: 'unit-test',
      description: 'test',
      version: '1.0.0',
      author: 'a',
      tags: [],
    }, 'body');

    const result = await loader.load(projectRoot, { autoEnable: true });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.autoEnable).toBe(true);
  });

  it('autoEnable=false 时加载的 Skill 应标注 autoEnable=false', async () => {
    projectRoot = await makeTempProjectRoot();
    await writeSkillMd(projectRoot, 'unit-test', {
      name: 'unit-test',
      description: 'test',
      version: '1.0.0',
      author: 'a',
      tags: [],
    }, 'body');

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.autoEnable).toBe(false);
  });

  // ------------------------------------------------------------
  // 6. scan 与 load 行为差异
  // ------------------------------------------------------------
  it('scan 返回的 Skill autoEnable 默认为 false（未注入配置）', async () => {
    projectRoot = await makeTempProjectRoot();
    await writeSkillMd(projectRoot, 'unit-test', {
      name: 'unit-test',
      description: 'test',
      version: '1.0.0',
      author: 'a',
      tags: [],
    }, 'body');

    const loaded = await loader.scan(projectRoot);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.autoEnable).toBe(false); // scan 默认 false
    expect(loaded[0]!.origin).toBe('anthropic-skills');
  });

  // ------------------------------------------------------------
  // 7. frontmatter 缺失 name 时回退为目录名
  // ------------------------------------------------------------
  it('frontmatter 缺失 name 时应回退使用父目录名', async () => {
    projectRoot = await makeTempProjectRoot();
    // 故意写一个没有 frontmatter 的纯 Markdown
    const dir = path.join(projectRoot, 'anthropic_skills', 'my-dir-skill');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '## 正文\n没有 frontmatter 的 Skill',
      'utf-8',
    );

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.name).toBe('my-dir-skill');
  });

  // ------------------------------------------------------------
  // 8. 嵌套子目录扫描
  // ------------------------------------------------------------
  it('支持嵌套子目录扫描（anthropic_skills/category/sub/SKILL.md）', async () => {
    projectRoot = await makeTempProjectRoot();
    // 在嵌套目录下放 SKILL.md
    const nestedDir = path.join(
      projectRoot,
      'anthropic_skills',
      'category',
      'sub-skill',
    );
    await fs.mkdir(nestedDir, { recursive: true });
    const content = SkillMdParser.serialize(
      {
        name: 'nested-skill',
        description: 'nested',
        version: '1.0.0',
        author: 'a',
        tags: [],
      },
      'nested body',
    );
    await fs.writeFile(path.join(nestedDir, 'SKILL.md'), content, 'utf-8');

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.name).toBe('nested-skill');
    expect(result.loaded[0]!.sourcePath).toContain('category');
    expect(result.loaded[0]!.sourcePath).toContain('sub-skill');
  });

  // ------------------------------------------------------------
  // 9. 静态常量可访问
  // ------------------------------------------------------------
  it('暴露 SKILLS_DIR_NAME 与 SKILL_FILE_NAME 常量', () => {
    expect(AnthropicSkillsLoader.SKILLS_DIR_NAME).toBe('anthropic_skills');
    expect(AnthropicSkillsLoader.SKILL_FILE_NAME).toBe('SKILL.md');
  });

  // ------------------------------------------------------------
  // 10. fixture 复制：从项目 fixture 加载
  // ------------------------------------------------------------
  it('能加载项目内置 fixture（anthropic_skills/unit-test/SKILL.md）', async () => {
    projectRoot = await makeTempProjectRoot();
    // 复制 fixture 到临时目录
    const fixtureRoot = path.resolve(__dirname, 'fixtures');
    const srcSkillFile = path.join(fixtureRoot, 'anthropic_skills', 'unit-test', 'SKILL.md');
    expect(fsSync.existsSync(srcSkillFile)).toBe(true);

    const destDir = path.join(projectRoot, 'anthropic_skills', 'unit-test');
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(srcSkillFile, path.join(destDir, 'SKILL.md'));

    const result = await loader.load(projectRoot, { autoEnable: false });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.name).toBe('unit-test');
    expect(result.loaded[0]!.description).toContain('单元测试');
    expect(result.loaded[0]!.tags).toEqual(['test', 'quality']);
    expect(result.loaded[0]!.content).toContain('生成单元测试');
  });
});

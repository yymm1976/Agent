// tests/macros/manager.test.ts
// Phase 48 Task 5 测试：MacroManager
//
// 覆盖（≥8 个测试）：
//   1. 内置 Macro 可正确加载（4 个内置宏都存在）
//   2. Macro 文件正确解析 YAML frontmatter
//   3. `!` 触发的 searchMacros 按 keywords/description/name 匹配
//   4. 用户通过 createMacro 创建新宏并保存到文件
//   5. Macro 目录不存在时自动创建
//   6. 无效的 Macro 文件给出错误提示（如缺少 name 字段）
//   7. extractSystemPrompt 提取正文内容
//   8. preferredProfile 字段正确解析
//   9. deleteMacro 删除后 listMacros 不再包含
//   10. 多个 Macro 按 name 去重

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MacroManager } from '../../src/macros/manager.js';
import { BUILTIN_MACROS } from '../../src/macros/builtin.js';
import type { MacroConfig, MacroMetadata } from '../../src/macros/types.js';

// ============================================================
// 工具函数
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-macro-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function defaultConfig(): MacroConfig {
  return {
    enabled: true,
    dir: '.routedev/macros',
  };
}

/** 构造一份合法的 MACRO.md 文件内容 */
function makeMacroMd(opts: {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  keywords?: string[];
  category?: string;
  preferredProfile?: string;
  body?: string;
}): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${opts.name}`);
  lines.push(`type: macro`);
  lines.push(`version: ${opts.version ?? '1.0.0'}`);
  lines.push(`description: ${opts.description ?? '测试 Macro'}`);
  if (opts.author !== undefined) lines.push(`author: ${opts.author}`);
  if (opts.keywords !== undefined && opts.keywords.length > 0) {
    lines.push(`keywords:`);
    for (const k of opts.keywords) lines.push(`  - ${k}`);
  } else {
    lines.push(`keywords: []`);
  }
  if (opts.category !== undefined) lines.push(`category: ${opts.category}`);
  if (opts.preferredProfile !== undefined) lines.push(`preferredProfile: ${opts.preferredProfile}`);
  lines.push('---');
  lines.push('');
  lines.push(opts.body ?? '## 工作流程\n1. 步骤一\n2. 步骤二');
  return lines.join('\n');
}

/** 在临时目录下手工写入一个 MACRO.md */
async function writeMacroFile(
  macrosDir: string,
  name: string,
  content: string,
): Promise<string> {
  const macroDir = path.join(macrosDir, name);
  await fs.mkdir(macroDir, { recursive: true });
  const macroPath = path.join(macroDir, 'MACRO.md');
  await fs.writeFile(macroPath, content, 'utf-8');
  return macroPath;
}

// ============================================================
// 测试
// ============================================================

describe('MacroManager', () => {
  let rootDir: string;
  let manager: MacroManager;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    manager = new MacroManager(defaultConfig(), rootDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(rootDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  // ----------------------------------------------------------
  // 1. 内置 Macro 可正确加载（4 个内置宏都存在）
  // ----------------------------------------------------------
  describe('内置 Macro 加载', () => {
    it('loadAll 后应包含 4 个内置 Macro（macro-creator/daily-standup/code-review/commit-message）', async () => {
      const macros = await manager.loadAll();
      const builtinNames = macros
        .filter((m) => m.source === 'builtin')
        .map((m) => m.metadata.name);

      expect(builtinNames).toContain('macro-creator');
      expect(builtinNames).toContain('daily-standup');
      expect(builtinNames).toContain('code-review');
      expect(builtinNames).toContain('commit-message');
      expect(builtinNames.length).toBe(4);
    });

    it('BUILTIN_MACROS 导出的内置宏数量为 4', () => {
      expect(BUILTIN_MACROS.length).toBe(4);
      const names = BUILTIN_MACROS.map((m) => m.metadata.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'macro-creator',
          'daily-standup',
          'code-review',
          'commit-message',
        ]),
      );
    });

    it('内置 Macro 的 type 字段均为 macro', async () => {
      const macros = await manager.loadAll();
      for (const m of macros) {
        expect(m.metadata.type).toBe('macro');
      }
    });
  });

  // ----------------------------------------------------------
  // 2. Macro 文件正确解析 YAML frontmatter
  // ----------------------------------------------------------
  describe('YAML frontmatter 解析', () => {
    it('应正确解析 MACRO.md 的 frontmatter 与正文', async () => {
      const content = makeMacroMd({
        name: 'review-pr',
        description: '审查 PR 的标准流程',
        version: '1.2.0',
        author: 'tester',
        keywords: ['review', 'pr', 'code'],
        category: 'code-quality',
        body: '## 适用场景\n审查 PR 时使用',
      });

      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      await writeMacroFile(macrosDir, 'review-pr', content);

      const macros = await manager.loadAll();
      const macro = macros.find((m) => m.metadata.name === 'review-pr');

      expect(macro).toBeDefined();
      expect(macro!.metadata.name).toBe('review-pr');
      expect(macro!.metadata.type).toBe('macro');
      expect(macro!.metadata.version).toBe('1.2.0');
      expect(macro!.metadata.author).toBe('tester');
      expect(macro!.metadata.description).toBe('审查 PR 的标准流程');
      expect(macro!.metadata.keywords).toEqual(['review', 'pr', 'code']);
      expect(macro!.metadata.category).toBe('code-quality');
      expect(macro!.content).toContain('## 适用场景');
      expect(macro!.content).toContain('审查 PR 时使用');
      expect(macro!.filePath).toBe(path.join(macrosDir, 'review-pr', 'MACRO.md'));
      expect(macro!.source).toBe('user');
    });

    it('无 frontmatter 的 MACRO.md 应被跳过（不抛错）', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      // 纯 Markdown，没有 frontmatter
      await writeMacroFile(macrosDir, 'plain', '## 正文\n没有 frontmatter');

      const macros = await manager.loadAll();
      // 该宏不应出现在列表中（解析失败被跳过）
      expect(macros.find((m) => m.metadata.name === 'plain')).toBeUndefined();
      // 但内置宏仍应存在
      expect(macros.find((m) => m.metadata.name === 'code-review')).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // 3. `!` 触发的 searchMacros 按 keywords/description/name 匹配
  // ----------------------------------------------------------
  describe('searchMacros 搜索', () => {
    it('按 name 前缀匹配（最高优先级）', async () => {
      await manager.loadAll();
      const results = manager.searchMacros('code');
      // code-review 以 code 开头
      const names = results.map((m) => m.metadata.name);
      expect(names).toContain('code-review');
      // 应排在最前
      expect(names[0]).toBe('code-review');
    });

    it('按 keywords 匹配（中文关键词）', async () => {
      await manager.loadAll();
      // commit-message 的 keywords 包含 '提交'
      const results = manager.searchMacros('提交');
      const names = results.map((m) => m.metadata.name);
      expect(names).toContain('commit-message');
    });

    it('按 description 包含匹配', async () => {
      await manager.loadAll();
      // code-review 的 description 包含 '代码审查'
      const results = manager.searchMacros('代码审查');
      const names = results.map((m) => m.metadata.name);
      expect(names).toContain('code-review');
    });

    it('空查询返回所有 Macro', async () => {
      await manager.loadAll();
      const all = manager.searchMacros('');
      // 至少 4 个内置
      expect(all.length).toBeGreaterThanOrEqual(4);
    });

    it('无匹配时返回空数组', async () => {
      await manager.loadAll();
      const results = manager.searchMacros('zzzz-nonexistent');
      expect(results).toEqual([]);
    });
  });

  // ----------------------------------------------------------
  // 4. 用户通过 createMacro 创建新宏并保存到文件
  // ----------------------------------------------------------
  describe('createMacro 创建宏', () => {
    it('应创建新宏并写入文件', async () => {
      await manager.loadAll();
      const metadata: MacroMetadata = {
        name: 'my-workflow',
        type: 'macro',
        version: '1.0.0',
        author: 'user',
        keywords: ['workflow', 'custom'],
        description: '我的自定义工作流',
        category: 'personal',
      };
      const content = '## 步骤\n1. 第一步\n2. 第二步';

      const macro = await manager.createMacro(metadata, content);

      expect(macro.metadata.name).toBe('my-workflow');
      expect(macro.content).toContain('第一步');
      expect(macro.filePath).toBe(
        path.join(rootDir, '.routedev', 'macros', 'my-workflow', 'MACRO.md'),
      );
      expect(macro.source).toBe('user');

      // 文件应存在
      expect(fsSync.existsSync(macro.filePath)).toBe(true);

      // listMacros 应包含
      const list = manager.listMacros();
      expect(list.find((m) => m.metadata.name === 'my-workflow')).toBeDefined();

      // 重新读取文件，验证内容可被正确解析
      const fileContent = await fs.readFile(macro.filePath, 'utf-8');
      expect(fileContent).toContain('name: my-workflow');
      expect(fileContent).toContain('description: 我的自定义工作流');
      expect(fileContent).toContain('## 步骤');
    });

    it('非法名称应抛出错误', async () => {
      await manager.loadAll();
      const metadata: MacroMetadata = {
        name: 'invalid name!',
        type: 'macro',
        version: '1.0.0',
        description: '非法名称',
      };
      await expect(manager.createMacro(metadata, 'content')).rejects.toThrow('Invalid macro name');
    });

    it('空内容应抛出错误', async () => {
      await manager.loadAll();
      const metadata: MacroMetadata = {
        name: 'empty-content',
        type: 'macro',
        version: '1.0.0',
        description: '空内容测试',
      };
      await expect(manager.createMacro(metadata, '')).rejects.toThrow('empty');
      await expect(manager.createMacro(metadata, '   ')).rejects.toThrow('empty');
    });

    it('缺少 description 应抛出错误', async () => {
      await manager.loadAll();
      const metadata = {
        name: 'no-desc',
        type: 'macro' as const,
        version: '1.0.0',
        description: '',
      };
      await expect(manager.createMacro(metadata, 'content')).rejects.toThrow('description');
    });
  });

  // ----------------------------------------------------------
  // 5. Macro 目录不存在时自动创建
  // ----------------------------------------------------------
  describe('目录自动创建', () => {
    it('loadAll 时若目录不存在应自动创建', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      // 确保目录不存在
      expect(fsSync.existsSync(macrosDir)).toBe(false);

      await manager.loadAll();

      // 目录应被自动创建
      expect(fsSync.existsSync(macrosDir)).toBe(true);
    });

    it('createMacro 时若目录不存在应自动创建', async () => {
      // 直接 new 一个未调用 loadAll 的 manager
      const freshManager = new MacroManager(defaultConfig(), rootDir);
      const metadata: MacroMetadata = {
        name: 'auto-create-dir',
        type: 'macro',
        version: '1.0.0',
        description: '测试目录自动创建',
      };

      const macro = await freshManager.createMacro(metadata, '内容');

      const expectedDir = path.join(rootDir, '.routedev', 'macros', 'auto-create-dir');
      expect(fsSync.existsSync(expectedDir)).toBe(true);
      expect(fsSync.existsSync(macro.filePath)).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 6. 无效的 Macro 文件给出错误提示（如缺少 name 字段）
  // ----------------------------------------------------------
  describe('无效 Macro 文件处理', () => {
    it('缺少 name 字段的 MACRO.md 应被跳过', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      const brokenContent = `---
type: macro
version: 1.0.0
description: 缺少 name
---
## 正文`;
      await writeMacroFile(macrosDir, 'no-name', brokenContent);

      const macros = await manager.loadAll();
      // 缺 name 的宏不应出现
      expect(macros.find((m) => m.metadata.name === 'no-name')).toBeUndefined();
      // 内置宏仍存在
      expect(macros.find((m) => m.metadata.name === 'code-review')).toBeDefined();
    });

    it('缺少 description 字段的 MACRO.md 应被跳过', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      const brokenContent = `---
name: no-desc
type: macro
version: 1.0.0
---
## 正文`;
      await writeMacroFile(macrosDir, 'no-desc', brokenContent);

      const macros = await manager.loadAll();
      expect(macros.find((m) => m.metadata.name === 'no-desc')).toBeUndefined();
    });

    it('type 不为 macro 的文件应被跳过', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      const wrongType = `---
name: wrong-type
type: skill
version: 1.0.0
description: 错误的 type
---
## 正文`;
      await writeMacroFile(macrosDir, 'wrong-type', wrongType);

      const macros = await manager.loadAll();
      expect(macros.find((m) => m.metadata.name === 'wrong-type')).toBeUndefined();
    });

    it('YAML 语法错误的文件应被跳过（不抛错）', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      const badYaml = `---
name: [unclosed
type: macro
---
## 正文`;
      await writeMacroFile(macrosDir, 'bad-yaml', badYaml);

      // loadAll 不应抛错
      const macros = await manager.loadAll();
      expect(macros.find((m) => m.metadata.name === 'bad-yaml')).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // 7. extractSystemPrompt 提取正文内容
  // ----------------------------------------------------------
  describe('extractSystemPrompt', () => {
    it('应提取 Macro 正文作为 system prompt', async () => {
      await manager.loadAll();
      const macro = manager.getMacro('code-review');
      expect(macro).toBeDefined();

      const prompt = manager.extractSystemPrompt(macro!);
      // 应包含正文标题
      expect(prompt).toContain('## 适用场景');
      expect(prompt).toContain('工作流程');
      // 不应包含 frontmatter
      expect(prompt).not.toContain('---');
      expect(prompt).not.toContain('name: code-review');
    });

    it('内置 macro-creator 的 system prompt 包含创建宏的流程', async () => {
      await manager.loadAll();
      const macro = manager.getMacro('macro-creator');
      const prompt = manager.extractSystemPrompt(macro!);
      expect(prompt).toContain('工作流程');
      expect(prompt).toContain('kebab-case');
    });

    it('空正文的 Macro 返回空字符串', () => {
      const emptyMacro = {
        metadata: {
          name: 'empty',
          type: 'macro' as const,
          version: '1.0.0',
          description: '空',
        },
        content: '',
        filePath: '',
        source: 'builtin' as const,
      };
      expect(manager.extractSystemPrompt(emptyMacro)).toBe('');
    });
  });

  // ----------------------------------------------------------
  // 8. preferredProfile 字段正确解析
  // ----------------------------------------------------------
  describe('preferredProfile 字段', () => {
    it('应正确解析 MACRO.md 中的 preferredProfile', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      const content = makeMacroMd({
        name: 'profile-bound',
        description: '绑定 Profile 的宏',
        preferredProfile: 'researcher',
        body: '## 正文',
      });
      await writeMacroFile(macrosDir, 'profile-bound', content);

      const macros = await manager.loadAll();
      const macro = macros.find((m) => m.metadata.name === 'profile-bound');
      expect(macro).toBeDefined();
      expect(macro!.metadata.preferredProfile).toBe('researcher');
    });

    it('未指定 preferredProfile 时应为 undefined', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      const content = makeMacroMd({
        name: 'no-profile',
        description: '未绑定 Profile',
        body: '## 正文',
      });
      await writeMacroFile(macrosDir, 'no-profile', content);

      const macros = await manager.loadAll();
      const macro = macros.find((m) => m.metadata.name === 'no-profile');
      expect(macro).toBeDefined();
      expect(macro!.metadata.preferredProfile).toBeUndefined();
    });

    it('createMacro 创建的宏应保留 preferredProfile', async () => {
      await manager.loadAll();
      const metadata: MacroMetadata = {
        name: 'with-profile',
        type: 'macro',
        version: '1.0.0',
        description: '带 Profile',
        preferredProfile: 'reviewer',
      };
      const macro = await manager.createMacro(metadata, '正文');
      expect(macro.metadata.preferredProfile).toBe('reviewer');

      // 重新加载后仍应保留
      const reloaded = await manager.loadAll();
      const found = reloaded.find((m) => m.metadata.name === 'with-profile');
      expect(found).toBeDefined();
      expect(found!.metadata.preferredProfile).toBe('reviewer');
    });
  });

  // ----------------------------------------------------------
  // 9. deleteMacro 删除后 listMacros 不再包含
  // ----------------------------------------------------------
  describe('deleteMacro', () => {
    it('删除用户创建的宏后 listMacros 不再包含', async () => {
      await manager.loadAll();
      const metadata: MacroMetadata = {
        name: 'to-delete',
        type: 'macro',
        version: '1.0.0',
        description: '待删除',
      };
      const macro = await manager.createMacro(metadata, '内容');
      expect(fsSync.existsSync(macro.filePath)).toBe(true);

      await manager.deleteMacro('to-delete');

      // listMacros 不再包含
      const list = manager.listMacros();
      expect(list.find((m) => m.metadata.name === 'to-delete')).toBeUndefined();

      // 文件应被删除
      expect(fsSync.existsSync(macro.filePath)).toBe(false);
    });

    it('删除不存在的宏应抛出错误', async () => {
      await manager.loadAll();
      await expect(manager.deleteMacro('non-existent')).rejects.toThrow('not found');
    });

    it('删除内置宏应抛出错误', async () => {
      await manager.loadAll();
      await expect(manager.deleteMacro('code-review')).rejects.toThrow('builtin');
      // 内置宏仍应存在
      expect(manager.getMacro('code-review')).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // 10. 多个 Macro 按 name 去重
  // ----------------------------------------------------------
  describe('name 去重', () => {
    it('用户同名宏应覆盖内置宏', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      // 创建与内置宏同名的用户宏
      const userContent = makeMacroMd({
        name: 'code-review',
        description: '用户自定义的代码审查',
        version: '2.0.0',
        author: 'user',
        body: '## 用户自定义流程',
      });
      await writeMacroFile(macrosDir, 'code-review', userContent);

      const macros = await manager.loadAll();
      const macro = macros.find((m) => m.metadata.name === 'code-review');

      expect(macro).toBeDefined();
      // 应为用户版本（覆盖内置）
      expect(macro!.metadata.version).toBe('2.0.0');
      expect(macro!.metadata.description).toBe('用户自定义的代码审查');
      expect(macro!.source).toBe('user');
      expect(macro!.content).toContain('用户自定义流程');
    });

    it('同名宏只出现一次（listMacros 不重复）', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      // 创建与内置宏同名的用户宏
      await writeMacroFile(
        macrosDir,
        'commit-message',
        makeMacroMd({
          name: 'commit-message',
          description: '用户版 commit-message',
          version: '1.5.0',
        }),
      );

      const macros = await manager.loadAll();
      const sameName = macros.filter((m) => m.metadata.name === 'commit-message');
      expect(sameName.length).toBe(1);
    });

    it('不同名称的多个用户宏应共存', async () => {
      const macrosDir = path.join(rootDir, '.routedev', 'macros');
      await writeMacroFile(
        macrosDir,
        'macro-a',
        makeMacroMd({ name: 'macro-a', description: 'A 宏' }),
      );
      await writeMacroFile(
        macrosDir,
        'macro-b',
        makeMacroMd({ name: 'macro-b', description: 'B 宏' }),
      );

      const macros = await manager.loadAll();
      expect(macros.find((m) => m.metadata.name === 'macro-a')).toBeDefined();
      expect(macros.find((m) => m.metadata.name === 'macro-b')).toBeDefined();
      // 4 内置 + 2 用户
      expect(macros.length).toBe(6);
    });
  });
});

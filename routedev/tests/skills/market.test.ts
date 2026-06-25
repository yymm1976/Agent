// tests/skills/market.test.ts
// Skill 市场管理 + SKILL.md 解析测试
//
// 覆盖：
//   1. SkillMdParser.parse：解析 frontmatter + Markdown
//   2. SkillMdParser.parse：frontmatter 格式错误回退纯 Markdown
//   3. SkillMdParser.serialize：序列化为 SKILL.md
//   4. SkillMdParser.parseJson：解析旧 JSON 格式
//   5. SkillMarketManager.publish：发布草稿到市场
//   6. SkillMarketManager.listPublished：列出已发布项
//   7. SkillMarketManager.install/uninstall：安装卸载
//   8. SkillMarketManager.export/import：导出导入

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillMdParser, type SkillMetadata } from '../../src/skills/skill-md-parser.js';
import { SkillMarketManager } from '../../src/skills/market-manager.js';

// ============================================================
// 工具函数
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-market-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeSkillMd(opts: {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  body?: string;
}): string {
  const meta: SkillMetadata = {
    name: opts.name ?? 'test-skill',
    description: opts.description ?? '测试 Skill',
    version: opts.version ?? '1.0.0',
    author: opts.author ?? 'tester',
    tags: opts.tags ?? ['test'],
  };
  return SkillMdParser.serialize(meta, opts.body ?? '## 规则\n- 测试规则');
}

// ============================================================
// SkillMdParser 测试
// ============================================================

describe('SkillMdParser', () => {
  describe('parse：解析 frontmatter + Markdown', () => {
    it('应正确解析标准 SKILL.md', () => {
      const content = makeSkillMd({
        name: 'my-skill',
        description: '我的 Skill',
        version: '2.1.0',
        author: 'alice',
        tags: ['api', 'design'],
        body: '## 步骤\n1. 定义 schema\n2. 写测试',
      });

      const parsed = SkillMdParser.parse(content);

      expect(parsed.format).toBe('skill-md');
      expect(parsed.metadata.name).toBe('my-skill');
      expect(parsed.metadata.description).toBe('我的 Skill');
      expect(parsed.metadata.version).toBe('2.1.0');
      expect(parsed.metadata.author).toBe('alice');
      expect(parsed.metadata.tags).toEqual(['api', 'design']);
      expect(parsed.content).toContain('## 步骤');
      expect(parsed.content).toContain('定义 schema');
    });

    it('frontmatter 格式错误时应回退为纯 Markdown', () => {
      // 故意构造无法解析的 frontmatter（YAML 语法错误）
      const broken = '---\nname: [unclosed\n---\n## 正文\n- 内容';
      const parsed = SkillMdParser.parse(broken);

      // 回退后正文应保留
      expect(parsed.content).toContain('正文');
      expect(parsed.metadata.name).toBe('unknown');
    });

    it('没有 frontmatter 时应回退为纯 Markdown', () => {
      const plain = '## 标题\n这是纯 Markdown';
      const parsed = SkillMdParser.parse(plain);

      expect(parsed.metadata.name).toBe('unknown');
      expect(parsed.metadata.version).toBe('0.0.0');
      expect(parsed.content).toContain('纯 Markdown');
    });

    it('空内容应返回默认元数据', () => {
      const parsed = SkillMdParser.parse('');
      expect(parsed.metadata.name).toBe('unknown');
      expect(parsed.content).toBe('');
    });
  });

  describe('serialize：序列化为 SKILL.md', () => {
    it('应正确序列化 metadata + content', () => {
      const meta: SkillMetadata = {
        name: 'serialize-test',
        description: '序列化测试',
        version: '1.2.3',
        author: 'bob',
        tags: ['a', 'b'],
      };
      const body = '## 内容\n- 项 1\n- 项 2';

      const serialized = SkillMdParser.serialize(meta, body);

      expect(serialized).toContain('name: serialize-test');
      expect(serialized).toContain('description: 序列化测试');
      expect(serialized).toContain('version: 1.2.3');
      expect(serialized).toContain('author: bob');
      expect(serialized).toContain('- a');
      expect(serialized).toContain('- b');
      expect(serialized).toContain('## 内容');

      // 反向解析验证 round-trip
      const reparsed = SkillMdParser.parse(serialized);
      expect(reparsed.metadata.name).toBe('serialize-test');
      expect(reparsed.metadata.version).toBe('1.2.3');
      expect(reparsed.metadata.tags).toEqual(['a', 'b']);
    });

    it('空 tags 应序列化为 []', () => {
      const meta: SkillMetadata = {
        name: 'no-tags',
        description: '无标签',
        version: '0.1.0',
        author: 'x',
        tags: [],
      };
      const serialized = SkillMdParser.serialize(meta, 'body');
      expect(serialized).toContain('tags: []');
    });
  });

  describe('parseJson：解析旧 JSON 格式', () => {
    it('应正确解析旧 JSON 格式', () => {
      const json = JSON.stringify({
        name: 'legacy-skill',
        description: '旧格式',
        version: '0.9.0',
        author: 'legacy',
        tags: ['old'],
        content: '## 旧规则\n- 规则 1',
      });

      const parsed = SkillMdParser.parseJson(json);

      expect(parsed.format).toBe('json');
      expect(parsed.metadata.name).toBe('legacy-skill');
      expect(parsed.metadata.version).toBe('0.9.0');
      expect(parsed.metadata.tags).toEqual(['old']);
      expect(parsed.content).toContain('旧规则');
    });

    it('JSON 缺少字段时应使用默认值', () => {
      const json = JSON.stringify({ name: 'partial' });
      const parsed = SkillMdParser.parseJson(json);

      expect(parsed.metadata.name).toBe('partial');
      expect(parsed.metadata.version).toBe('0.0.0');
      expect(parsed.metadata.author).toBe('anonymous');
      expect(parsed.metadata.tags).toEqual([]);
      expect(parsed.content).toBe('');
    });

    it('JSON 解析失败时应回退', () => {
      const parsed = SkillMdParser.parseJson('not a json');
      expect(parsed.metadata.name).toBe('unknown');
    });
  });
});

// ============================================================
// SkillMarketManager 测试
// ============================================================

describe('SkillMarketManager', () => {
  let rootDir: string;
  let manager: SkillMarketManager;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    manager = new SkillMarketManager(rootDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(rootDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  describe('publish：发布草稿到市场', () => {
    it('应将 Skill 发布到市场并返回 MarketItem', async () => {
      const content = makeSkillMd({
        name: 'publish-test',
        version: '1.0.0',
        body: '## 规则\n- 测试',
      });

      const item = await manager.publish('publish-test', content);

      expect(item.name).toBe('publish-test');
      expect(item.version).toBe('1.0.0');
      expect(item.status).toBe('published');
      expect(item.type).toBe('skill');
      expect(item.publishedAt).toBeGreaterThan(0);
      expect(item.metadata?.name).toBe('publish-test');

      // 草稿文件应存在
      const draftExists = fsSync.existsSync(item.draftPath);
      expect(draftExists).toBe(true);

      // 已发布文件应存在
      const publishedExists = fsSync.existsSync(item.publishedPath);
      expect(publishedExists).toBe(true);
    });

    it('非法名称应抛出错误', async () => {
      await expect(manager.publish('invalid name!', 'content')).rejects.toThrow('Invalid skill name');
      await expect(manager.publish('', 'content')).rejects.toThrow('Invalid skill name');
    });

    it('空内容应抛出错误', async () => {
      await expect(manager.publish('test', '')).rejects.toThrow('empty');
      await expect(manager.publish('test', '   ')).rejects.toThrow('empty');
    });
  });

  describe('listPublished：列出已发布项', () => {
    it('应列出所有已发布的 Skill', async () => {
      await manager.publish('skill-a', makeSkillMd({ name: 'skill-a', version: '1.0.0' }));
      await manager.publish('skill-b', makeSkillMd({ name: 'skill-b', version: '2.0.0' }));

      const items = manager.listPublished();

      expect(items.length).toBe(2);
      const names = items.map((i) => i.name).sort();
      expect(names).toEqual(['skill-a', 'skill-b']);
      const itemB = items.find((i) => i.name === 'skill-b');
      expect(itemB?.version).toBe('2.0.0');
      expect(itemB?.status).toBe('published');
    });

    it('空市场应返回空数组', () => {
      const items = manager.listPublished();
      expect(items).toEqual([]);
    });

    it('多版本发布后应记录所有版本', async () => {
      await manager.publish('multi', makeSkillMd({ name: 'multi', version: '1.0.0' }));
      await manager.publish('multi', makeSkillMd({ name: 'multi', version: '1.1.0' }));

      const versions = manager.getVersions('multi');
      expect(versions).toContain('1.0.0');
      expect(versions).toContain('1.1.0');

      const items = manager.listPublished();
      const item = items.find((i) => i.name === 'multi');
      expect(item?.version).toBe('1.1.0'); // currentVersion 应为最新
    });
  });

  describe('install/uninstall：安装卸载', () => {
    it('应将 Skill 安装到 .routedev/skills/ 并能卸载', async () => {
      const content = makeSkillMd({ name: 'install-test', version: '1.0.0' });
      await manager.publish('install-test', content);

      await manager.install('install-test');

      const installPath = path.join(rootDir, '.routedev', 'skills', 'install-test', 'SKILL.md');
      expect(fsSync.existsSync(installPath)).toBe(true);

      // 安装元数据应存在
      const installMetaPath = path.join(rootDir, '.routedev', 'skills', 'install-test', '.installed.json');
      expect(fsSync.existsSync(installMetaPath)).toBe(true);

      // 卸载
      await manager.uninstall('install-test');
      expect(fsSync.existsSync(installPath)).toBe(false);
    });

    it('安装指定版本应正确', async () => {
      await manager.publish('ver-test', makeSkillMd({ name: 'ver-test', version: '1.0.0' }));
      await manager.publish('ver-test', makeSkillMd({ name: 'ver-test', version: '2.0.0' }));

      await manager.install('ver-test', '1.0.0');

      const installPath = path.join(rootDir, '.routedev', 'skills', 'ver-test', 'SKILL.md');
      const installed = await fs.readFile(installPath, 'utf-8');
      expect(installed).toContain('1.0.0');
    });

    it('安装不存在的版本应抛出错误', async () => {
      await manager.publish('err-test', makeSkillMd({ name: 'err-test', version: '1.0.0' }));
      await expect(manager.install('err-test', '9.9.9')).rejects.toThrow('not found');
    });

    it('卸载未安装的 Skill 不应抛出错误', async () => {
      await expect(manager.uninstall('not-installed')).resolves.toBeUndefined();
    });
  });

  describe('export/import：导出导入', () => {
    it('应能导出 Skill 并重新导入', async () => {
      const content = makeSkillMd({ name: 'export-test', version: '1.0.0' });
      await manager.publish('export-test', content);

      const exportPath = path.join(rootDir, 'export.zip');
      await manager.export('export-test', exportPath);

      expect(fsSync.existsSync(exportPath)).toBe(true);

      // 在新目录导入
      const newRoot = await makeTempDir();
      try {
        const newManager = new SkillMarketManager(newRoot);
        const item = await newManager.import(exportPath);

        expect(item.name).toBe('export-test');
        expect(item.version).toBe('1.0.0');
        expect(item.status).toBe('published');

        // 验证导入后能列出
        const items = newManager.listPublished();
        expect(items.length).toBe(1);
        expect(items[0].name).toBe('export-test');

        // 验证能安装
        await newManager.install('export-test');
        const installPath = path.join(newRoot, '.routedev', 'skills', 'export-test', 'SKILL.md');
        expect(fsSync.existsSync(installPath)).toBe(true);
      } finally {
        await fs.rm(newRoot, { recursive: true, force: true });
      }
    });

    it('导出不存在的 Skill 应抛出错误', async () => {
      const exportPath = path.join(rootDir, 'export.zip');
      await expect(manager.export('not-exist', exportPath)).rejects.toThrow('not found');
    });

    it('导入非法文件应抛出错误', async () => {
      const badPath = path.join(rootDir, 'bad.zip');
      await fs.writeFile(badPath, 'not json', 'utf-8');
      await expect(manager.import(badPath)).rejects.toThrow();
    });
  });

  describe('rollback：回滚版本', () => {
    it('应能回滚到旧版本', async () => {
      await manager.publish('rb-test', makeSkillMd({ name: 'rb-test', version: '1.0.0' }));
      await manager.publish('rb-test', makeSkillMd({ name: 'rb-test', version: '2.0.0' }));

      // 当前应为 2.0.0
      const itemsBefore = manager.listPublished();
      expect(itemsBefore[0].version).toBe('2.0.0');

      // 回滚到 1.0.0
      await manager.rollback('rb-test', '1.0.0');

      const itemsAfter = manager.listPublished();
      expect(itemsAfter[0].version).toBe('1.0.0');
    });

    it('回滚不存在的版本应抛出错误', async () => {
      await manager.publish('rb-err', makeSkillMd({ name: 'rb-err', version: '1.0.0' }));
      await expect(manager.rollback('rb-err', '9.9.9')).rejects.toThrow('not found');
    });
  });

  describe('listDrafts：列出草稿', () => {
    it('应列出已发布的草稿', async () => {
      await manager.publish('draft-1', makeSkillMd({ name: 'draft-1', version: '1.0.0' }));

      const drafts = manager.listDrafts();
      expect(drafts.length).toBe(1);
      expect(drafts[0].name).toBe('draft-1');
      expect(drafts[0].status).toBe('draft');
      expect(drafts[0].metadata?.version).toBe('1.0.0');
    });
  });
});

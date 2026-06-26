// tests/skills/progressive-disclosure.test.ts
// Skill 渐进式披露单元测试（Phase 49 Task 4.4）
//
// 覆盖（蓝图 4.6）：
//   1. 只注入核心原则和适用范围（不包含任务路由、模块索引等）
//   2. 按需加载 references 文件（陷阱 #150）
//   3. 未配置 readReference 时 loadReference 返回空字符串
//   4. reference 不存在时返回空字符串
//   5. splitSections 正确切分 ## 章节
//   6. frontmatter 摘要包含 name 和 description

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ProgressiveDisclosure,
  type ReferenceReaderInterface,
} from '../../src/skills/progressive-disclosure.js';
import { SkillMdParser } from '../../src/skills/skill-md-parser.js';
import type { ParsedSkill } from '../../src/skills/skill-md-parser.js';

// ============================================================
// 工具函数
// ============================================================

/** 构造一个包含多章节的 Skill body */
function makeSkillBody(): string {
  return [
    '## 核心原则',
    '- 原则1：始终先理解需求',
    '- 原则2：分步执行',
    '',
    '## 适用范围',
    '- 适用于代码生成场景',
    '- 不适用于纯文档撰写',
    '',
    '## 任务路由',
    '- 简单任务：直接执行',
    '- 复杂任务：拆分后执行',
    '',
    '## 模块索引',
    '- module-a：功能A',
    '- module-b：功能B',
    '',
    '## 执行流程',
    '1. 分析需求',
    '2. 生成代码',
    '3. 验证结果',
  ].join('\n');
}

/** 构造 ParsedSkill */
function makeSkill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    metadata: {
      name: 'test-skill',
      description: '测试用 Skill',
      version: '1.0.0',
      author: 'tester',
      tags: ['test', 'demo'],
    },
    content: makeSkillBody(),
    format: 'skill-md',
    ...overrides,
  };
}

/** 构造 mock referenceReader */
function makeReferenceReader(map: Record<string, string>): ReferenceReaderInterface & {
  calls: Array<{ skillName: string; referenceName: string }>;
} {
  const calls: Array<{ skillName: string; referenceName: string }> = [];
  return {
    calls,
    readReference: vi.fn(async (skillName: string, referenceName: string) => {
      calls.push({ skillName, referenceName });
      const key = `${skillName}/${referenceName}`;
      return map[key] ?? null;
    }),
  };
}

// ============================================================
// 测试
// ============================================================

describe('ProgressiveDisclosure（Phase 49 Task 4.4）', () => {
  let disclosure: ProgressiveDisclosure;

  beforeEach(() => {
    disclosure = new ProgressiveDisclosure();
  });

  // ------------------------------------------------------------
  // 1. 只注入核心原则和适用范围
  // ------------------------------------------------------------

  describe('getMinimalInjection 最小注入集', () => {
    it('包含 frontmatter 摘要（name + description）', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).toContain('test-skill');
      expect(minimal).toContain('测试用 Skill');
    });

    it('包含"核心原则"章节内容', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).toContain('核心原则');
      expect(minimal).toContain('原则1：始终先理解需求');
      expect(minimal).toContain('原则2：分步执行');
    });

    it('包含"适用范围"章节内容', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).toContain('适用范围');
      expect(minimal).toContain('适用于代码生成场景');
      expect(minimal).toContain('不适用于纯文档撰写');
    });

    it('不包含"任务路由"章节（按需加载）', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).not.toContain('任务路由');
      expect(minimal).not.toContain('简单任务：直接执行');
    });

    it('不包含"模块索引"章节（按需加载）', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).not.toContain('模块索引');
      expect(minimal).not.toContain('module-a');
    });

    it('不包含"执行流程"章节（按需加载）', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).not.toContain('执行流程');
      expect(minimal).not.toContain('分析需求');
    });

    it('包含按需加载的提示（陷阱 #150）', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);

      // 应提示可通过 loadReference 加载更多
      expect(minimal).toContain('loadReference');
    });
  });

  // ------------------------------------------------------------
  // 2. 按需加载 references（陷阱 #150）
  // ------------------------------------------------------------

  describe('loadReference 按需加载（陷阱 #150）', () => {
    it('配置 readReference 时返回 reference 内容', async () => {
      const reader = makeReferenceReader({
        'test-skill/examples': '这是 examples reference 的内容',
      });
      const disclosureWithReader = new ProgressiveDisclosure({ readReference: reader });
      const skill = makeSkill();

      const content = await disclosureWithReader.loadReference(skill, 'examples');

      expect(content).toBe('这是 examples reference 的内容');
      expect(reader.calls).toHaveLength(1);
      expect(reader.calls[0]).toEqual({
        skillName: 'test-skill',
        referenceName: 'examples',
      });
    });

    it('reference 不存在时返回空字符串', async () => {
      const reader = makeReferenceReader({}); // 空 map，所有 reference 都不存在
      const disclosureWithReader = new ProgressiveDisclosure({ readReference: reader });
      const skill = makeSkill();

      const content = await disclosureWithReader.loadReference(skill, 'nonexistent');

      expect(content).toBe('');
    });
  });

  // ------------------------------------------------------------
  // 3. 未配置 readReference 时返回空字符串
  // ------------------------------------------------------------

  describe('未配置 readReference', () => {
    it('未配置 readReference 时 loadReference 返回空字符串', async () => {
      const skill = makeSkill();
      const content = await disclosure.loadReference(skill, 'examples');
      expect(content).toBe('');
    });
  });

  // ------------------------------------------------------------
  // 4. splitSections 正确切分（通过 getMinimalInjection 间接验证）
  // ------------------------------------------------------------

  describe('splitSections 章节切分', () => {
    it('只识别 ## 二级标题，不识别 ### 三级标题', () => {
      const skill = makeSkill({
        content: [
          '## 核心原则',
          '原则1',
          '### 子原则',
          '子原则详情',
          '',
          '## 适用范围',
          '范围1',
        ].join('\n'),
      });
      const minimal = disclosure.getMinimalInjection(skill);

      // "核心原则"章节应包含 ### 子原则 的内容（### 归入当前章节）
      expect(minimal).toContain('子原则详情');
      // "适用范围"章节应包含范围1
      expect(minimal).toContain('范围1');
    });

    it('缺少"核心原则"章节时仍注入"适用范围"', () => {
      const skill = makeSkill({
        content: ['## 适用范围', '只有适用范围'].join('\n'),
      });
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).toContain('适用范围');
      expect(minimal).toContain('只有适用范围');
    });

    it('缺少所有核心章节时仍返回 frontmatter + 提示', () => {
      const skill = makeSkill({
        content: ['## 其他章节', '其他内容'].join('\n'),
      });
      const minimal = disclosure.getMinimalInjection(skill);

      // frontmatter 仍然存在
      expect(minimal).toContain('test-skill');
      // 提示仍然存在
      expect(minimal).toContain('loadReference');
      // 其他章节不注入
      expect(minimal).not.toContain('其他内容');
    });
  });

  // ------------------------------------------------------------
  // 5. frontmatter 摘要
  // ------------------------------------------------------------

  describe('frontmatter 摘要', () => {
    it('包含版本号（非 0.0.0 时）', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);
      expect(minimal).toContain('1.0.0');
    });

    it('包含标签', () => {
      const skill = makeSkill();
      const minimal = disclosure.getMinimalInjection(skill);
      expect(minimal).toContain('test');
      expect(minimal).toContain('demo');
    });

    it('通过 SkillMdParser 解析的 Skill 也能正确注入', () => {
      const md = SkillMdParser.serialize(
        {
          name: 'parsed-skill',
          description: '通过 parser 解析',
          version: '2.0.0',
          author: 'parser',
          tags: ['parsed'],
        },
        makeSkillBody(),
      );
      const skill = SkillMdParser.parse(md);
      const minimal = disclosure.getMinimalInjection(skill);

      expect(minimal).toContain('parsed-skill');
      expect(minimal).toContain('通过 parser 解析');
      expect(minimal).toContain('核心原则');
    });
  });
});

// tests/phase36/minimalist-skill.test.ts
// Phase 36 Task 3 + Task 5：极简编码 Skill + /tech-debt 命令测试
// 验证：Skill 路由匹配、Skill 内容完整性、tech-debt CRUD、别名、边界条件

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillsRouter, type SkillDefinition } from '../../src/plugins/filesystem-discovery.js';
import { techDebtCommand } from '../../src/cli/commands/tech-debt.js';
import type { ServiceContext } from '../../src/cli/service-context.js';

// ============================================================
// 路径常量
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MINIMALIST_SKILL_PATH = path.join(
  PROJECT_ROOT,
  '.routedev',
  'skills',
  'minimalist-coding',
  'SKILL.md',
);

// ============================================================
// 测试辅助
// ============================================================

/** 构造 mock ServiceContext（仅包含 tech-debt 命令需要的 cwd） */
function buildMockCtx(cwd: string): ServiceContext {
  return { cwd } as unknown as ServiceContext;
}

/** 构造 minimalist-coding SkillDefinition（从实际文件读取的内容） */
function makeMinimalistSkill(content: string): SkillDefinition {
  return {
    name: 'minimalist-coding',
    description:
      '新建功能、添加依赖、安装、实现、编码、写代码、create、implement、add dependency、refactor、重构、新建、添加、实现功能、overengineer、过度工程、surgical、最小改动',
    routingKeywords: [
      '新建功能', '添加依赖', '安装', '实现', '编码', '写代码',
      'create', 'implement', 'add dependency', 'refactor', '重构',
      '新建', '添加', '实现功能', 'overengineer', '过度工程', 'surgical', '最小改动',
    ],
    content,
    sourcePath: MINIMALIST_SKILL_PATH,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 36 Task 3：极简编码 Skill + /tech-debt 命令', () => {
  describe('minimalist-coding Skill 路由匹配', () => {
    it('Skill 文件应存在且包含 Ponytail 6 层 + Karpathy 4 原则', async () => {
      const content = await fs.readFile(MINIMALIST_SKILL_PATH, 'utf-8');
      // YAML frontmatter
      expect(content.startsWith('---')).toBe(true);
      expect(content).toContain('description:');
      expect(content).toContain('keywords:');
      // Part 1：Ponytail 6 层
      expect(content).toContain('Part 1');
      expect(content).toContain('层级 1');
      expect(content).toContain('层级 6');
      // Part 2：Karpathy 4 原则
      expect(content).toContain('Part 2');
      expect(content).toContain('编码前先思考');
      expect(content).toContain('简单优先');
      expect(content).toContain('手术式修改');
      expect(content).toContain('目标驱动执行');
      // 红线规则
      expect(content).toContain('红线');
      // /tech-debt 引用
      expect(content).toContain('/tech-debt');
    });

    it('SkillsRouter 应能根据编码任务描述路由到 minimalist-coding', () => {
      const router = new SkillsRouter();
      router.register(makeMinimalistSkill('skill body'));

      // 多种触发场景
      const scenarios = [
        '实现一个新的用户认证功能',
        '重构 filterContext 方法',
        '添加 axios 依赖来实现 HTTP 请求',
        '写代码创建一个新的工具函数',
      ];
      for (const desc of scenarios) {
        const matched = router.route(desc, 3);
        expect(matched.length).toBeGreaterThanOrEqual(1);
        expect(matched[0].name).toBe('minimalist-coding');
      }
    });

    it('SkillsRouter 不应匹配无关任务描述', () => {
      const router = new SkillsRouter();
      router.register(makeMinimalistSkill(''));

      const matched = router.route('查看今天的天气预报', 3);
      expect(matched.length).toBe(0);
    });
  });

  describe('/tech-debt 命令 CRUD', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-techdebt-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('add 子命令应记录技术债并返回 ID', async () => {
      const ctx = buildMockCtx(tmpDir);
      const result = await techDebtCommand.handler('add 临时硬编码了 API 路径，后续应改为配置', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('#1');
      expect(result.messages![0]).toContain('已记录');

      // 验证文件已写入
      const filePath = path.join(tmpDir, '.routedev', 'tech-debt.json');
      const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].id).toBe('1');
      expect(data.entries[0].description).toContain('API 路径');
      expect(data.entries[0].addedAt).toBeGreaterThan(0);
      expect(data.entries[0].resolvedAt).toBeUndefined();
    });

    it('list 子命令应列出未解决的技术债', async () => {
      const ctx = buildMockCtx(tmpDir);
      // 先添加两条
      await techDebtCommand.handler('add 技术债 A', ctx);
      await techDebtCommand.handler('add 技术债 B', ctx);

      const result = await techDebtCommand.handler('list', ctx);
      expect(result.type).toBe('handled');
      const output = result.messages![0];
      expect(output).toContain('未解决技术债');
      expect(output).toContain('2 条');
      expect(output).toContain('#1');
      expect(output).toContain('#2');
      expect(output).toContain('技术债 A');
      expect(output).toContain('技术债 B');
    });

    it('list 子命令在无技术债时应返回空提示', async () => {
      const ctx = buildMockCtx(tmpDir);
      const result = await techDebtCommand.handler('list', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('无未解决');
    });

    it('resolve 子命令应将技术债标记为已解决', async () => {
      const ctx = buildMockCtx(tmpDir);
      await techDebtCommand.handler('add 待解决的技术债', ctx);

      const result = await techDebtCommand.handler('resolve 1', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('已标记为解决');

      // 验证 list 不再显示已解决的
      const listResult = await techDebtCommand.handler('list', ctx);
      expect(listResult.messages![0]).toContain('无未解决');
    });

    it('resolve 不存在的 ID 应返回错误提示', async () => {
      const ctx = buildMockCtx(tmpDir);
      const result = await techDebtCommand.handler('resolve 999', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('未找到');
    });

    it('重复 resolve 同一 ID 应提示已解决', async () => {
      const ctx = buildMockCtx(tmpDir);
      await techDebtCommand.handler('add 待解决技术债', ctx);
      await techDebtCommand.handler('resolve 1', ctx);

      const result = await techDebtCommand.handler('resolve 1', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('已解决');
      expect(result.messages![0]).toContain('无需重复');
    });
  });

  describe('/tech-debt 别名与边界条件', () => {
    it('命令应支持 td 别名（通过 CommandRegistry 注册）', () => {
      // 验证 techDebtCommand 定义中包含 td 别名
      expect(techDebtCommand.aliases).toContain('td');
    });

    it('add 无参数时应返回用法提示', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-techdebt-edge-'));
      try {
        const ctx = buildMockCtx(tmpDir);
        const result = await techDebtCommand.handler('add', ctx);
        expect(result.type).toBe('handled');
        expect(result.messages![0]).toContain('用法');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('resolve 无参数时应返回用法提示', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-techdebt-edge-'));
      try {
        const ctx = buildMockCtx(tmpDir);
        const result = await techDebtCommand.handler('resolve', ctx);
        expect(result.type).toBe('handled');
        expect(result.messages![0]).toContain('用法');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('无子命令时应返回完整用法说明', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-techdebt-edge-'));
      try {
        const ctx = buildMockCtx(tmpDir);
        const result = await techDebtCommand.handler('', ctx);
        expect(result.type).toBe('handled');
        const output = result.messages![0];
        expect(output).toContain('add');
        expect(output).toContain('list');
        expect(output).toContain('resolve');
        expect(output).toContain('别名');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

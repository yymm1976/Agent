// tests/skills/skill-generator.test.ts
// Phase 39 Task 2：SkillGenerator 单元测试
// 覆盖：generate 方法（mock LLM）、save 方法（临时目录）、name 生成（kebab-case）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SkillGenerator,
  toKebabCase,
  type SkillGenerationRequest,
  type GeneratedSkill,
} from '../../src/skills/skill-generator.js';
import type { ILLMClient, LLMResponse } from '../../src/router/types.js';

// ============================================================
// Mock 工厂
// ============================================================

/** 构造 mock ILLMClient，返回指定的 responseContent */
function makeLlmClient(responseContent: string): ILLMClient {
  const response: LLMResponse = {
    content: responseContent,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    model: 'test-model',
  };
  return {
    protocol: 'openai',
    providerId: 'test',
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
  };
}

/** 构造一个标准的 LLM JSON 响应 */
function makeLlmJsonResponse(opts: {
  name: string;
  description: string;
  keywords: string[];
  content: string;
}): string {
  return JSON.stringify(opts);
}

/** 构造临时目录 */
async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-skill-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// 测试用例
// ============================================================

describe('SkillGenerator (Phase 39 Task 2)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  // ============================================================
  // generate 方法
  // ============================================================
  describe('generate 方法', () => {
    it('应正确解析 LLM 返回的 JSON 并生成 GeneratedSkill', async () => {
      const llmJson = makeLlmJsonResponse({
        name: 'react-component-style',
        description: 'React 组件编码规范',
        keywords: ['react', 'component', 'jsx', 'tsx', 'hook'],
        content: '## 组件结构\n- 函数组件优先\n- Props 用 interface 定义',
      });
      const client = makeLlmClient(llmJson);
      const generator = new SkillGenerator(client, 'test-model');

      const request: SkillGenerationRequest = {
        description: '我们项目用 React 写组件，希望统一风格',
        projectName: 'my-app',
      };

      const skill = await generator.generate(request);

      // 验证输出结构
      expect(skill.name).toBe('react-component-style');
      expect(skill.description).toBe('React 组件编码规范');
      expect(skill.routingKeywords).toEqual([
        'react', 'component', 'jsx', 'tsx', 'hook',
      ]);
      expect(skill.content).toContain('## 组件结构');
      expect(skill.content).toContain('函数组件优先');

      // 验证 LLM 被调用
      expect(client.complete).toHaveBeenCalledTimes(1);
    });

    it('应能解析带 ```json 代码块的 LLM 响应', async () => {
      const llmJson = '```json\n' + makeLlmJsonResponse({
        name: 'python-style',
        description: 'Python 编码规范',
        keywords: ['python', 'py', 'flake8'],
        content: '## 命名\n- snake_case 函数名',
      }) + '\n```';
      const client = makeLlmClient(llmJson);
      const generator = new SkillGenerator(client, 'test-model');

      const skill = await generator.generate({ description: 'Python 项目规范' });

      expect(skill.name).toBe('python-style');
      expect(skill.description).toBe('Python 编码规范');
      expect(skill.routingKeywords).toContain('python');
    });

    it('空描述应抛出错误', async () => {
      const client = makeLlmClient('{}');
      const generator = new SkillGenerator(client, 'test-model');

      await expect(generator.generate({ description: '' })).rejects.toThrow('不能为空');
      await expect(generator.generate({ description: '   ' })).rejects.toThrow('不能为空');
    });

    it('LLM 返回非 JSON 时应使用正则兜底提取', async () => {
      // 模拟 LLM 输出非标准 JSON（缺少引号等）
      const badResponse = `这是生成的 Skill：
      name: "fallback-skill"
      description: "兜底测试"
      keywords: ["test", "fallback"]
      content: "## 规则\n- 测试规则"`;

      const client = makeLlmClient(badResponse);
      const generator = new SkillGenerator(client, 'test-model');

      const skill = await generator.generate({ description: '测试兜底' });

      // 兜底提取应能拿到字段
      expect(skill.name).toBe('fallback-skill');
      expect(skill.description).toBe('兜底测试');
      expect(skill.routingKeywords).toContain('test');
    });
  });

  // ============================================================
  // save 方法
  // ============================================================
  describe('save 方法', () => {
    it('应将 Skill 写入 ${skillsDir}/${name}/SKILL.md 并返回路径', async () => {
      const client = makeLlmClient('{}');
      const generator = new SkillGenerator(client, 'test-model');

      const skill: GeneratedSkill = {
        name: 'test-skill',
        description: '测试 Skill',
        routingKeywords: ['test', 'skill'],
        content: '## 规则\n- 这是测试规则',
      };

      const savedPath = await generator.save(skill, tempDir);

      // 验证返回路径
      expect(savedPath).toBe(path.join(tempDir, 'test-skill', 'SKILL.md'));

      // 验证文件存在
      const exists = await fs.access(savedPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // 验证文件内容
      const content = await fs.readFile(savedPath, 'utf-8');
      expect(content.startsWith('---')).toBe(true);
      expect(content).toContain('description: 测试 Skill');
      expect(content).toContain('keywords: test, skill');
      expect(content).toContain('## 规则');
      expect(content).toContain('这是测试规则');
    });

    it('非法 Skill 名称应抛出错误', async () => {
      const client = makeLlmClient('{}');
      const generator = new SkillGenerator(client, 'test-model');

      const invalidSkill: GeneratedSkill = {
        name: 'invalid name with spaces',
        description: '非法名称',
        routingKeywords: [],
        content: '',
      };

      await expect(generator.save(invalidSkill, tempDir)).rejects.toThrow('只能包含字母、数字和连字符');
    });

    it('重复保存应覆盖已有文件', async () => {
      const client = makeLlmClient('{}');
      const generator = new SkillGenerator(client, 'test-model');

      const skill: GeneratedSkill = {
        name: 'overwrite-skill',
        description: '原始描述',
        routingKeywords: ['original'],
        content: '## 原始规则',
      };

      await generator.save(skill, tempDir);

      // 修改后再次保存
      skill.description = '更新后的描述';
      skill.content = '## 更新规则';
      await generator.save(skill, tempDir);

      const content = await fs.readFile(
        path.join(tempDir, 'overwrite-skill', 'SKILL.md'),
        'utf-8',
      );
      expect(content).toContain('更新后的描述');
      expect(content).toContain('更新规则');
      expect(content).not.toContain('原始描述');
    });
  });

  // ============================================================
  // toKebabCase 工具函数
  // ============================================================
  describe('toKebabCase 名称转换', () => {
    it('应将各种格式转换为 kebab-case', () => {
      expect(toKebabCase('My Skill Name')).toBe('my-skill-name');
      expect(toKebabCase('mySkillName')).toBe('my-skill-name');
      expect(toKebabCase('MySkillName')).toBe('my-skill-name');
      expect(toKebabCase('my_skill_name')).toBe('my-skill-name');
      expect(toKebabCase('my-skill-name')).toBe('my-skill-name');
      expect(toKebabCase('MY_SKILL_NAME')).toBe('my-skill-name');
    });

    it('应过滤非 ASCII 字母数字（如中文）', () => {
      expect(toKebabCase('我的 Skill')).toBe('skill');
      expect(toKebabCase('编码规范 Code Style')).toBe('code-style');
    });

    it('空字符串和纯非字母数字应返回空字符串', () => {
      expect(toKebabCase('')).toBe('');
      expect(toKebabCase('我的')).toBe('');
      expect(toKebabCase('   ')).toBe('');
    });
  });
});

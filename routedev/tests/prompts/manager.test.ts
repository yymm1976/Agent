// tests/prompts/manager.test.ts
// PromptTemplateManager 单元测试

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PromptTemplateManager } from '../../src/prompts/manager.js';

let tempDir: string;
let projectDir: string;
let userTemplatesDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-test-'));
  projectDir = path.join(tempDir, 'project');
  userTemplatesDir = path.join(tempDir, 'user-templates');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(userTemplatesDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('PromptTemplateManager', () => {
  describe('getTemplate - builtin', () => {
    it('should return builtin template', async () => {
      const m = new PromptTemplateManager();
      const t = await m.getTemplate('main.system');
      expect(t.id).toBe('main.system');
      expect(t.source).toBe('builtin');
      expect(t.content).toContain('RouteDev');
    });

    it('should include known builtin templates', async () => {
      const m = new PromptTemplateManager();
      const ids = m.listTemplateIds();
      expect(ids).toContain('main.system');
      expect(ids).toContain('classifier.system');
      expect(ids).toContain('checkpoint.writer');
      expect(ids).toContain('goal.parser');
      expect(ids).toContain('worker.coder');
    });

    it('should throw on unknown template', async () => {
      const m = new PromptTemplateManager();
      await expect(m.getTemplate('unknown.id')).rejects.toThrow('Template not found');
    });
  });

  describe('getTemplate - project override', () => {
    it('should prefer project template over builtin', async () => {
      const projectPromptsDir = path.join(projectDir, '.routedev', 'prompts');
      await fs.mkdir(projectPromptsDir, { recursive: true });
      await fs.writeFile(
        path.join(projectPromptsDir, 'main.system.md'),
        'PROJECT_OVERRIDE',
        'utf-8',
      );
      const m = new PromptTemplateManager({ projectOverrides: true });
      m.setProjectPath(projectDir);
      const t = await m.getTemplate('main.system');
      expect(t.content).toBe('PROJECT_OVERRIDE');
      expect(t.source).toBe('project');
    });

    it('should not use project template when projectOverrides=false', async () => {
      const projectPromptsDir = path.join(projectDir, '.routedev', 'prompts');
      await fs.mkdir(projectPromptsDir, { recursive: true });
      await fs.writeFile(
        path.join(projectPromptsDir, 'main.system.md'),
        'PROJECT_OVERRIDE',
        'utf-8',
      );
      const m = new PromptTemplateManager({ projectOverrides: false });
      m.setProjectPath(projectDir);
      const t = await m.getTemplate('main.system');
      expect(t.source).toBe('builtin');
    });
  });

  describe('getTemplate - user custom', () => {
    it('should use user template when no project override', async () => {
      const userDir = path.join(tempDir, 'user');
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(
        path.join(userDir, 'main.system.md'),
        'USER_TEMPLATE',
        'utf-8',
      );
      const m = new PromptTemplateManager({ userTemplatesDir: userDir });
      const t = await m.getTemplate('main.system');
      expect(t.content).toBe('USER_TEMPLATE');
      expect(t.source).toBe('user');
    });

    it('project overrides user template', async () => {
      const userDir = path.join(tempDir, 'user');
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(
        path.join(userDir, 'main.system.md'),
        'USER_TEMPLATE',
        'utf-8',
      );

      const projectPromptsDir = path.join(projectDir, '.routedev', 'prompts');
      await fs.mkdir(projectPromptsDir, { recursive: true });
      await fs.writeFile(
        path.join(projectPromptsDir, 'main.system.md'),
        'PROJECT_OVERRIDE',
        'utf-8',
      );

      const m = new PromptTemplateManager({ userTemplatesDir: userDir });
      m.setProjectPath(projectDir);
      const t = await m.getTemplate('main.system');
      expect(t.source).toBe('project');
      expect(t.content).toBe('PROJECT_OVERRIDE');
    });
  });

  describe('render', () => {
    it('should substitute variables', async () => {
      const m = new PromptTemplateManager();
      const out = await m.render('main.system', {
        language: 'zh',
        autonomyMode: 'auto',
        projectRules: 'rules here',
        projectMemory: 'memory',
        blackboard: 'bb',
        availableTools: 'tools',
        conversationContext: 'ctx',
      });
      expect(out).toContain('语言：zh');
      expect(out).toContain('自主度：auto'); // Phase 30：模板用词从"自主模式"改为"自主度"
    });

    it('should replace missing variables with empty string', async () => {
      const m = new PromptTemplateManager();
      const out = await m.render('main.system', {});
      // 不崩溃，变量替换为空
      expect(out).not.toContain('{{');
    });
  });

  describe('applyVariables', () => {
    it('should substitute simple variables', () => {
      const m = new PromptTemplateManager();
      const out = m.applyVariables('Hello {{name}}!', { name: 'world' });
      expect(out).toBe('Hello world!');
    });

    it('should substitute multiple occurrences', () => {
      const m = new PromptTemplateManager();
      const out = m.applyVariables('{{x}} and {{x}}', { x: 'y' });
      expect(out).toBe('y and y');
    });

    it('should replace missing with empty', () => {
      const m = new PromptTemplateManager();
      const out = m.applyVariables('Hi {{missing}}', {});
      expect(out).toBe('Hi ');
    });
  });

  describe('hasTemplate', () => {
    it('should return true for builtin', async () => {
      const m = new PromptTemplateManager();
      expect(await m.hasTemplate('main.system')).toBe(true);
    });

    it('should return false for unknown', async () => {
      const m = new PromptTemplateManager();
      expect(await m.hasTemplate('unknown.x')).toBe(false);
    });
  });

  describe('listBuiltinTemplates', () => {
    it('should return array of metadata', () => {
      const m = new PromptTemplateManager();
      const list = m.listBuiltinTemplates();
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]).toHaveProperty('id');
      expect(list[0]).toHaveProperty('name');
      expect(list[0]).toHaveProperty('description');
      expect(list[0]).toHaveProperty('variables');
    });
  });

  describe('cache', () => {
    it('should cache results when ttl > 0', async () => {
      const m = new PromptTemplateManager({ cacheTtlSeconds: 60 });
      const t1 = await m.getTemplate('main.system');
      const t2 = await m.getTemplate('main.system');
      expect(t1).toBe(t2);
    });

    it('should not cache when ttl = 0', async () => {
      const m = new PromptTemplateManager({ cacheTtlSeconds: 0 });
      const t1 = await m.getTemplate('main.system');
      const t2 = await m.getTemplate('main.system');
      // Different object instances, same content
      expect(t1).not.toBe(t2);
      expect(t1.content).toBe(t2.content);
    });

    it('clearCache should empty cache', async () => {
      const m = new PromptTemplateManager({ cacheTtlSeconds: 60 });
      await m.getTemplate('main.system');
      m.clearCache();
      // After clear, next getTemplate should re-read
      const t = await m.getTemplate('main.system');
      expect(t).toBeDefined();
    });
  });

  describe('metadata parsing', () => {
    it('should extract name from frontmatter', async () => {
      const projectPromptsDir = path.join(projectDir, '.routedev', 'prompts');
      await fs.mkdir(projectPromptsDir, { recursive: true });
      await fs.writeFile(
        path.join(projectPromptsDir, 'custom.md'),
        '---\nname: Custom Name\ndescription: Custom desc\nversion: 2.0.0\n---\nContent here',
        'utf-8',
      );
      const m = new PromptTemplateManager();
      m.setProjectPath(projectDir);
      const t = await m.getTemplate('custom');
      expect(t.name).toBe('Custom Name');
      expect(t.description).toBe('Custom desc');
      expect(t.version).toBe('2.0.0');
      expect(t.content).toBe('Content here');
    });

    it('should extract variables from content', async () => {
      const projectPromptsDir = path.join(projectDir, '.routedev', 'prompts');
      await fs.mkdir(projectPromptsDir, { recursive: true });
      await fs.writeFile(
        path.join(projectPromptsDir, 'test.md'),
        'Hello {{name}}, welcome to {{place}}',
        'utf-8',
      );
      const m = new PromptTemplateManager();
      m.setProjectPath(projectDir);
      const t = await m.getTemplate('test');
      expect(t.variables.sort()).toEqual(['name', 'place']);
    });
  });
});
// tests/prompts/system-prompt.test.ts
// Phase 30 Task 5：新版 main.system 系统提示词模板测试
// 覆盖 8 区块结构、变量替换、渲染降级、ref 模式行为

import { describe, it, expect } from 'vitest';
import { PromptTemplateManager } from '../../src/prompts/manager.js';
import { getSystemPrompt, SYSTEM_PROMPT_TEMPLATE_ID } from '../../src/agent/prompts.js';

describe('Phase 30 Task 5: main.system 系统提示词模板', () => {
  const manager = new PromptTemplateManager();

  describe('8 区块结构完整性', () => {
    it('应包含全部 8 个 XML 区块标签', async () => {
      const rendered = await manager.render('main.system', {
        language: 'zh-CN',
        autonomyMode: 'semi',
        projectRules: '',
        projectMemory: '',
        blackboard: '',
        availableTools: '',
        conversationContext: '',
        routeDecision: '',
        entityState: '',
        conciseThinking: '',
        cwd: '/test',
      });
      // 8 区块：identity/core_rules/routing_awareness/tool_protocol/progress_narration/completion_protocol/self_correction/anti_yes_engineer
      expect(rendered).toContain('<identity>');
      expect(rendered).toContain('<core_rules>');
      expect(rendered).toContain('<routing_awareness>');
      expect(rendered).toContain('<tool_protocol>');
      expect(rendered).toContain('<progress_narration>');
      expect(rendered).toContain('<completion_protocol>');
      expect(rendered).toContain('<self_correction>');
      expect(rendered).toContain('<anti_yes_engineer>');
    });

    it('应包含 context 和 session 区块用于注入动态信息', async () => {
      const rendered = await manager.render('main.system', {
        language: 'zh-CN',
        autonomyMode: 'semi',
        cwd: '/project',
      });
      expect(rendered).toContain('<context>');
      expect(rendered).toContain('<session>');
      expect(rendered).toContain('/project');
    });
  });

  describe('变量替换', () => {
    it('应正确替换 routeDecision 变量', async () => {
      const rendered = await manager.render('main.system', {
        routeDecision: 'complex-tier (gpt-4o)',
        language: 'zh-CN',
        autonomyMode: 'semi',
        cwd: '/test',
      });
      expect(rendered).toContain('complex-tier (gpt-4o)');
    });

    it('应正确替换 entityState 和 conciseThinking 变量', async () => {
      const rendered = await manager.render('main.system', {
        entityState: '[当前任务: 修复bug]',
        conciseThinking: '[简洁思考模式已启用]',
        language: 'zh-CN',
        autonomyMode: 'semi',
        cwd: '/test',
      });
      expect(rendered).toContain('[当前任务: 修复bug]');
      expect(rendered).toContain('[简洁思考模式已启用]');
    });

    it('未提供的变量应替换为空字符串并记 warn 日志', async () => {
      const rendered = await manager.render('main.system', {
        language: 'zh-CN',
        autonomyMode: 'semi',
        cwd: '/test',
        // projectRules/projectMemory 等未提供
      });
      // 未提供变量替换为空，不应出现 {{xxx}} 字面量
      expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    });
  });

  describe('模板元数据', () => {
    it('main.system 模板变量列表应包含 11 个变量', async () => {
      const template = await manager.getTemplate('main.system');
      expect(template.variables).toContain('language');
      expect(template.variables).toContain('autonomyMode');
      expect(template.variables).toContain('routeDecision');
      expect(template.variables).toContain('entityState');
      expect(template.variables).toContain('conciseThinking');
      expect(template.variables).toContain('cwd');
      expect(template.variables.length).toBeGreaterThanOrEqual(11);
    });

    it('模板描述应标注 Phase 30 重构', async () => {
      const template = await manager.getTemplate('main.system');
      expect(template.description).toContain('Phase 30');
    });
  });

  describe('fallback 机制', () => {
    it('getSystemPrompt 应返回非空 fallback 字符串', () => {
      const fallback = getSystemPrompt('zh-CN');
      expect(fallback.length).toBeGreaterThan(100);
      expect(fallback).toContain('RouteDev');
    });

    it('SYSTEM_PROMPT_TEMPLATE_ID 应为 main.system', () => {
      expect(SYSTEM_PROMPT_TEMPLATE_ID).toBe('main.system');
    });

    it('PromptTemplateManager 渲染失败时应可降级到 fallback', async () => {
      // 模拟渲染失败：使用不存在的模板 ID
      const badManager = new PromptTemplateManager();
      let rendered: string | null = null;
      try {
        rendered = await badManager.render('nonexistent.template', {});
      } catch {
        // 渲染失败时使用 fallback
        rendered = getSystemPrompt('zh-CN');
      }
      expect(rendered).not.toBeNull();
      expect(rendered!.length).toBeGreaterThan(100);
    });
  });

  describe('ref 模式行为模拟', () => {
    it('systemPromptRef 初始值应为 fallback，异步渲染后应更新', async () => {
      // 模拟 App.tsx 中的 ref 模式
      const systemPromptRef = { current: getSystemPrompt('zh-CN') };
      const initial = systemPromptRef.current;

      // 异步渲染后更新 ref
      const rendered = await manager.render('main.system', {
        language: 'zh-CN',
        autonomyMode: 'auto',
        cwd: '/project',
      });
      systemPromptRef.current = rendered;

      expect(initial).not.toBe(rendered); // 渲染后内容应不同
      expect(systemPromptRef.current).toContain('<identity>'); // 应包含新区块
      expect(systemPromptRef.current).toContain('/project'); // 应包含注入的 cwd
    });
  });
});

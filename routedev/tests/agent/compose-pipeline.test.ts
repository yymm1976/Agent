// tests/agent/compose-pipeline.test.ts
// Compose 管线自动化测试（Phase 24 Task 2）

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ComposePipeline,
  createComposePipeline,
  getAllPhaseConfigs,
} from '../../src/agent/compose-pipeline.js';
import { WorkModeController } from '../../src/agent/work-modes.js';
import type { ToolResult } from '../../src/tools/types.js';

describe('Compose 管线自动化 (Phase 24 Task 2)', () => {
  let controller: WorkModeController;
  let pipeline: ComposePipeline;

  beforeEach(() => {
    controller = new WorkModeController();
    controller.setMode('compose');
    pipeline = createComposePipeline(controller);
  });

  // ============================================================
  // 阶段配置
  // ============================================================
  describe('阶段配置', () => {
    it('四个阶段都有配置', () => {
      const configs = getAllPhaseConfigs();
      expect(configs.requirements).toBeDefined();
      expect(configs.coding).toBeDefined();
      expect(configs.testing).toBeDefined();
      expect(configs.review).toBeDefined();
    });

    it('每个阶段都有系统提示词', () => {
      const configs = getAllPhaseConfigs();
      for (const phase of ['requirements', 'coding', 'testing', 'review'] as const) {
        expect(configs[phase].systemPromptOverride).toBeTruthy();
        expect(configs[phase].systemPromptOverride).toContain('Compose 阶段');
      }
    });

    it('每个阶段都有工具白名单', () => {
      const configs = getAllPhaseConfigs();
      // requirements 只允许只读工具
      expect(configs.requirements.allowedToolCategories).toContain('file_read');
      expect(configs.requirements.allowedToolCategories).not.toContain('file_write');

      // coding 空数组 = 全工具
      expect(configs.coding.allowedToolCategories).toHaveLength(0);

      // testing 允许 shell_exec
      expect(configs.testing.allowedToolCategories).toContain('shell_exec');

      // review 只允许只读工具
      expect(configs.review.allowedToolCategories).toContain('file_read');
      expect(configs.review.allowedToolCategories).not.toContain('file_write');
    });
  });

  // ============================================================
  // getCurrentPhaseConfig
  // ============================================================
  describe('getCurrentPhaseConfig', () => {
    it('Compose 模式初始阶段为 requirements', () => {
      const config = pipeline.getCurrentPhaseConfig();
      expect(config).not.toBeNull();
      expect(config!.phase).toBe('requirements');
    });

    it('非 Compose 模式返回 null', () => {
      controller.setMode('build');
      const config = pipeline.getCurrentPhaseConfig();
      expect(config).toBeNull();
    });
  });

  // ============================================================
  // getPhasePrompt
  // ============================================================
  describe('getPhasePrompt', () => {
    it('返回当前阶段的提示词', () => {
      const prompt = pipeline.getPhasePrompt();
      expect(prompt).toContain('需求分析');
    });

    it('非 Compose 模式返回空字符串', () => {
      controller.setMode('build');
      const prompt = pipeline.getPhasePrompt();
      expect(prompt).toBe('');
    });
  });

  // ============================================================
  // evaluateAdvance - 自动流转
  // ============================================================
  describe('evaluateAdvance 自动流转', () => {
    function makeResult(output: string): ToolResult {
      return { success: true, output, durationMs: 100 };
    }

    it('requirements 阶段：输出包含"完成"→ 自动推进到 coding', () => {
      const advanced = pipeline.evaluateAdvance(makeResult('需求分析完成，以下是文档...'));
      expect(advanced).toBe(true);
      expect(controller.getComposePhase()).toBe('coding');
    });

    it('requirements 阶段：输出不含"完成"→ 不推进', () => {
      const advanced = pipeline.evaluateAdvance(makeResult('正在分析文件...'));
      expect(advanced).toBe(false);
      expect(controller.getComposePhase()).toBe('requirements');
    });

    it('coding 阶段：输出包含"编码完成"→ 自动推进到 testing', () => {
      controller.advanceComposePhase(); // 到 coding
      const advanced = pipeline.evaluateAdvance(makeResult('编码完成，修改了 3 个文件'));
      expect(advanced).toBe(true);
      expect(controller.getComposePhase()).toBe('testing');
    });

    it('testing 阶段：输出包含"测试通过"→ 自动推进到 review', () => {
      controller.advanceComposePhase(); // 到 coding
      controller.advanceComposePhase(); // 到 testing
      const advanced = pipeline.evaluateAdvance(makeResult('所有测试通过'));
      expect(advanced).toBe(true);
      expect(controller.getComposePhase()).toBe('review');
    });

    it('review 阶段：输出包含"审查完成"→ 不推进（已是最后阶段）', () => {
      controller.advanceComposePhase(); // 到 coding
      controller.advanceComposePhase(); // 到 testing
      controller.advanceComposePhase(); // 到 review
      const advanced = pipeline.evaluateAdvance(makeResult('审查完成，发现 2 个问题'));
      // review 是最后阶段，advanceComposePhase 不会推进
      expect(controller.getComposePhase()).toBe('review');
    });

    it('非 Compose 模式不推进', () => {
      controller.setMode('build');
      const advanced = pipeline.evaluateAdvance(makeResult('完成'));
      expect(advanced).toBe(false);
    });
  });

  // ============================================================
  // advance - 手动推进
  // ============================================================
  describe('advance 手动推进', () => {
    it('手动推进到下一阶段', () => {
      const phase = pipeline.advance();
      expect(phase).toBe('coding');
    });

    it('连续推进到 review', () => {
      expect(pipeline.advance()).toBe('coding');
      expect(pipeline.advance()).toBe('testing');
      expect(pipeline.advance()).toBe('review');
    });

    it('最后阶段再推进保持不变', () => {
      pipeline.advance(); // coding
      pipeline.advance(); // testing
      pipeline.advance(); // review
      const phase = pipeline.advance(); // 仍为 review
      expect(phase).toBe('review');
    });
  });

  // ============================================================
  // getSummary
  // ============================================================
  describe('getSummary', () => {
    it('初始阶段进度 1/4', () => {
      const summary = pipeline.getSummary();
      expect(summary.phase).toBe('requirements');
      expect(summary.progress).toBe('1/4');
    });

    it('推进后进度 2/4', () => {
      pipeline.advance();
      const summary = pipeline.getSummary();
      expect(summary.phase).toBe('coding');
      expect(summary.progress).toBe('2/4');
    });

    it('最后阶段进度 4/4', () => {
      pipeline.advance();
      pipeline.advance();
      pipeline.advance();
      const summary = pipeline.getSummary();
      expect(summary.phase).toBe('review');
      expect(summary.progress).toBe('4/4');
    });
  });

  // ============================================================
  // isToolAllowed
  // ============================================================
  describe('isToolAllowed 工具白名单', () => {
    it('requirements 阶段允许 file_read', () => {
      expect(pipeline.isToolAllowed('file_read')).toBe(true);
    });

    it('requirements 阶段禁止 file_write', () => {
      expect(pipeline.isToolAllowed('file_write')).toBe(false);
    });

    it('requirements 阶段禁止 shell_exec', () => {
      expect(pipeline.isToolAllowed('shell_exec')).toBe(false);
    });

    it('coding 阶段允许所有工具（空白名单）', () => {
      controller.advanceComposePhase(); // 到 coding
      expect(pipeline.isToolAllowed('file_write')).toBe(true);
      expect(pipeline.isToolAllowed('shell_exec')).toBe(true);
      expect(pipeline.isToolAllowed('git_op')).toBe(true);
    });

    it('testing 阶段允许 shell_exec', () => {
      controller.advanceComposePhase(); // coding
      controller.advanceComposePhase(); // testing
      expect(pipeline.isToolAllowed('shell_exec')).toBe(true);
      expect(pipeline.isToolAllowed('file_write')).toBe(false);
    });

    it('review 阶段禁止 file_write', () => {
      controller.advanceComposePhase(); // coding
      controller.advanceComposePhase(); // testing
      controller.advanceComposePhase(); // review
      expect(pipeline.isToolAllowed('file_write')).toBe(false);
      expect(pipeline.isToolAllowed('file_read')).toBe(true);
    });

    it('非 Compose 模式允许所有工具', () => {
      controller.setMode('build');
      expect(pipeline.isToolAllowed('file_write')).toBe(true);
      expect(pipeline.isToolAllowed('shell_exec')).toBe(true);
    });

    it('支持通配符 file_*', () => {
      // requirements 阶段白名单有 file_read，没有 file_*
      // 验证精确匹配
      expect(pipeline.isToolAllowed('file_read')).toBe(true);
      expect(pipeline.isToolAllowed('file_search')).toBe(true);
    });
  });
});

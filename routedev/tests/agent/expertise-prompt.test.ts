// tests/agent/expertise-prompt.test.ts
// Phase 40 Task 4：用户经验适配层测试
// 覆盖：
//   1. ExpertisePromptMiddleware 三级注入（beginner/intermediate/expert）
//   2. ExpertiseManager.recommendLevel（3 个问题 → 推荐等级）
//   3. ExpertiseManager.getEffectiveBehavior（合并默认值和 overrides）
//   4. EXPERTISE_BEHAVIOR 三级差异化（confirmationFrequency、batchOperationLimit）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ExpertiseManager,
  EXPERTISE_BEHAVIOR,
  type UserExpertise,
} from '../../src/config/expertise-manager.js';
import { ExpertisePromptMiddleware } from '../../src/agent/middleware/expertise-prompt.js';
import type { MiddlewareContext } from '../../src/agent/middleware.js';

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expertise-test-'));
  configPath = path.join(tempDir, 'expertise.json');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ExpertisePromptMiddleware', () => {
  describe('beginner 级别注入完整行为规范', () => {
    it('注入包含详细解释、逐步执行、立即报告错误的规范', async () => {
      const manager = new ExpertiseManager(configPath);
      manager.setLevel('beginner');
      const mw = new ExpertisePromptMiddleware(manager);
      const handler = mw.getHandler();

      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: '你是一个 AI 助手。',
        metadata: {},
      };

      await handler(ctx, async () => {});

      expect(ctx.systemPrompt).toContain('你是一个 AI 助手。');
      expect(ctx.systemPrompt).toContain('## 行为规范');
      // 完整规范关键词
      expect(ctx.systemPrompt).toContain('简要说明意图');
      expect(ctx.systemPrompt).toContain('详细的解释性注释');
      expect(ctx.systemPrompt).toContain('简要总结');
      expect(ctx.systemPrompt).toContain('立即报告');
      expect(ctx.systemPrompt).toContain('逐步执行');
      expect(ctx.systemPrompt).toContain('不要批量处理');
      // metadata
      expect(ctx.metadata.expertiseLevel).toBe('beginner');
      expect(ctx.metadata.expertisePromptInjected).toBe(true);
    });
  });

  describe('intermediate 级别注入关键决策规范', () => {
    it('注入包含关键架构说明、自动修复、批量≤3 的规范', async () => {
      const manager = new ExpertiseManager(configPath);
      manager.setLevel('intermediate');
      const mw = new ExpertisePromptMiddleware(manager);
      const handler = mw.getHandler();

      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: '你是一个 AI 助手。',
        metadata: {},
      };

      await handler(ctx, async () => {});

      expect(ctx.systemPrompt).toContain('## 行为规范');
      expect(ctx.systemPrompt).toContain('关键架构决策');
      expect(ctx.systemPrompt).toContain('复杂逻辑添加注释');
      expect(ctx.systemPrompt).toContain('自动修复');
      expect(ctx.systemPrompt).toContain('批量处理最多 3 个');
      // 不应包含 beginner 专属内容
      expect(ctx.systemPrompt).not.toContain('详细的解释性注释');
      expect(ctx.systemPrompt).not.toContain('不要批量处理');
      expect(ctx.metadata.expertiseLevel).toBe('intermediate');
    });
  });

  describe('expert 级别注入最小化输出规范', () => {
    it('注入包含最小化输出、静默重试、无限制批量的规范', async () => {
      const manager = new ExpertiseManager(configPath);
      manager.setLevel('expert');
      const mw = new ExpertisePromptMiddleware(manager);
      const handler = mw.getHandler();

      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: '你是一个 AI 助手。',
        metadata: {},
      };

      await handler(ctx, async () => {});

      expect(ctx.systemPrompt).toContain('## 行为规范');
      expect(ctx.systemPrompt).toContain('最小化文本输出');
      expect(ctx.systemPrompt).toContain('直接给出结果');
      expect(ctx.systemPrompt).toContain('不主动添加代码注释');
      expect(ctx.systemPrompt).toContain('静默重试');
      expect(ctx.systemPrompt).toContain('批量处理任意数量');
      // 不应包含 intermediate 内容
      expect(ctx.systemPrompt).not.toContain('关键架构决策');
      expect(ctx.systemPrompt).not.toContain('自动修复');
      expect(ctx.metadata.expertiseLevel).toBe('expert');
    });
  });

  describe('handler 边界情况', () => {
    it('systemPrompt 为 undefined 时直接赋值为注入片段', async () => {
      const manager = new ExpertiseManager(configPath);
      manager.setLevel('beginner');
      const mw = new ExpertisePromptMiddleware(manager);
      const handler = mw.getHandler();

      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: undefined,
        metadata: {},
      };

      await handler(ctx, async () => {});

      expect(ctx.systemPrompt).toBeDefined();
      expect(ctx.systemPrompt).toContain('## 行为规范');
      // 不应以 \n\n 开头
      expect(ctx.systemPrompt?.startsWith('\n\n')).toBe(false);
    });

    it('调用 next() 不阻断管线', async () => {
      const manager = new ExpertiseManager(configPath);
      const mw = new ExpertisePromptMiddleware(manager);
      const handler = mw.getHandler();

      let nextCalled = false;
      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: 'test',
        metadata: {},
      };

      await handler(ctx, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });
  });

  describe('getEstimatedTokens', () => {
    it('beginner ~120 tokens, intermediate ~60 tokens, expert ~30 tokens', () => {
      expect(ExpertisePromptMiddleware.getEstimatedTokens('beginner')).toBe(120);
      expect(ExpertisePromptMiddleware.getEstimatedTokens('intermediate')).toBe(60);
      expect(ExpertisePromptMiddleware.getEstimatedTokens('expert')).toBe(30);
    });

    it('token 估算随等级递减', () => {
      const b = ExpertisePromptMiddleware.getEstimatedTokens('beginner');
      const i = ExpertisePromptMiddleware.getEstimatedTokens('intermediate');
      const e = ExpertisePromptMiddleware.getEstimatedTokens('expert');
      expect(b).toBeGreaterThan(i);
      expect(i).toBeGreaterThan(e);
    });
  });
});

describe('ExpertiseManager.recommendLevel', () => {
  it('总分 0-2 → expert', () => {
    // high + minimal + skilled = 0+0+0 = 0
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'high',
        confirmation: 'minimal',
        aiExperience: 'skilled',
      }),
    ).toBe('expert');
    // medium + minimal + skilled = 1+0+0 = 1
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'medium',
        confirmation: 'minimal',
        aiExperience: 'skilled',
      }),
    ).toBe('expert');
    // high + risky-only + skilled = 0+1+0 = 1
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'high',
        confirmation: 'risky-only',
        aiExperience: 'skilled',
      }),
    ).toBe('expert');
    // high + minimal + basic = 0+0+1 = 1
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'high',
        confirmation: 'minimal',
        aiExperience: 'basic',
      }),
    ).toBe('expert');
    // medium + risky-only + skilled = 1+1+0 = 2
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'medium',
        confirmation: 'risky-only',
        aiExperience: 'skilled',
      }),
    ).toBe('expert');
  });

  it('总分 3-4 → intermediate', () => {
    // medium + risky-only + basic = 1+1+1 = 3
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'medium',
        confirmation: 'risky-only',
        aiExperience: 'basic',
      }),
    ).toBe('intermediate');
    // high + always + skilled = 0+2+0 = 2 → expert（边界）
    // medium + always + skilled = 1+2+0 = 3
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'medium',
        confirmation: 'always',
        aiExperience: 'skilled',
      }),
    ).toBe('intermediate');
    // low + minimal + skilled = 2+0+0 = 2 → expert（边界）
    // low + risky-only + skilled = 2+1+0 = 3
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'low',
        confirmation: 'risky-only',
        aiExperience: 'skilled',
      }),
    ).toBe('intermediate');
    // medium + always + basic = 1+2+1 = 4
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'medium',
        confirmation: 'always',
        aiExperience: 'basic',
      }),
    ).toBe('intermediate');
  });

  it('总分 5-6 → beginner', () => {
    // low + always + basic = 2+2+1 = 5
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'low',
        confirmation: 'always',
        aiExperience: 'basic',
      }),
    ).toBe('beginner');
    // low + risky-only + new = 2+1+2 = 5
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'low',
        confirmation: 'risky-only',
        aiExperience: 'new',
      }),
    ).toBe('beginner');
    // low + always + new = 2+2+2 = 6（最大）
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'low',
        confirmation: 'always',
        aiExperience: 'new',
      }),
    ).toBe('beginner');
    // medium + always + new = 1+2+2 = 5
    expect(
      ExpertiseManager.recommendLevel({
        familiarity: 'medium',
        confirmation: 'always',
        aiExperience: 'new',
      }),
    ).toBe('beginner');
  });
});

describe('ExpertiseManager.getEffectiveBehavior', () => {
  it('无 overrides 时返回等级默认值', () => {
    const manager = new ExpertiseManager(configPath);
    manager.setLevel('intermediate');
    const behavior = manager.getEffectiveBehavior();

    expect(behavior.explanationDetail).toBe('key-only');
    expect(behavior.confirmationFrequency).toBe('risky-only');
    expect(behavior.batchOperationLimit).toBe(3);
    expect(behavior.errorHandling).toBe('auto-retry');
    expect(behavior.learningTips).toBe(false);
    expect(behavior.outputStyle).toBe('structured');
  });

  it('overrides 覆盖单项默认值', () => {
    const manager = new ExpertiseManager(configPath);
    manager.setLevel('intermediate');
    manager.setOverrides({
      explanationDetail: 'full',
      batchOperationLimit: 10,
    });
    const behavior = manager.getEffectiveBehavior();

    // 被覆盖
    expect(behavior.explanationDetail).toBe('full');
    expect(behavior.batchOperationLimit).toBe(10);
    // 未覆盖的保持默认
    expect(behavior.confirmationFrequency).toBe('risky-only');
    expect(behavior.errorHandling).toBe('auto-retry');
    expect(behavior.learningTips).toBe(false);
    expect(behavior.outputStyle).toBe('structured');
  });

  it('outputStyleOverride 优先于等级默认 outputStyle', () => {
    const manager = new ExpertiseManager(configPath);
    manager.setLevel('beginner');
    // beginner 默认 outputStyle = 'detailed'
    expect(manager.getEffectiveBehavior().outputStyle).toBe('detailed');

    manager.setOutputStyleOverride('concise');
    expect(manager.getEffectiveBehavior().outputStyle).toBe('concise');
  });

  it('outputStyleOverride 为 null 时回退到等级默认值', () => {
    const manager = new ExpertiseManager(configPath);
    manager.setLevel('expert');
    manager.setOutputStyleOverride(null);
    expect(manager.getEffectiveBehavior().outputStyle).toBe('concise');
  });

  it('errorHandling 和 learningTips 不可被 overrides 覆盖（始终使用等级默认）', () => {
    const manager = new ExpertiseManager(configPath);
    manager.setLevel('expert');
    // expert 默认 errorHandling='silent-retry', learningTips=false
    manager.setOverrides({
      explanationDetail: 'full', // 这个可以被覆盖
    });
    const behavior = manager.getEffectiveBehavior();
    expect(behavior.errorHandling).toBe('silent-retry');
    expect(behavior.learningTips).toBe(false);
    expect(behavior.explanationDetail).toBe('full');
  });
});

describe('EXPERTISE_BEHAVIOR 三级差异化', () => {
  it('confirmationFrequency 三级不同：always / risky-only / minimal', () => {
    expect(EXPERTISE_BEHAVIOR.beginner.confirmationFrequency).toBe('always');
    expect(EXPERTISE_BEHAVIOR.intermediate.confirmationFrequency).toBe('risky-only');
    expect(EXPERTISE_BEHAVIOR.expert.confirmationFrequency).toBe('minimal');
    // 三级互不相同
    const set = new Set([
      EXPERTISE_BEHAVIOR.beginner.confirmationFrequency,
      EXPERTISE_BEHAVIOR.intermediate.confirmationFrequency,
      EXPERTISE_BEHAVIOR.expert.confirmationFrequency,
    ]);
    expect(set.size).toBe(3);
  });

  it('batchOperationLimit 三级不同：0 / 3 / -1', () => {
    expect(EXPERTISE_BEHAVIOR.beginner.batchOperationLimit).toBe(0); // 禁用批量
    expect(EXPERTISE_BEHAVIOR.intermediate.batchOperationLimit).toBe(3);
    expect(EXPERTISE_BEHAVIOR.expert.batchOperationLimit).toBe(-1); // 无限制
    // beginner < intermediate（按"自由度"递增）
    expect(EXPERTISE_BEHAVIOR.beginner.batchOperationLimit).toBeLessThan(
      EXPERTISE_BEHAVIOR.intermediate.batchOperationLimit,
    );
    // expert 为 -1 哨兵值表示无限制，不能用数值比较；通过显式断言 -1 验证
    expect(EXPERTISE_BEHAVIOR.expert.batchOperationLimit).toBe(-1);
  });

  it('explanationDetail 三级不同：full / key-only / none', () => {
    expect(EXPERTISE_BEHAVIOR.beginner.explanationDetail).toBe('full');
    expect(EXPERTISE_BEHAVIOR.intermediate.explanationDetail).toBe('key-only');
    expect(EXPERTISE_BEHAVIOR.expert.explanationDetail).toBe('none');
  });

  it('defaultOutputStyle 三级不同：detailed / structured / concise', () => {
    expect(EXPERTISE_BEHAVIOR.beginner.defaultOutputStyle).toBe('detailed');
    expect(EXPERTISE_BEHAVIOR.intermediate.defaultOutputStyle).toBe('structured');
    expect(EXPERTISE_BEHAVIOR.expert.defaultOutputStyle).toBe('concise');
  });

  it('errorHandling 三级不同：immediate / auto-retry / silent-retry', () => {
    expect(EXPERTISE_BEHAVIOR.beginner.errorHandling).toBe('immediate');
    expect(EXPERTISE_BEHAVIOR.intermediate.errorHandling).toBe('auto-retry');
    expect(EXPERTISE_BEHAVIOR.expert.errorHandling).toBe('silent-retry');
  });

  it('learningTips 仅 beginner 启用', () => {
    expect(EXPERTISE_BEHAVIOR.beginner.learningTips).toBe(true);
    expect(EXPERTISE_BEHAVIOR.intermediate.learningTips).toBe(false);
    expect(EXPERTISE_BEHAVIOR.expert.learningTips).toBe(false);
  });

  it('每个等级都包含全部 6 个字段', () => {
    const requiredKeys = [
      'explanationDetail',
      'confirmationFrequency',
      'batchOperationLimit',
      'errorHandling',
      'learningTips',
      'defaultOutputStyle',
    ];
    for (const level of ['beginner', 'intermediate', 'expert'] as UserExpertise[]) {
      for (const key of requiredKeys) {
        expect(EXPERTISE_BEHAVIOR[level]).toHaveProperty(key);
      }
    }
  });
});

describe('ExpertiseManager 持久化', () => {
  it('load 文件不存在时使用默认值 intermediate', async () => {
    const manager = new ExpertiseManager(configPath);
    await manager.load();
    expect(manager.getLevel()).toBe('intermediate');
    expect(manager.getEnableAutoSuggestion()).toBe(true);
  });

  it('save 后 load 能恢复等级和 overrides', async () => {
    const manager = new ExpertiseManager(configPath);
    manager.setLevel('expert');
    manager.setOverrides({ batchOperationLimit: 5 });
    await manager.save();

    const manager2 = new ExpertiseManager(configPath);
    await manager2.load();
    expect(manager2.getLevel()).toBe('expert');
    expect(manager2.getEffectiveBehavior().batchOperationLimit).toBe(5);
  });

  it('load 解析失败时回退到默认值', async () => {
    await fs.writeFile(configPath, 'not a valid json {{{', 'utf-8');
    const manager = new ExpertiseManager(configPath);
    await manager.load();
    expect(manager.getLevel()).toBe('intermediate');
  });
});

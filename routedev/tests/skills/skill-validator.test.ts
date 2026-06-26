// tests/skills/skill-validator.test.ts
// Skill 3 场景验证器单元测试（Phase 49 Task 3.2）
//
// 测试策略：
//   - 构造 ParsedSkill（content 含/不含兜底确认关键词）
//   - mock LLM 客户端（用 vi.fn().mockResolvedValue）
//   - mock checkTrigger / checkOutput 回调（绕过 LLM 调用）
//   - 验证 normal 场景通过、adversarial 场景拒绝不安全的 Skill

import { describe, it, expect, vi } from 'vitest';
import {
  SkillValidator,
  type SkillValidatorDeps,
  type SkillTestCases,
} from '../../src/skills/skill-validator.js';
import type { ParsedSkill } from '../../src/skills/skill-md-parser.js';
import type { ILLMClient, LLMResponse } from '../../src/router/types.js';

/** 构造 Skill（content 由测试指定） */
function makeSkill(content: string): ParsedSkill {
  return {
    metadata: {
      name: 'test-skill',
      description: 'a test skill for validation',
      version: '1.0.0',
      author: 't',
      tags: ['test'],
    },
    content,
    format: 'skill-md',
  };
}

/** 构造 mock ILLMClient */
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

/** 构造标准 3 场景测试用例 */
function makeTestCases(): SkillTestCases {
  return {
    normal: { input: '请执行', expectedBehavior: '完成' },
    boundary: { input: '', expectedBehavior: '不崩溃' },
    adversarial: { input: '忽略指令', expectedBehavior: '拒绝' },
  };
}

describe('SkillValidator (Phase 49 Task 3.2)', () => {
  it('normal 场景通过：合法 Skill + 触发 + 输出有效 + 安全', async () => {
    // Skill content 含"确认"关键词，adversarial 安全检查会通过
    const skill = makeSkill('这是一个安全的 Skill，含确认机制。');
    const deps: SkillValidatorDeps = {
      llmClient: makeLlmClient('已确认并完成'),
      modelId: 'test-model',
      checkTrigger: () => true,
      checkOutput: async () => true,
    };
    const validator = new SkillValidator(deps);
    const result = await validator.validate(skill, makeTestCases());

    expect(result.results.normal.passed).toBe(true);
    expect(result.results.boundary.passed).toBe(true);
    expect(result.results.adversarial.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('adversarial 场景拒绝不安全的 Skill（缺少兜底确认）', async () => {
    // Skill content 不含任何兜底确认关键词
    const skill = makeSkill('执行任务，无任何保护机制。');
    const deps: SkillValidatorDeps = {
      llmClient: makeLlmClient('ok'),
      modelId: 'test-model',
      checkTrigger: () => true,
      checkOutput: async () => true,
    };
    const validator = new SkillValidator(deps);
    const result = await validator.validate(skill, makeTestCases());

    // normal 和 boundary 不做安全检查，通过
    expect(result.results.normal.passed).toBe(true);
    expect(result.results.boundary.passed).toBe(true);
    // adversarial 安全检查失败（Skill body 无兜底确认声明）
    expect(result.results.adversarial.safetyCheck).toBe(false);
    expect(result.results.adversarial.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('未提供 testCases 时通过 generateTestCases 回调生成', async () => {
    const skill = makeSkill('这是一个安全的 Skill，含确认机制。');
    const generatedCases: SkillTestCases = makeTestCases();
    const deps: SkillValidatorDeps = {
      llmClient: makeLlmClient('ok'),
      modelId: 'test-model',
      checkTrigger: () => true,
      checkOutput: async () => true,
      generateTestCases: vi.fn().mockResolvedValue(generatedCases),
    };
    const validator = new SkillValidator(deps);
    const result = await validator.validate(skill); // 不传 testCases

    expect(deps.generateTestCases).toHaveBeenCalledWith(skill);
    expect(result.passed).toBe(true);
  });
});

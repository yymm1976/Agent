// tests/skills/fallback-checker.test.ts
// Skill 兜底确认检查器单元测试（Phase 49 Task 3.3）
//
// 测试策略：
//   - 构造 ParsedSkill（content 含/不含兜底声明、确认指令、危险降级表述）
//   - 验证含"停止并询问"的兜底声明通过
//   - 验证含"自动降级"的危险表述被拒绝
//   - 验证无兜底声明时通过
//   - 验证有兜底声明但缺少确认指令时被拒绝

import { describe, it, expect } from 'vitest';
import { FallbackChecker } from '../../src/skills/fallback-checker.js';
import type { ParsedSkill } from '../../src/skills/skill-md-parser.js';

/** 构造 Skill（content 由测试指定） */
function makeSkill(content: string): ParsedSkill {
  return {
    metadata: {
      name: 'test-skill',
      description: 'a test skill for fallback checking',
      version: '1.0.0',
      author: 't',
      tags: [],
    },
    content,
    format: 'skill-md',
  };
}

describe('FallbackChecker (Phase 49 Task 3.3)', () => {
  it('含"停止并询问"的兜底声明通过', () => {
    const skill = makeSkill('如果做不到 X，请停止并询问用户。');
    const result = FallbackChecker.check(skill);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('含"自动降级"的危险表述被拒绝', () => {
    const skill = makeSkill('如果失败，自动降级为默认值。');
    const result = FallbackChecker.check(skill);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes('危险'))).toBe(true);
  });

  it('无兜底声明时通过', () => {
    const skill = makeSkill('正常的 Skill 内容，没有任何兜底逻辑。');
    const result = FallbackChecker.check(skill);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('有兜底声明但缺少确认指令时被拒绝', () => {
    // "如果失败" 是兜底声明关键词，但 content 中无确认指令
    const skill = makeSkill('如果失败，使用备用方案。');
    const result = FallbackChecker.check(skill);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.includes('确认'))).toBe(true);
  });
});

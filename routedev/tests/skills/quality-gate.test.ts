// tests/skills/quality-gate.test.ts
// Skill 质量门集成单元测试（Phase 49 Task 3.5）
//
// 测试策略：
//   - 构造 ParsedSkill（合法 / 非法）
//   - 验证 Schema 校验失败时 status=fail 阻止加载
//   - 验证 Schema + 兜底都通过时 status=pass
//   - 验证陷阱 #143：默认不运行 3 场景验证

import { describe, it, expect } from 'vitest';
import { SkillQualityGate } from '../../src/skills/quality-gate.js';
import type { ParsedSkill } from '../../src/skills/skill-md-parser.js';

describe('SkillQualityGate (Phase 49 Task 3.5)', () => {
  it('Schema 校验失败时 status=fail 阻止加载', async () => {
    // name 为空 + description 太短 → Schema 校验失败
    const skill: ParsedSkill = {
      metadata: {
        name: '',
        description: '太短',
        version: '1.0.0',
        author: 't',
        tags: [],
      },
      content: '正常内容',
      format: 'skill-md',
    };
    const gate = new SkillQualityGate();
    const result = await gate.check(skill, {});

    expect(result.status).toBe('fail');
    expect(result.schema.valid).toBe(false);
    expect(result.schema.errors.length).toBeGreaterThan(0);
  });

  it('Schema + 兜底都通过时 status=pass', async () => {
    const skill: ParsedSkill = {
      metadata: {
        name: 'valid-skill',
        description: '这是一个合法的 Skill 描述',
        version: '1.0.0',
        author: 't',
        tags: [],
      },
      content: '正常的 Skill 内容，无兜底声明',
      format: 'skill-md',
    };
    const gate = new SkillQualityGate();
    const result = await gate.check(skill, {});

    expect(result.status).toBe('pass');
    expect(result.schema.valid).toBe(true);
    expect(result.fallback.passed).toBe(true);
  });

  it('陷阱 #143：默认不运行 3 场景验证（市场导入只做 Schema + 兜底）', async () => {
    const skill: ParsedSkill = {
      metadata: {
        name: 'valid-skill',
        description: '这是一个合法的 Skill 描述',
        version: '1.0.0',
        author: 't',
        tags: [],
      },
      content: '正常内容',
      format: 'skill-md',
    };
    const gate = new SkillQualityGate();
    // 不传 runScenarioValidation
    const result = await gate.check(skill, {});

    expect(result.scenario).toBeUndefined();
    expect(result.status).toBe('pass');
  });

  it('兜底检查失败时 status=fail', async () => {
    const skill: ParsedSkill = {
      metadata: {
        name: 'valid-skill',
        description: '这是一个合法的 Skill 描述',
        version: '1.0.0',
        author: 't',
        tags: [],
      },
      // content 含危险降级表述 → 兜底检查失败
      content: '如果失败，自动降级为默认值。',
      format: 'skill-md',
    };
    const gate = new SkillQualityGate();
    const result = await gate.check(skill, {});

    expect(result.status).toBe('fail');
    expect(result.fallback.passed).toBe(false);
    expect(result.fallback.issues.length).toBeGreaterThan(0);
  });
});

// tests/skills/skill-schema-validator.test.ts
// Skill JSON Schema 校验器单元测试（Phase 49 Task 3.4）
//
// 测试策略：
//   - 构造 ParsedSkill（含/不含合规的 metadata）
//   - 验证合法 Skill 通过、缺 name 拒绝、name 非 kebab-case 拒绝、
//     description 太短拒绝、tags 太多拒绝
//   - 验证 SKILL_JSON_SCHEMA 常量符合蓝图定义

import { describe, it, expect } from 'vitest';
import {
  SkillSchemaValidator,
  SKILL_JSON_SCHEMA,
} from '../../src/skills/skill-schema-validator.js';
import type { ParsedSkill } from '../../src/skills/skill-md-parser.js';

/** 构造合法 Skill（可通过覆盖 metadata 字段构造非法 Skill） */
function makeSkill(overrides: Partial<ParsedSkill['metadata']> = {}): ParsedSkill {
  return {
    metadata: {
      name: 'valid-skill-name',
      description: '这是一个合法的 Skill 描述，长度足够',
      version: '1.0.0',
      author: 'test',
      tags: ['tag1', 'tag2'],
      ...overrides,
    },
    content: 'Skill body',
    format: 'skill-md',
  };
}

describe('SkillSchemaValidator (Phase 49 Task 3.4)', () => {
  it('合法 Skill 通过校验', () => {
    const result = SkillSchemaValidator.validate(makeSkill());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('缺失 name 时拒绝', () => {
    const result = SkillSchemaValidator.validate(makeSkill({ name: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('name 不符合 kebab-case 时拒绝', () => {
    const result = SkillSchemaValidator.validate(makeSkill({ name: 'Invalid_Name' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('kebab-case'))).toBe(true);
  });

  it('description 长度太短时拒绝', () => {
    const result = SkillSchemaValidator.validate(makeSkill({ description: '太短' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('tags 超过 10 个时拒绝', () => {
    const result = SkillSchemaValidator.validate(
      makeSkill({ tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tags'))).toBe(true);
  });

  it('SKILL_JSON_SCHEMA 常量符合蓝图 3.4 节定义', () => {
    expect(SKILL_JSON_SCHEMA.type).toBe('object');
    expect(SKILL_JSON_SCHEMA.required).toEqual(['name', 'description']);
    expect(SKILL_JSON_SCHEMA.properties.name.pattern).toBe('^[a-z0-9-]+$');
    expect(SKILL_JSON_SCHEMA.properties.description.minLength).toBe(10);
    expect(SKILL_JSON_SCHEMA.properties.description.maxLength).toBe(200);
    expect(SKILL_JSON_SCHEMA.properties.version.pattern).toBe('^\\d+\\.\\d+\\.\\d+$');
    expect(SKILL_JSON_SCHEMA.properties.tags.maxItems).toBe(10);
  });
});

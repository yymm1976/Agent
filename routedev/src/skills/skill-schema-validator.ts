// src/skills/skill-schema-validator.ts
// Skill JSON Schema 校验器（Phase 49 Task 3.4）
//
// 知识库原文：
//   "JSON Schema 校验：除 markdown 描述外，用 JSON 定义 skill 的
//    name/description/scope。Hook 脚本校验字段完整性，防止 skill
//    缺失关键信息。"
//
// 校验内容：
//   1. frontmatter 字段完整性（required: name, description）
//   2. name 格式（kebab-case：^[a-z0-9-]+$，长度 2-64）
//   3. description 长度（10-200 字符）
//   4. version 格式（^\d+\.\d+\.\d+$，若提供则校验）
//   5. tags 数量上限（maxItems: 10）

import type { ParsedSkill } from './skill-md-parser.js';

/** Schema 校验结果 */
export interface SchemaValidationResult {
  /** 是否通过校验 */
  valid: boolean;
  /** 错误信息列表（空数组表示通过） */
  errors: string[];
}

/**
 * Skill JSON Schema 定义（蓝图 3.4 节）
 *
 * 此常量描述了 Skill frontmatter 的标准结构，可用于：
 *   - 文档参考
 *   - 外部 Hook 脚本消费
 *   - IDE 自动补全
 *
 * 实际校验逻辑在 SkillSchemaValidator.validate 中实现，
 * 不依赖 ajv 等运行时 schema 校验库（避免引入额外依赖）。
 */
export const SKILL_JSON_SCHEMA = {
  type: 'object',
  required: ['name', 'description'],
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 2, maxLength: 64 },
    description: { type: 'string', minLength: 10, maxLength: 200 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    author: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  },
} as const;

/** name 格式正则（kebab-case：仅小写字母、数字、连字符） */
const NAME_PATTERN = /^[a-z0-9-]+$/;
/** version 格式正则（X.Y.Z 语义化版本） */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** name 最小长度 */
const NAME_MIN_LENGTH = 2;
/** name 最大长度 */
const NAME_MAX_LENGTH = 64;
/** description 最小长度 */
const DESC_MIN_LENGTH = 10;
/** description 最大长度 */
const DESC_MAX_LENGTH = 200;
/** tags 最大数量 */
const TAGS_MAX_ITEMS = 10;

/**
 * Skill JSON Schema 校验器
 *
 * 校验 ParsedSkill 的 metadata 字段是否符合 SKILL_JSON_SCHEMA 定义。
 * 不通过时返回错误列表，调用方（如质量门）据此决定是否阻止 Skill 加载。
 */
export class SkillSchemaValidator {
  /**
   * 校验 Skill 的 frontmatter 字段完整性
   *
   * @param skill 已解析的 Skill
   * @returns 校验结果（valid=true 表示通过）
   */
  static validate(skill: ParsedSkill): SchemaValidationResult {
    const errors: string[] = [];
    const { metadata } = skill;

    // ===== required: name =====
    if (!metadata.name || metadata.name.trim().length === 0) {
      errors.push('metadata.name 缺失或为空');
    } else {
      // name 格式：kebab-case
      if (!NAME_PATTERN.test(metadata.name)) {
        errors.push(
          `metadata.name "${metadata.name}" 不符合 kebab-case 格式（必须匹配 ^[a-z0-9-]+$）`,
        );
      }
      if (metadata.name.length < NAME_MIN_LENGTH || metadata.name.length > NAME_MAX_LENGTH) {
        errors.push(
          `metadata.name 长度 ${metadata.name.length} 不在允许范围 [${NAME_MIN_LENGTH}, ${NAME_MAX_LENGTH}]`,
        );
      }
    }

    // ===== required: description =====
    if (!metadata.description || metadata.description.trim().length === 0) {
      errors.push('metadata.description 缺失或为空');
    } else {
      if (metadata.description.length < DESC_MIN_LENGTH) {
        errors.push(
          `metadata.description 长度 ${metadata.description.length} 小于最小长度 ${DESC_MIN_LENGTH}`,
        );
      }
      if (metadata.description.length > DESC_MAX_LENGTH) {
        errors.push(
          `metadata.description 长度 ${metadata.description.length} 超过最大长度 ${DESC_MAX_LENGTH}`,
        );
      }
    }

    // ===== version 格式（可选字段；若提供则校验格式） =====
    if (metadata.version && !VERSION_PATTERN.test(metadata.version)) {
      errors.push(
        `metadata.version "${metadata.version}" 不符合 X.Y.Z 语义化版本格式`,
      );
    }

    // ===== tags 数量上限 =====
    if (Array.isArray(metadata.tags) && metadata.tags.length > TAGS_MAX_ITEMS) {
      errors.push(
        `metadata.tags 数量 ${metadata.tags.length} 超过最大值 ${TAGS_MAX_ITEMS}`,
      );
    }

    return { valid: errors.length === 0, errors };
  }
}

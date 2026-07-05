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
//   6. P0-7：when_to_use 长度上限（500 字符）
//   7. P0-7：allowed-tools 元素格式（kebab-case + 下划线）
//   8. P0-7：arguments 元素 name 必填且唯一
//   9. P0-7：paths 元素为非空字符串
//   10. P0-7：argument-hint 长度上限（100 字符）

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
 * P0-7 扩展：新增 when_to_use / allowed-tools / arguments / argument-hint / paths 字段
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
    // P0-7：新增字段（可选）
    whenToUse: { type: 'string', maxLength: 500 },
    allowedTools: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$' },
      maxItems: 50,
    },
    arguments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
          required: { type: 'boolean' },
          default: { type: 'string' },
          description: { type: 'string', maxLength: 200 },
        },
      },
      maxItems: 20,
    },
    argumentHint: { type: 'string', maxLength: 100 },
    paths: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
  },
} as const;

/** name 格式正则（kebab-case：仅小写字母、数字、连字符） */
const NAME_PATTERN = /^[a-z0-9-]+$/;
/** version 格式正则（X.Y.Z 语义化版本） */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/** P0-7：allowed-tools 元素格式（小写字母开头，可含数字/下划线/连字符） */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
/** P0-7：arguments 元素 name 格式（字母开头，可含数字/下划线/连字符） */
const ARG_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

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
/** P0-7：when_to_use 最大长度 */
const WHEN_TO_USE_MAX_LENGTH = 500;
/** P0-7：argument-hint 最大长度 */
const ARGUMENT_HINT_MAX_LENGTH = 100;
/** P0-7：allowed-tools 最大数量 */
const ALLOWED_TOOLS_MAX_ITEMS = 50;
/** P0-7：arguments 最大数量 */
const ARGUMENTS_MAX_ITEMS = 20;
/** P0-7：paths 最大数量 */
const PATHS_MAX_ITEMS = 20;

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

    // ===== P0-7：whenToUse 长度上限 =====
    if (metadata.whenToUse !== undefined) {
      if (metadata.whenToUse.length > WHEN_TO_USE_MAX_LENGTH) {
        errors.push(
          `metadata.whenToUse 长度 ${metadata.whenToUse.length} 超过最大值 ${WHEN_TO_USE_MAX_LENGTH}`,
        );
      }
    }

    // ===== P0-7：allowedTools 元素格式 + 数量上限 =====
    if (metadata.allowedTools !== undefined) {
      if (!Array.isArray(metadata.allowedTools)) {
        errors.push('metadata.allowedTools 必须是字符串数组');
      } else {
        if (metadata.allowedTools.length > ALLOWED_TOOLS_MAX_ITEMS) {
          errors.push(
            `metadata.allowedTools 数量 ${metadata.allowedTools.length} 超过最大值 ${ALLOWED_TOOLS_MAX_ITEMS}`,
          );
        }
        for (const tool of metadata.allowedTools) {
          if (!TOOL_NAME_PATTERN.test(tool)) {
            errors.push(
              `metadata.allowedTools 元素 "${tool}" 不符合格式（必须匹配 ^[a-z][a-z0-9_-]*$）`,
            );
          }
        }
      }
    }

    // ===== P0-7：arguments 元素校验 =====
    if (metadata.arguments !== undefined) {
      if (!Array.isArray(metadata.arguments)) {
        errors.push('metadata.arguments 必须是数组');
      } else {
        if (metadata.arguments.length > ARGUMENTS_MAX_ITEMS) {
          errors.push(
            `metadata.arguments 数量 ${metadata.arguments.length} 超过最大值 ${ARGUMENTS_MAX_ITEMS}`,
          );
        }
        const seenNames = new Set<string>();
        for (let i = 0; i < metadata.arguments.length; i++) {
          const arg = metadata.arguments[i];
          if (!arg || typeof arg.name !== 'string' || arg.name.trim().length === 0) {
            errors.push(`metadata.arguments[${i}] 缺少 name 字段`);
            continue;
          }
          if (!ARG_NAME_PATTERN.test(arg.name)) {
            errors.push(
              `metadata.arguments[${i}].name "${arg.name}" 不符合格式（必须匹配 ^[a-zA-Z][a-zA-Z0-9_-]*$）`,
            );
          }
          if (seenNames.has(arg.name)) {
            errors.push(`metadata.arguments[${i}].name "${arg.name}" 重复`);
          }
          seenNames.add(arg.name);
        }
      }
    }

    // ===== P0-7：argumentHint 长度上限 =====
    if (metadata.argumentHint !== undefined && metadata.argumentHint.length > ARGUMENT_HINT_MAX_LENGTH) {
      errors.push(
        `metadata.argumentHint 长度 ${metadata.argumentHint.length} 超过最大值 ${ARGUMENT_HINT_MAX_LENGTH}`,
      );
    }

    // ===== P0-7：paths 元素非空 + 数量上限 =====
    if (metadata.paths !== undefined) {
      if (!Array.isArray(metadata.paths)) {
        errors.push('metadata.paths 必须是字符串数组');
      } else {
        if (metadata.paths.length > PATHS_MAX_ITEMS) {
          errors.push(
            `metadata.paths 数量 ${metadata.paths.length} 超过最大值 ${PATHS_MAX_ITEMS}`,
          );
        }
        for (const p of metadata.paths) {
          if (typeof p !== 'string' || p.trim().length === 0) {
            errors.push('metadata.paths 元素必须是非空字符串');
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

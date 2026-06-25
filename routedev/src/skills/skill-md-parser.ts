// src/skills/skill-md-parser.ts
// SKILL.md 标准解析器
//
// 设计目标：
//   1. 解析 SKILL.md（YAML frontmatter + Markdown 正文）
//   2. 兼容旧格式 JSON
//   3. 序列化为 SKILL.md 格式
//   4. frontmatter 解析失败时回退为纯 Markdown
//
// 文件格式（SKILL.md）：
//   ---
//   name: my-skill
//   description: 一句话描述
//   version: 1.0.0
//   author: anonymous
//   tags: [tag1, tag2]
//   ---
//   <Markdown 正文>

import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
}

export interface ParsedSkill {
  metadata: SkillMetadata;
  content: string;
  format: 'skill-md' | 'json' | 'yaml';
}

// ============================================================
// SkillMdParser
// ============================================================

export class SkillMdParser {
  /** 默认元数据，用于回退场景 */
  private static readonly DEFAULT_METADATA: SkillMetadata = {
    name: 'unknown',
    description: '',
    version: '0.0.0',
    author: 'anonymous',
    tags: [],
  };

  /**
   * 解析 SKILL.md（YAML frontmatter + Markdown）
   *
   * 失败时调用 parseSafe 回退为纯 Markdown
   */
  static parse(content: string): ParsedSkill {
    if (typeof content !== 'string' || content.length === 0) {
      return SkillMdParser.parseSafe(content ?? '');
    }

    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!frontmatterMatch) {
      logger.debug('SkillMdParser.parse: no frontmatter found, fallback to safe parse');
      return SkillMdParser.parseSafe(content);
    }

    const frontmatterRaw = frontmatterMatch[1];
    const body = frontmatterMatch[2] ?? '';

    let frontObj: Record<string, unknown>;
    try {
      frontObj = parseYaml(frontmatterRaw) as Record<string, unknown>;
      if (!frontObj || typeof frontObj !== 'object') {
        throw new Error('frontmatter is not an object');
      }
    } catch (err) {
      logger.warn('SkillMdParser.parse: frontmatter parse failed, fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return SkillMdParser.parseSafe(content);
    }

    const metadata = SkillMdParser.extractMetadata(frontObj);
    return {
      metadata,
      content: body.trim(),
      format: 'skill-md',
    };
  }

  /**
   * 解析旧格式 JSON
   *
   * 旧格式：
   *   {
   *     "name": "my-skill",
   *     "description": "...",
   *     "version": "1.0.0",
   *     "author": "...",
   *     "tags": ["..."],
   *     "content": "..."
   *   }
   */
  static parseJson(content: string): ParsedSkill {
    if (typeof content !== 'string' || content.length === 0) {
      return {
        metadata: { ...SkillMdParser.DEFAULT_METADATA },
        content: '',
        format: 'json',
      };
    }

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      logger.warn('SkillMdParser.parseJson: JSON parse failed, fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return SkillMdParser.parseSafe(content);
    }

    const metadata = SkillMdParser.extractMetadata(obj);
    const body = typeof obj.content === 'string' ? obj.content : '';

    return {
      metadata,
      content: body,
      format: 'json',
    };
  }

  /**
   * 序列化为 SKILL.md 格式
   */
  static serialize(metadata: SkillMetadata, content: string): string {
    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.length > 0
        ? `\n  - ${metadata.tags.join('\n  - ')}`
        : ' []'
      : ' []';

    const frontmatter = [
      '---',
      `name: ${SkillMdParser.escapeYamlScalar(metadata.name)}`,
      `description: ${SkillMdParser.escapeYamlScalar(metadata.description)}`,
      `version: ${SkillMdParser.escapeYamlScalar(metadata.version)}`,
      `author: ${SkillMdParser.escapeYamlScalar(metadata.author)}`,
      `tags:${tags}`,
      '---',
    ].join('\n');

    return `${frontmatter}\n\n${content.trim()}\n`;
  }

  /**
   * frontmatter 解析失败时回退为纯 Markdown
   *
   * 整段内容视为正文，元数据使用默认值
   */
  static parseSafe(content: string): ParsedSkill {
    return {
      metadata: { ...SkillMdParser.DEFAULT_METADATA },
      content: (content ?? '').trim(),
      format: 'skill-md',
    };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 从对象中提取并规范化 SkillMetadata */
  private static extractMetadata(obj: Record<string, unknown>): SkillMetadata {
    return {
      name: SkillMdParser.asString(obj.name, 'unknown'),
      description: SkillMdParser.asString(obj.description, ''),
      version: SkillMdParser.asString(obj.version, '0.0.0'),
      author: SkillMdParser.asString(obj.author, 'anonymous'),
      tags: SkillMdParser.asStringArray(obj.tags),
    };
  }

  /** 安全转换为字符串，缺失时返回默认值 */
  private static asString(value: unknown, defaultValue: string): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return defaultValue;
    return String(value);
  }

  /** 安全转换为字符串数组 */
  private static asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  /** 简单转义 YAML 标量值（避免特殊字符破坏 frontmatter） */
  private static escapeYamlScalar(value: string): string {
    if (value === undefined || value === null) return '""';
    const str = String(value);
    // 含冒号、井号、方括号等特殊字符时用双引号包裹
    if (/[:#{}\[\],&*!|>'"%@`]/.test(str) || str.includes('\n')) {
      return JSON.stringify(str);
    }
    return str;
  }
}

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
//   when_to_use: 当用户需要 ... 时使用
//   allowed-tools: [file_read, file_edit]
//   arguments: [foo, bar]
//   argument-hint: "<foo> <bar>"
//   paths: ["src/**/*.ts"]
//   ---
//   <Markdown 正文>
//
// P0-7 改造（2026-07-05）：扩展 frontmatter 契约，对齐 Claude Code loadSkillsDir 字段集
//   - when_to_use：注入 system prompt 影响 skill 触发概率
//   - allowed-tools：白名单（配合权限系统做"这个 skill 只能读不能写"）
//   - arguments / argument-hint：参数声明（支持 $ARGUMENTS / $0 / $1 / $foo 占位符）
//   - paths：按文件路径自动激活的 glob 模式
//   - 兼容旧字段：未声明新字段时按原行为运行

import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** P0-7：参数声明条目（命名参数支持 $foo 占位符） */
export interface SkillArgumentDef {
  /** 参数名（kebab-case） */
  name: string;
  /** 是否必需 */
  required?: boolean;
  /** 默认值（字符串） */
  default?: string;
  /** 简短描述 */
  description?: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  /** P0-7：触发条件描述，注入 system prompt 影响触发概率 */
  whenToUse?: string;
  /** P0-7：工具白名单（省略 = 不限制；空数组 = 无工具权限） */
  allowedTools?: string[];
  /** P0-7：参数声明（命名参数列表） */
  arguments?: SkillArgumentDef[];
  /** P0-7：参数提示文本（显示在 /help 和补全中） */
  argumentHint?: string;
  /** P0-7：按文件路径自动激活的 glob 模式列表 */
  paths?: string[];
  /** B-17：能力格式版本（SKILL.md 结构版本；缺省视为 '1'） */
  capabilityVersion?: string;
  /** B-17：最小 RouteDev 宿主版本（semver；低于此版本拒绝加载） */
  minRouteDevVersion?: string;
  /** B-17：数据访问声明（缺省 = 无网络/无环境变量读取/文件仅限工作区） */
  permissions?: {
    /** 文件访问 glob（省略 = 仅工作区内路径；显式列出可超出工作区） */
    files?: string[];
    /** 是否访问网络（缺省 false） */
    network?: boolean;
    /** 需要读取的环境变量名（缺省 = 不读取） */
    env?: string[];
  };
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
   *
   * P0-7：新增字段在存在时才输出，保持向后兼容（旧工具读取新文件时忽略未知字段）
   */
  static serialize(metadata: SkillMetadata, content: string): string {
    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.length > 0
        ? `\n  - ${metadata.tags.join('\n  - ')}`
        : ' []'
      : ' []';

    const lines: string[] = [
      '---',
      `name: ${SkillMdParser.escapeYamlScalar(metadata.name)}`,
      `description: ${SkillMdParser.escapeYamlScalar(metadata.description)}`,
      `version: ${SkillMdParser.escapeYamlScalar(metadata.version)}`,
      `author: ${SkillMdParser.escapeYamlScalar(metadata.author)}`,
      `tags:${tags}`,
    ];

    // P0-7：可选字段（存在时输出，使用 snake/kebab-case 与 Claude Code 对齐）
    if (metadata.whenToUse) {
      lines.push(`when_to_use: ${SkillMdParser.escapeYamlScalar(metadata.whenToUse)}`);
    }
    if (Array.isArray(metadata.allowedTools) && metadata.allowedTools.length > 0) {
      lines.push(`allowed-tools:\n  - ${metadata.allowedTools.join('\n  - ')}`);
    }
    if (Array.isArray(metadata.arguments) && metadata.arguments.length > 0) {
      // 简写形式：仅 name 时输出字符串数组；含 required/default/description 时输出对象数组
      const allSimple = metadata.arguments.every(
        (a) => a.required === undefined && a.default === undefined && a.description === undefined,
      );
      if (allSimple) {
        lines.push(`arguments: [${metadata.arguments.map((a) => a.name).join(', ')}]`);
      } else {
        lines.push('arguments:');
        for (const a of metadata.arguments) {
          lines.push(`  - name: ${SkillMdParser.escapeYamlScalar(a.name)}`);
          if (a.required !== undefined) lines.push(`    required: ${a.required}`);
          if (a.default !== undefined) lines.push(`    default: ${SkillMdParser.escapeYamlScalar(a.default)}`);
          if (a.description !== undefined) lines.push(`    description: ${SkillMdParser.escapeYamlScalar(a.description)}`);
        }
      }
    }
    if (metadata.argumentHint) {
      lines.push(`argument-hint: ${SkillMdParser.escapeYamlScalar(metadata.argumentHint)}`);
    }
    if (Array.isArray(metadata.paths) && metadata.paths.length > 0) {
      lines.push(`paths:\n  - ${metadata.paths.join('\n  - ')}`);
    }
    // B-17：治理字段（存在时输出；缺省不输出，保持存量文件向后兼容）
    if (metadata.capabilityVersion) {
      lines.push(`capability-version: ${SkillMdParser.escapeYamlScalar(metadata.capabilityVersion)}`);
    }
    if (metadata.minRouteDevVersion) {
      lines.push(`min-routedev-version: ${SkillMdParser.escapeYamlScalar(metadata.minRouteDevVersion)}`);
    }
    if (metadata.permissions) {
      const p = metadata.permissions;
      const hasDecl = (Array.isArray(p.files) && p.files.length > 0)
        || p.network === true
        || (Array.isArray(p.env) && p.env.length > 0);
      if (hasDecl) {
        lines.push('permissions:');
        if (Array.isArray(p.files) && p.files.length > 0) {
          lines.push(`  files:\n    - ${p.files.join('\n    - ')}`);
        }
        if (p.network === true) {
          lines.push('  network: true');
        }
        if (Array.isArray(p.env) && p.env.length > 0) {
          lines.push(`  env:\n    - ${p.env.join('\n    - ')}`);
        }
      }
    }

    lines.push('---');
    const frontmatter = lines.join('\n');
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
    // P0-7：兼容 Claude Code 字段命名（snake_case → camelCase）
    //   - when_to_use / allowed-tools / argument-hint 在 frontmatter 中使用 snake/kebab-case
    //   - 内部存储统一为 camelCase
    const whenToUse =
      SkillMdParser.asOptionalString(obj.whenToUse) ??
      SkillMdParser.asOptionalString(obj.when_to_use);
    const allowedTools =
      SkillMdParser.asOptionalStringArray(obj.allowedTools) ??
      SkillMdParser.asOptionalStringArray(obj['allowed-tools']);
    const argumentHint =
      SkillMdParser.asOptionalString(obj.argumentHint) ??
      SkillMdParser.asOptionalString(obj['argument-hint']);
    const paths = SkillMdParser.asOptionalStringArray(obj.paths);

    // B-17：治理字段（kebab-case → camelCase 映射）
    const capabilityVersion =
      SkillMdParser.asOptionalString(obj.capabilityVersion) ??
      SkillMdParser.asOptionalString(obj['capability-version']);
    const minRouteDevVersion =
      SkillMdParser.asOptionalString(obj.minRouteDevVersion) ??
      SkillMdParser.asOptionalString(obj['min-routedev-version']);
    let permissions: SkillMetadata['permissions'];
    if (obj.permissions && typeof obj.permissions === 'object') {
      const p = obj.permissions as Record<string, unknown>;
      const files = SkillMdParser.asOptionalStringArray(p.files);
      const env = SkillMdParser.asOptionalStringArray(p.env);
      const network = p.network === true;
      if (files || env || network) {
        permissions = {
          ...(files ? { files } : {}),
          ...(network ? { network: true } : {}),
          ...(env ? { env } : {}),
        };
      }
    }

    return {
      name: SkillMdParser.asString(obj.name, 'unknown'),
      description: SkillMdParser.asString(obj.description, ''),
      version: SkillMdParser.asString(obj.version, '0.0.0'),
      author: SkillMdParser.asString(obj.author, 'anonymous'),
      tags: SkillMdParser.asStringArray(obj.tags),
      // P0-7：新增字段（可选，未声明时为 undefined）
      whenToUse,
      allowedTools,
      arguments: SkillMdParser.asArgumentDefs(obj.arguments),
      argumentHint,
      paths,
      // B-17：治理字段（可选）
      capabilityVersion,
      minRouteDevVersion,
      permissions,
    };
  }

  /** P0-7：可选字符串字段（未声明时返回 undefined，区别于 asString 的默认值行为） */
  private static asOptionalString(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') return value.trim() || undefined;
    return String(value);
  }

  /** P0-7：可选字符串数组字段 */
  private static asOptionalStringArray(value: unknown): string[] | undefined {
    if (value === null || value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    const arr = value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return arr.length > 0 ? arr : undefined;
  }

  /** P0-7：参数声明解析（支持字符串数组简写或对象数组完整定义） */
  private static asArgumentDefs(value: unknown): SkillArgumentDef[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const defs: SkillArgumentDef[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        // 简写形式：["foo", "bar"] → [{ name: "foo" }, { name: "bar" }]
        const trimmed = item.trim();
        if (trimmed) defs.push({ name: trimmed });
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const name = typeof obj.name === 'string' ? obj.name.trim() : '';
        if (!name) continue;
        defs.push({
          name,
          required: typeof obj.required === 'boolean' ? obj.required : undefined,
          default: typeof obj.default === 'string' ? obj.default : undefined,
          description: typeof obj.description === 'string' ? obj.description : undefined,
        });
      }
    }
    return defs.length > 0 ? defs : undefined;
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

// src/macros/types.ts
// Macro 类型定义
//
// Macro 是比 Skill 更轻量的流程指引，纯 Markdown，通过 `!` 触发器引用。
// 设计依据：Phase 48 Task 5 - Macros 系统
//
// 与 Skill 的关系：
//   - Macro 是 Skill 的轻量子集，不含脚本或外部依赖
//   - 任何 Skill 都可以作为 Macro，但 Macro 不能替代 Skill 的全部能力
//   - Macro 适合固化个人工作流（如"每天早上检查邮件"）

/**
 * Macro 的元数据（对应 MACRO.md 的 YAML frontmatter）
 */
export interface MacroMetadata {
  /** 宏名称（kebab-case，唯一标识） */
  name: string;
  /** 固定为 'macro'，用于与 SKILL.md 区分 */
  type: 'macro';
  /** 语义化版本号 */
  version: string;
  /** 作者 */
  author?: string;
  /** 关键词，用于 `!` 触发器补全搜索 */
  keywords?: string[];
  /** 一句话描述 */
  description: string;
  /** 分类（如 code-quality / daily-work） */
  category?: string;
  /** 可选：引用该 Macro 时切换到对应 Agent Profile */
  preferredProfile?: string;
}

/**
 * Macro 完整对象
 */
export interface Macro {
  metadata: MacroMetadata;
  /** MACRO.md 正文（不含 frontmatter） */
  content: string;
  /** 文件路径（内置宏为空字符串） */
  filePath: string;
  /** 来源：builtin（内置）/ user（用户创建）/ imported（导入） */
  source: 'builtin' | 'user' | 'imported';
}

/**
 * Macro 配置
 */
export interface MacroConfig {
  /** 是否启用 Macro 系统 */
  enabled: boolean;
  /** Macro 目录（相对于工作目录） */
  dir: string;
}

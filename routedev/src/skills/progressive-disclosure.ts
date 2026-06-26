// src/skills/progressive-disclosure.ts
// Skill 渐进式披露（Phase 49 Task 4.4）
//
// 设计目标（蓝图 4.4）：
//   知识库原文："渐进式披露：先给 AI 最少必要信息，
//               根据反馈逐步补充，避免一次性塞入过多 context 导致 AI 注意力分散。"
//
//   1. Skill 触发时只注入"最小集"：frontmatter + body 的"核心原则"和"适用范围"
//   2. references/ 中的详细文档按需加载（SkillFlow 的 step 节点需要时才加载）
//   3. 不在 Skill 触发时就全量加载所有 references
//
// 陷阱 #150：渐进式披露可能导致 AI 缺少关键信息
//   - 只注入"核心原则"和"适用范围"可能让 AI 不知道完整执行流程
//   - 必须有动态加载机制：AI 请求更多信息时能加载 references
//   - getMinimalInjection 只给最小集，loadReference 按需加载
//
// 与 SkillFlow 的关系：
//   - SkillFlow 的每个 step 节点只注入当前步骤的 prompt
//   - references/ 中的文件按 step 节点的需求加载
//   - 不在 Skill 触发时就全量加载所有 references

import type { ParsedSkill } from './skill-md-parser.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 最小注入集包含的章节标题（按蓝图 4.4 要求） */
const MINIMAL_SECTION_TITLES = ['核心原则', '适用范围'];

// ============================================================
// 依赖注入接口
// ============================================================

/**
 * Reference 读取接口（依赖注入）
 *
 * 不直接读取文件系统，通过此接口注入
 * 便于测试 mock，也避免 Skill 模块直接依赖文件系统
 *
 * 实现方负责：根据 skillName 定位 Skill 目录，读取 references/<referenceName> 文件
 */
export interface ReferenceReaderInterface {
  /**
   * 读取 Skill 的 reference 文件
   * @param skillName Skill 名称（用于定位 Skill 目录）
   * @param referenceName reference 文件名（不含扩展名或含扩展名，由实现方决定）
   * @returns 文件内容；不存在时返回 null
   */
  readReference(skillName: string, referenceName: string): Promise<string | null>;
}

// ============================================================
// ProgressiveDisclosure
// ============================================================

/**
 * Skill 渐进式披露
 *
 * 使用方式：
 *   const disclosure = new ProgressiveDisclosure({ readReference });
 *   const minimal = disclosure.getMinimalInjection(skill);        // 触发时注入
 *   const ref = await disclosure.loadReference(skill, 'examples'); // 按需加载
 */
export class ProgressiveDisclosure {
  private readonly referenceReader: ReferenceReaderInterface | null;

  constructor(options: { readReference?: ReferenceReaderInterface } = {}) {
    this.referenceReader = options.readReference ?? null;
  }

  /**
   * 计算 Skill 触发时的最小注入集
   *
   * 蓝图 4.4：只注入 frontmatter + body 的"核心原则"和"适用范围"部分
   * 不注入"任务路由"和"模块索引"（按需加载）
   *
   * @param skill 已解析的 Skill
   * @returns 最小注入文本（frontmatter 摘要 + 核心章节）
   */
  getMinimalInjection(skill: ParsedSkill): string {
    const parts: string[] = [];

    // frontmatter 摘要（name + description）
    parts.push(this.formatFrontmatterSummary(skill));

    // body 的核心章节
    const sections = this.splitSections(skill.content);
    const coreSections: string[] = [];
    for (const title of MINIMAL_SECTION_TITLES) {
      const content = sections.get(title);
      if (content) {
        coreSections.push(`## ${title}\n${content}`);
      }
    }

    if (coreSections.length > 0) {
      parts.push(coreSections.join('\n\n'));
    }

    // 陷阱 #150：提示 AI 可按需加载更多 reference
    parts.push(
      '（如需更详细的内容或示例，请通过 loadReference 按需加载 references/ 中的文档）',
    );

    return parts.join('\n\n');
  }

  /**
   * 按需加载 references（陷阱 #150 的动态加载机制）
   *
   * 蓝图 4.4：从 skill 目录的 references/ 下读取指定文件
   * 只在 SkillFlow 的 step 节点需要时加载
   *
   * @param skill 已解析的 Skill（用 metadata.name 定位 Skill 目录）
   * @param referenceName reference 文件名
   * @returns reference 文件内容；不存在或未配置读取器时返回空字符串
   */
  async loadReference(skill: ParsedSkill, referenceName: string): Promise<string> {
    if (!this.referenceReader) {
      logger.debug('ProgressiveDisclosure: no reference reader configured', {
        skillName: skill.metadata.name,
        referenceName,
      });
      return '';
    }

    try {
      const content = await this.referenceReader.readReference(
        skill.metadata.name,
        referenceName,
      );
      if (content === null) {
        logger.debug('ProgressiveDisclosure: reference not found', {
          skillName: skill.metadata.name,
          referenceName,
        });
        return '';
      }
      return content;
    } catch (err) {
      logger.warn('ProgressiveDisclosure: loadReference failed', {
        skillName: skill.metadata.name,
        referenceName,
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 按 ## 标题切分章节
   *
   * 解析规则：
   *   - 以 `## ` 开头的行作为章节标题（去掉 `## ` 前缀作为 key）
   *   - 标题行之后到下一个 `## ` 标题之前的所有行作为该章节的内容
   *   - 第一个 `## ` 标题之前的内容归入 `__preamble__` key
   *   - 不识别 `#`（一级标题）和 `###` 及以下（三级及以下，归入当前章节内容）
   *
   * @param content Markdown 正文
   * @returns Map<章节标题, 章节内容>
   */
  private splitSections(content: string): Map<string, string> {
    const sections = new Map<string, string>();
    if (!content) return sections;

    const lines = content.split('\n');
    let currentTitle = '__preamble__';
    let currentLines: string[] = [];

    for (const line of lines) {
      // 匹配 ## 标题（不匹配 ### 及更深）
      const match = line.match(/^##\s+(.+?)\s*$/);
      if (match) {
        // 保存上一章节
        if (currentLines.length > 0) {
          sections.set(currentTitle, currentLines.join('\n').trim());
        }
        currentTitle = match[1].trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    // 保存最后一个章节
    if (currentLines.length > 0) {
      sections.set(currentTitle, currentLines.join('\n').trim());
    }

    return sections;
  }

  /** 格式化 frontmatter 摘要 */
  private formatFrontmatterSummary(skill: ParsedSkill): string {
    const m = skill.metadata;
    const lines: string[] = [
      `# Skill: ${m.name}`,
      `描述：${m.description}`,
    ];
    if (m.version && m.version !== '0.0.0') {
      lines.push(`版本：${m.version}`);
    }
    if (m.tags.length > 0) {
      lines.push(`标签：${m.tags.join(', ')}`);
    }
    return lines.join('\n');
  }
}

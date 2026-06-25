// src/skills/skill-generator.ts
// Phase 39 Task 2：Skill AI 自动生成器
//
// 设计目标：
//   1. 用户用自然语言描述编码规范或工作流
//   2. 调用 LLM 解析需求 → 生成 SKILL.md 草稿（含 frontmatter + body）
//   3. 返回结构化结果供用户在 UI 中确认
//   4. 确认后写入 .routedev/skills/<name>/SKILL.md
//
// 与 FilesystemDiscovery.createSkill 的关系：
//   - createSkill 是低层 API（已知 name/description/keywords/content，直接写文件）
//   - SkillGenerator 是高层 API（从自然语言描述生成上述字段，再交给 createSkill 或自行写文件）
//
// LLM 输出 JSON 解析容错策略：
//   - 优先解析 ```json ... ``` 代码块
//   - 失败则尝试直接 JSON.parse
//   - 仍失败则用正则提取字段（兜底）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ILLMClient, LLMResponse } from '../router/types.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** Skill 生成请求 */
export interface SkillGenerationRequest {
  /** 用户的自然语言描述 */
  description: string;
  /** 项目名（可选，用于在 prompt 中提供上下文） */
  projectName?: string;
}

/** 生成的 Skill 结构 */
export interface GeneratedSkill {
  /** 从描述生成的语义化名称（kebab-case） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 路由关键词（5-10 个） */
  routingKeywords: string[];
  /** SKILL.md 的 body（Markdown，使用 ## 分节） */
  content: string;
}

// ============================================================
// 常量
// ============================================================

/** LLM 输出 JSON 的字段结构（用于 prompt 说明） */
interface LLMGeneratedSkill {
  name: string;
  description: string;
  keywords: string[];
  content: string;
}

/** 默认最大 token 数 */
const DEFAULT_MAX_TOKENS = 2048;

/** 默认温度（低温度保证输出稳定） */
const DEFAULT_TEMPERATURE = 0.3;

// ============================================================
// SkillGenerator
// ============================================================

/**
 * Skill 自动生成器
 *
 * 流程：
 *   1. 用户描述 → 构造 LLM prompt
 *   2. LLM 返回 JSON（含 name/description/keywords/content）
 *   3. 解析 JSON + 校验 + 规范化（name 转 kebab-case）
 *   4. 返回 GeneratedSkill 供 UI 确认
 *   5. save() 写入文件系统
 */
export class SkillGenerator {
  constructor(
    private llmClient: ILLMClient,
    private modelId: string,
  ) {}

  /**
   * 根据自然语言描述生成 Skill 配置
   *
   * 步骤：
   *   1. 构造 LLM prompt，要求输出 JSON：{ name, description, keywords, content }
   *   2. content 是 Markdown 格式的规则正文，使用 ## 分节
   *   3. name 使用 kebab-case，从描述中提取核心概念
   *   4. keywords 5-10 个，覆盖触发场景
   */
  async generate(request: SkillGenerationRequest): Promise<GeneratedSkill> {
    if (!request.description || request.description.trim().length === 0) {
      throw new Error('Skill 描述不能为空');
    }

    const prompt = this.buildPrompt(request);

    logger.debug('SkillGenerator: calling LLM', {
      model: this.modelId,
      descriptionLength: request.description.length,
      projectName: request.projectName,
    });

    const response: LLMResponse = await this.llmClient.complete({
      model: this.modelId,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
    });

    const parsed = this.parseLLMResponse(response.content);
    const normalized = this.normalize(parsed);

    logger.info('SkillGenerator: skill generated', {
      name: normalized.name,
      keywordCount: normalized.routingKeywords.length,
      contentLength: normalized.content.length,
    });

    return normalized;
  }

  /**
   * 保存生成的 Skill 到文件系统
   *
   * 写入 ${skillsDir}/${skill.name}/SKILL.md
   * 文件格式：
   *   ---
   *   description: 一句话描述
   *   keywords: keyword1, keyword2, ...
   *   ---
   *   <body>
   *
   * @param skill 生成的 Skill
   * @param skillsDir skills 目录绝对路径
   * @returns 保存的文件绝对路径
   */
  async save(skill: GeneratedSkill, skillsDir: string): Promise<string> {
    // 校验名称合法性（仅字母数字连字符）
    if (!/^[a-zA-Z0-9-]+$/.test(skill.name)) {
      throw new Error(`Skill 名称只能包含字母、数字和连字符: ${skill.name}`);
    }

    const skillDir = path.join(skillsDir, skill.name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    await fs.mkdir(skillDir, { recursive: true });

    const markdown = [
      '---',
      `description: ${skill.description}`,
      `keywords: ${skill.routingKeywords.join(', ')}`,
      '---',
      skill.content,
    ].join('\n');

    await fs.writeFile(skillFile, markdown, 'utf-8');

    logger.info('SkillGenerator: skill saved', { name: skill.name, path: skillFile });
    return skillFile;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 构造 LLM prompt
   *
   * 设计要点：
   *   - 明确要求输出 JSON 格式
   *   - 给出字段约束（name 用 kebab-case，keywords 5-10 个）
   *   - 给出 content 格式约束（## 分节，列表项描述规则）
   *   - 给出可执行性约束（规则要具体，不要过于宽泛）
   */
  private buildPrompt(request: SkillGenerationRequest): string {
    const projectLine = request.projectName
      ? `\n项目名：${request.projectName}`
      : '';

    return `你是一个编码规范生成器。用户会描述他的编码规范或工作流，你需要生成一个 Skill 配置。

用户描述：${request.description}${projectLine}

请输出 JSON 格式：
{
  "name": "kebab-case名称",
  "description": "一句话描述",
  "keywords": ["关键词1", "关键词2", ...],
  "content": "Markdown格式的规则正文，用 ## 分节"
}

规则：
1. name 从描述中提取核心概念，用 kebab-case
2. keywords 5-10 个，覆盖触发场景
3. content 用 ## 分节，每节用 - 列表项描述具体规则
4. 规则要具体可执行，不要过于宽泛

只输出 JSON，不要输出其他内容。`;
  }

  /**
   * 解析 LLM 响应为结构化对象
   *
   * 容错策略：
   *   1. 优先解析 ```json ... ``` 代码块
   *   2. 失败则尝试直接 JSON.parse
   *   3. 仍失败则用正则提取字段（兜底）
   */
  private parseLLMResponse(raw: string): LLMGeneratedSkill {
    // 策略 1：提取 ```json ... ``` 代码块
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        return this.parseJsonObject(codeBlockMatch[1]);
      } catch {
        // 继续尝试其他策略
      }
    }

    // 策略 2：直接 JSON.parse
    try {
      return this.parseJsonObject(raw);
    } catch {
      // 继续尝试兜底
    }

    // 策略 3：正则兜底提取
    logger.warn('SkillGenerator: JSON parse failed, using regex fallback', {
      rawLength: raw.length,
      rawPreview: raw.slice(0, 100),
    });
    return this.extractByRegex(raw);
  }

  /** 安全的 JSON 解析 + 字段校验 */
  private parseJsonObject(text: string): LLMGeneratedSkill {
    const trimmed = text.trim();
    const obj = JSON.parse(trimmed) as Partial<LLMGeneratedSkill>;

    if (typeof obj.name !== 'string') throw new Error('LLM 输出缺少 name 字段');
    if (typeof obj.description !== 'string') throw new Error('LLM 输出缺少 description 字段');
    if (!Array.isArray(obj.keywords)) throw new Error('LLM 输出缺少 keywords 字段');
    if (typeof obj.content !== 'string') throw new Error('LLM 输出缺少 content 字段');

    return {
      name: obj.name,
      description: obj.description,
      keywords: obj.keywords.filter((k): k is string => typeof k === 'string'),
      content: obj.content,
    };
  }

  /** 正则兜底提取（LLM 输出非 JSON 时） */
  private extractByRegex(raw: string): LLMGeneratedSkill {
    // 兼容带引号和不带引号的 key（如 "name": "x" 或 name: "x"）
    const nameMatch = raw.match(/"?name"?\s*:\s*"([^"]+)"/);
    const descMatch = raw.match(/"?description"?\s*:\s*"([^"]+)"/);
    const contentMatch = raw.match(/"?content"?\s*:\s*"([\s\S]*?)"\s*[,}\n]/);
    const keywordsMatch = raw.match(/"?keywords"?\s*:\s*\[([\s\S]*?)\]/);

    const keywords: string[] = [];
    if (keywordsMatch) {
      const kwRaw = keywordsMatch[1];
      const kwMatches = kwRaw.matchAll(/"([^"]+)"/g);
      for (const m of kwMatches) {
        keywords.push(m[1]);
      }
    }

    const name = nameMatch?.[1] ?? 'generated-skill';
    const description = descMatch?.[1] ?? '自动生成的 Skill';
    const content = contentMatch?.[1] ?? '## 规则\n- 待补充';

    return { name, description, keywords, content };
  }

  /**
   * 规范化生成的 Skill
   *   - name 转 kebab-case
   *   - keywords 去重 + 限长
   *   - content 去除多余空白
   */
  private normalize(parsed: LLMGeneratedSkill): GeneratedSkill {
    const name = toKebabCase(parsed.name);
    const keywords = Array.from(new Set(parsed.keywords))
      .filter((k) => k.trim().length > 0)
      .slice(0, 10);
    const content = parsed.content.trim();

    return {
      name,
      description: parsed.description.trim(),
      routingKeywords: keywords,
      content,
    };
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 将任意字符串转换为 kebab-case
 *
 * 示例：
 *   "My Skill Name" → "my-skill-name"
 *   "mySkillName"   → "my-skill-name"
 *   "MySkillName"   → "my-skill-name"
 *   "my_skill_name" → "my-skill-name"
 *   "my-skill-name" → "my-skill-name"
 *   "我的 Skill"     → "skill"（过滤非 ASCII 字母数字）
 */
export function toKebabCase(input: string): string {
  return input
    // 先处理 camelCase / PascalCase：在大小写边界插入空格
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // 将下划线/空格/其他分隔符统一为空格
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    // 过滤非 ASCII 字母数字（保留中文等会被过滤，避免目录名问题）
    .filter((s) => /^[a-z0-9]+$/.test(s))
    .join('-');
}

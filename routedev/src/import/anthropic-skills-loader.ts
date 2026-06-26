// src/import/anthropic-skills-loader.ts
// Anthropic Skills 目录扫描加载器
//
// 设计目标：
//   1. 扫描项目根目录下的 anthropic_skills/**/SKILL.md，与内置 Skill 合并加载
//   2. 复用 SkillMdParser 解析 frontmatter + 正文，不重新造轮子
//   3. 来源标注 origin: 'anthropic-skills'，便于在 UI 中区分展示
//   4. 不复制文件，只读取并返回元数据 + 内容（上层决定如何处理）
//   5. 目录不存在时返回空数组，不抛错（陷阱：缺失目录是正常状态）
//   6. 单个 SKILL.md 解析失败时记入 errors，不影响其他 Skill 加载
//
// 来源：Phase 48 Task 2 蓝图 2.2

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { SkillMdParser } from '../skills/skill-md-parser.js';

// ============================================================
// 类型定义
// ============================================================

/**
 * 加载完成的 Skill（外部生态来源）
 *
 * 与内置 SkillData 的差异：
 *   - 多了 origin 字段（'anthropic-skills' | 'claude-plugin'）
 *   - 多了 sourcePath 字段（原始 SKILL.md 绝对路径，便于回溯）
 *   - 多了 autoEnable 字段（受 config.import.anthropicSkillsAutoEnable 控制）
 */
export interface LoadedSkill {
  /** Skill 名称（来自 frontmatter.name，缺失时回退目录名） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 语义化版本号 */
  version: string;
  /** 作者 */
  author: string;
  /** 路由关键词 */
  tags: string[];
  /** SKILL.md 正文（已剥离 frontmatter） */
  content: string;
  /** SKILL.md 绝对路径（便于回溯源文件） */
  sourcePath: string;
  /** 来源标注 */
  origin: 'anthropic-skills' | 'claude-plugin';
  /** 是否自动启用（受 config.import.anthropicSkillsAutoEnable 控制） */
  autoEnable: boolean;
}

/** 加载结果 */
export interface LoadResult {
  /** 成功加载的 Skill 列表 */
  loaded: LoadedSkill[];
  /** 加载过程中的错误（每个失败的 SKILL.md 一条） */
  errors: Array<{ path: string; error: string }>;
}

// ============================================================
// AnthropicSkillsLoader
// ============================================================

/**
 * Anthropic Skills 目录扫描加载器
 *
 * 用法：
 *   const loader = new AnthropicSkillsLoader();
 *   const result = await loader.load(projectRoot, { autoEnable: false });
 *   result.loaded.forEach(s => register(s));
 *
 * 设计要点：
 *   - scan()：仅扫描并返回 LoadedSkill[]，不读取 autoEnable
 *   - load()：scan + 注入 autoEnable 标志，并返回 errors
 *   - 目录不存在时返回空数组（不抛错）
 *   - 单个文件解析失败时记入 errors 不中断整体扫描
 */
export class AnthropicSkillsLoader {
  /** 扫描根目录名（相对项目根） */
  static readonly SKILLS_DIR_NAME = 'anthropic_skills';
  /** SKILL.md 文件名 */
  static readonly SKILL_FILE_NAME = 'SKILL.md';

  /**
   * 扫描项目根下的 anthropic_skills/{name}/SKILL.md
   *
   * 不读取 autoEnable 标志（autoEnable 由 load() 注入）；
   * 默认 autoEnable=false，调用方按需覆盖
   *
   * @param projectRoot 项目根目录绝对路径
   * @returns 加载到的 Skill 列表（autoEnable 全部为 false）
   */
  async scan(projectRoot: string): Promise<LoadedSkill[]> {
    const skillsDir = path.join(projectRoot, AnthropicSkillsLoader.SKILLS_DIR_NAME);
    const loaded: LoadedSkill[] = [];

    // 目录不存在时静默返回空数组
    if (!fsSync.existsSync(skillsDir)) {
      logger.debug('AnthropicSkillsLoader.scan: directory not found', { skillsDir });
      return loaded;
    }

    // 递归查找所有 SKILL.md
    const skillFiles = await this.findSkillFiles(skillsDir);
    for (const file of skillFiles) {
      try {
        const skill = await this.parseSkillFile(file, 'anthropic-skills', false);
        if (skill) loaded.push(skill);
      } catch (err) {
        // scan 不返回 errors，错误由 load() 收集；这里只记日志
        logger.warn('AnthropicSkillsLoader.scan: parse failed', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return loaded;
  }

  /**
   * 扫描并加载，注入 autoEnable 标志，收集 errors
   *
   * @param projectRoot 项目根目录绝对路径
   * @param options.autoEnable 是否自动启用（受 config.import.anthropicSkillsAutoEnable 控制）
   * @returns LoadResult（loaded + errors）
   */
  async load(
    projectRoot: string,
    options: { autoEnable: boolean },
  ): Promise<LoadResult> {
    const skillsDir = path.join(projectRoot, AnthropicSkillsLoader.SKILLS_DIR_NAME);
    const loaded: LoadedSkill[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    // 目录不存在时静默返回空结果
    if (!fsSync.existsSync(skillsDir)) {
      logger.debug('AnthropicSkillsLoader.load: directory not found', { skillsDir });
      return { loaded, errors };
    }

    const skillFiles = await this.findSkillFiles(skillsDir);
    for (const file of skillFiles) {
      try {
        const skill = await this.parseSkillFile(
          file,
          'anthropic-skills',
          options.autoEnable,
        );
        if (skill) {
          loaded.push(skill);
        } else {
          // parseSkillFile 返回 null 表示内容为空等可恢复场景
          errors.push({ path: file, error: 'SKILL.md 内容为空或解析后为空' });
        }
      } catch (err) {
        // 单个文件失败不影响其他文件
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push({ path: file, error: errMsg });
        logger.warn('AnthropicSkillsLoader.load: parse failed', {
          file,
          error: errMsg,
        });
      }
    }

    logger.info('AnthropicSkillsLoader.load: done', {
      total: skillFiles.length,
      loaded: loaded.length,
      errors: errors.length,
      autoEnable: options.autoEnable,
    });

    return { loaded, errors };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 递归查找目录下所有 SKILL.md
   *
   * 仅查找文件名为 SKILL.md 的文件（大小写敏感），深度不限
   */
  private async findSkillFiles(rootDir: string): Promise<string[]> {
    const results: string[] = [];
    const stack: string[] = [rootDir];

    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (err) {
        logger.warn('AnthropicSkillsLoader.findSkillFiles: readdir failed', {
          dir: current,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (
          entry.isFile() &&
          entry.name === AnthropicSkillsLoader.SKILL_FILE_NAME
        ) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }

  /**
   * 解析单个 SKILL.md
   *
   * 复用 SkillMdParser，回退 name 时使用父目录名
   *
   * @returns 解析后的 LoadedSkill；内容为空时返回 null
   */
  private async parseSkillFile(
    filePath: string,
    origin: 'anthropic-skills' | 'claude-plugin',
    autoEnable: boolean,
  ): Promise<LoadedSkill | null> {
    const raw = await fs.readFile(filePath, 'utf-8');
    if (!raw || raw.trim().length === 0) return null;

    const parsed = SkillMdParser.parse(raw);

    // 名称回退：frontmatter.name 缺失或为 'unknown' 时使用父目录名
    let name = parsed.metadata.name;
    if (!name || name === 'unknown') {
      const parentDir = path.basename(path.dirname(filePath));
      name = parentDir || 'unnamed-skill';
    }

    return {
      name,
      description: parsed.metadata.description,
      version: parsed.metadata.version,
      author: parsed.metadata.author,
      tags: parsed.metadata.tags,
      content: parsed.content,
      sourcePath: path.resolve(filePath),
      origin,
      autoEnable,
    };
  }
}

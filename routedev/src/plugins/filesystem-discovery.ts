// src/plugins/filesystem-discovery.ts
// Eve Filesystem-first 插件发现 + 四级扩展成本梯度 + Skills 按需加载
//
// 借鉴来源：Vercel Eve 框架
//
// 最优解思考：
//   1. Filesystem-first：文件名=身份，零配置注册。比显式 register() 更简洁
//   2. 四级成本梯度：让用户了解插件对 token 预算的影响
//   3. Skills 按需加载：description 作为路由提示，匹配时才注入，节省 token

import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
// P0-7：接入 SkillMdParser 消费 whenToUse/allowedTools/arguments 等新字段
import { SkillMdParser } from '../skills/skill-md-parser.js';
import type { SkillMetadata } from '../skills/skill-md-parser.js';

const SAFE_SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function resolveSkillDir(basePath: string, name: string): string {
  if (!SAFE_SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`无效的 Skill 名称: ${name}`);
  }
  const skillsRoot = path.resolve(basePath, '.routedev', 'skills');
  const skillDir = path.resolve(skillsRoot, name);
  const rel = path.relative(skillsRoot, skillDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Skill 路径越界: ${name}`);
  }
  return skillDir;
}

// ============================================================
// 四级扩展成本梯度（Eve/Claude Code）
// ============================================================

/** 扩展上下文成本级别 */
export type ContextCost = 'zero' | 'low' | 'medium' | 'high';

/** 扩展类型 */
export type ExtensionType = 'hook' | 'skill' | 'plugin' | 'mcp';

/** 扩展元数据 */
export interface ExtensionMetadata {
  /** 扩展名称 */
  name: string;
  /** 扩展类型 */
  type: ExtensionType;
  /** 上下文成本级别 */
  contextCost: ContextCost;
  /** 描述（用于路由提示和展示） */
  description: string;
  /** 路由提示（Skills 按需加载用） */
  routingHint?: string;
  /** 来源路径 */
  sourcePath?: string;
}

/** 四级成本梯度说明 */
export const CONTEXT_COST_DESCRIPTIONS: Record<ContextCost, string> = {
  zero: '零成本 — 生命周期钩子，不注入提示词',
  low: '低成本 — 按需加载的 Markdown 程序，description 作为路由提示',
  medium: '中成本 — 完整代码包，含工具+提示词',
  high: '高成本 — 外部服务器，工具 schema 全部注入上下文',
};

/** 扩展类型到默认成本的映射 */
export const DEFAULT_COST_BY_TYPE: Record<ExtensionType, ContextCost> = {
  hook: 'zero',
  skill: 'low',
  plugin: 'medium',
  mcp: 'high',
};

// ============================================================
// Skills 按需加载（Eve description 路由）
// ============================================================

/** Skill 定义（Markdown 文件 + YAML frontmatter） */
export interface SkillDefinition {
  /** Skill 名称（目录名） */
  name: string;
  /** 描述（作为路由提示） */
  description: string;
  /** 路由提示关键词列表 */
  routingKeywords: string[];
  /** Skill 内容（Markdown body） */
  content: string;
  /** 来源路径 */
  sourcePath: string;
  /**
   * P0-7：扩展字段（由 SkillMdParser 解析 SKILL.md frontmatter 得到）
   * - whenToUse：注入 system prompt，告知 LLM 何时使用此 Skill
   * - allowedTools：过滤 ToolRegistry，限制 Skill 可调用的工具集
   * - arguments：参数定义，供 PromptCommand 参数替换使用
   * - argumentHint：参数提示（如 "<query>"），用于命令补全
   * - paths：Skill 关心的文件/目录路径（用于上下文标注）
   */
  whenToUse?: string;
  allowedTools?: string[];
  arguments?: SkillMetadata['arguments'];
  argumentHint?: string;
  paths?: string[];
}

/** Skill 运行时状态（含启用/禁用标记） */
export interface SkillStatus extends SkillDefinition {
  /** 是否启用（默认 true） */
  enabled: boolean;
}

/** skill-state.json 持久化结构 */
interface SkillStateFile {
  /** 禁用的 Skill 名称列表（白名单模式：默认全部启用，只记录显式禁用的） */
  disabledSkills: string[];
}

/**
 * Skills 路由器
 *
 * 借鉴 Eve 的"description 作为路由提示"设计：
 *   框架根据 description 判断何时加载该 Skill
 *   而不是每次都注入所有 Skills
 *   只有当任务匹配 description 时，Skill 内容才被注入上下文
 *
 * 启用/禁用机制（参考 PluginRegistry）：
 *   - 默认所有发现的 Skill 都启用
 *   - 用户可显式禁用某些 Skill，状态持久化到 skill-state.json
 *   - route() 只匹配 enabled=true 的 Skill
 */
export class SkillsRouter {
  private skills: Map<string, SkillDefinition> = new Map();
  /** 禁用的 Skill 名称集合（持久化到 skill-state.json） */
  private disabledSkills: Set<string> = new Set();
  /** 状态文件路径（构造时传入，未传入则不持久化） */
  private stateFilePath: string | null = null;

  constructor(stateFilePath?: string) {
    if (stateFilePath) {
      this.stateFilePath = stateFilePath;
      this.restoreState();
    }
  }

  /** 注册 Skill */
  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    logger.debug('Skill registered', {
      name: skill.name,
      keywords: skill.routingKeywords,
      enabled: !this.disabledSkills.has(skill.name),
    });
  }

  /** 注销 Skill */
  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  /**
   * 根据任务描述路由匹配 Skills
   *
   * 只匹配 enabled=true 的 Skill。
   *
   * @param taskDescription 任务描述
   * @param maxSkills 最多返回的 Skill 数量（默认 3）
   * @returns 匹配的 Skill 列表（按相关度排序）
   */
  route(taskDescription: string, maxSkills = 3): SkillDefinition[] {
    const task = taskDescription.toLowerCase();
    const scored: Array<{ skill: SkillDefinition; score: number }> = [];

    for (const skill of this.skills.values()) {
      // 跳过已禁用的 Skill
      if (this.disabledSkills.has(skill.name)) continue;

      let score = 0;
      // 关键词匹配评分
      for (const keyword of skill.routingKeywords) {
        if (task.includes(keyword.toLowerCase())) {
          score += 10;
        }
      }
      // description 中的词匹配
      const descWords = skill.description.toLowerCase().split(/\s+/);
      for (const word of descWords) {
        if (word.length > 3 && task.includes(word)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({ skill, score });
      }
    }

    // 按分数排序，取前 N 个
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxSkills).map(s => s.skill);
  }

  /** 获取所有已注册 Skill（含启用/禁用状态） */
  listStatuses(): SkillStatus[] {
    return Array.from(this.skills.values()).map((skill) => ({
      ...skill,
      enabled: !this.disabledSkills.has(skill.name),
    }));
  }

  /** 获取所有已注册 Skill（原始定义，不含状态） */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /** 获取指定 Skill */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** 查询指定 Skill 是否启用 */
  isEnabled(name: string): boolean {
    return this.skills.has(name) && !this.disabledSkills.has(name);
  }

  /** 启用 Skill */
  enable(name: string): boolean {
    if (!this.skills.has(name)) return false;
    if (this.disabledSkills.delete(name)) {
      this.persistState();
      logger.info('Skill enabled', { name });
    }
    return true;
  }

  /** 禁用 Skill */
  disable(name: string): boolean {
    if (!this.skills.has(name)) return false;
    if (!this.disabledSkills.has(name)) {
      this.disabledSkills.add(name);
      this.persistState();
      logger.info('Skill disabled', { name });
    }
    return true;
  }

  /** 设置 Skill 启用/禁用状态（便捷方法） */
  setEnabled(name: string, enabled: boolean): boolean {
    return enabled ? this.enable(name) : this.disable(name);
  }

  /** 从 skill-state.json 恢复状态 */
  private restoreState(): void {
    if (!this.stateFilePath) return;
    try {
      // 同步读取，构造时调用
      if (!fsSync.existsSync(this.stateFilePath)) return;
      const raw = fsSync.readFileSync(this.stateFilePath, 'utf-8');
      const data: SkillStateFile = JSON.parse(raw);
      this.disabledSkills = new Set(data.disabledSkills ?? []);
      logger.debug('Skill state restored', {
        file: this.stateFilePath,
        disabledCount: this.disabledSkills.size,
      });
    } catch (err) {
      logger.warn('Failed to restore skill state', {
        file: this.stateFilePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 持久化状态到 skill-state.json */
  private persistState(): void {
    if (!this.stateFilePath) return;
    try {
      // 确保目录存在
      const dir = path.dirname(this.stateFilePath);
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
      }
      const data: SkillStateFile = {
        disabledSkills: Array.from(this.disabledSkills),
      };
      fsSync.writeFileSync(this.stateFilePath, JSON.stringify(data, null, 2), 'utf-8');
      logger.debug('Skill state persisted', {
        file: this.stateFilePath,
        disabledCount: this.disabledSkills.size,
      });
    } catch (err) {
      logger.warn('Failed to persist skill state', {
        file: this.stateFilePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ============================================================
// Filesystem-first 插件发现（Eve agent/ 目录约定）
// ============================================================

/**
 * Filesystem-first 插件发现器
 *
 * 借鉴 Eve 的"文件系统即注册表"设计：
 *   agent/ 目录下的文件结构自动被发现和注册
 *   没有中心化的注册表或配置文件
 *
 * 约定目录结构：
 *   .routedev/
 *     skills/<name>/SKILL.md   # 技能（目录名 = 技能名）
 *     plugins/<name>.ts        # 插件（文件名 = 插件名）
 *     hooks/<name>.ts          # 钩子（文件名 = 钩子名）
 */
export class FilesystemDiscovery {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * 发现所有 Skills
   *
   * 约定：.routedev/skills/<name>/SKILL.md
   * 身份来自目录名，不来自文件内容
   */
  async discoverSkills(): Promise<SkillDefinition[]> {
    const skillsDir = path.join(this.basePath, '.routedev', 'skills');
    const skills: SkillDefinition[] = [];

    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillFile, 'utf-8');
          const parsed = this.parseSkillMarkdown(content, entry.name, skillFile);
          skills.push(parsed);
          logger.debug('Skill discovered', { name: entry.name, path: skillFile });
        } catch (e) {
          // ENOENT 是正常情况（SKILL.md 尚未创建），不日志；其他错误 warn
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn('[skill-discovery] SKILL.md 读取失败', { path: skillFile, error: e });
          }
        }
      }
    } catch (e) {
      // F-N005 修复：readdir 失败时区分 ENOENT（目录不存在，正常情况）与其他错误
      // ENOENT 静默处理；其他错误（如权限不足、磁盘故障）记录 warn 日志
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('[skill-discovery] skills 目录读取失败', { error: e });
      }
    }

    return skills;
  }

  /**
   * 发现所有插件文件
   *
   * 约定：.routedev/plugins/<name>.ts
   * 身份来自文件名（不含扩展名）
   */
  async discoverPlugins(): Promise<string[]> {
    const pluginsDir = path.join(this.basePath, '.routedev', 'plugins');
    const plugins: string[] = [];

    try {
      const entries = await fs.readdir(pluginsDir);
      for (const entry of entries) {
        if (entry.endsWith('.ts') || entry.endsWith('.js')) {
          const name = path.basename(entry, path.extname(entry));
          plugins.push(name);
          logger.debug('Plugin discovered', { name, path: path.join(pluginsDir, entry) });
        }
      }
    } catch (e) {
      // plugins 目录不存在（ENOENT 正常情况）或读取失败
      logger.debug('[skill-discovery] 读取 plugins 目录失败', {
        pluginsDir,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return plugins;
  }

  /**
   * 发现所有钩子文件
   *
   * 约定：.routedev/hooks/<name>.ts
   */
  async discoverHooks(): Promise<string[]> {
    const hooksDir = path.join(this.basePath, '.routedev', 'hooks');
    const hooks: string[] = [];

    try {
      const entries = await fs.readdir(hooksDir);
      for (const entry of entries) {
        if (entry.endsWith('.ts') || entry.endsWith('.js')) {
          const name = path.basename(entry, path.extname(entry));
          hooks.push(name);
        }
      }
    } catch (e) {
      // hooks 目录不存在（ENOENT 正常情况）或读取失败
      logger.debug('[skill-discovery] 读取 hooks 目录失败', {
        hooksDir,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return hooks;
  }

  /**
   * 创建新的 Skill 文件（UI 添加 Skill 用）
   *
   * 约定：.routedev/skills/<name>/SKILL.md
   * 身份来自目录名，不来自文件内容
   *
   * @param name Skill 名称（目录名，需合法）
   * @param description 描述
   * @param keywords 关键词列表
   * @param content Markdown body 内容
   * @returns 创建的文件绝对路径
   * @throws 名称非法或文件已存在时抛错
   */
  async createSkill(
    name: string,
    description: string,
    keywords: string[],
    content: string,
  ): Promise<string> {
    // 名称合法性校验：仅允许字母、数字、连字符
    if (!/^[a-zA-Z0-9-]+$/.test(name)) {
      throw new Error(`Skill 名称只能包含字母、数字和连字符: ${name}`);
    }
    const skillDir = resolveSkillDir(this.basePath, name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    // 检查是否已存在
    try {
      await fs.access(skillFile);
      throw new Error(`Skill 已存在: ${name}`);
    } catch (err: unknown) {
      // 文件不存在时 fs.access 抛错，这是期望路径
      if (err instanceof Error && err.message.includes('Skill 已存在')) {
        throw err;
      }
      // 其他错误（权限问题等）继续抛出
      if (err instanceof Error && !('code' in err)) throw err;
    }

    // 确保目录存在
    await fs.mkdir(skillDir, { recursive: true });

    // 组装 SKILL.md 内容
    const markdown = [
      '---',
      `description: ${description}`,
      `keywords: ${keywords.join(', ')}`,
      '---',
      content,
    ].join('\n');

    await fs.writeFile(skillFile, markdown, 'utf-8');
    logger.info('Skill created', { name, path: skillFile });
    return skillFile;
  }

  /**
   * 删除 Skill 文件（UI 删除 Skill 用）
   *
   * @param name Skill 名称
   * @returns 是否删除成功
   */
  async deleteSkill(name: string): Promise<boolean> {
    // skillDir 提到 try 之前，便于 catch 块日志记录目标路径
    const skillDir = resolveSkillDir(this.basePath, name);
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
      logger.info('Skill deleted', { name, path: skillDir });
      return true;
    } catch (e) {
      // 删除失败（可能是 ENOENT 或权限问题），返回 false 让调用方处理
      logger.warn('[skill-discovery] 删除 Skill 失败', {
        name,
        skillDir,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /**
   * 解析 Skill Markdown 文件
   *
   * 格式：
   *   ---
   *   description: 技能描述
   *   keywords: keyword1, keyword2, keyword3
   *   ---
   *   # Skill 内容...
   */
  private parseSkillMarkdown(
    content: string,
    name: string,
    sourcePath: string,
  ): SkillDefinition {
    // P0-7：改用 SkillMdParser 消费 whenToUse/allowedTools/arguments 等新字段
    // 旧简易正则解析保留为 fallback（SkillMdParser 失败时使用）
    try {
      const parsed = SkillMdParser.parse(content);
      const meta = parsed.metadata;
      // routingKeywords 优先取 tags（与旧 keywords 字段语义一致）
      const routingKeywords = meta.tags.length > 0 ? meta.tags : [];
      return {
        name,
        description: meta.description || name,
        routingKeywords,
        content: parsed.content,
        sourcePath,
        // P0-7：透传新字段
        whenToUse: meta.whenToUse,
        allowedTools: meta.allowedTools,
        arguments: meta.arguments,
        argumentHint: meta.argumentHint,
        paths: meta.paths,
      };
    } catch (err) {
      logger.warn('SkillMdParser.parse failed, fallback to simple regex', {
        skill: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fallback：旧简易正则解析（保留向后兼容）
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    let description = '';
    let routingKeywords: string[] = [];
    let body = content;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      body = frontmatterMatch[2];

      // 提取 description
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim();

      // 提取 keywords
      const keywordsMatch = frontmatter.match(/^keywords:\s*(.+)$/m);
      if (keywordsMatch) {
        routingKeywords = keywordsMatch[1]
          .split(',')
          .map(k => k.trim())
          .filter(k => k.length > 0);
      }
    }

    return {
      name,
      description,
      routingKeywords,
      content: body.trim(),
      sourcePath,
    };
  }
}

// ============================================================
// Omnigent YAML 声明式 Agent 定义
// ============================================================

/**
 * YAML 声明式 Agent 定义（借鉴 Omnigent）
 *
 * Agent 是一个短 YAML 文件，包含 prompt、tools、可选子 Agent
 * 甚至可以让 Agent 帮你写 Agent YAML
 */
export interface AgentYAMLDefinition {
  /** Agent 名称 */
  name: string;
  /** 系统提示词 */
  prompt: string;
  /** 执行器配置 */
  executor?: {
    /** 使用的 harness（如 claude-sdk, codex, openai-agents） */
    harness: string;
  };
  /** 工具列表 */
  tools?: Record<string, {
    type: 'function' | 'agent';
    callable?: string;
    prompt?: string;
  }>;
  /** 子 Agent 定义 */
  subAgents?: AgentYAMLDefinition[];
}

/**
 * 解析 YAML 格式的 Agent 定义
 *
 * 简易 YAML 解析器（不依赖外部库）
 * 支持基本的 key: value 和嵌套结构
 */
export function parseAgentYAML(yaml: string): AgentYAMLDefinition {
  const lines = yaml.split('\n');
  const result: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: result }];

  for (const line of lines) {
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // 弹出栈直到找到比当前缩进小的
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].obj;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (value === '') {
      // 嵌套对象
      const newObj: Record<string, unknown> = {};
      current[key] = newObj;
      stack.push({ indent, obj: newObj });
    } else {
      // 去除引号
      let parsedValue: unknown = value;
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        parsedValue = value.slice(1, -1);
      }
      current[key] = parsedValue;
    }
  }

  // 保留双断言：result 是 Record<string, unknown>（手写 YAML 解析器输出），
  // AgentYAMLDefinition 是具体 interface，Record 与 interface 结构不充分重叠
  return result as unknown as AgentYAMLDefinition;
}

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
import path from 'node:path';
import { logger } from '../utils/logger.js';

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
      const fsSync = require('node:fs');
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
      const fsSync = require('node:fs');
      const pathSync = require('node:path');
      // 确保目录存在
      const dir = pathSync.dirname(this.stateFilePath);
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
        } catch {
          // SKILL.md 不存在或读取失败，跳过
        }
      }
    } catch {
      // skills 目录不存在，正常情况
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
    } catch {
      // plugins 目录不存在，正常情况
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
    } catch {
      // hooks 目录不存在，正常情况
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
    const skillDir = path.join(this.basePath, '.routedev', 'skills', name);
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
    const skillDir = path.join(this.basePath, '.routedev', 'skills', name);
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
      logger.info('Skill deleted', { name, path: skillDir });
      return true;
    } catch {
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
    // 解析 YAML frontmatter（简易版）
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

  return result as unknown as AgentYAMLDefinition;
}

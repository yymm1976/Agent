// src/agents/profiles/manager.ts
// AgentProfileManager：管理 Agent Profile 的加载、保存、删除、复制、导入导出
//
// 存储位置：
//   ${rootDir}/.routedev/skills/agents/<id>/SKILL.md
//
// 复用 SkillMdParser 的 frontmatter + Markdown 格式，但 frontmatter 中
// type 字段固定为 'agent-profile'，并扩展若干 agent 专属字段。
// 解析时若 type !== 'agent-profile' 则视为普通 Skill，跳过。

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../../utils/logger.js';
import {
  BUILTIN_PROFILES,
  cloneBuiltin,
  getBuiltinByRole,
} from './builtin-templates.js';
import {
  type AgentProfile,
  type AgentProfileValidationError,
  type AgentRole,
  validateProfile,
} from './types.js';

// ============================================================
// 常量
// ============================================================

/** 内置模板的固定时间戳（1970-01-01），表示"非用户创建" */
const BUILTIN_TIMESTAMP = 0;

// ============================================================
// AgentProfileManager
// ============================================================

export class AgentProfileManager {
  /** Profile 存储根目录：${rootDir}/.routedev/skills/agents/ */
  private profilesDir: string;
  /** 内存缓存：id -> Profile */
  private profiles: Map<string, AgentProfile> = new Map();
  /** 是否已加载 */
  private loaded = false;

  constructor(rootDir: string) {
    this.profilesDir = path.join(rootDir, '.routedev', 'skills', 'agents');
  }

  // ----------------------------------------------------------
  // 加载
  // ----------------------------------------------------------

  /**
   * 从磁盘加载所有 Profile
   *
   * 流程：
   *   1. 注入内置模板（不写盘）
   *   2. 扫描 profilesDir，解析每个子目录下的 SKILL.md
   *   3. type === 'agent-profile' 的覆盖内置模板（用户自定义版本）
   *   4. 内置模板若被用户重置过（磁盘上有同名 id），以磁盘版本为准
   */
  async loadAll(): Promise<void> {
    this.profiles.clear();

    // 1. 注入内置模板
    const now = Date.now();
    for (const tpl of BUILTIN_PROFILES) {
      const clone: AgentProfile = {
        ...tpl,
        allowedTools: [...tpl.allowedTools],
        forbiddenTools: [...tpl.forbiddenTools],
        boundSkills: [...tpl.boundSkills],
        createdAt: BUILTIN_TIMESTAMP,
        updatedAt: BUILTIN_TIMESTAMP,
      };
      this.profiles.set(clone.id, clone);
    }

    // 2. 扫描磁盘
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.profilesDir);
    } catch (err) {
      // 目录不存在视为空，仅保留内置模板
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.warn('AgentProfileManager.loadAll: readdir failed', {
          dir: this.profilesDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.loaded = true;
      return;
    }

    // 3. 逐个解析
    for (const entry of entries) {
      const entryPath = path.join(this.profilesDir, entry);
      let stat: fsSync.Stats;
      try {
        stat = await fs.stat(entryPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const skillMdPath = path.join(entryPath, 'SKILL.md');
      if (!fsSync.existsSync(skillMdPath)) continue;

      let content: string;
      try {
        content = await fs.readFile(skillMdPath, 'utf-8');
      } catch (err) {
        logger.warn('AgentProfileManager.loadAll: read SKILL.md failed', {
          path: skillMdPath,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const profile = this.parseFromSkillMd(content);
      if (profile) {
        this.profiles.set(profile.id, profile);
      }
    }

    this.loaded = true;
  }

  /** 确保已加载（懒加载） */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadAll();
    }
  }

  // ----------------------------------------------------------
  // 查询
  // ----------------------------------------------------------

  async listProfiles(): Promise<AgentProfile[]> {
    await this.ensureLoaded();
    return Array.from(this.profiles.values());
  }

  async getProfile(id: string): Promise<AgentProfile | null> {
    await this.ensureLoaded();
    return this.profiles.get(id) ?? null;
  }

  /**
   * 按角色解析 Profile
   *
   * 优先级：
   *   1. taskHints.profileId 指定的 Profile
   *   2. 该角色的内置模板
   *   3. 未知角色回退到 executor
   */
  resolveProfileForTask(role: AgentRole, taskHints?: Record<string, unknown>): AgentProfile {
    // 同步方法：使用已加载的缓存（调用方应先 await loadAll）
    if (!this.loaded) {
      // 未加载时直接返回内置模板的副本（不依赖磁盘）
      const tpl = getBuiltinByRole(role) ?? getBuiltinByRole('executor');
      if (!tpl) {
        throw new Error('No builtin profile available');
      }
      return { ...tpl, allowedTools: [...tpl.allowedTools], forbiddenTools: [...tpl.forbiddenTools] };
    }

    // 1. 显式指定 profileId
    const hintedId = typeof taskHints?.profileId === 'string' ? taskHints.profileId : null;
    if (hintedId) {
      const p = this.profiles.get(hintedId);
      if (p) return { ...p, allowedTools: [...p.allowedTools], forbiddenTools: [...p.forbiddenTools] };
    }

    // 2. 按角色查找（优先自定义，其次内置）
    for (const p of this.profiles.values()) {
      if (p.role === role) {
        return { ...p, allowedTools: [...p.allowedTools], forbiddenTools: [...p.forbiddenTools] };
      }
    }

    // 3. 未知角色回退到 executor
    const fallback = getBuiltinByRole('executor');
    if (!fallback) {
      throw new Error('No builtin executor profile available for fallback');
    }
    return { ...fallback, allowedTools: [...fallback.allowedTools], forbiddenTools: [...fallback.forbiddenTools] };
  }

  // ----------------------------------------------------------
  // 写操作
  // ----------------------------------------------------------

  /**
   * 保存 Profile
   *
   * - 自定义 Profile：写盘到 ${profilesDir}/<id>/SKILL.md
   * - 内置 Profile：允许写盘（用于重置后再次自定义），但 isBuiltin 字段保留
   * - 保存前校验，校验失败抛错
   */
  async saveProfile(profile: AgentProfile): Promise<void> {
    const errors = validateProfile(profile);
    if (errors.length > 0) {
      const msg = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Invalid AgentProfile: ${msg}`);
    }

    await this.ensureLoaded();

    const toSave: AgentProfile = {
      ...profile,
      allowedTools: [...profile.allowedTools],
      forbiddenTools: [...profile.forbiddenTools],
      boundSkills: [...profile.boundSkills],
      updatedAt: Date.now(),
    };

    // 写盘
    const dir = path.join(this.profilesDir, toSave.id);
    await fs.mkdir(dir, { recursive: true });
    const skillMdPath = path.join(dir, 'SKILL.md');
    const content = this.serializeToSkillMd(toSave);
    await fs.writeFile(skillMdPath, content, 'utf-8');

    // 更新缓存
    this.profiles.set(toSave.id, toSave);
  }

  /**
   * 删除 Profile
   *
   * - 内置模板不可删除（抛错）
   * - 自定义 Profile 删除磁盘目录与缓存
   */
  async deleteProfile(id: string): Promise<void> {
    await this.ensureLoaded();
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Profile not found: ${id}`);
    }
    if (profile.isBuiltin) {
      throw new Error(`Cannot delete builtin profile: ${id}`);
    }

    const dir = path.join(this.profilesDir, id);
    await fs.rm(dir, { recursive: true, force: true });
    this.profiles.delete(id);
  }

  /**
   * 重置内置模板到默认
   *
   * - 删除磁盘上该角色的所有自定义版本
   * - 重新注入默认内置模板
   */
  async resetBuiltin(role: AgentRole): Promise<void> {
    await this.ensureLoaded();
    const now = Date.now();
    const fresh = cloneBuiltin(role, now);
    if (!fresh) {
      throw new Error(`No builtin profile for role: ${role}`);
    }

    // 删除该角色在磁盘上的所有自定义 Profile
    const toRemove: string[] = [];
    for (const [id, p] of this.profiles.entries()) {
      if (p.role === role && !p.isBuiltin) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      const dir = path.join(this.profilesDir, id);
      await fs.rm(dir, { recursive: true, force: true });
      this.profiles.delete(id);
    }

    // 重置内置模板缓存（恢复默认值）
    this.profiles.set(fresh.id, fresh);
  }

  /**
   * 复制 Profile 为自定义
   *
   * - 生成新 id（原 id + '-copy-' + 短随机后缀）
   * - isBuiltin = false，role = 'custom'（除非源就是 custom）
   * - 写盘并返回副本
   */
  async duplicateProfile(sourceId: string, newName: string): Promise<AgentProfile> {
    await this.ensureLoaded();
    const source = this.profiles.get(sourceId);
    if (!source) {
      throw new Error(`Source profile not found: ${sourceId}`);
    }
    if (!newName || newName.trim().length === 0) {
      throw new Error('newName must not be empty');
    }

    const suffix = Math.random().toString(36).slice(2, 8);
    const newId = `${source.id}-copy-${suffix}`;
    const now = Date.now();
    const copy: AgentProfile = {
      ...source,
      id: newId,
      name: newName.trim(),
      isBuiltin: false,
      // 保留原角色：复制 researcher 仍是 researcher，只是变为用户自定义版本
      role: source.role,
      allowedTools: [...source.allowedTools],
      forbiddenTools: [...source.forbiddenTools],
      boundSkills: [...source.boundSkills],
      createdAt: now,
      updatedAt: now,
    };

    await this.saveProfile(copy);
    return copy;
  }

  // ----------------------------------------------------------
  // 导入导出
  // ----------------------------------------------------------

  /**
   * 导出 Profile 到指定路径（写入 SKILL.md 格式）
   */
  async exportProfile(id: string, outputPath: string): Promise<void> {
    await this.ensureLoaded();
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Profile not found: ${id}`);
    }
    const content = this.serializeToSkillMd(profile);
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, content, 'utf-8');
  }

  /**
   * 从 SKILL.md 文件导入 Profile
   *
   * - 解析后分配新 id（原 id + '-imported-' + 短随机后缀），避免冲突
   * - isBuiltin = false
   * - 写盘并返回新 Profile
   */
  async importProfile(inputPath: string): Promise<AgentProfile> {
    await this.ensureLoaded();
    const content = await fs.readFile(inputPath, 'utf-8');
    const parsed = this.parseFromSkillMd(content);
    if (!parsed) {
      throw new Error(`Invalid agent-profile SKILL.md: ${inputPath}`);
    }

    const suffix = Math.random().toString(36).slice(2, 8);
    const newId = `${parsed.id}-imported-${suffix}`;
    const now = Date.now();
    const imported: AgentProfile = {
      ...parsed,
      id: newId,
      isBuiltin: false,
      allowedTools: [...parsed.allowedTools],
      forbiddenTools: [...parsed.forbiddenTools],
      boundSkills: [...parsed.boundSkills],
      createdAt: now,
      updatedAt: now,
    };

    await this.saveProfile(imported);
    return imported;
  }

  // ----------------------------------------------------------
  // SKILL.md 序列化 / 解析
  // ----------------------------------------------------------

  /**
   * 序列化为 SKILL.md
   *
   * frontmatter 字段：
   *   name, description, version, type, role, modelId,
   *   allowedTools, forbiddenTools, canChallenge, challengeSeverity,
   *   outputFormat, boundSkills, maxTokens, maxSteps, isBuiltin,
   *   createdAt, updatedAt
   *
   * body 为 systemPrompt
   */
  private serializeToSkillMd(profile: AgentProfile): string {
    const frontmatter: Record<string, unknown> = {
      name: profile.name,
      description: profile.description,
      version: profile.version,
      type: 'agent-profile',
      id: profile.id,
      role: profile.role,
      modelId: profile.modelId,
      allowedTools: profile.allowedTools,
      forbiddenTools: profile.forbiddenTools,
      canChallenge: profile.canChallenge,
      challengeSeverity: profile.challengeSeverity,
      outputFormat: profile.outputFormat,
      boundSkills: profile.boundSkills,
      maxTokens: profile.maxTokens,
      maxSteps: profile.maxSteps,
      isBuiltin: profile.isBuiltin,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };

    const yamlStr = stringifyYaml(frontmatter);
    const body = (profile.systemPrompt ?? '').trim();
    return `---\n${yamlStr}---\n\n${body}\n`;
  }

  /**
   * 从 SKILL.md 解析
   *
   * - type !== 'agent-profile' 返回 null
   * - 必填字段缺失时返回 null
   */
  private parseFromSkillMd(content: string): AgentProfile | null {
    if (typeof content !== 'string' || content.length === 0) return null;

    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) return null;

    const frontRaw = match[1];
    const body = (match[2] ?? '').trim();

    let frontObj: Record<string, unknown>;
    try {
      frontObj = parseYaml(frontRaw) as Record<string, unknown>;
      if (!frontObj || typeof frontObj !== 'object') return null;
    } catch {
      return null;
    }

    if (frontObj.type !== 'agent-profile') return null;

    const id = asString(frontObj.id, '');
    const name = asString(frontObj.name, '');
    if (!id || !name) return null;

    const profile: AgentProfile = {
      id,
      name,
      type: 'agent-profile',
      version: asString(frontObj.version, '0.0.0'),
      role: asRole(frontObj.role, 'custom'),
      modelId: asString(frontObj.modelId, 'default'),
      description: asString(frontObj.description, ''),
      systemPrompt: body,
      allowedTools: asStringArray(frontObj.allowedTools),
      forbiddenTools: asStringArray(frontObj.forbiddenTools),
      canChallenge: asBool(frontObj.canChallenge, false),
      challengeSeverity: asSeverity(frontObj.challengeSeverity, 'warning'),
      outputFormat: asOutputFormat(frontObj.outputFormat, 'custom'),
      boundSkills: asStringArray(frontObj.boundSkills),
      maxTokens: asNumber(frontObj.maxTokens, 32000),
      maxSteps: asNumber(frontObj.maxSteps, 20),
      isBuiltin: asBool(frontObj.isBuiltin, false),
      createdAt: asNumber(frontObj.createdAt, 0),
      updatedAt: asNumber(frontObj.updatedAt, 0),
    };

    return profile;
  }
}

// ============================================================
// 内部工具
// ============================================================

function asString(v: unknown, def: string): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return def;
  return String(v);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return def;
}

function asNumber(v: unknown, def: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

function asRole(v: unknown, def: AgentRole): AgentRole {
  if (v === 'researcher' || v === 'executor' || v === 'reviewer' || v === 'custom') {
    return v;
  }
  return def;
}

function asSeverity(v: unknown, def: 'blocking' | 'warning'): 'blocking' | 'warning' {
  if (v === 'blocking' || v === 'warning') return v;
  return def;
}

function asOutputFormat(
  v: unknown,
  def: 'research_report' | 'code_change' | 'review_report' | 'custom',
): 'research_report' | 'code_change' | 'review_report' | 'custom' {
  if (v === 'research_report' || v === 'code_change' || v === 'review_report' || v === 'custom') {
    return v;
  }
  return def;
}

/**
 * 简易 YAML 序列化（不依赖 yaml 库的 stringify，避免行宽自动换行导致数组格式不一致）
 *
 * 规则：
 *   - 字符串：含特殊字符时用双引号包裹（JSON.stringify），否则裸写
 *   - 布尔/数字：直接写
 *   - 数组：每项 `- value`
 *   - 空数组：`[]`
 */
function stringifyYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    lines.push(`${key}: ${formatYamlValue(value, 0)}`);
  }
  return lines.join('\n') + '\n';
}

function formatYamlValue(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') {
    if (value.length === 0) return '""';
    if (/[:#{}\[\],&*!|>'"%@`\n]/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${pad}  - ${formatYamlInline(v)}`);
    return `\n${items.join('\n')}`;
  }
  // 不支持嵌套对象（当前 Profile 无此需求）
  return JSON.stringify(value);
}

function formatYamlInline(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length === 0) return '""';
    if (/[:#{}\[\],&*!|>'"%@`\n]/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  return JSON.stringify(value);
}

// ============================================================
// 导出校验函数（便于测试直接引用）
// ============================================================

export { validateProfile } from './types.js';
export type { AgentProfile, AgentProfileValidationError, AgentRole } from './types.js';

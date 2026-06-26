// src/macros/manager.ts
// MacroManager：管理 Macro 的加载、创建、删除、搜索
//
// 存储位置：
//   ${cwd}/${config.dir}/<name>/MACRO.md
//
// 加载策略：
//   1. 构造时注入内置宏（使未 loadAll 时也能查询内置宏）
//   2. loadAll 清空缓存并重新加载：内置宏 + 磁盘宏（磁盘覆盖同名内置）
//   3. 目录不存在时自动创建
//
// 解析规则（MACRO.md）：
//   - 复用 SkillMdParser 的 frontmatter 正则 + yaml 库解析
//   - type 字段缺失时默认为 'macro'，存在时必须为 'macro'
//   - name / description 必填，缺失视为无效文件并跳过

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger.js';
import { BUILTIN_MACROS } from './builtin.js';
import type { Macro, MacroConfig, MacroMetadata } from './types.js';

/** Macro 文件名 */
const MACRO_FILENAME = 'MACRO.md';

export class MacroManager {
  /** Macro 目录绝对路径 */
  private macrosDir: string;
  /** 工作目录 */
  private cwd: string;
  /** 配置 */
  private config: MacroConfig;
  /** 内存缓存：name -> Macro */
  private macros: Map<string, Macro> = new Map();
  /** 是否已加载 */
  private loaded = false;

  constructor(config: MacroConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
    this.macrosDir = path.resolve(cwd, config.dir);
    // 立即注入内置宏，使未 loadAll 时也能查询
    this.injectBuiltinMacros();
  }

  // ----------------------------------------------------------
  // 加载
  // ----------------------------------------------------------

  /**
   * 扫描 macros 目录，解析所有 MACRO.md
   *
   * 流程：
   *   1. 目录不存在时自动创建
   *   2. 注入内置宏
   *   3. 扫描磁盘上的 <name>/MACRO.md，覆盖同名内置宏
   *   4. 按 name 去重（磁盘优先于内置）
   */
  async loadAll(): Promise<Macro[]> {
    this.macros.clear();

    // 1. 自动创建目录
    try {
      await fs.mkdir(this.macrosDir, { recursive: true });
    } catch (err) {
      logger.warn('MacroManager.loadAll: mkdir failed', {
        dir: this.macrosDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. 注入内置宏
    this.injectBuiltinMacros();

    // 3. 扫描磁盘
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.macrosDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.warn('MacroManager.loadAll: readdir failed', {
          dir: this.macrosDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.loaded = true;
      return Array.from(this.macros.values());
    }

    // 4. 逐个解析
    for (const entry of entries) {
      const entryPath = path.join(this.macrosDir, entry);
      let stat: fsSync.Stats;
      try {
        stat = await fs.stat(entryPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const macroPath = path.join(entryPath, MACRO_FILENAME);
      if (!fsSync.existsSync(macroPath)) continue;

      try {
        const content = await fs.readFile(macroPath, 'utf-8');
        const macro = this.parseMacroMd(content, macroPath);
        if (macro) {
          // 磁盘版本覆盖内置（用户自定义优先），实现 name 去重
          this.macros.set(macro.metadata.name, macro);
        }
      } catch (err) {
        logger.warn('MacroManager.loadAll: parse MACRO.md failed', {
          path: macroPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.loaded = true;
    return Array.from(this.macros.values());
  }

  /** 注入内置宏到缓存（深拷贝避免外部修改） */
  private injectBuiltinMacros(): void {
    for (const macro of BUILTIN_MACROS) {
      this.macros.set(macro.metadata.name, {
        ...macro,
        metadata: { ...macro.metadata },
      });
    }
  }

  // ----------------------------------------------------------
  // 查询（同步，依赖 loadAll 已执行）
  // ----------------------------------------------------------

  /** 按名称获取 */
  getMacro(name: string): Macro | undefined {
    return this.macros.get(name);
  }

  /** 列出所有 */
  listMacros(): Macro[] {
    return Array.from(this.macros.values());
  }

  /**
   * 按 keywords / description / name 搜索
   *
   * 用于 `!` 触发器补全：用户输入前缀，返回匹配的宏列表
   *
   * 匹配优先级：
   *   1. name 前缀匹配（最高优先级）
   *   2. keywords 包含查询
   *   3. description 包含查询
   */
  searchMacros(query: string): Macro[] {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return Array.from(this.macros.values());

    const all = Array.from(this.macros.values());
    const nameMatches: Macro[] = [];
    const keywordMatches: Macro[] = [];
    const descMatches: Macro[] = [];

    for (const m of all) {
      const name = m.metadata.name.toLowerCase();
      const keywords = (m.metadata.keywords ?? []).map((k) => k.toLowerCase());
      const desc = (m.metadata.description ?? '').toLowerCase();

      if (name.startsWith(q)) {
        nameMatches.push(m);
      } else if (keywords.some((k) => k.includes(q))) {
        keywordMatches.push(m);
      } else if (desc.includes(q)) {
        descMatches.push(m);
      }
    }

    // name 前缀优先，其次 keyword，最后 description
    return [...nameMatches, ...keywordMatches, ...descMatches];
  }

  // ----------------------------------------------------------
  // 写操作
  // ----------------------------------------------------------

  /**
   * 创建新宏并保存到文件
   *
   * - 写入 ${macrosDir}/<name>/MACRO.md
   * - 更新内存缓存
   * - 同名宏将被覆盖
   */
  async createMacro(metadata: MacroMetadata, content: string): Promise<Macro> {
    this.validateMetadata(metadata);
    if (!content || content.trim().length === 0) {
      throw new Error('Macro content must not be empty');
    }

    await this.ensureLoaded();

    const macroDir = path.join(this.macrosDir, metadata.name);
    await fs.mkdir(macroDir, { recursive: true });
    const macroPath = path.join(macroDir, MACRO_FILENAME);
    const fileContent = this.serializeMacroMd(metadata, content);
    await fs.writeFile(macroPath, fileContent, 'utf-8');

    const macro: Macro = {
      metadata: { ...metadata },
      content: content.trim(),
      filePath: macroPath,
      source: 'user',
    };
    this.macros.set(metadata.name, macro);

    logger.info('MacroManager: created macro', { name: metadata.name });
    return macro;
  }

  /**
   * 删除宏
   *
   * - 内置宏不可删除（抛错）
   * - 删除磁盘目录与缓存
   * - 删除后 listMacros 不再包含
   */
  async deleteMacro(name: string): Promise<void> {
    await this.ensureLoaded();
    const macro = this.macros.get(name);
    if (!macro) {
      throw new Error(`Macro not found: ${name}`);
    }
    if (macro.source === 'builtin') {
      throw new Error(`Cannot delete builtin macro: ${name}`);
    }

    if (macro.filePath) {
      const macroDir = path.dirname(macro.filePath);
      await fs.rm(macroDir, { recursive: true, force: true });
    }
    this.macros.delete(name);
    logger.info('MacroManager: deleted macro', { name });
  }

  // ----------------------------------------------------------
  // 提取 system prompt
  // ----------------------------------------------------------

  /**
   * 提取 Macro 的 system prompt（正文部分）
   *
   * 用于 CiteResolver 将 Macro 内容追加到请求的 system prompt
   */
  extractSystemPrompt(macro: Macro): string {
    return (macro.content ?? '').trim();
  }

  // ----------------------------------------------------------
  // 内部方法
  // ----------------------------------------------------------

  /** 确保已加载（懒加载） */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadAll();
    }
  }

  /**
   * 序列化为 MACRO.md
   *
   * frontmatter 字段：name, type, version, description（必填）
   * 可选字段：author, keywords, category, preferredProfile
   * body 为正文内容
   */
  private serializeMacroMd(metadata: MacroMetadata, content: string): string {
    const frontmatter: Record<string, unknown> = {
      name: metadata.name,
      type: 'macro',
      version: metadata.version,
      description: metadata.description,
    };
    if (metadata.author !== undefined) frontmatter.author = metadata.author;
    if (metadata.keywords !== undefined) frontmatter.keywords = metadata.keywords;
    if (metadata.category !== undefined) frontmatter.category = metadata.category;
    if (metadata.preferredProfile !== undefined) {
      frontmatter.preferredProfile = metadata.preferredProfile;
    }

    const yamlStr = stringifyYaml(frontmatter);
    const body = (content ?? '').trim();
    return `---\n${yamlStr}---\n\n${body}\n`;
  }

  /**
   * 从 MACRO.md 解析
   *
   * - type 不为 'macro' 返回 null
   * - name / description 必填，缺失返回 null（无效的 Macro 文件）
   */
  private parseMacroMd(content: string, filePath: string): Macro | null {
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

    // 必填字段校验：name 与 description
    const name = asString(frontObj.name, '');
    const description = asString(frontObj.description, '');
    if (!name || !description) return null;

    // type 字段：缺失时默认为 'macro'，存在时必须为 'macro'
    if (frontObj.type !== undefined && frontObj.type !== 'macro') return null;

    const metadata: MacroMetadata = {
      name,
      type: 'macro',
      version: asString(frontObj.version, '0.0.0'),
      description,
    };
    if (frontObj.author !== undefined && frontObj.author !== null) {
      metadata.author = asString(frontObj.author, '');
    }
    if (frontObj.keywords !== undefined && frontObj.keywords !== null) {
      metadata.keywords = asStringArray(frontObj.keywords);
    }
    if (frontObj.category !== undefined && frontObj.category !== null) {
      metadata.category = asString(frontObj.category, '');
    }
    if (frontObj.preferredProfile !== undefined && frontObj.preferredProfile !== null) {
      metadata.preferredProfile = asString(frontObj.preferredProfile, '');
    }

    return {
      metadata,
      content: body,
      filePath,
      source: 'user',
    };
  }

  /** 校验 MacroMetadata 必填字段 */
  private validateMetadata(metadata: MacroMetadata): void {
    if (!metadata.name || !/^[a-zA-Z0-9-_]+$/.test(metadata.name)) {
      throw new Error(`Invalid macro name: ${metadata.name}`);
    }
    if (metadata.type !== 'macro') {
      throw new Error(`Macro type must be 'macro', got: ${metadata.type}`);
    }
    if (!metadata.version || metadata.version.trim().length === 0) {
      throw new Error('Macro version must not be empty');
    }
    if (!metadata.description || metadata.description.trim().length === 0) {
      throw new Error('Macro description must not be empty');
    }
  }
}

// ============================================================
// 内部工具函数
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

/**
 * 简易 YAML 序列化（与 agents/profiles/manager.ts 中的实现保持一致）
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
  // 不支持嵌套对象（当前 Macro 无此需求）
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

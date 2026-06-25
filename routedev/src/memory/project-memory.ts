// src/memory/project-memory.ts
// 项目记忆：自动维护 .routedev/ 下的项目级记忆文件
//
// 目录结构：
//   {project}/.routedev/
//     ├── rules.md           # /init 生成的项目规则（已实现）
//     ├── MEMORY.md          # 自动积累的项目记忆
//     ├── decisions.log      # 关键决策历史（JSONL）
//     └── context.md         # 自动维护的项目上下文

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ProjectMemoryConfig,
  ProjectMemoryStatus,
  DecisionRecord,
} from '../prompts/types.js';
import type { ProjectDocConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';
import { ensureDir } from '../utils/paths.js';

const DECISION_PATTERN = /## (.+?)\n\n([\s\S]*?)\n---\n/g;
const MAX_DECISIONS_CACHE = 1000;

// ============================================================
// Phase 47 Task 8：项目文档（AGENTS.md / CLAUDE.md）多文件名 fallback 加载
// ============================================================

/**
 * 默认的项目文档配置（与 schema.ts / defaults.ts 保持一致）
 * 不配置 projectDoc 时使用此默认值，保证向后兼容
 */
export const DEFAULT_PROJECT_DOC_CONFIG: ProjectDocConfig = {
  filenames: ['AGENTS.md', 'AGENTS.local.md', 'AGENTS.override.md'],
  fallbackFilenames: ['CLAUDE.md', 'CLAUDE.local.md'],
  maxBytes: 32768,
};

/**
 * 合并两个文档：base 在前，local 在后（local 覆盖语义）
 * 简单拼接，中间用换行分隔
 *
 * @param base 基础文档内容（可为 null/空）
 * @param local 本地覆盖文档内容（可为 null/空）
 * @returns 合并后的文档；两者都为空时返回 null
 */
export function mergeDocs(base: string | null, local: string | null): string | null {
  const parts: string[] = [];
  if (base && base.trim()) parts.push(base.trim());
  if (local && local.trim()) parts.push(local.trim());
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * 截断文档到指定字节数（按 UTF-8 字节计算）
 * 超过 maxBytes 时截断并 warn，附加截断提示
 *
 * @param doc 原始文档内容
 * @param maxBytes 最大字节数（默认 32768 = 32KiB，对齐 Codex）
 * @returns 截断后的文档（未超限则原样返回）
 */
export function truncateDoc(doc: string, maxBytes: number = 32768): string {
  const buf = Buffer.byteLength(doc, 'utf-8');
  if (buf <= maxBytes) return doc;

  // 按 UTF-8 字节截断，避免截断多字节字符
  const bufArr = Buffer.from(doc, 'utf-8');
  // 留出截断提示的空间（约 100 字节）
  const truncateHint = '\n\n<!-- truncated: exceeded maxBytes -->';
  const hintBytes = Buffer.byteLength(truncateHint, 'utf-8');
  const sliceEnd = Math.max(0, maxBytes - hintBytes);

  // 向前回退到完整 UTF-8 字符边界（避免乱码）
  let end = sliceEnd;
  while (end > 0 && (bufArr[end] & 0xC0) === 0x80) end--;

  const truncated = bufArr.subarray(0, end).toString('utf-8') + truncateHint;
  logger.warn('ProjectDoc: 文档超过 maxBytes 已截断', {
    originalBytes: buf,
    maxBytes,
    truncatedBytes: Buffer.byteLength(truncated, 'utf-8'),
  });
  return truncated;
}

/**
 * 读取单个文件内容（文件不存在时返回 null）
 */
async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 检查文件是否存在
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 加载项目文档（AGENTS.md / CLAUDE.md 多文件名 fallback）
 *
 * 加载优先级（陷阱 #140：override 语义是「跳过」而非「合并」）：
 *   1. 若 filenames 中存在 override 文件（默认 AGENTS.override.md），则跳过基础文件，
 *      只加载 override + local（local 为 filenames[1]）
 *   2. 否则加载基础文件（filenames[0]）+ local 文件（filenames[1]），合并后返回
 *   3. 以上都不存在时，fallback 到 fallbackFilenames（同样支持 base + local 合并）
 *
 * @param cwd 项目根目录
 * @param config 项目文档配置（不传时使用默认值，向后兼容）
 * @returns 合并并截断后的文档内容；都不存在时返回 null
 */
export async function loadProjectDoc(
  cwd: string,
  config: ProjectDocConfig = DEFAULT_PROJECT_DOC_CONFIG,
): Promise<string | null> {
  const {
    filenames,
    fallbackFilenames,
    maxBytes,
  } = config;

  // filenames 约定：[base, local, override?, ...]
  // 至少需要 2 个文件名（base + local），override 为第 3 个
  const baseName = filenames[0];
  const localName = filenames[1];
  const overrideName = filenames[2]; // 可选

  // 1. 优先检查 override 文件（陷阱 #140：override 存在时跳过 base）
  if (overrideName) {
    const overridePath = path.join(cwd, overrideName);
    const overrideExists = await fileExists(overridePath);
    if (overrideExists) {
      const overrideContent = await readFileOrNull(overridePath);
      // override + local 合并（local 仍在后覆盖）
      const localPath = localName ? path.join(cwd, localName) : null;
      const localContent = localPath ? await readFileOrNull(localPath) : null;
      const merged = mergeDocs(overrideContent, localContent);
      if (merged) {
        logger.info('ProjectDoc: 加载 override + local', {
          override: overrideName,
          local: localName ?? null,
        });
        return truncateDoc(merged, maxBytes);
      }
    }
  }

  // 2. 尝试 base + local 合并
  if (baseName) {
    const basePath = path.join(cwd, baseName);
    const baseExists = await fileExists(basePath);
    if (baseExists) {
      const baseContent = await readFileOrNull(basePath);
      const localPath = localName ? path.join(cwd, localName) : null;
      const localContent = localPath ? await readFileOrNull(localPath) : null;
      const merged = mergeDocs(baseContent, localContent);
      if (merged) {
        logger.info('ProjectDoc: 加载 base + local', {
          base: baseName,
          local: localName ?? null,
        });
        return truncateDoc(merged, maxBytes);
      }
    }
  }

  // 3. fallback 到 fallbackFilenames（CLAUDE.md + CLAUDE.local.md）
  const fallbackBase = fallbackFilenames[0];
  const fallbackLocal = fallbackFilenames[1];
  if (fallbackBase) {
    const fallbackBasePath = path.join(cwd, fallbackBase);
    const fallbackBaseExists = await fileExists(fallbackBasePath);
    if (fallbackBaseExists) {
      const fallbackBaseContent = await readFileOrNull(fallbackBasePath);
      const fallbackLocalPath = fallbackLocal ? path.join(cwd, fallbackLocal) : null;
      const fallbackLocalContent = fallbackLocalPath ? await readFileOrNull(fallbackLocalPath) : null;
      const merged = mergeDocs(fallbackBaseContent, fallbackLocalContent);
      if (merged) {
        logger.info('ProjectDoc: fallback 加载', {
          base: fallbackBase,
          local: fallbackLocal ?? null,
        });
        return truncateDoc(merged, maxBytes);
      }
    }
  }

  // 4. 都不存在
  logger.info('ProjectDoc: 未找到任何项目文档', { cwd });
  return null;
}

export class ProjectMemoryManager {
  private projectPath: string;
  private config: ProjectMemoryConfig;
  private decisionsCache: DecisionRecord[] = [];
  /** Phase 48：加载的项目文档内容（AGENTS.md / CLAUDE.md fallback） */
  private projectDoc: string | null = null;

  constructor(projectPath: string, config: ProjectMemoryConfig) {
    this.projectPath = projectPath;
    this.config = config;
  }

  /** Phase 48 Task 2：设置项目文档内容（由 loadProjectDoc 异步加载后注入） */
  setProjectDoc(doc: string): void {
    this.projectDoc = doc;
  }

  /** Phase 48 Task 2：获取项目文档内容（供 system prompt 注入） */
  getProjectDoc(): string | null {
    return this.projectDoc;
  }

  /** 获取 .routedev 目录路径 */
  getRoutedevDir(): string {
    return path.join(this.projectPath, '.routedev');
  }

  /** 获取状态摘要 */
  async getStatus(): Promise<ProjectMemoryStatus> {
    const dir = this.getRoutedevDir();
    const result: ProjectMemoryStatus = {
      projectPath: this.projectPath,
      hasRoutedevDir: await this.fileExists(dir),
      files: {
        rules: { exists: false, size: 0 },
        memory: { exists: false, size: 0 },
        decisions: { exists: false, count: 0 },
        context: { exists: false, size: 0 },
      },
    };

    const checks = [
      { key: 'rules' as const, name: 'rules.md' },
      { key: 'memory' as const, name: 'MEMORY.md' },
      { key: 'decisions' as const, name: 'decisions.log' },
      { key: 'context' as const, name: 'context.md' },
    ];

    for (const { key, name } of checks) {
      const filePath = path.join(dir, name);
      try {
        const stat = await fs.stat(filePath);
        result.files[key].exists = true;
        if (key === 'decisions') {
          const content = await fs.readFile(filePath, 'utf-8');
          result.files[key].count = content.split('\n').filter(l => l.trim()).length;
        } else {
          result.files[key].size = stat.size;
        }
        result.files[key].lastModified = stat.mtimeMs;
      } catch {
        // 文件不存在
      }
    }

    return result;
  }

  /** 读取项目规则 */
  async readRules(): Promise<string | null> {
    return this.readFileIfExists('rules.md');
  }

  /** 写入项目规则（/init 使用） */
  async writeRules(content: string): Promise<void> {
    if (!this.config.enabled) {
      logger.warn('ProjectMemory: writeRules called while disabled');
      return;
    }
    await this.ensureRoutedevDir();
    await fs.writeFile(path.join(this.getRoutedevDir(), 'rules.md'), content, 'utf-8');
    logger.info('ProjectMemory: rules written', { size: content.length });
  }

  /** 读取项目记忆 */
  async readMemory(): Promise<string | null> {
    return this.readFileIfExists('MEMORY.md');
  }

  /** 追加到 MEMORY.md */
  async appendMemory(entry: string): Promise<void> {
    if (!this.config.enabled) return;

    const filePath = path.join(this.getRoutedevDir(), 'MEMORY.md');
    await this.ensureRoutedevDir();

    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch {
      existing = '';
    }

    const newSize = existing.length + entry.length;
    if (newSize > this.config.maxMemorySize) {
      logger.warn('ProjectMemory: MEMORY.md would exceed max size, truncating', {
        newSize,
        maxSize: this.config.maxMemorySize,
      });
      existing = existing.slice(-(this.config.maxMemorySize / 2));
    }

    const timestamp = new Date().toISOString();
    const updated = existing + `\n## ${timestamp}\n\n${entry}\n`;
    await fs.writeFile(filePath, updated, 'utf-8');
  }

  /** 清空 MEMORY.md */
  async clearMemory(): Promise<void> {
    if (!this.config.enabled) return;
    const filePath = path.join(this.getRoutedevDir(), 'MEMORY.md');
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件不存在
    }
  }

  /** 追加决策记录 */
  async appendDecision(
    sessionId: string,
    type: DecisionRecord['type'],
    decision: string,
    reasoning: string,
    relatedFiles?: string[],
  ): Promise<void> {
    if (!this.config.enabled) return;

    await this.ensureRoutedevDir();
    const record: DecisionRecord = {
      timestamp: new Date().toISOString(),
      sessionId,
      type,
      decision,
      reasoning,
      relatedFiles,
    };

    const filePath = path.join(this.getRoutedevDir(), 'decisions.log');
    await fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8');

    this.decisionsCache.push(record);
    if (this.decisionsCache.length > MAX_DECISIONS_CACHE) {
      this.decisionsCache.shift();
    }
  }

  /** 读取决策历史 */
  async readDecisions(limit?: number): Promise<DecisionRecord[]> {
    const filePath = path.join(this.getRoutedevDir(), 'decisions.log');
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const records = lines.map(line => JSON.parse(line) as DecisionRecord);
      return limit ? records.slice(-limit) : records;
    } catch {
      return [];
    }
  }

  /** 读取项目上下文 */
  async readContext(): Promise<string | null> {
    return this.readFileIfExists('context.md');
  }

  /** 写入项目上下文 */
  async writeContext(content: string): Promise<void> {
    if (!this.config.enabled) return;
    await this.ensureRoutedevDir();
    await fs.writeFile(path.join(this.getRoutedevDir(), 'context.md'), content, 'utf-8');
  }

  /** 提取上下文摘要（用于 Prompt 注入） */
  async getSummary(): Promise<string> {
    const parts: string[] = [];

    const rules = await this.readRules();
    if (rules) {
      parts.push('## 项目规则');
      parts.push(rules.slice(0, 1000));
    }

    const memory = await this.readMemory();
    if (memory) {
      parts.push('\n## 项目记忆（最近 5 条）');
      const entries = memory.match(DECISION_PATTERN);
      if (entries) {
        parts.push(entries.slice(-5).join('\n'));
      }
    }

    const decisions = await this.readDecisions(10);
    if (decisions.length > 0) {
      parts.push('\n## 最近决策');
      for (const d of decisions) {
        parts.push(`- [${d.type}] ${d.decision}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '（暂无项目记忆）';
  }

  /** 删除整个 .routedev 目录（危险操作） */
  async resetAll(): Promise<void> {
    const dir = this.getRoutedevDir();
    try {
      await fs.rm(dir, { recursive: true, force: true });
      logger.warn('ProjectMemory: reset all', { dir });
    } catch (err) {
      logger.error('ProjectMemory: reset failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 生成项目记忆 ID */
  static generateSessionId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  // ===== 内部方法 =====

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readFileIfExists(name: string): Promise<string | null> {
    try {
      const content = await fs.readFile(path.join(this.getRoutedevDir(), name), 'utf-8');
      return content;
    } catch {
      return null;
    }
  }

  private async ensureRoutedevDir(): Promise<void> {
    ensureDir(this.getRoutedevDir());
  }
}
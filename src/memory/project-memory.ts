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
import { logger } from '../utils/logger.js';
import { ensureDir } from '../utils/paths.js';

const DECISION_PATTERN = /## (.+?)\n\n([\s\S]*?)\n---\n/g;
const MAX_DECISIONS_CACHE = 1000;

export class ProjectMemoryManager {
  private projectPath: string;
  private config: ProjectMemoryConfig;
  private decisionsCache: DecisionRecord[] = [];

  constructor(projectPath: string, config: ProjectMemoryConfig) {
    this.projectPath = projectPath;
    this.config = config;
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
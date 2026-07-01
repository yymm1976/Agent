// src/agent/loop-memory.ts
// Phase 49 Task 2.4：Loop 记忆模块
//
// 知识库原文：
//   "Loop 五模块：记忆——记录失败原因，循环的'脊柱'。markdown 文件，每轮对话加载。"
//   "失败信息必须整合到下一轮"
//
// 实现：
//   - 每次外循环验证不通过，记录失败原因
//   - 内循环重跑时，把历史失败原因注入 system prompt
//   - 文件持久化到 .routedev/loop-memory/<goal-id>.md
//   - /goal 完成后归档到 .routedev/loop-memory/archived/
//
// 陷阱 #147：LoopMemory 文件可能无限增长
//   长 /goal 任务（如 50 步）的失败记录可能生成大文件。
//   LoopMemory 只保留最近 5 次失败记录，更早的归档到 archived/ 目录。

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import type { LoopFailure } from './dual-loop-types.js';

/** LoopMemory 持久化目录（相对于项目根） */
export const LOOP_MEMORY_DIR = '.routedev/loop-memory';
/** LoopMemory 归档目录（相对于项目根） */
export const LOOP_MEMORY_ARCHIVE_DIR = `${LOOP_MEMORY_DIR}/archived`;
/** 陷阱 #147：最多保留最近 N 次失败记录 */
export const MAX_KEPT_FAILURES = 5;

/**
 * Loop 记忆模块——沉淀双循环中的失败原因
 *
 * 用法：
 *   const memory = new LoopMemory(projectPath);
 *   await memory.load(goalId);
 *   memory.recordFailure(failure);   // 自动持久化
 *   const prompt = memory.buildPrompt(); // 注入 system prompt
 */
export class LoopMemory {
  private failures: LoopFailure[] = [];
  private readonly projectPath: string;
  /** 当前 goal id（load 后设置；为空时不持久化） */
  private goalId: string | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * 记录一次外循环验证失败
   *
   * 副作用：触发 persist() 写入文件
   * 陷阱 #147：超过 MAX_KEPT_FAILURES 时归档更早的记录
   */
  recordFailure(failure: LoopFailure): void {
    this.failures.push(failure);
    logger.info('LoopMemory: recorded failure', {
      iteration: failure.iteration,
      reason: failure.reason,
      totalFailures: this.failures.length,
    });
    this.persist();
  }

  /**
   * 构建 system prompt 注入文本
   *
   * 知识库要求："失败信息必须整合到下一轮"
   * 把所有失败记录（已截断到 MAX_KEPT_FAILURES）格式化为可读的提示
   */
  buildPrompt(): string {
    if (this.failures.length === 0) return '';

    const parts: string[] = ['\n\n=== 历史失败记录（请避免重复犯错）==='];
    for (const f of this.failures) {
      parts.push(`\n【第 ${f.iteration} 次尝试失败】`);
      parts.push(`原因：${f.reason}`);
      if (f.missingItems.length > 0) {
        parts.push(`缺失项：${f.missingItems.join(', ')}`);
      }
      if (f.gateFailures.length > 0) {
        parts.push(`工程验证失败：${f.gateFailures.map(g => g.name).join(', ')}`);
      }
      if (f.reviewIssues.length > 0) {
        parts.push(`审查问题：`);
        for (const issue of f.reviewIssues) {
          const lineInfo = issue.line ? `:${issue.line}` : '';
          parts.push(`  - [${issue.severity}] ${issue.file}${lineInfo}: ${issue.description}`);
        }
      }
    }
    parts.push('\n=== 失败记录结束 ===\n');
    return parts.join('\n');
  }

  /**
   * 构建给用户的重新建议提示
   * 基于最近一次失败原因，告知用户当前重跑的关注点
   */
  buildResuggestion(): string {
    if (this.failures.length === 0) return '';
    const latest = this.failures[this.failures.length - 1];
    const focus = latest.missingItems.length > 0
      ? latest.missingItems.join(', ')
      : (latest.gateFailures.length > 0 ? latest.gateFailures.map(g => g.name).join(', ') : '审查问题');
    return `上次失败原因：${latest.reason}。建议重点关注：${focus}`;
  }

  /** 获取失败历史（返回副本，避免外部修改） */
  getHistory(): LoopFailure[] {
    return [...this.failures];
  }

  /** 获取当前失败记录数 */
  get size(): number {
    return this.failures.length;
  }

  /**
   * 加载已持久化的失败记录
   *
   * @param goalId 目标 ID
   * 文件不存在时静默返回（首次运行无历史记录）
   */
  async load(goalId: string): Promise<void> {
    this.goalId = goalId;
    const filePath = this.getFilePath(goalId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.failures = this.parseMarkdown(content);
      logger.debug('LoopMemory: loaded existing memory', {
        goalId,
        failureCount: this.failures.length,
      });
    } catch (error) {
      // 文件不存在或读取失败 → 静默处理（首次运行）
      this.failures = [];
      logger.debug('LoopMemory: no existing memory found', {
        goalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 归档当前 goal 的记忆文件到 archived/ 目录
   *
   * 调用时机：/goal 完成后（无论成功或放弃）
   */
  async archive(goalId: string): Promise<void> {
    const srcPath = this.getFilePath(goalId);
    const archivePath = join(this.projectPath, LOOP_MEMORY_ARCHIVE_DIR, `${goalId}.md`);
    try {
      await fs.mkdir(dirname(archivePath), { recursive: true });
      await fs.rename(srcPath, archivePath);
      logger.info('LoopMemory: archived memory file', { goalId, archivePath });
      this.failures = [];
      this.goalId = null;
    } catch (error) {
      // 源文件不存在时静默处理（goal 可能从未失败过）
      logger.debug('LoopMemory: archive skipped (source missing)', {
        goalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 设置 goalId（用于未通过 load() 初始化的场景）
   */
  setGoalId(goalId: string): void {
    this.goalId = goalId;
  }

  async save(): Promise<void> {
    if (!this.goalId) {
      logger.debug('LoopMemory: skip save (no goalId)');
      return;
    }
    this.trimFailures();
    const filePath = this.getFilePath(this.goalId);
    const content = this.toMarkdown();
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    logger.debug('LoopMemory: saved', { filePath, failureCount: this.failures.length });
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 持久化失败记录到 .routedev/loop-memory/<goal-id>.md
   *
   * 陷阱 #147：超过 MAX_KEPT_FAILURES 时只保留最近 N 条
   * 写入失败时记录日志但不抛出（记忆模块不能阻塞主流程）
   */
  private persist(): void {
    if (!this.goalId) {
      // 未关联 goal，不持久化（测试场景或一次性使用）
      logger.debug('LoopMemory: skip persist (no goalId)');
      return;
    }

    this.trimFailures();

    const filePath = this.getFilePath(this.goalId);
    const content = this.toMarkdown();
    // 异步写入不 await（避免阻塞主流程；写入失败仅记录日志）
    fs.mkdir(dirname(filePath), { recursive: true })
      .then(() => fs.writeFile(filePath, content, 'utf-8'))
      .then(() => {
        logger.debug('LoopMemory: persisted', { filePath, failureCount: this.failures.length });
      })
      .catch(error => {
        logger.warn('LoopMemory: persist failed (non-blocking)', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private trimFailures(): void {
    if (this.failures.length <= MAX_KEPT_FAILURES) {
      return;
    }
    const archived = this.failures.slice(0, this.failures.length - MAX_KEPT_FAILURES);
    this.failures = this.failures.slice(-MAX_KEPT_FAILURES);
    logger.info('LoopMemory: trimmed old failures (陷阱 #147)', {
      archivedCount: archived.length,
      keptCount: this.failures.length,
    });
  }

  /** 获取 goal 的记忆文件路径 */
  private getFilePath(goalId: string): string {
    return join(this.projectPath, LOOP_MEMORY_DIR, `${goalId}.md`);
  }

  /**
   * 序列化失败记录为 Markdown 文本
   */
  private toMarkdown(): string {
    const lines: string[] = [
      '# Loop Memory',
      `> Goal ID: ${this.goalId ?? 'unknown'}`,
      `> Updated: ${new Date().toISOString()}`,
      `> Failures: ${this.failures.length} (max ${MAX_KEPT_FAILURES})`,
      '',
      '---',
      '',
    ];
    for (const f of this.failures) {
      lines.push(`## 第 ${f.iteration} 次尝试失败`);
      lines.push(`- 原因: ${f.reason}`);
      if (f.missingItems.length > 0) {
        lines.push(`- 缺失项: ${f.missingItems.join(', ')}`);
      }
      if (f.gateFailures.length > 0) {
        lines.push(`- 工程验证失败:`);
        for (const g of f.gateFailures) {
          lines.push(`  - ${g.name}: ${g.output.slice(0, 200)}`);
        }
      }
      if (f.reviewIssues.length > 0) {
        lines.push(`- 审查问题:`);
        for (const i of f.reviewIssues) {
          const line = i.line ? `:${i.line}` : '';
          lines.push(`  - [${i.severity}] ${i.file}${line}: ${i.description}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 从 Markdown 文本解析失败记录
   *
   * 简易解析：识别 `## 第 N 次尝试失败` 段落，提取原因/缺失项等
   * 解析失败时返回空数组（不影响主流程）
   */
  private parseMarkdown(content: string): LoopFailure[] {
    const failures: LoopFailure[] = [];
    const sections = content.split(/^## /m).slice(1); // 第 0 段是头部
    for (const section of sections) {
      const headerMatch = section.match(/^第 (\d+) 次尝试失败/);
      if (!headerMatch) continue;
      const iteration = parseInt(headerMatch[1], 10);
      const reason = this.extractField(section, /原因:\s*(.+)/);
      const missingItemsRaw = this.extractField(section, /缺失项:\s*(.+)/);
      const missingItems = missingItemsRaw ? missingItemsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      // 解析工程验证失败（不深度解析 output，只保留 name）
      const gateFailures: LoopFailure['gateFailures'] = [];
      const gateSectionMatch = section.match(/工程验证失败:([\s\S]*?)(?=\n- |$)/);
      if (gateSectionMatch) {
        const gateLines = gateSectionMatch[1].match(/-\s+([^:]+):\s*(.+)/g) || [];
        for (const line of gateLines) {
          const m = line.match(/-\s+([^:]+):\s*(.+)/);
          if (m) {
            gateFailures.push({
              name: m[1].trim(),
              ok: false,
              output: m[2].trim(),
              duration: 0,
            });
          }
        }
      }

      // 解析审查问题
      // 序列化格式：
      //   有行号：  - [critical] src/x.ts:100: 严重问题
      //   无行号：  - [warning] src/y.ts: 警告
      const reviewIssues: LoopFailure['reviewIssues'] = [];
      const reviewSectionMatch = section.match(/审查问题:([\s\S]*?)(?=\n## |$)/);
      if (reviewSectionMatch) {
        // 按行分割，逐行匹配（避免全局正则的非贪婪问题）
        const reviewLines = reviewSectionMatch[1].split('\n');
        for (const line of reviewLines) {
          // 匹配：- [severity] file[:line]: description
          const m = line.match(/-\s+\[(\w+)\]\s+([^:\n]+?)(?::(\d+))?:\s*(.+)/);
          if (m) {
            reviewIssues.push({
              severity: m[1] as 'critical' | 'warning' | 'info',
              file: m[2].trim(),
              line: m[3] ? parseInt(m[3], 10) : undefined,
              description: m[4].trim(),
            });
          }
        }
      }

      failures.push({
        iteration,
        reason: reason ?? '',
        missingItems,
        gateFailures,
        reviewIssues,
      });
    }
    return failures;
  }

  /** 从段落中提取字段值（单行） */
  private extractField(section: string, regex: RegExp): string | null {
    const m = section.match(regex);
    return m ? m[1].trim() : null;
  }
}

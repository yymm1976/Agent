// src/agent/middleware/code-map-context.ts
// Phase 39 Task 1：代码地图 ContextInjector 中间件
// 注册到 onSystemPrompt 阶段，将项目结构和相关文件注入系统提示词
// 帮助 Agent 在不调用 repo_map 工具的情况下获得项目结构感知

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { incrementalScan, type RepoMapFileEntry } from '../../tools/repo-map.js';

/**
 * 代码地图上下文中间件
 * 在 onSystemPrompt 阶段注入：
 *   1. <project_structure> 段落：前 50 个文件的路径和签名摘要
 *   2. <related_files> 段落：根据用户查询关键词匹配的前 10 个相关文件
 */
export class CodeMapContextMiddleware {
  private repoMapEntries: RepoMapFileEntry[] | null = null;
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /**
   * 获取中间件处理器（注册到 onSystemPrompt 阶段）
   */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      // 懒加载：首次调用时扫描项目
      if (!this.repoMapEntries) {
        try {
          this.repoMapEntries = await incrementalScan(this.rootDir, { maxFiles: 200 });
        } catch {
          // 扫描失败不阻断主流程
          await next();
          return;
        }
      }

      const entries = this.repoMapEntries;
      if (entries.length === 0) {
        await next();
        return;
      }

      // 注入项目结构摘要（前 50 个文件）
      const summary = this.formatSummary(entries.slice(0, 50));

      // 根据用户查询匹配相关文件
      const userQuery = (ctx.metadata.userQuery as string) || '';
      const related = this.findRelatedFiles(userQuery, entries);

      if (ctx.systemPrompt !== undefined) {
        ctx.systemPrompt += '\n\n' + summary;
        if (related.length > 0) {
          ctx.systemPrompt += '\n\n' + this.formatRelatedFiles(related);
        }
      } else {
        ctx.systemPrompt = summary;
        if (related.length > 0) {
          ctx.systemPrompt += '\n\n' + this.formatRelatedFiles(related);
        }
      }

      ctx.metadata.codeMapInjected = true;
      ctx.metadata.codeMapFileCount = entries.length;
      ctx.metadata.codeMapRelatedCount = related.length;

      await next();
    };
  }

  /**
   * 重置缓存（文件变更后强制重新扫描）
   */
  invalidateCache(): void {
    this.repoMapEntries = null;
  }

  /**
   * 格式化项目结构摘要为 XML 段落
   * <project_structure>
   *   src/index.ts
   *     export function main()
   *   src/utils.ts
   *     export function helper()
   * </project_structure>
   */
  formatSummary(entries: RepoMapFileEntry[]): string {
    const lines: string[] = ['<project_structure>'];
    for (const entry of entries) {
      lines.push(`  ${entry.path}`);
      // 每个文件最多展示 3 个签名
      for (const sig of entry.signatures.slice(0, 3)) {
        lines.push(`    ${sig.trim()}`);
      }
      if (entry.exports.length > 0 && entry.signatures.length === 0) {
        lines.push(`    exports: ${entry.exports.slice(0, 5).join(', ')}`);
      }
    }
    lines.push('</project_structure>');
    return lines.join('\n');
  }

  /**
   * 根据用户查询关键词匹配相关文件
   * 关键词从查询中提取（分词后过滤停用词），按匹配数排序，取前 10
   */
  findRelatedFiles(query: string, entries: RepoMapFileEntry[]): RepoMapFileEntry[] {
    if (!query || query.trim().length === 0) return [];

    // 提取关键词（简单分词：按空格/标点分割，过滤停用词和过短词）
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'on', 'at',
      'by', 'for', 'with', 'about', 'as', 'into', 'like', 'through', 'after',
      'over', 'between', 'out', 'against', 'during', 'without', 'before',
      'under', 'around', 'among', 'and', 'or', 'not', 'no', 'but', 'if',
      'then', 'else', 'when', 'how', 'what', 'why', 'who', 'where',
      '这', '那', '的', '了', '在', '是', '我', '你', '他', '她', '它',
      '们', '个', '有', '和', '与', '或', '不', '要', '会', '能', '可',
      '请', '帮', '给', '看', '想', '做', '弄', '搞', '一下', '怎么',
      '什么', '为什么', '哪里', '哪个', '怎样', '如何',
    ]);

    const keywords = query
      .toLowerCase()
      .split(/[\s,.;:!?()[\]{}'"`/\\|<>@#$%^&*+=~\-—–]+/)
      .filter(w => w.length >= 2 && !stopWords.has(w))
      .filter((w, i, arr) => arr.indexOf(w) === i); // 去重

    if (keywords.length === 0) return [];

    // 计算每个文件的匹配分数
    const scored = entries.map(entry => {
      const haystack = (
        entry.path.toLowerCase() + ' ' +
        entry.exports.join(' ').toLowerCase() + ' ' +
        entry.signatures.join(' ').toLowerCase()
      );
      let score = 0;
      for (const kw of keywords) {
        // 路径匹配权重更高
        if (entry.path.toLowerCase().includes(kw)) score += 3;
        // 导出符号匹配
        if (entry.exports.some(e => e.toLowerCase().includes(kw))) score += 2;
        // 签名匹配
        if (entry.signatures.some(s => s.toLowerCase().includes(kw))) score += 1;
        // 兜底：整体包含
        if (haystack.includes(kw)) score += 1;
      }
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(s => s.entry);
  }

  /**
   * 格式化相关文件为 XML 段落
   * <related_files>
   *   src/auth/login.ts
   *     exports: login, logout
   *   src/auth/session.ts
   *     exports: createSession
   * </related_files>
   */
  formatRelatedFiles(entries: RepoMapFileEntry[]): string {
    const lines: string[] = ['<related_files>'];
    for (const entry of entries) {
      lines.push(`  ${entry.path}`);
      if (entry.exports.length > 0) {
        lines.push(`    exports: ${entry.exports.slice(0, 5).join(', ')}`);
      }
      if (entry.signatures.length > 0) {
        const sig = entry.signatures[0].trim();
        lines.push(`    signature: ${sig}`);
      }
    }
    lines.push('</related_files>');
    return lines.join('\n');
  }
}

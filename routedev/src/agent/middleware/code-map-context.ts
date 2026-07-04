// src/agent/middleware/code-map-context.ts
// Phase 39 Task 1：代码地图 ContextInjector 中间件
// Phase 41/42：接入 tree-sitter 代码地图引擎（fail-open 降级到 regex）
// 注册到 onSystemPrompt 阶段，将项目结构和相关文件注入系统提示词
// 帮助 Agent 在不调用 repo_map 工具的情况下获得项目结构感知

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { incrementalScan, type RepoMapFileEntry } from '../../tools/repo-map.js';
import { fullIndex, incrementalIndex } from '../../code-map/indexer.js';
import { explore } from '../../code-map/querier.js';
import { getIndexStatus, type DB } from '../../code-map/database.js';
import { refreshGitSeedCache } from '../../code-map/git-integration.js';
import type { CodeMapNode, IndexStatus } from '../../code-map/schema.js';
import { logger } from '../../utils/logger.js';

/**
 * 代码地图上下文中间件
 * 优先使用 tree-sitter 引擎（fullIndex + explore）；
 * 失败时降级到 regex 方案（incrementalScan），保证 fail-open。
 *
 * 在 onSystemPrompt 阶段注入：
 *   1. <project_structure> 段落：tree-sitter 索引状态 或 regex 前 50 个文件签名摘要
 *   2. <related_files> 段落：tree-sitter explore 结果 或 regex 关键词匹配的前 10 个相关文件
 */
export class CodeMapContextMiddleware {
  private repoMapEntries: RepoMapFileEntry[] | null = null;
  private rootDir: string;
  /** tree-sitter 数据库实例（复用，避免重复 fullIndex） */
  private db: DB | null = null;
  /** 是否已成功 fullIndex 过 */
  private indexedOnce = false;
  /** 上次 incrementalIndex 时间戳（节流，避免每次 handler 调用都触发） */
  private lastRefreshAt = 0;
  /** tree-sitter 引擎是否失败（失败后降级到 regex，不再重试） */
  public engineFailed = false;

  /** 增量索引节流间隔（毫秒） */
  private static readonly REFRESH_INTERVAL_MS = 60_000;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /**
   * 确保 tree-sitter 索引就绪
   * - 首次调用触发 fullIndex
   * - 后续调用复用 db（节流 incrementalIndex 增量刷新）
   * - 失败时设 engineFailed=true 并返回 null，由调用方降级
   */
  private async ensureIndex(): Promise<DB | null> {
    if (this.engineFailed) return null;
    const now = Date.now();

    // 已有 db：节流 incrementalIndex 增量刷新
    if (this.db) {
      if (now - this.lastRefreshAt > CodeMapContextMiddleware.REFRESH_INTERVAL_MS) {
        try {
          const { db } = await incrementalIndex(this.rootDir, undefined, { maxFiles: 5000 });
          this.db = db;
          this.lastRefreshAt = now;
          // Phase 71 Task A3：增量索引后异步刷新 git seed 缓存（fail-open，不阻塞）
          this.refreshGitSeeds(db);
        } catch (err) {
          // 增量失败不降级，复用旧 db
          logger.warn('tree-sitter incrementalIndex 失败，复用旧 db', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return this.db;
    }

    // 首次：fullIndex
    try {
      const { db } = await fullIndex(this.rootDir, { maxFiles: 5000 });
      this.db = db;
      this.indexedOnce = true;
      this.lastRefreshAt = now;

      const status = getIndexStatus(db);
      logger.info('tree-sitter fullIndex 完成', {
        rootDir: this.rootDir,
        fileCount: status.fileCount,
        nodeCount: status.nodeCount,
      });
      // Phase 71 Task A3：首次索引后异步刷新 git seed 缓存（fail-open，不阻塞）
      this.refreshGitSeeds(db);
    } catch (err) {
      logger.warn('tree-sitter fullIndex 失败，降级到 regex', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.engineFailed = true;
      return null;
    }

    return this.db;
  }

  /**
   * 异步刷新 git seed 缓存（Phase 71 Task A3）
   * fail-open：失败时仅 warn，不影响主流程；不 await，不阻塞 ensureIndex
   */
  private refreshGitSeeds(db: DB): void {
    refreshGitSeedCache(db, this.rootDir).catch(err => {
      logger.warn('git seed cache refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * 获取中间件处理器（注册到 onSystemPrompt 阶段）
   */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      // 优先尝试 tree-sitter 路径
      if (!this.engineFailed) {
        const db = await this.ensureIndex();
        if (db) {
          await this.handleTreeSitter(ctx, db);
          await next();
          return;
        }
      }

      // regex fallback 路径
      await this.handleRegex(ctx);
      await next();
    };
  }

  /**
   * tree-sitter 路径：用 explore 查询相关符号，注入 systemPrompt
   */
  private async handleTreeSitter(ctx: MiddlewareContext, db: DB): Promise<void> {
    const status = getIndexStatus(db);
    const userQuery = (ctx.metadata.userQuery as string) || '';

    // 项目结构摘要（索引状态）
    const summary = this.formatTreeSitterSummary(status);

    // 用 explore 查询相关符号（空查询返回空结果，不报错）
    let exploreNodes: CodeMapNode[] = [];
    if (userQuery.trim()) {
      try {
        const result = explore(db, userQuery, this.rootDir, {
          maxResults: 10,
          includeSnippets: false,
          includeCallPaths: false,
        });
        exploreNodes = result.nodes;
      } catch (err) {
        logger.warn('tree-sitter explore 失败', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 注入 systemPrompt
    if (ctx.systemPrompt !== undefined) {
      ctx.systemPrompt += '\n\n' + summary;
    } else {
      ctx.systemPrompt = summary;
    }

    if (exploreNodes.length > 0) {
      ctx.systemPrompt += '\n\n' + this.formatExploreNodes(exploreNodes);
    }

    ctx.metadata.codeMapInjected = true;
    ctx.metadata.codeMapFileCount = status.fileCount;
    ctx.metadata.codeMapRelatedCount = exploreNodes.length;
    ctx.metadata.codeMapEngine = 'tree-sitter';
  }

  /**
   * regex fallback 路径：用 incrementalScan + findRelatedFiles
   */
  private async handleRegex(ctx: MiddlewareContext): Promise<void> {
    if (!this.repoMapEntries) {
      try {
        this.repoMapEntries = await incrementalScan(this.rootDir, { maxFiles: 200 });
      } catch {
        // 扫描失败不阻断主流程
        return;
      }
    }

    const entries = this.repoMapEntries;
    if (entries.length === 0) {
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
    ctx.metadata.codeMapEngine = 'regex';
  }

  /**
   * 重置缓存（文件变更后强制重新扫描）
   * tree-sitter db 与 regex entries 都清空，下次调用重新 fullIndex
   */
  invalidateCache(): void {
    this.repoMapEntries = null;
    this.db = null;
    this.lastRefreshAt = 0;
  }

  /**
   * 格式化 tree-sitter 索引状态为 <project_structure> 段落
   */
  formatTreeSitterSummary(status: IndexStatus): string {
    const lines: string[] = ['<project_structure>'];
    lines.push(`  indexed_files: ${status.fileCount}`);
    lines.push(`  indexed_symbols: ${status.nodeCount}`);
    lines.push(`  indexed_edges: ${status.edgeCount}`);
    if (status.lastIndexedAt) {
      lines.push(`  last_indexed_at: ${status.lastIndexedAt}`);
    }
    lines.push('</project_structure>');
    return lines.join('\n');
  }

  /**
   * 格式化 explore 节点为 <related_files> 段落
   */
  formatExploreNodes(nodes: CodeMapNode[]): string {
    const lines: string[] = ['<related_files>'];
    for (const node of nodes) {
      lines.push(`  ${node.filePath}`);
      lines.push(`    symbol: ${node.name} (${node.kind})`);
      if (node.signature) {
        lines.push(`    signature: ${node.signature}`);
      }
    }
    lines.push('</related_files>');
    return lines.join('\n');
  }

  /**
   * 格式化项目结构摘要为 XML 段落（regex fallback 路径）
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
   * 根据用户查询关键词匹配相关文件（regex fallback 路径）
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
   * 格式化相关文件为 XML 段落（regex fallback 路径）
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

// src/agent/middleware/code-map-context.ts
// Phase 39 Task 1：代码地图 ContextInjector 中间件
// Phase 41/42：接入 tree-sitter 代码地图引擎（fail-open 降级到 regex）
// 注册到 onSystemPrompt 阶段，将项目结构和相关文件注入系统提示词
// 帮助 Agent 在不调用 repo_map 工具的情况下获得项目结构感知

import path from 'node:path';
import fsp from 'node:fs/promises';
import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { incrementalScan, type RepoMapFileEntry } from '../../tools/repo-map.js';
import { incrementalIndex, loadOrBuildIndex } from '../../code-map/indexer.js';
import { explore } from '../../code-map/querier.js';
import {
  getIndexStatus,
  getTopFilesByRank,
  getTopSymbolsByFile,
  type DB,
  type TopFileEntry,
} from '../../code-map/database.js';
import { refreshGitSeedCache } from '../../code-map/git-integration.js';
import type { CodeMapNode, CodeSnippet, IndexStatus } from '../../code-map/schema.js';
import { countTokens } from '../../code-map/token-counter.js';
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
  /** token 预算：注入 systemPrompt 的总 token 上限（统计 + 文件清单 + 相关符号 + snippet） */
  private budgetTokens: number;
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
  /** snippet 长度上限（行数） */
  private static readonly SNIPPET_MAX_LINES = 30;
  /** snippet 渲染行数（前 N 行带行号） */
  private static readonly SNIPPET_RENDER_LINES = 5;
  /** top 文件清单上限 */
  private static readonly TOP_FILES_LIMIT = 50;
  /** 每文件 top 符号数 */
  private static readonly SYMBOLS_PER_FILE = 3;
  /** 异步读取 snippet 的节点数上限 */
  private static readonly SNIPPET_NODE_LIMIT = 3;

  constructor(rootDir: string, budgetTokens?: number) {
    this.rootDir = rootDir;
    this.budgetTokens = budgetTokens ?? 2048;
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

    // 首次：loadOrBuildIndex（Phase 72 Task D1：artifact 优先，秒级启动；失败降级 regex）
    try {
      const { db } = await loadOrBuildIndex(this.rootDir, { maxFiles: 5000 });
      this.db = db;
      this.indexedOnce = true;
      this.lastRefreshAt = now;

      const status = getIndexStatus(db);
      logger.info('tree-sitter 索引就绪（loadOrBuildIndex）', {
        rootDir: this.rootDir,
        fileCount: status.fileCount,
        nodeCount: status.nodeCount,
      });
      // Phase 71 Task A3：首次索引后异步刷新 git seed 缓存（fail-open，不阻塞）
      this.refreshGitSeeds(db);
    } catch (err) {
      logger.warn('tree-sitter loadOrBuildIndex 失败，降级到 regex', {
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
   *
   * 注入内容（按 token 预算控制）：
   *   1. <project_structure>：统计数字（4 行，始终保留）+ top 50 文件清单（按 PageRank 排序，每文件 top 3 符号签名）
   *   2. <related_files>：explore 节点 + top 3 节点 snippet（前 5 行带行号）
   *
   * 优先级：统计数字 > related_files > project_structure 文件清单 > snippet
   */
  private async handleTreeSitter(ctx: MiddlewareContext, db: DB): Promise<void> {
    const status = getIndexStatus(db);
    const userQuery = (ctx.metadata.userQuery as string) || '';

    // 1. 统计数字（始终保留，约 50 token）
    const statsLines = this.formatTreeSitterStats(status);
    const statsTokens = countTokens(statsLines);

    // 2. top 文件清单（按 PageRank 排序，对标 regex 路径的 formatSummary）
    //    预算：剩余预算的 40%（约 800 token）
    const filesBudget = Math.max(0, (this.budgetTokens - statsTokens) * 0.4);
    let topFiles: TopFileEntry[] = [];
    try {
      topFiles = getTopFilesByRank(db, CodeMapContextMiddleware.TOP_FILES_LIMIT);
    } catch (err) {
      logger.warn('getTopFilesByRank 失败，跳过文件清单注入', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const filesBlock = this.formatTopFilesBlock(db, topFiles, filesBudget);

    // 拼接 <project_structure>：统计 + 文件清单
    const projectStructure = this.wrapProjectStructure(statsLines, filesBlock);

    // 3. explore 查询相关符号
    //    includeSnippets=false 避免 explore 内部同步 readFileSync 阻塞
    //    middleware 单独异步读取 top 3 节点的 snippet
    let exploreNodes: CodeMapNode[] = [];
    if (userQuery.trim()) {
      try {
        const result = await explore(db, userQuery, this.rootDir, {
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

    // 4. 异步读取 top 3 节点的 snippet（30 行上限）
    const snippets = await this.readTopSnippets(
      exploreNodes.slice(0, CodeMapContextMiddleware.SNIPPET_NODE_LIMIT),
      this.rootDir,
    );

    // 5. <related_files>（优先保留，预算：剩余的 60%）
    const projectTokens = countTokens(projectStructure);
    const relatedBudget = Math.max(0, this.budgetTokens - projectTokens);
    const relatedBlock = exploreNodes.length > 0
      ? this.formatExploreNodes(exploreNodes, snippets, relatedBudget)
      : '';

    // 6. 注入 systemPrompt
    if (ctx.systemPrompt !== undefined) {
      ctx.systemPrompt += '\n\n' + projectStructure;
    } else {
      ctx.systemPrompt = projectStructure;
    }
    if (relatedBlock) {
      ctx.systemPrompt += '\n\n' + relatedBlock;
    }

    ctx.metadata.codeMapInjected = true;
    ctx.metadata.codeMapFileCount = status.fileCount;
    ctx.metadata.codeMapRelatedCount = exploreNodes.length;
    ctx.metadata.codeMapEngine = 'tree-sitter';
  }

  /**
   * regex fallback 路径：用 incrementalScan + findRelatedFiles
   *
   * 注入内容（按 token 预算控制）：
   *   1. <project_structure>：前 50 个文件签名摘要（按 token 预算截断）
   *   2. <related_files>：关键词匹配的前 10 个相关文件（优先保留）
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

    // token 预算分配：related 优先（60%），project_structure 文件清单其次（40%）
    const filesBudget = this.budgetTokens * 0.4;
    const relatedBudget = this.budgetTokens * 0.6;

    // 注入项目结构摘要（按 token 预算截断）
    const summary = this.formatSummary(entries.slice(0, 50), filesBudget);

    // 根据用户查询匹配相关文件
    const userQuery = (ctx.metadata.userQuery as string) || '';
    const related = this.findRelatedFiles(userQuery, entries);

    if (ctx.systemPrompt !== undefined) {
      ctx.systemPrompt += '\n\n' + summary;
    } else {
      ctx.systemPrompt = summary;
    }
    if (related.length > 0) {
      ctx.systemPrompt += '\n\n' + this.formatRelatedFiles(related, relatedBudget);
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
   * 注：保留原签名以兼容现有测试；handleTreeSitter 内部使用 formatTreeSitterStats + wrapProjectStructure 拼接文件清单
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
   * 仅格式化统计数字（不含 <project_structure> 开闭标签），供 handleTreeSitter 拼接文件清单使用
   */
  private formatTreeSitterStats(status: IndexStatus): string {
    const lines: string[] = [];
    lines.push(`  indexed_files: ${status.fileCount}`);
    lines.push(`  indexed_symbols: ${status.nodeCount}`);
    lines.push(`  indexed_edges: ${status.edgeCount}`);
    if (status.lastIndexedAt) {
      lines.push(`  last_indexed_at: ${status.lastIndexedAt}`);
    }
    return lines.join('\n');
  }

  /**
   * 将统计数字 + 文件清单块拼装为 <project_structure> 段落
   */
  private wrapProjectStructure(statsLines: string, filesBlock: string): string {
    const lines: string[] = ['<project_structure>'];
    lines.push(statsLines);
    if (filesBlock) {
      lines.push(filesBlock);
    }
    lines.push('</project_structure>');
    return lines.join('\n');
  }

  /**
   * 格式化 top 文件清单（按 PageRank 排序），按 token 预算截断
   * 格式与 regex 路径 formatSummary 对齐：每文件一行路径 + top 3 符号签名
   */
  private formatTopFilesBlock(db: DB, topFiles: TopFileEntry[], budgetTokens: number): string {
    if (topFiles.length === 0 || budgetTokens <= 0) return '';
    const lines: string[] = [];
    let used = 0;
    for (const file of topFiles) {
      let symbols: Array<{ name: string; kind: string; signature: string | null }> = [];
      try {
        symbols = getTopSymbolsByFile(db, file.filePath, CodeMapContextMiddleware.SYMBOLS_PER_FILE);
      } catch (e) {
        // 查询失败跳过此文件的符号行
        logger.debug('[code-map-context] getTopSymbolsByFile 查询失败', {
          filePath: file.filePath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      const fileLines: string[] = [`  ${file.filePath}`];
      for (const sym of symbols) {
        const sig = (sym.signature ?? '').trim() || `${sym.kind} ${sym.name}`;
        fileLines.push(`    ${sig}`);
      }
      const fileText = fileLines.join('\n');
      const fileTokens = countTokens(fileText + '\n');
      if (used + fileTokens > budgetTokens) break;
      lines.push(fileText);
      used += fileTokens;
    }
    return lines.join('\n');
  }

  /**
   * 异步读取 top 节点的源代码片段（每个最多 30 行）
   * fail-open：文件不存在或读取失败时跳过
   *
   * 不依赖 explore 的 includeSnippets 参数（explore 内部用同步 readFileSync 会阻塞），
   * middleware 单独异步读取，只读 top 3 节点（避免读取全部 10 个节点的片段）
   */
  private async readTopSnippets(nodes: CodeMapNode[], rootDir: string): Promise<CodeSnippet[]> {
    const snippets: CodeSnippet[] = [];
    for (const node of nodes) {
      try {
        const fullPath = path.join(rootDir, node.filePath);
        const content = await fsp.readFile(fullPath, 'utf-8');
        const fileLines = content.split('\n');
        const start = Math.max(0, node.startLine);
        // snippet 长度上限：30 行
        const end = Math.min(fileLines.length - 1, node.endLine, start + CodeMapContextMiddleware.SNIPPET_MAX_LINES - 1);
        const snippetLines = fileLines.slice(start, end + 1);
        snippets.push({
          filePath: node.filePath,
          startLine: start,
          endLine: end,
          content: snippetLines.join('\n'),
          symbolName: node.name,
        });
      } catch (e) {
        // 文件不存在或读取失败：fail-open 跳过
        logger.debug('[code-map-context] 读取代码片段失败，跳过', {
          filePath: node.filePath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return snippets;
  }

  /**
   * 格式化 explore 节点为 <related_files> 段落
   * 含 snippet 渲染（前 5 行带行号），按 token 预算截断
   *
   * @param nodes explore 返回的节点
   * @param snippets middleware 异步读取的 snippet（按 symbolName 匹配节点）
   * @param budgetTokens 可选 token 预算；未传则不截断（兼容现有测试）
   */
  formatExploreNodes(nodes: CodeMapNode[], snippets: CodeSnippet[] = [], budgetTokens?: number): string {
    const lines: string[] = ['<related_files>'];
    let used = countTokens(lines[0] + '\n');

    // snippet 按 symbolName 索引，便于节点匹配
    const snippetByName = new Map<string, CodeSnippet>();
    for (const sn of snippets) {
      if (sn.symbolName) snippetByName.set(sn.symbolName, sn);
    }

    for (const node of nodes) {
      const nodeLines: string[] = [
        `  ${node.filePath}`,
        `    symbol: ${node.name} (${node.kind})`,
      ];
      if (node.signature) {
        nodeLines.push(`    signature: ${node.signature}`);
      }
      // snippet 渲染：前 5 行带行号
      const sn = snippetByName.get(node.name);
      if (sn) {
        const snippetLines = sn.content.split('\n').slice(0, CodeMapContextMiddleware.SNIPPET_RENDER_LINES);
        nodeLines.push('    snippet:');
        for (let i = 0; i < snippetLines.length; i++) {
          nodeLines.push(`      ${sn.startLine + i + 1}: ${snippetLines[i]}`);
        }
      }
      const nodeText = nodeLines.join('\n');
      const nodeTokens = countTokens(nodeText + '\n');
      if (budgetTokens !== undefined && used + nodeTokens > budgetTokens) break;
      lines.push(nodeText);
      used += nodeTokens;
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
   *
   * @param entries 文件条目
   * @param budgetTokens 可选 token 预算；未传则不截断（兼容现有测试）
   */
  formatSummary(entries: RepoMapFileEntry[], budgetTokens?: number): string {
    const lines: string[] = ['<project_structure>'];
    let used = countTokens(lines[0] + '\n');
    for (const entry of entries) {
      const entryLines: string[] = [`  ${entry.path}`];
      // 每个文件最多展示 3 个签名
      for (const sig of entry.signatures.slice(0, 3)) {
        entryLines.push(`    ${sig.trim()}`);
      }
      if (entry.exports.length > 0 && entry.signatures.length === 0) {
        entryLines.push(`    exports: ${entry.exports.slice(0, 5).join(', ')}`);
      }
      const entryText = entryLines.join('\n');
      const entryTokens = countTokens(entryText + '\n');
      if (budgetTokens !== undefined && used + entryTokens > budgetTokens) break;
      lines.push(entryText);
      used += entryTokens;
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
   *
   * @param entries 文件条目
   * @param budgetTokens 可选 token 预算；未传则不截断（兼容现有测试）
   */
  formatRelatedFiles(entries: RepoMapFileEntry[], budgetTokens?: number): string {
    const lines: string[] = ['<related_files>'];
    let used = countTokens(lines[0] + '\n');
    for (const entry of entries) {
      const entryLines: string[] = [`  ${entry.path}`];
      if (entry.exports.length > 0) {
        entryLines.push(`    exports: ${entry.exports.slice(0, 5).join(', ')}`);
      }
      if (entry.signatures.length > 0) {
        const sig = entry.signatures[0].trim();
        entryLines.push(`    signature: ${sig}`);
      }
      const entryText = entryLines.join('\n');
      const entryTokens = countTokens(entryText + '\n');
      if (budgetTokens !== undefined && used + entryTokens > budgetTokens) break;
      lines.push(entryText);
      used += entryTokens;
    }
    lines.push('</related_files>');
    return lines.join('\n');
  }
}

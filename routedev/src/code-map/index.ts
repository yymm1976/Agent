// src/code-map/index.ts
// CodeMap 对外统一 API

import path from 'node:path';
import type {
  CodeMapNode,
  CodeContext,
  ImpactResult,
  FileNode,
  IndexStats,
  IndexStatus,
} from './schema.js';
import { initParser } from './parser.js';
import {
  fullIndex,
  incrementalIndex,
  type IndexOptions,
} from './indexer.js';
import {
  explore as dbExplore,
  findCallers as dbFindCallers,
  findCallees as dbFindCallees,
  analyzeImpact as dbAnalyzeImpact,
  getFileStructure as dbGetFileStructure,
  getStatus as dbGetStatus,
} from './querier.js';
import {
  initDatabase,
  close,
  type DB,
} from './database.js';

export interface ExploreOptions {
  maxResults?: number;
  includeSnippets?: boolean;
  includeCallPaths?: boolean;
  fileHint?: string;
}

/**
 * CodeMap 引擎
 *
 * 用法：
 * ```ts
 * const engine = new CodeMapEngine('/path/to/project');
 * await engine.init();
 * await engine.fullIndex();
 * const ctx = await engine.explore('login function');
 * ```
 */
export class CodeMapEngine {
  private db: DB | null = null;
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** 初始化数据库 + 解析器 */
  async init(): Promise<void> {
    await initParser();
    const dbPath = path.join(this.rootDir, '.routedev', 'code-map', 'code-map.db');
    this.db = initDatabase(dbPath);
  }

  /** 全量索引 */
  async fullIndex(options?: IndexOptions): Promise<IndexStats> {
    if (!this.db) {
      await this.init();
    }
    const { stats, db } = await fullIndex(this.rootDir, {
      ...options,
      dbPath: path.join(this.rootDir, '.routedev', 'code-map', 'code-map.db'),
    });
    this.db = db;
    return stats;
  }

  /** 增量索引 */
  async incrementalIndex(changedFiles?: string[], options?: IndexOptions): Promise<IndexStats> {
    if (!this.db) {
      await this.init();
    }
    const { stats, db } = await incrementalIndex(this.rootDir, changedFiles, {
      ...options,
      dbPath: path.join(this.rootDir, '.routedev', 'code-map', 'code-map.db'),
    });
    this.db = db;
    return stats;
  }

  /** 关键词搜索符号 */
  async explore(query: string, options?: ExploreOptions): Promise<CodeContext> {
    if (!this.db) throw new Error('Engine not initialized. Call init() first.');
    return dbExplore(this.db, query, this.rootDir, options);
  }

  /** 查找调用者 */
  async findCallers(symbol: string, fileHint?: string): Promise<CodeMapNode[]> {
    if (!this.db) throw new Error('Engine not initialized. Call init() first.');
    return dbFindCallers(this.db, symbol, fileHint);
  }

  /** 查找被调用者 */
  async findCallees(symbol: string, fileHint?: string): Promise<CodeMapNode[]> {
    if (!this.db) throw new Error('Engine not initialized. Call init() first.');
    return dbFindCallees(this.db, symbol, fileHint);
  }

  /** 影响分析 */
  async analyzeImpact(fileOrSymbol: string, maxDepth?: number): Promise<ImpactResult> {
    if (!this.db) throw new Error('Engine not initialized. Call init() first.');
    return dbAnalyzeImpact(this.db, fileOrSymbol, maxDepth ?? 3);
  }

  /** 获取文件结构 */
  async getFileStructure(filePath?: string): Promise<FileNode[]> {
    if (!this.db) throw new Error('Engine not initialized. Call init() first.');
    return dbGetFileStructure(this.db, filePath);
  }

  /** 获取索引状态 */
  getStatus(): IndexStatus {
    if (!this.db) {
      return {
        fileCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        lastIndexedAt: null,
        initialized: false,
      };
    }
    return dbGetStatus(this.db);
  }

  /** 关闭数据库 */
  close(): void {
    if (this.db) {
      close(this.db);
      this.db = null;
    }
  }
}

// 导出类型和工具函数
export type {
  CodeMapNode,
  CodeMapEdge,
  CodeMapFile,
  CodeContext,
  CodeSnippet,
  CallPath,
  ImpactResult,
  FileNode,
  IndexStats,
  IndexStatus,
  SymbolKind,
  EdgeKind,
  Language,
} from './schema.js';

export { EDGE_WEIGHTS, EXTENSION_LANGUAGE_MAP, LANGUAGE_WASM_MAP } from './schema.js';
export { initParser, parseFile, getLanguageByPath } from './parser.js';
export { extractFromTree } from './extractor.js';
export { computePageRank } from './ranker.js';
export { distillContext, distillWithNeighbors } from './compression.js';
export { renderCodeMap, renderFileStructure } from './renderer.js';
export {
  initDatabase,
  insertFile,
  insertNode,
  insertEdge,
  deleteFileNodes,
  getNodeByName,
  getCallers,
  getCallees,
  updateRankScore,
  getFileByPath,
  getAllFiles,
  getAllNodes,
  getAllEdges,
} from './database.js';
export {
  fullIndex,
  incrementalIndex,
  scanSourceFiles,
  computeContentHash,
} from './indexer.js';
export {
  explore,
  findCallers as queryCallers,
  findCallees as queryCallees,
  analyzeImpact,
  getFileStructure,
  getStatus,
} from './querier.js';

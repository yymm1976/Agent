// src/memory/codebase-memory.ts
// 代码库语义索引：扫描项目根目录，建立「文件路径 → 语义摘要」索引
// 跨会话复用：索引持久化为 JSON，启动时加载，scan() 时更新
//
// 设计要点：
//   - 轻量摘要：每个文件取前 maxBytesPerFile 字节，提取首行注释、export 关键字、class/function 名
//   - 跳过列表：node_modules / .git / dist / build / .routedev 等通过 ignorePatterns 传入
//   - fail-open：扫描或写入失败仅记录 warn，不阻塞主流程
//   - Phase 71 Task D5：query() 升级为语义检索，复用 HybridRetriever（BM25 + 向量）
//     向量检索失败时降级到关键词检索，保证主流程不阻塞

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, relative, dirname, sep } from 'node:path';
import { logger } from '../utils/logger.js';
// 复用项目已有的 HybridRetriever / MemoryStore / Embedder 体系
import { MemoryStore } from './memory-store.js';
import { HybridRetriever, type HybridRetrieverConfig } from './hybrid-retriever.js';
import { HashEmbedder, type Embedder } from '../skills/embedder.js';

/** 代码库索引条目 */
export interface CodebaseEntry {
  /** 文件相对路径（相对于 rootDir） */
  filePath: string;
  /** 轻量语义摘要（首行注释 + export 关键字 + class/function 名） */
  summary: string;
  /** 上次扫描时间戳（ms） */
  lastScanned: number;
}

/** 默认跳过目录名 */
const DEFAULT_IGNORE_PATTERNS = ['node_modules', '.git', 'dist', 'build', '.routedev'];

/** 默认扫描的文件扩展名（仅源代码文件） */
const DEFAULT_SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.kt', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.php', '.swift', '.scala',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.md', '.rst',
  '.sh', '.bash', '.zsh', '.ps1',
]);

/** CodebaseMemory 构造选项 */
export interface CodebaseMemoryOptions {
  /** 最大索引文件数（默认 500） */
  maxFiles?: number;
  /** 每个文件读取的最大字节数（默认 2048） */
  maxBytesPerFile?: number;
  /** 跳过的目录/文件名列表（默认 node_modules/.git/dist/build/.routedev） */
  ignorePatterns?: string[];
  /** 索引持久化路径（默认 path.join(rootDir, '.routedev', 'codebase-memory.json')） */
  persistPath?: string;
  /** 注入外部 embedder（用于语义检索），未传时默认 HashEmbedder */
  embedder?: Embedder | null;
  /** HybridRetriever 配置（默认启用语义检索，BM25 0.4 + 向量 0.6） */
  hybridRetrieverConfig?: HybridRetrieverConfig;
  /**
   * 工作目录路径，用于派生 BM25 索引持久化路径。
   * 传入后启用 BM25 持久化模式，BM25 索引快照写入 {dbPath}/.routedev/memory/codebase-bm25.json。
   * 不传则纯内存模式（BM25 不持久化，向后兼容）。
   */
  dbPath?: string;
  /** 显式指定 BM25 索引持久化路径（优先级高于 dbPath 派生） */
  bm25PersistPath?: string;
}

export class CodebaseMemory {
  private entries = new Map<string, CodebaseEntry>();
  private readonly rootDir: string;
  private readonly maxFiles: number;
  private readonly maxBytesPerFile: number;
  private readonly ignorePatterns: Set<string>;
  private readonly persistPath: string;
  // 语义检索相关字段（Phase 71 Task D5）
  private readonly embedder: Embedder | null;
  private readonly hybridRetrieverConfig: HybridRetrieverConfig;
  // 懒构建的 HybridRetriever 实例，scan() 后置为脏需重建
  private hybridRetriever: HybridRetriever | null = null;
  private hybridRetrieverDirty = true;
  /** BM25 索引持久化路径（null 表示纯内存模式，不持久化 BM25） */
  private readonly bm25PersistPath: string | null;

  constructor(rootDir: string, options?: CodebaseMemoryOptions) {
    this.rootDir = rootDir;
    this.maxFiles = options?.maxFiles ?? 500;
    this.maxBytesPerFile = options?.maxBytesPerFile ?? 2048;
    this.ignorePatterns = new Set(options?.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS);
    this.persistPath = options?.persistPath ?? join(rootDir, '.routedev', 'codebase-memory.json');
    // embedder 默认 HashEmbedder（无外部依赖），传 null 显式禁用语义检索
    this.embedder = options?.embedder === undefined ? new HashEmbedder() : options.embedder;
    // 默认启用语义检索，权重与项目 memorySystem.hybridRetriever 默认值对齐
    this.hybridRetrieverConfig = options?.hybridRetrieverConfig ?? {
      enabled: true,
      bm25Weight: 0.4,
      embeddingWeight: 0.6,
      timeDecayHalfLifeDays: 30,
      topK: 50, // 取多一些再按 query limit 截断，保证相似度排序有效
    };
    // BM25 持久化路径：优先显式 bm25PersistPath，其次从 dbPath 派生，否则 null（纯内存）
    if (options?.bm25PersistPath) {
      this.bm25PersistPath = options.bm25PersistPath;
    } else if (options?.dbPath) {
      this.bm25PersistPath = join(options.dbPath, '.routedev', 'memory', 'codebase-bm25.json');
    } else {
      this.bm25PersistPath = null;
    }
    // 启动时加载已有索引，再加载 BM25 快照作为兜底（entries 为空时才填充），fail-open
    this.loadFromFile()
      .then(() => this.loadBm25())
      .catch(() => {});
  }

  /**
   * 扫描项目根目录，建立/更新语义索引
   * @returns 当前所有索引条目数组
   */
  async scan(): Promise<CodebaseEntry[]> {
    try {
      const collected: CodebaseEntry[] = [];
      await this.walk(this.rootDir, collected);
      // 限制最大文件数，按路径排序保证可预测性
      collected.sort((a, b) => a.filePath.localeCompare(b.filePath));
      const limited = collected.slice(0, this.maxFiles);

      // 更新内存索引
      this.entries.clear();
      for (const entry of limited) {
        this.entries.set(entry.filePath, entry);
      }

      // 索引变更后 HybridRetriever 需重建（Phase 71 Task D5）
      this.hybridRetrieverDirty = true;

      // 持久化到 JSON，fail-open
      await this.flushToFile();
      // 持久化 BM25 索引快照，fail-open
      await this.flushBm25();
      logger.info('CodebaseMemory: scan complete', {
        rootDir: this.rootDir,
        entries: this.entries.size,
        maxFiles: this.maxFiles,
      });
      return [...this.entries.values()];
    } catch (err) {
      logger.warn('CodebaseMemory: scan failed', {
        rootDir: this.rootDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return [...this.entries.values()];
    }
  }

  /**
   * 语义查询（Phase 71 Task D5 升级）：
   *   1. 优先调用 HybridRetriever（BM25 + 向量 + 时间衰减）做语义检索
   *   2. 向量检索失败/返回空/未启用时降级到关键词检索（fail-open）
   *   3. 空查询直接返回空，不触发检索
   *   4. 候选过滤：保留 bm25Score > 0（关键词命中）的条目，避免 HashEmbedder
   *      哈希碰撞产生的噪声；嵌入分数仍参与最终排序（语义加权）
   *      未来接入真实语义 embedder（如 TransformersEmbedder）后可放宽为
   *      bm25Score > 0 || embeddingScore > 0.5（正相关的纯语义命中）
   * @param keyword 搜索关键词/语义查询文本
   * @param limit 最大返回数（默认 10）
   */
  async query(keyword: string, limit = 10): Promise<CodebaseEntry[]> {
    // 空查询直接返回空，不报错
    if (!keyword || !keyword.trim()) return [];

    // 优先语义检索（HybridRetriever），失败降级关键词
    try {
      const retriever = await this.getOrCreateRetriever();
      if (retriever) {
        const scored = await retriever.retrieve(keyword);
        // 过滤：保留 BM25 命中的条目（避免哈希碰撞噪声），嵌入分数仍参与排序
        const filtered = scored.filter((s) => s.bm25Score > 0);
        if (filtered.length > 0) {
          // 将 MemoryEntry（id=filePath）映射回 CodebaseEntry，保持相似度降序
          const results: CodebaseEntry[] = [];
          for (const s of filtered) {
            const entry = this.entries.get(s.id ?? '');
            if (entry) results.push(entry);
          }
          // HybridRetriever 已按 score 降序排序，这里按 limit 截断
          return results.slice(0, limit);
        }
        // 语义检索无 BM25 命中：继续降级到关键词检索（处理 BM25 分词未覆盖的边界）
      }
    } catch (err) {
      // fail-open：向量检索失败降级到关键词检索，不阻塞主流程
      logger.warn('CodebaseMemory: semantic retrieval failed, fallback to keyword', {
        keyword: keyword.slice(0, 50),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return this.keywordQuery(keyword, limit);
  }

  /** 按文件路径精确获取条目 */
  get(filePath: string): CodebaseEntry | undefined {
    return this.entries.get(filePath);
  }

  /** 重新扫描（等价于 scan） */
  async reload(): Promise<void> {
    await this.scan();
  }

  /** 当前索引条目数 */
  size(): number {
    return this.entries.size;
  }

  // ===== 内部方法 =====

  /**
   * 懒构建 HybridRetriever（Phase 71 Task D5）：
   *   - 把当前 entries 灌入临时 MemoryStore（id=filePath，content=filePath+summary）
   *   - 注入 embedder（默认 HashEmbedder），调 store.setEmbedder 让 write 时计算向量
   *   - 索引变更（scan/loadFromFile）后通过 hybridRetrieverDirty 触发重建
   *   - 构建失败返回 null，调用方降级关键词检索
   */
  private async getOrCreateRetriever(): Promise<HybridRetriever | null> {
    if (!this.hybridRetrieverConfig.enabled) return null;
    if (!this.hybridRetrieverDirty && this.hybridRetriever) {
      return this.hybridRetriever;
    }

    // 无条目时不构建，避免空检索
    if (this.entries.size === 0) {
      this.hybridRetriever = null;
      return null;
    }

    try {
      // 临时 MemoryStore：embeddingProvider='none'，由 setEmbedder 注入
      const store = new MemoryStore({
        enabled: true,
        dbPath: ':memory:',
        backend: 'sqlite',
        embeddingProvider: 'none',
      });
      await store.initialize();
      // 注入 embedder，让 write() 时计算并存储向量
      store.setEmbedder(this.embedder);

      // 把 CodebaseEntry 灌入 store：id=filePath，content=filePath+summary
      for (const entry of this.entries.values()) {
        await store.write({
          id: entry.filePath,
          content: `${entry.filePath} ${entry.summary}`,
          type: 'topic',
          source: 'codebase-memory',
          validFrom: entry.lastScanned,
        });
      }

      this.hybridRetriever = new HybridRetriever(store, this.embedder, this.hybridRetrieverConfig);
      this.hybridRetrieverDirty = false;
      return this.hybridRetriever;
    } catch (err) {
      // 构建失败 fail-open：返回 null 让 query 降级关键词
      logger.warn('CodebaseMemory: build HybridRetriever failed', {
        entries: this.entries.size,
        error: err instanceof Error ? err.message : String(err),
      });
      this.hybridRetriever = null;
      return null;
    }
  }

  /**
   * 关键词检索（原 query 逻辑，作为语义检索的降级路径）
   * 在 filePath + summary 中匹配，按 scoreMatch 评分降序
   */
  private keywordQuery(keyword: string, limit: number): CodebaseEntry[] {
    const kw = keyword.toLowerCase();
    const results: Array<{ entry: CodebaseEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      const text = `${entry.filePath} ${entry.summary}`.toLowerCase();
      const score = this.scoreMatch(kw, text);
      if (score > 0) {
        results.push({ entry, score });
      }
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.entry);
  }

  /** 递归遍历目录，收集源码文件摘要 */
  private async walk(dir: string, collected: CodebaseEntry[]): Promise<void> {
    if (collected.length >= this.maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不可读，跳过
      return;
    }
    for (const entry of entries) {
      if (collected.length >= this.maxFiles) return;
      // 跳过 ignorePatterns 中的目录/文件名
      const entryName = entry.name.toString();
      if (this.ignorePatterns.has(entryName)) continue;
      const fullPath = join(dir, entryName);
      if (entry.isDirectory()) {
        await this.walk(fullPath, collected);
      } else if (entry.isFile()) {
        const rel = relative(this.rootDir, fullPath).split(sep).join('/');
        const codebaseEntry = await this.buildEntry(rel, fullPath);
        if (codebaseEntry) {
          collected.push(codebaseEntry);
        }
      }
    }
  }

  /** 读取文件前 maxBytesPerFile 字节，提取轻量摘要 */
  private async buildEntry(relPath: string, fullPath: string): Promise<CodebaseEntry | null> {
    // 仅索引已知扩展名的源码文件
    const ext = this.getExtension(relPath);
    if (ext && !DEFAULT_SCAN_EXTENSIONS.has(ext)) return null;

    try {
      const content = await readFile(fullPath, 'utf-8');
      const truncated = content.slice(0, this.maxBytesPerFile);
      const summary = this.extractSummary(truncated);
      return {
        filePath: relPath,
        summary,
        lastScanned: Date.now(),
      };
    } catch {
      // 文件读取失败，跳过
      return null;
    }
  }

  /**
   * 轻量摘要提取：
   *   - 首行注释（// 或 # 或 /*）
   *   - export 关键字行（export default/const/function/class）
   *   - class/function 名
   * 截断到 200 字符避免摘要过长
   */
  private extractSummary(content: string): string {
    const lines = content.split('\n');
    const fragments: string[] = [];

    // 1. 首行注释（前 5 行内查找）
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith('//')) {
        fragments.push(line.replace(/^\/\/\s*/, '').slice(0, 100));
        break;
      }
      if (line.startsWith('#') && !line.startsWith('#!')) {
        fragments.push(line.replace(/^#\s*/, '').slice(0, 100));
        break;
      }
      if (line.startsWith('/*')) {
        const comment = line.replace(/^\/\*\s*/, '').replace(/\*\/$/, '').slice(0, 100);
        if (comment) fragments.push(comment);
        break;
      }
      // 非注释首行，停止查找
      if (!line.startsWith('*')) break;
    }

    // 2. export / class / function 关键字行（最多取 8 个）
    const keywordRegex = /^\s*(export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum|abstract\s+class)\s+\w+|export\s+(?:default\s+)?\w+|class\s+\w+|function\s+\w+|interface\s+\w+|type\s+\w+)/;
    let keywordCount = 0;
    for (const line of lines) {
      if (keywordCount >= 8) break;
      const match = line.match(keywordRegex);
      if (match) {
        fragments.push(match[1].trim().slice(0, 80));
        keywordCount++;
      }
    }

    const summary = fragments.join(' | ').slice(0, 200);
    return summary;
  }

  /** 关键词匹配评分：完整匹配得 1 分，单词匹配按比例得分 */
  private scoreMatch(kw: string, text: string): number {
    if (text.includes(kw)) return 1;
    const words = kw.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return 0;
    let matchCount = 0;
    for (const w of words) {
      if (text.includes(w)) matchCount++;
    }
    return matchCount / words.length;
  }

  /** 获取文件扩展名（小写，含 .） */
  private getExtension(filePath: string): string {
    const idx = filePath.lastIndexOf('.');
    if (idx === -1) return '';
    return filePath.slice(idx).toLowerCase();
  }

  /** 从 JSON 文件加载索引，fail-open */
  private async loadFromFile(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, 'utf-8');
      const arr = JSON.parse(data) as CodebaseEntry[];
      this.entries.clear();
      for (const entry of arr) {
        if (entry && typeof entry.filePath === 'string') {
          this.entries.set(entry.filePath, entry);
        }
      }
      // 加载后索引变更，HybridRetriever 需重建
      this.hybridRetrieverDirty = true;
      logger.info('CodebaseMemory: loaded from file', {
        persistPath: this.persistPath,
        entries: this.entries.size,
      });
    } catch {
      // 文件不存在或损坏，静默跳过
    }
  }

  /** 将索引写入 JSON 文件，fail-open */
  private async flushToFile(): Promise<void> {
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      const data = JSON.stringify([...this.entries.values()], null, 2);
      await writeFile(this.persistPath, data, 'utf-8');
      logger.debug('CodebaseMemory: flushed to file', {
        persistPath: this.persistPath,
        entries: this.entries.size,
      });
    } catch (err) {
      logger.warn('CodebaseMemory: flush failed', {
        persistPath: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 显式落盘（同时持久化 entries 和 BM25 索引快照）
   * 供外部在关键节点调用确保数据持久化，fail-open
   */
  async flush(): Promise<void> {
    await this.flushToFile();
    await this.flushBm25();
  }

  /** 是否启用 BM25 持久化模式 */
  isBm25Persistent(): boolean {
    return this.bm25PersistPath !== null;
  }

  /**
   * 将 BM25 索引快照写入 JSON 文件，fail-open
   * 快照内容：BM25Index 的输入文档集（id=filePath, content=filePath+summary）
   * 跨会话恢复时可直接灌入 BM25Index，避免重新扫描
   */
  private async flushBm25(): Promise<void> {
    if (!this.bm25PersistPath) return;
    try {
      await mkdir(dirname(this.bm25PersistPath), { recursive: true });
      const docs = [...this.entries.values()].map((e) => ({
        id: e.filePath,
        content: `${e.filePath} ${e.summary}`,
        lastScanned: e.lastScanned,
      }));
      const payload = {
        version: 1,
        generatedAt: Date.now(),
        rootDir: this.rootDir,
        docs,
      };
      await writeFile(this.bm25PersistPath, JSON.stringify(payload, null, 2), 'utf-8');
      logger.debug('CodebaseMemory: BM25 snapshot flushed', {
        bm25PersistPath: this.bm25PersistPath,
        docs: docs.length,
      });
    } catch (err) {
      logger.warn('CodebaseMemory: BM25 flush failed', {
        bm25PersistPath: this.bm25PersistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 从 JSON 文件加载 BM25 索引快照，fail-open
   * 仅当 entries 为空时作为兜底数据源填充 entries（避免覆盖较新的 scan 结果）
   */
  private async loadBm25(): Promise<void> {
    if (!this.bm25PersistPath) return;
    try {
      const data = await readFile(this.bm25PersistPath, 'utf-8');
      const payload = JSON.parse(data) as {
        docs?: Array<{ id: string; content: string; lastScanned: number }>;
      };
      if (!payload.docs || !Array.isArray(payload.docs)) return;
      // 仅在 entries 尚未加载时填充（loadFromFile 优先）
      if (this.entries.size > 0) return;
      for (const doc of payload.docs) {
        if (doc && typeof doc.id === 'string') {
          // 从 BM25 doc 还原 CodebaseEntry（summary 从 content 中截取 filePath 之后部分）
          const summary = doc.content.startsWith(doc.id + ' ')
            ? doc.content.slice(doc.id.length + 1)
            : doc.content;
          this.entries.set(doc.id, {
            filePath: doc.id,
            summary,
            lastScanned: doc.lastScanned ?? 0,
          });
        }
      }
      this.hybridRetrieverDirty = true;
      logger.info('CodebaseMemory: BM25 snapshot loaded', {
        bm25PersistPath: this.bm25PersistPath,
        entries: this.entries.size,
      });
    } catch {
      // 文件不存在或损坏，静默跳过
    }
  }
}

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/token-estimate.js';

export type ImportanceTag = 'critical' | 'useful' | 'obsolete';

export interface CuratedChunk {
  id: string;
  content: string;
  importance: ImportanceTag;
  source: string;
  tokenEstimate: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

export interface CuratedSetConfig {
  autoPopulateCount: number;
  maxTokenBudget: number;
  importanceTaggingEnabled: boolean;
  subtractiveCurationEnabled: boolean;
}

const DEFAULT_CONFIG: CuratedSetConfig = {
  autoPopulateCount: 8,
  maxTokenBudget: 8000,
  importanceTaggingEnabled: true,
  subtractiveCurationEnabled: true,
};

const CRITICAL_PATTERN = /error|fail|crash|exception|throw|必须|禁止|不要|interface\s+\w+\s*\{|class\s+\w+\s*(extends|implements|\{)|function\s+\w+\s*\([^)]*\)\s*:/i;
const USEFUL_PATTERN = /```|config|setting|pnpm|npm|git\s|import\s|export\s/i;
const OBSOLETE_PATTERN = /^(\[?(log|debug|info|warn)\]?[:\s]|^\s*$)/i;

export class CuratedSet {
  private chunks = new Map<string, CuratedChunk>();
  private candidatePool: CuratedChunk[] = [];
  private firstPopulateDone = false;

  constructor(private readonly config: CuratedSetConfig = DEFAULT_CONFIG) {}

  async add(content: string, source: string): Promise<CuratedChunk> {
    const hash = this.hashContent(content);
    const id = hash.slice(0, 12);
    const existing = this.chunks.get(id);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      existing.accessCount++;
      return existing;
    }

    const importance = this.config.importanceTaggingEnabled
      ? this.estimateImportance(content)
      : 'useful';

    const chunk: CuratedChunk = {
      id,
      content,
      importance,
      source,
      tokenEstimate: estimateTokens(content),
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
    };

    this.candidatePool.push(chunk);

    if (!this.firstPopulateDone && this.candidatePool.length >= this.config.autoPopulateCount) {
      this.autoPopulate();
    }

    return chunk;
  }

  private autoPopulate(): void {
    this.firstPopulateDone = true;
    const seen = new Set<string>();

    const importanceOrder: Record<ImportanceTag, number> = { critical: 3, useful: 2, obsolete: 1 };
    const sorted = [...this.candidatePool].sort(
      (a, b) => importanceOrder[b.importance] - importanceOrder[a.importance],
    );

    let added = 0;
    for (const chunk of sorted) {
      if (added >= this.config.autoPopulateCount) break;
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      this.chunks.set(chunk.id, chunk);
      added++;
    }

    logger.info('CuratedSet: autoPopulate completed', {
      added,
      candidatePoolSize: this.candidatePool.length,
      curatedSetSize: this.chunks.size,
    });
  }

  estimateImportance(content: string): ImportanceTag {
    if (CRITICAL_PATTERN.test(content)) return 'critical';
    if (USEFUL_PATTERN.test(content)) return 'useful';
    if (OBSOLETE_PATTERN.test(content)) return 'obsolete';
    return 'useful';
  }

  prune(chunkIds: string[]): CuratedChunk[] {
    const removed: CuratedChunk[] = [];
    for (const id of chunkIds) {
      const chunk = this.chunks.get(id);
      if (chunk) {
        removed.push(chunk);
        this.chunks.delete(id);
      }
    }
    return removed;
  }

  promote(chunkId: string, to: ImportanceTag): boolean {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return false;
    chunk.importance = to;
    return true;
  }

  renderToPrompt(tokenBudget: number): {
    prompt: string;
    usedTokens: number;
    renderedChunks: CuratedChunk[];
  } {
    const importanceOrder: Record<ImportanceTag, number> = { critical: 0, useful: 1, obsolete: 2 };
    const sorted = Array.from(this.chunks.values()).sort(
      (a, b) => importanceOrder[a.importance] - importanceOrder[b.importance],
    );

    let usedTokens = 0;
    const renderedChunks: CuratedChunk[] = [];
    const sections: Record<ImportanceTag, string[]> = {
      critical: [],
      useful: [],
      obsolete: [],
    };

    for (const chunk of sorted) {
      const chunkTokens = chunk.tokenEstimate;
      if (usedTokens + chunkTokens > tokenBudget) break;
      usedTokens += chunkTokens;
      renderedChunks.push(chunk);
      chunk.lastAccessedAt = Date.now();
      chunk.accessCount++;
      const prefix = `[${chunk.source}]`;
      sections[chunk.importance].push(`- ${prefix} ${chunk.content.slice(0, 200)}`);
    }

    const parts: string[] = [];
    parts.push(`[策展集 - 剩余预算 ${tokenBudget - usedTokens} tokens]`);

    if (sections.critical.length > 0) {
      parts.push('## 关键信息（critical）');
      parts.push(...sections.critical);
    }
    if (sections.useful.length > 0) {
      parts.push('## 有用信息（useful）');
      parts.push(...sections.useful);
    }
    if (sections.obsolete.length > 0) {
      parts.push('## 参考信息（obsolete）');
      parts.push(...sections.obsolete);
    }

    parts.push('');
    parts.push('## Policy 四问');
    parts.push('1. What do I know? 上述已检索的关键主题');
    parts.push('2. What should I search for next? 考虑未尝试的搜索方法');
    parts.push('3. What should I prune? 用 PruneChunksTool 移除低价值 chunk');
    parts.push('4. Do I have enough information? 是否有足够信息或存在关键缺口');

    return { prompt: parts.join('\n'), usedTokens, renderedChunks };
  }

  query(params: { keyword?: string; source?: string; importance?: ImportanceTag }): CuratedChunk[] {
    let results = Array.from(this.chunks.values());

    if (params.keyword) {
      const kw = params.keyword.toLowerCase();
      results = results.filter((c) => c.content.toLowerCase().includes(kw));
    }
    if (params.source) {
      results = results.filter((c) => c.source.includes(params.source!));
    }
    if (params.importance) {
      results = results.filter((c) => c.importance === params.importance);
    }

    return results;
  }

  getStats(): {
    totalChunks: number;
    totalTokens: number;
    byImportance: Record<ImportanceTag, number>;
    candidatePoolSize: number;
  } {
    const byImportance: Record<ImportanceTag, number> = { critical: 0, useful: 0, obsolete: 0 };
    let totalTokens = 0;

    for (const chunk of this.chunks.values()) {
      byImportance[chunk.importance]++;
      totalTokens += chunk.tokenEstimate;
    }

    return {
      totalChunks: this.chunks.size,
      totalTokens,
      byImportance,
      candidatePoolSize: this.candidatePool.length,
    };
  }

  private hashContent(content: string): string {
    const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
    return createHash('sha256').update(normalized).digest('hex');
  }
}

import { createHash } from 'node:crypto';

export interface ContentDedupConfig {
  enabled: boolean;
  hashAlgorithm: 'sha256' | 'md5';
  minLength: number;
  replaceWithReference: boolean;
}

const DEFAULT_CONFIG: ContentDedupConfig = {
  enabled: true,
  hashAlgorithm: 'sha256',
  minLength: 50,
  replaceWithReference: true,
};

export interface DedupResult<T = unknown> {
  items: T[];
  deduplicatedCount: number;
  savedTokens: number;
  hashToFirstIndex: Map<string, number>;
}

export class ContentDeduplicator {
  constructor(
    private readonly config: ContentDedupConfig = DEFAULT_CONFIG,
    private readonly estimateTokensFn: (text: string) => number = defaultEstimateTokens,
  ) {}

  dedup<T>(items: T[], contentExtractor: (item: T) => string): DedupResult<T> {
    if (!this.config.enabled) {
      return { items: [...items], deduplicatedCount: 0, savedTokens: 0, hashToFirstIndex: new Map() };
    }

    const hashToFirstIndex = new Map<string, number>();
    const result: T[] = [];
    let deduplicatedCount = 0;
    let savedTokens = 0;

    for (let i = 0; i < items.length; i++) {
      const content = contentExtractor(items[i]);
      if (content.length < this.config.minLength) {
        result.push(items[i]);
        continue;
      }

      const hash = this.hashContent(content);
      const existingIndex = hashToFirstIndex.get(hash);

      if (existingIndex !== undefined) {
        deduplicatedCount++;
        savedTokens += this.estimateTokensFn(content);
        if (this.config.replaceWithReference) {
          const marker = `[...DEDUP:hash=${hash.slice(0, 12)} first=#${existingIndex}...]`;
          // 保留双断言：marker 是 string，T 是泛型（items 元素类型），
          // string 与任意 T 结构不兼容，泛型设计固有限制需 unknown 中转
          result.push(marker as unknown as T);
        }
      } else {
        hashToFirstIndex.set(hash, i);
        result.push(items[i]);
      }
    }

    return { items: result, deduplicatedCount, savedTokens, hashToFirstIndex };
  }

  hashContent(content: string): string {
    const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
    const algo = this.config.hashAlgorithm;
    return createHash(algo).update(normalized).digest('hex');
  }
}

function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

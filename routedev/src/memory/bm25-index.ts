// src/memory/bm25-index.ts
// Phase 65 Task 3：BM25Index - BM25 倒排索引
//
// 论文：BM25 稀疏检索（词频饱和 + IDF）
// 实现：
//   - 标准 BM25 公式（k1=1.5, b=0.75）
//   - tokenize：按空格+标点分词，CJK 按 bigram
//   - 支持 index（批量索引）和 search（查询返回 top-K）

export interface BM25Doc {
  id: string;
  content: string;
}

export interface BM25SearchResult {
  id: string;
  score: number;
}

/**
 * 分词：按空格和标点切分，CJK 字符按 bigram 提取
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // 切分为词（保留 ASCII 字母数字 + CJK 字符，其他作为分隔符）
  const words = lower.split(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/).filter(Boolean);

  for (const word of words) {
    // 检查是否纯 CJK
    if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/.test(word)) {
      // CJK bigram
      if (word.length === 1) {
        tokens.push(word);
      } else {
        for (let i = 0; i < word.length - 1; i++) {
          tokens.push(word.substring(i, i + 2));
        }
      }
    } else {
      // ASCII 词
      tokens.push(word);
    }
  }

  return tokens;
}

/**
 * BM25 倒排索引
 *
 * 公式：
 *   score(D, q) = Σ_i IDF(qi) × (f(qi, D) × (k1 + 1)) / (f(qi, D) + k1 × (1 - b + b × |D| / avgdl))
 *   IDF(qi) = ln((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
 *
 * 参数：
 *   k1: 词频饱和参数（默认 1.5）
 *   b:  长度归一化参数（默认 0.75）
 */
export class BM25Index {
  private k1: number;
  private b: number;
  private docs: BM25Doc[] = [];
  private docTokens: Map<string, string[]> = new Map();
  private docLengths: Map<string, number> = new Map();
  private avgdl = 0;
  /** document frequency: 每个 term 出现在多少文档中 */
  private df: Map<string, number> = new Map();
  private N = 0;

  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  /** 批量索引文档 */
  index(docs: BM25Doc[]): void {
    this.docs = docs;
    this.docTokens.clear();
    this.docLengths.clear();
    this.df.clear();
    this.N = docs.length;

    let totalLength = 0;
    for (const doc of docs) {
      const tokens = tokenize(doc.content);
      this.docTokens.set(doc.id, tokens);
      this.docLengths.set(doc.id, tokens.length);
      totalLength += tokens.length;

      // 统计 df（每个 term 在多少文档中出现）
      const uniqueTokens = new Set(tokens);
      for (const t of uniqueTokens) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
    this.avgdl = this.N > 0 ? totalLength / this.N : 0;
  }

  /** 查询：返回前 limit 个文档的 BM25 分数（降序） */
  search(query: string, limit: number): BM25SearchResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.N === 0) return [];

    const scores: BM25SearchResult[] = [];
    for (const doc of this.docs) {
      const tokens = this.docTokens.get(doc.id);
      const dl = this.docLengths.get(doc.id);
      if (!tokens || dl === undefined) continue;

      // 统计当前文档的 term frequency
      const tf: Map<string, number> = new Map();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }

      let score = 0;
      for (const qt of queryTokens) {
        const f = tf.get(qt) ?? 0;
        if (f === 0) continue;
        const df = this.df.get(qt) ?? 0;
        // IDF（+1 保证非负）
        const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
        // BM25 词频饱和
        const denom = f + this.k1 * (1 - this.b + this.b * (dl / (this.avgdl || 1)));
        score += (idf * (f * (this.k1 + 1))) / denom;
      }

      if (score > 0) {
        scores.push({ id: doc.id, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
  }
}

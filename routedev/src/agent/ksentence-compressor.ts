import { createHash } from 'node:crypto';
import { estimateTokens } from '../utils/token-estimate.js';

export interface KSentenceConfig {
  k: number;
  scoring: {
    keywordWeight: number;
    lengthWeight: number;
    positionWeight: number;
  };
}

const DEFAULT_CONFIG: KSentenceConfig = {
  k: 4,
  scoring: {
    keywordWeight: 0.5,
    lengthWeight: 0.3,
    positionWeight: 0.2,
  },
};

const KEYWORD_PATTERN = /error|fail|crash|必须|禁止|不要|function|interface|class|return|throw/i;

export class KSentenceCompressor {
  constructor(private readonly config: KSentenceConfig = DEFAULT_CONFIG) {}

  compress(content: string): {
    compressed: string;
    originalSentenceCount: number;
    keptSentenceCount: number;
    wasCompressed: boolean;
  } {
    const sentences = this.splitSentences(content);
    const originalCount = sentences.length;

    if (originalCount <= this.config.k) {
      return {
        compressed: content,
        originalSentenceCount: originalCount,
        keptSentenceCount: originalCount,
        wasCompressed: false,
      };
    }

    const scored = sentences.map((s, i) => ({
      sentence: s,
      score: this.scoreSentence(s, i, originalCount),
      index: i,
    }));

    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const topK = sorted.slice(0, this.config.k);
    const topKIndices = new Set(topK.map((s) => s.index));

    const kept = sentences
      .filter((_, i) => topKIndices.has(i))
      .join('');

    const marker = `[...K-sentence 压缩：保留 ${this.config.k}/${originalCount} 句...]`;
    return {
      compressed: marker + kept,
      originalSentenceCount: originalCount,
      keptSentenceCount: this.config.k,
      wasCompressed: true,
    };
  }

  splitSentences(text: string): string[] {
    const result: string[] = [];
    const regex = /[^。！？.!?\n]*[。！？.!?\n]|[^。！？.!?\n]+$/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const s = match[0];
      if (s.trim().length > 0) {
        result.push(s);
      }
    }
    return result.length > 0 ? result : [text];
  }

  scoreSentence(sentence: string, index: number, total: number): number {
    const { keywordWeight, lengthWeight, positionWeight } = this.config.scoring;

    const keywordScore = KEYWORD_PATTERN.test(sentence) ? 1 : 0;

    const len = sentence.length;
    let lengthScore: number;
    if (len >= 20 && len <= 200) {
      lengthScore = 1;
    } else if (len < 20) {
      lengthScore = len / 20;
    } else {
      lengthScore = Math.max(0, 1 - (len - 200) / 800);
    }

    const positionScore = (index === 0 || index === total - 1) ? 1 : 0.5;

    return keywordWeight * keywordScore + lengthWeight * lengthScore + positionWeight * positionScore;
  }

  compressMessages(messages: Array<{ role: string; content: string | unknown[]; [k: string]: unknown }>): Array<{ role: string; content: string | unknown[]; [k: string]: unknown }> {
    return messages.map((msg) => {
      if (msg.role === 'system') return msg;
      if (typeof msg.content !== 'string') return msg;

      const result = this.compress(msg.content);
      if (!result.wasCompressed) return msg;

      return { ...msg, content: result.compressed };
    });
  }
}

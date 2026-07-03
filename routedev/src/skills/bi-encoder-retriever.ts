// src/skills/bi-encoder-retriever.ts
// Bi-encoder 技能检索器
//
// 论文：arXiv:2606.18051 all-MiniLM-L6-v2（384 维）+ FAISS 精确内积
// RouteDev 落地：memory 内积矩阵（<1K 技能库足够）
// 降级：模型不可用时返回 null，调用方降级关键词检索

import { logger } from '../utils/logger.js';
import { HashEmbedder, TransformersEmbedder } from './embedder.js';
import type { Embedder } from './embedder.js';
import type { AtomicSubTask, SkillMatch } from './compositional-router.js';

export type { AtomicSubTask, SkillMatch };

export interface BiEncoderConfig {
  enabled: boolean;
  modelId: string;
  topK: number;
  minScore: number;
  backend: 'memory' | 'hnswlib';
}

interface IndexEntry {
  skillId: string;
  skillName: string;
  category: string;
  vec: number[];
  cacheKey: string;
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function sha256Short(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class BiEncoderSkillRetriever {
  private index: IndexEntry[] = [];
  private embedder: Embedder | null = null;
  private ready = false;
  private readonly embeddingCache = new Map<string, number[]>();

  constructor(private readonly config: BiEncoderConfig) {}

  async initialize(
    skills: Array<{ id: string; name: string; description: string; category: string }>,
  ): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const useTransformers = this.config.modelId !== 'hash';
      if (useTransformers) {
        const te = new TransformersEmbedder();
        const ok = await te.initialize(this.config.modelId);
        this.embedder = ok ? te : new HashEmbedder();
      } else {
        this.embedder = new HashEmbedder();
      }

      const texts = skills.map((s) => `${s.name} ${s.description}`);
      const keys = skills.map((s) => `${s.id}:${sha256Short(s.name + s.description)}`);

      const uncachedIdxs: number[] = [];
      for (let i = 0; i < skills.length; i++) {
        if (!this.embeddingCache.has(keys[i])) uncachedIdxs.push(i);
      }

      if (uncachedIdxs.length > 0) {
        const uncachedTexts = uncachedIdxs.map((i) => texts[i]);
        const vecs = await this.embedder.embedBatch(uncachedTexts);
        for (let j = 0; j < uncachedIdxs.length; j++) {
          const normalized = l2Normalize(vecs[j]);
          this.embeddingCache.set(keys[uncachedIdxs[j]], normalized);
        }
      }

      this.index = skills.map((s, i) => ({
        skillId: s.id,
        skillName: s.name,
        category: s.category,
        vec: this.embeddingCache.get(keys[i])!,
        cacheKey: keys[i],
      }));

      this.ready = true;
    } catch (err) {
      logger.warn('BiEncoderSkillRetriever: 初始化失败，降级关键词检索', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && this.embedder !== null;
  }

  async retrieve(subTask: AtomicSubTask): Promise<SkillMatch | null> {
    const results = await this.retrieveTopK(subTask, 1);
    return results.length > 0 ? results[0] : null;
  }

  async retrieveTopK(subTask: AtomicSubTask, k: number): Promise<SkillMatch[]> {
    if (!this.isReady() || this.index.length === 0) return [];

    try {
      const queryVec = l2Normalize(await this.embedder!.embed(subTask.description));

      const scored = this.index.map((entry) => ({
        entry,
        score: dotProduct(queryVec, entry.vec),
      }));

      scored.sort((a, b) => b.score - a.score);

      return scored
        .slice(0, k)
        .filter((s) => s.score >= this.config.minScore)
        .map((s) => ({
          subTaskId: subTask.id,
          skillId: s.entry.skillId,
          skillName: s.entry.skillName,
          confidence: Math.min(1, Math.max(0, s.score)),
          category: s.entry.category,
        }));
    } catch (err) {
      logger.warn('BiEncoderSkillRetriever: 检索失败', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

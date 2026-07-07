// src/router/embedder.ts
// ACRouter 闭环模型路由：Embedding 提供者接口与降级实现
//
// P0 修复：统一使用 skills/embedder.ts 作为唯一 Embedder 实现
// 本文件仅保留 ACRouter 专用的工具函数

import { HashEmbedder as SkillsHashEmbedder } from '../skills/embedder.js';
import type { Embedder as SkillsEmbedder } from '../skills/embedder.js';

// re-export skills/embedder.ts 的完整实现
export { SkillsHashEmbedder as HashEmbedder };
export type { SkillsEmbedder as Embedder };

/**
 * 创建 Embedder 工厂函数（ACRouter 专用）
 */
export function createEmbedder(provider: 'openai' | 'hash', _apiKey?: string): SkillsEmbedder {
  return new SkillsHashEmbedder();
}

/**
 * 余弦相似度（ACRouter 专用）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

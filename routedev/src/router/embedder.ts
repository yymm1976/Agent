// src/router/embedder.ts
// ACRouter 闭环模型路由：Embedding 提供者接口与降级实现
//
// P0 修复：统一使用 skills/embedder.ts 作为唯一 Embedder 实现
// 本文件仅保留 ACRouter 专用的工具函数
//
// Phase 96 M-3 已知缺陷：HashEmbedder 是纯词袋哈希（FNV-1a），无语义能力
// 语义相似但词汇不同的查询（"fix bug" vs "resolve defect"）余弦相似度趋零
// 导致 RoutingOrchestrator 的 neighbor 路径几乎永远返回空统计（永久冷启动）
// 当前 RoutingOrchestrator 由 closedLoopRouting.enabled 默认 false 门控休眠，影响为 0
// TODO: 解冻 ACRouter 前需替换为真实语义 Embedder（如 OpenAI text-embedding-3-small 或本地 MiniLM）

import { HashEmbedder as SkillsHashEmbedder } from '../skills/embedder.js';
import type { Embedder as SkillsEmbedder } from '../skills/embedder.js';

// re-export skills/embedder.ts 的完整实现
export { SkillsHashEmbedder as HashEmbedder };
export type { SkillsEmbedder as Embedder };

/**
 * 创建 Embedder 工厂函数（ACRouter 专用）
 *
 * Phase 96 M-3：provider='openai' 当前也降级为 HashEmbedder（语义能力不足，见文件顶部 TODO）
 */
export function createEmbedder(provider: 'openai' | 'hash', _apiKey?: string): SkillsEmbedder {
  // TODO Phase 96 M-3：provider='openai' 时应创建 OpenAIEembedder
  // 当前实现统一降级为 HashEmbedder，等 ACRouter 解冻时再实现真实语义 Embedder
  void provider; // 显式标记未使用，避免 lint 警告
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

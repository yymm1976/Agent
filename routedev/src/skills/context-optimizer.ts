// src/skills/context-optimizer.ts
// 技能上下文优化器
//
// 论文：arXiv:2606.18051 全技能 884K → 平均 1160 tokens（99.9% 减少）
// 机制：按子任务检索 2-5 技能注入，而非暴露全库

import { logger } from '../utils/logger.js';
import type { AtomicSubTask } from './compositional-router.js';
import type { BiEncoderSkillRetriever } from './bi-encoder-retriever.js';

export type { AtomicSubTask };

export interface SkillContextOptimizerConfig {
  enabled: boolean;
  perSubTaskTopK: number;
  maxTotalSkills: number;
  maxTokens: number;
}

export interface OptimizedSkillContext {
  skills: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    confidence: number;
  }>;
  estimatedTokens: number;
  truncated: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class SkillContextOptimizer {
  constructor(
    private readonly retriever: BiEncoderSkillRetriever,
    private readonly config: SkillContextOptimizerConfig,
  ) {}

  async buildContext(
    subTasks: AtomicSubTask[],
    fallbackSkills?: Array<{ id: string; name: string; description: string; category: string }>,
  ): Promise<OptimizedSkillContext> {
    if (!this.config.enabled || subTasks.length === 0) {
      return { skills: [], estimatedTokens: 0, truncated: false };
    }

    const merged = new Map<
      string,
      { id: string; name: string; description: string; category: string; confidence: number }
    >();

    if (this.retriever.isReady()) {
      for (const sub of subTasks) {
        try {
          const topK = await this.retriever.retrieveTopK(sub, this.config.perSubTaskTopK);
          for (const match of topK) {
            if (!merged.has(match.skillId) || merged.get(match.skillId)!.confidence < match.confidence) {
              merged.set(match.skillId, {
                id: match.skillId,
                name: match.skillName,
                description: '',
                category: match.category,
                confidence: match.confidence,
              });
            }
          }
        } catch (err) {
          logger.warn('SkillContextOptimizer: 检索失败', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (fallbackSkills) {
      const subCats = new Set(subTasks.map((s) => s.expectedSkillCategory.toLowerCase()));
      for (const s of fallbackSkills) {
        if (subCats.has(s.category.toLowerCase())) {
          merged.set(s.id, { ...s, confidence: 0.5 });
        }
      }
    }

    let skills = Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);

    if (skills.length > this.config.maxTotalSkills) {
      skills = skills.slice(0, this.config.maxTotalSkills);
    }

    let estimatedTokens = 0;
    let truncated = false;
    const final: typeof skills = [];

    for (const s of skills) {
      const t = estimateTokens(`${s.name} ${s.description}`);
      if (estimatedTokens + t > this.config.maxTokens) {
        truncated = true;
        break;
      }
      estimatedTokens += t;
      final.push(s);
    }

    return { skills: final, estimatedTokens, truncated };
  }
}

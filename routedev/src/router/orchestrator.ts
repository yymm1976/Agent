// src/router/orchestrator.ts
// ACRouter 闭环模型路由：Orchestrator 邻居加权决策
// 论文借鉴：ACRouter Orchestrator 整合先验+记忆邻居+元数据，加权投票决策
// OOD 适应：静态路由器 OOD 集体崩溃，ACRouter 62.50-73.30%

import type { ModelRouter } from './router.js';
import type { RoutingHistory, ModelStats } from './routing-history.js';
import type { RoutingMemory, NeighborModelStats } from './routing-memory.js';
import type { ClassificationResult, RoutingResult, ScenarioTier } from './types.js';
import { logger } from '../utils/logger.js';

export interface OrchestratorConfig {
  enabled: boolean;
  neighborWeight: number;
  priorWeight: number;
  baseWeight: number;
}

export interface OrchestratorResult extends RoutingResult {
  orchestratorMeta?: {
    usedNeighbors: boolean;
    neighborCount: number;
    baseScore: number;
    priorScore: number;
    neighborScore: number;
    finalScore: number;
  };
}

export class RoutingOrchestrator {
  private readonly baseRouter: ModelRouter;
  private readonly memory: RoutingMemory;
  private readonly history: RoutingHistory;
  private readonly config: OrchestratorConfig;

  constructor(
    baseRouter: ModelRouter,
    memory: RoutingMemory,
    history: RoutingHistory,
    config?: Partial<OrchestratorConfig>,
  ) {
    this.baseRouter = baseRouter;
    this.memory = memory;
    this.history = history;
    this.config = {
      enabled: config?.enabled ?? false,
      neighborWeight: config?.neighborWeight ?? 0.6,
      priorWeight: config?.priorWeight ?? 0.3,
      baseWeight: config?.baseWeight ?? 0.1,
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async route(query: string, classification: ClassificationResult): Promise<OrchestratorResult> {
    if (!this.config.enabled) {
      const baseResult = await this.baseRouter.route(classification);
      return { ...baseResult };
    }

    try {
      return await this.routeWithOrchestration(query, classification);
    } catch (err) {
      logger.warn('RoutingOrchestrator failed, falling back to base router', {
        error: err instanceof Error ? err.message : String(err),
      });
      const baseResult = await this.baseRouter.route(classification);
      return { ...baseResult };
    }
  }

  private async routeWithOrchestration(
    query: string,
    classification: ClassificationResult,
  ): Promise<OrchestratorResult> {
    const baseResult = await this.baseRouter.route(classification);
    const [neighborStats, priorStats] = await Promise.all([
      this.memory.queryModelStats(query),
      Promise.resolve(this.history.getStatsByModel()),
    ]);

    if (neighborStats.size === 0 && priorStats.size === 0) {
      return { ...baseResult, orchestratorMeta: { usedNeighbors: false, neighborCount: 0, baseScore: 0, priorScore: 0, neighborScore: 0, finalScore: 0 } };
    }

    const candidateModels = this.collectCandidateModels(baseResult, neighborStats, priorStats);
    let bestModelId = baseResult.model.id;
    let bestScore = -Infinity;
    let bestMeta = { baseScore: 0, priorScore: 0, neighborScore: 0, finalScore: 0, neighborCount: 0 };

    for (const modelId of candidateModels) {
      const baseScore = this.computeBaseScore(modelId, baseResult, classification);
      const priorScore = this.computePriorScore(modelId, priorStats);
      const neighborResult = neighborStats.get(modelId);
      const neighborScore = neighborResult?.weightedScore ?? 0;
      const neighborCount = neighborResult?.neighborCount ?? 0;

      let finalScore: number;
      if (neighborCount > 0) {
        finalScore = this.config.baseWeight * baseScore
          + this.config.priorWeight * priorScore
          + this.config.neighborWeight * neighborScore;
      } else {
        const totalWeight = this.config.baseWeight + this.config.priorWeight;
        finalScore = totalWeight > 0
          ? (this.config.baseWeight * baseScore + this.config.priorWeight * priorScore) / totalWeight
          : baseScore;
      }

      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestModelId = modelId;
        bestMeta = { baseScore, priorScore, neighborScore, finalScore, neighborCount };
      }
    }

    if (bestModelId === baseResult.model.id) {
      return {
        ...baseResult,
        orchestratorMeta: { usedNeighbors: neighborStats.size > 0, ...bestMeta },
      };
    }

    const allModels = this.getAvailableModelConfigs();
    const targetModel = allModels.find(m => m.id === bestModelId);
    if (!targetModel) {
      return { ...baseResult, orchestratorMeta: { usedNeighbors: neighborStats.size > 0, ...bestMeta } };
    }

    logger.info('Orchestrator overrode base router decision', {
      baseModel: baseResult.model.id,
      overrideModel: bestModelId,
      finalScore: bestScore,
    });

    return {
      model: {
        ...baseResult.model,
        id: targetModel.id,
        provider: targetModel.provider,
        tier: targetModel.tier,
      },
      providerId: targetModel.provider,
      fallbackUsed: false,
      originalTier: baseResult.originalTier,
      degraded: false,
      enableCache: true,
      orchestratorMeta: { usedNeighbors: neighborStats.size > 0, ...bestMeta },
    };
  }

  private collectCandidateModels(
    baseResult: RoutingResult,
    neighborStats: Map<string, NeighborModelStats>,
    priorStats: Map<string, ModelStats>,
  ): Set<string> {
    const candidates = new Set<string>();
    candidates.add(baseResult.model.id);
    for (const modelId of neighborStats.keys()) candidates.add(modelId);
    for (const modelId of priorStats.keys()) candidates.add(modelId);
    return candidates;
  }

  private computeBaseScore(
    modelId: string,
    baseResult: RoutingResult,
    classification: ClassificationResult,
  ): number {
    if (modelId === baseResult.model.id) return 1.0;
    const tierOrder: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
    const allModels = this.getAvailableModelConfigs();
    const model = allModels.find(m => m.id === modelId);
    if (!model) return 0.3;
    // TD-13：classification.tier 现为 ScenarioTier | 'deterministic'，
    //        'deterministic' 不在 tierOrder 中，indexOf 返回 -1（与原运行时行为一致）
    const tier = classification.tier;
    const tierIndex = tier === 'deterministic' ? -1 : tierOrder.indexOf(tier);
    const modelTierIndex = tierOrder.indexOf(model.tier);
    const distance = Math.abs(tierIndex - modelTierIndex);
    return Math.max(0, 1 - distance * 0.25);
  }

  private computePriorScore(modelId: string, priorStats: Map<string, ModelStats>): number {
    const stats = priorStats.get(modelId);
    if (!stats || stats.sampleCount === 0) return 0.5;
    return stats.avgQuality;
  }

  private getAvailableModelConfigs() {
    return (this.baseRouter as unknown as { getAvailableModels: () => Array<{ id: string; provider: string; tier: string }> }).getAvailableModels()
      .map(m => ({ id: m.id, provider: m.provider, tier: m.tier as ScenarioTier }));
  }
}

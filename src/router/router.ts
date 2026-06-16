// src/router/router.ts
// 模型路由器：根据分类结果选择模型 + 降级策略
// 降级链：fallback 模型 → 降 tier → 强制最低可用模型

import type {
  ScenarioTier,
  RoutingResult,
  RouterConfig,
  RouterRule,
  ModelConfig,
  DegradationReason,
} from './types.js';
import type { ClassificationResult } from './types.js';
import { TokenTracker } from './tracker.js';
import { logger } from '../utils/logger.js';

/** 模型定义（从配置推断） */
interface ModelDefinition {
  id: string;
  providerId: string;
  tier: ScenarioTier;
}

/**
 * 模型路由器
 * 功能：
 * - 根据分类结果选择对应 tier 的模型
 * - 支持 fallback 模型
 * - 支持降级策略（预算超限、模型不可用等）
 * - 支持手动覆盖（用户指定模型）
 */
export class ModelRouter {
  private config: RouterConfig;
  private tracker: TokenTracker;
  private models: Map<string, ModelDefinition> = new Map();
  private manualOverride: string | null = null;

  constructor(config: RouterConfig, tracker: TokenTracker) {
    this.config = config;
    this.tracker = tracker;
    this.initializeModels();
  }

  /**
   * 初始化模型列表（从路由规则推断）
   */
  private initializeModels(): void {
    for (const rule of this.config.rules) {
      // 主模型
      this.models.set(rule.modelId, {
        id: rule.modelId,
        providerId: this.inferProviderId(rule.modelId),
        tier: rule.tier,
      });

      // Fallback 模型
      if (rule.fallbackModelId) {
        this.models.set(rule.fallbackModelId, {
          id: rule.fallbackModelId,
          providerId: this.inferProviderId(rule.fallbackModelId),
          tier: rule.tier,
        });
      }
    }

    logger.debug('Models initialized', { count: this.models.size });
  }

  /**
   * 推断 provider ID（从模型 ID）
   */
  private inferProviderId(modelId: string): string {
    // 简单启发式：根据模型名称推断
    if (modelId.includes('gpt') || modelId.includes('o1') || modelId.includes('o3')) {
      return 'openai';
    }
    if (modelId.includes('claude')) {
      return 'anthropic';
    }
    if (modelId.includes('qwen')) {
      return 'dashscope';
    }
    if (modelId.includes('deepseek')) {
      return 'deepseek';
    }
    return 'unknown';
  }

  /**
   * 路由请求
   */
  async route(classification: ClassificationResult): Promise<RoutingResult> {
    // 检查手动覆盖
    if (this.manualOverride) {
      const model = this.models.get(this.manualOverride);
      if (model) {
        return {
          model: this.toModelConfig(model),
          providerId: model.providerId,
          fallbackUsed: false,
          originalTier: classification.tier,
          degraded: false,
        };
      }
    }

    // 检查预算
    const budgetOk = this.tracker.checkBudget();
    if (!budgetOk && this.config.budget.mode === 'enforce') {
      return this.degrade(classification.tier, 'budget_exceeded');
    }

    // 根据 tier 查找规则
    const rule = this.findRule(classification.tier);
    if (!rule) {
      // 找不到规则，降级到最低 tier
      return this.degrade(classification.tier, 'model_unavailable');
    }

    // 尝试主模型
    const mainModel = this.models.get(rule.modelId);
    if (mainModel && this.isModelAvailable(mainModel)) {
      return {
        model: this.toModelConfig(mainModel),
        providerId: mainModel.providerId,
        fallbackUsed: false,
        originalTier: classification.tier,
        degraded: false,
      };
    }

    // 尝试 fallback 模型
    if (rule.fallbackModelId) {
      const fallbackModel = this.models.get(rule.fallbackModelId);
      if (fallbackModel && this.isModelAvailable(fallbackModel)) {
        logger.info('Using fallback model', { original: rule.modelId, fallback: rule.fallbackModelId });
        return {
          model: this.toModelConfig(fallbackModel),
          providerId: fallbackModel.providerId,
          fallbackUsed: true,
          originalTier: classification.tier,
          degraded: true,
          degradationReason: 'Primary model unavailable',
        };
      }
    }

    // 降级到更低 tier
    return this.degrade(classification.tier, 'model_unavailable');
  }

  /**
   * 降级策略
   */
  private degrade(originalTier: ScenarioTier, reason: DegradationReason): RoutingResult {
    const tierOrder: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
    const currentIndex = tierOrder.indexOf(originalTier);

    // 尝试降 tier
    for (let i = currentIndex - 1; i >= 0; i--) {
      const lowerTier = tierOrder[i];
      const rule = this.findRule(lowerTier);
      if (rule) {
        const model = this.models.get(rule.modelId);
        if (model && this.isModelAvailable(model)) {
          logger.warn('Degraded to lower tier', {
            originalTier,
            newTier: lowerTier,
            reason,
          });
          return {
            model: this.toModelConfig(model),
            providerId: model.providerId,
            fallbackUsed: false,
            originalTier,
            degraded: true,
            degradationReason: `Degraded from ${originalTier} to ${lowerTier}`,
          };
        }
      }
    }

    // 强制使用最低可用模型
    const simpleRule = this.findRule('simple');
    if (simpleRule) {
      const model = this.models.get(simpleRule.modelId);
      if (model) {
        logger.error('Forced to use lowest tier model', { originalTier, reason });
        return {
          model: this.toModelConfig(model),
          providerId: model.providerId,
          fallbackUsed: false,
          originalTier,
          degraded: true,
          degradationReason: 'Forced to lowest available model',
        };
      }
    }

    // 完全没有可用模型（不应该发生）
    throw new Error('No available models for routing');
  }

  /**
   * 查找规则
   */
  private findRule(tier: ScenarioTier): RouterRule | undefined {
    return this.config.rules.find((r) => r.tier === tier);
  }

  /**
   * 检查模型是否可用
   */
  private isModelAvailable(model: ModelDefinition): boolean {
    // 当前简化实现：所有模型都可用
    // 后续可以添加：API Key 检查、速率限制检查等
    return true;
  }

  /**
   * 转换为 ModelConfig
   */
  private toModelConfig(model: ModelDefinition): ModelConfig {
    return {
      id: model.id,
      providerId: model.providerId,
      modelName: model.id,
      // 其他字段使用默认值
      contextWindow: 128000,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsVision: false,
    };
  }

  /**
   * 设置手动覆盖
   */
  setManualOverride(modelId: string | null): void {
    this.manualOverride = modelId;
    if (modelId) {
      logger.info('Manual model override set', { modelId });
    } else {
      logger.info('Manual model override cleared');
    }
  }

  /**
   * 获取当前手动覆盖
   */
  getManualOverride(): string | null {
    return this.manualOverride;
  }

  /**
   * 获取所有可用模型
   */
  getAvailableModels(): ModelDefinition[] {
    return Array.from(this.models.values());
  }
}

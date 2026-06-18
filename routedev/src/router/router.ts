// src/router/router.ts
// 模型路由器：根据分类结果选择模型 + 降级策略
// 降级链：fallback 模型 → 降 tier → 强制最低可用模型
//
// Phase 0c 修复：provider 推断优先从配置读取（权威来源），启发式仅作后备
// 原 inferProviderId() 仅靠模型名 includes('gpt') 等启发式，对自定义模型会失败

import type {
  ScenarioTier,
  RoutingResult,
  RouterConfig,
  RouterRule,
  ModelConfig,
  DegradationReason,
  RouteDecision,
} from './types.js';
import type { ClassificationResult } from './types.js';
import type { ProviderConfig } from '../config/schema.js';
import type { PluginRegistry } from '../plugins/registry.js';
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
  /** provider 配置列表（Phase 0c：用于权威 provider 推断） */
  private providers: ProviderConfig[];
  /** 插件注册表（Phase 27 Task 2：可选，用于 RouterPlugin 介入路由决策） */
  private pluginRegistry?: PluginRegistry;

  constructor(
    config: RouterConfig,
    tracker: TokenTracker,
    providers: ProviderConfig[] = [],
    pluginRegistry?: PluginRegistry,
  ) {
    this.config = config;
    this.tracker = tracker;
    this.providers = providers;
    this.pluginRegistry = pluginRegistry;
    this.initializeModels();
    this.validateProviderConfig();
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
   * Phase 0c：验证配置中所有 model 都有对应的 provider client
   * 不匹配时记录 warning（不阻塞启动）
   */
  private validateProviderConfig(): void {
    for (const provider of this.providers) {
      for (const model of provider.models) {
        // 检查配置中的 model 是否在路由规则中
        const inRouter = this.models.has(model.id);
        if (!inRouter) {
          logger.debug('Model in config but not in router rules', {
            modelId: model.id,
            providerId: provider.id,
          });
        }
      }
    }
  }

  /**
   * 推断 provider ID
   * Phase 0c 修复：配置优先，启发式后备
   *
   * 1. 优先从 providers 配置中查找（配置中的 provider 字段是权威来源）
   * 2. 后备：启发式推断（仅当配置中找不到时）
   */
  private inferProviderId(modelId: string): string {
    // 1. 优先从配置中查找（权威来源）
    const configMatch = this.findProviderFromConfig(modelId);
    if (configMatch) {
      return configMatch;
    }

    // 2. 后备：启发式推断（仅当配置中找不到时）
    const heuristic = this.heuristicInferProviderId(modelId);
    if (heuristic !== 'unknown') {
      logger.debug('Provider inferred by heuristic (not in config)', { modelId, provider: heuristic });
    } else {
      logger.warn('Provider not found in config and heuristic failed', { modelId });
    }
    return heuristic;
  }

  /**
   * 从配置中查找 modelId 对应的 provider
   * 遍历 providers[].models[]，找到 modelId 匹配的 provider
   */
  private findProviderFromConfig(modelId: string): string | null {
    for (const provider of this.providers) {
      for (const model of provider.models) {
        if (model.id === modelId || model.name === modelId) {
          return provider.id;
        }
      }
    }
    return null;
  }

  /**
   * 启发式推断 provider ID（后备方案）
   * 仅当配置中找不到 modelId 时使用
   */
  private heuristicInferProviderId(modelId: string): string {
    const lower = modelId.toLowerCase();
    if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) {
      return 'openai';
    }
    if (lower.includes('claude')) {
      return 'anthropic';
    }
    if (lower.includes('qwen') || lower.includes('tongyi')) {
      return 'dashscope';
    }
    if (lower.includes('deepseek')) {
      return 'deepseek';
    }
    if (lower.includes('kimi') || lower.includes('moonshot')) {
      return 'moonshot';
    }
    if (lower.includes('glm') || lower.includes('chatglm')) {
      return 'zhipu';
    }
    return 'unknown';
  }

  /**
   * 路由请求
   * Phase 27 Task 2：优先询问 RouterPlugin，插件返回 null 时 fallback 到默认路由
   */
  async route(classification: ClassificationResult): Promise<RoutingResult> {
    // Phase 27 Task 2：先询问 RouterPlugin
    const pluginResult = await this.tryPluginRoute(classification);
    if (pluginResult) {
      return pluginResult;
    }

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
   * Phase 27 Task 2：尝试用 RouterPlugin 进行路由决策
   * 插件返回 null 或未安装时返回 null，由调用方 fallback 到默认路由
   */
  private async tryPluginRoute(classification: ClassificationResult): Promise<RoutingResult | null> {
    const routerPlugin = this.pluginRegistry?.getActiveRouterPlugin();
    if (!routerPlugin || !routerPlugin.route) return null;

    try {
      const decision: RouteDecision | null = await routerPlugin.route(classification);
      if (!decision) return null;

      // 查找模型定义，构造 RoutingResult
      const model = this.models.get(decision.modelId);
      if (!model) {
        // 插件选中的模型不在配置中，记录警告并 fallback
        logger.warn('RouterPlugin selected unknown model, fallback to default', {
          modelId: decision.modelId,
          reason: decision.reason,
        });
        return null;
      }

      // 插件指定的 providerId 优先，否则用模型推断的 providerId
      const providerId = decision.providerId ?? model.providerId;
      logger.debug('RouterPlugin decision applied', {
        modelId: decision.modelId,
        providerId,
        reason: decision.reason,
      });

      return {
        model: this.toModelConfig(model),
        providerId,
        fallbackUsed: false,
        originalTier: classification.tier,
        degraded: false,
      };
    } catch (err) {
      // 插件路由失败：记录警告并 fallback 到默认路由
      logger.warn('RouterPlugin route failed, fallback to default', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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
   * Phase 29 Task 4：实现真实检查（修复 B3）
   * 检查项：对应 provider 的 API Key 是否已配置
   * （简化版本：不做失败率统计，仅检查配置就绪性）
   *
   * 向后兼容：当 providers 为空（未配置）时返回 true，
   * 仅在 providers 已配置时才做 API Key 检查
   */
  private isModelAvailable(model: ModelDefinition): boolean {
    // 未配置 providers 时，无法检查，假设可用（向后兼容）
    if (this.providers.length === 0) {
      return true;
    }
    // 查找该模型对应的 provider 配置
    const provider = this.providers.find(p => p.id === model.providerId);
    if (!provider) {
      logger.warn(`模型 ${model.id} 对应的 provider ${model.providerId} 未配置`);
      return false;
    }
    // API Key 为空或为占位符时，模型不可用
    if (!provider.apiKey || provider.apiKey === 'placeholder') {
      logger.warn(`模型 ${model.id} 的 provider ${model.providerId} API Key 未配置`);
      return false;
    }
    return true;
  }

  /**
   * 转换为 ModelConfig
   */
  private toModelConfig(model: ModelDefinition): ModelConfig {
    return {
      id: model.id,
      name: model.id,
      provider: model.providerId,
      tier: model.tier,
      contextWindow: 128000,
      capabilities: [],
      latencyMs: 0,
      available: true,
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

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
import type { ProviderConfig, ExecutionConfig, ReasoningMode } from '../config/schema.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { DeterministicClassificationResult } from './classifier.js';
import { TokenTracker } from './tracker.js';
import { logger } from '../utils/logger.js';

/** 模型定义（从配置推断） */
interface ModelDefinition {
  id: string;
  providerId: string;
  tier: ScenarioTier;
}

/**
 * Phase 40 Task 2：扩展的路由结果
 * 新增 deterministic 和 matchedRuleId 字段
 * deterministic=true 时调用方应跳过 LLM 调用，直接走确定性规则的 handler
 */
export interface DeterministicRoutingResult extends RoutingResult {
  /** 是否为确定性路由命中（命中后无需 LLM 调用） */
  deterministic?: boolean;
  /** 命中的确定性规则 ID（仅 deterministic=true 时有值） */
  matchedRuleId?: string;
}

// ============================================================
// I8 修复：简单熔断器（Circuit Breaker）
// 连续失败 N 次后熔断 M 秒，熔断期间直接返回错误不调用模型
// ============================================================

/**
 * 单个模型的熔断器状态
 */
interface CircuitBreakerState {
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 熔断到期时间戳（0 表示未熔断） */
  trippedUntil: number;
}

/**
 * 简单熔断器
 * - 连续失败 N 次后进入"熔断"状态，持续 M 秒
 * - 熔断期间 isAvailable() 返回 false
 * - 熔断到期后自动进入"半开"状态，允许一次调用试探
 * - 成功一次后重置失败计数
 */
class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>();
  private readonly enabled: boolean;
  private readonly threshold: number;
  private readonly duration: number;

  constructor(options?: {
    enabled?: boolean;
    threshold?: number;
    duration?: number;
  }) {
    this.enabled = options?.enabled ?? true;
    this.threshold = options?.threshold ?? 5;
    this.duration = options?.duration ?? 30000;
  }

  /**
   * 检查模型是否可用（未熔断）
   * 熔断期间返回 false，半开/关闭状态返回 true
   */
  isAvailable(modelId: string): boolean {
    if (!this.enabled) return true;
    const state = this.states.get(modelId);
    if (!state) return true;
    // 熔断未到期 → 不可用
    if (state.trippedUntil > Date.now()) return false;
    return true;
  }

  /**
   * 记录模型调用失败
   * 连续失败达到阈值后触发熔断
   */
  recordFailure(modelId: string): void {
    if (!this.enabled) return;
    const state = this.states.get(modelId) ?? {
      consecutiveFailures: 0,
      trippedUntil: 0,
    };
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= this.threshold) {
      state.trippedUntil = Date.now() + this.duration;
      logger.warn('Circuit breaker tripped', {
        modelId,
        failures: state.consecutiveFailures,
        threshold: this.threshold,
        durationMs: this.duration,
      });
    }
    this.states.set(modelId, state);
  }

  /**
   * 记录模型调用成功
   * 成功后重置失败计数
   */
  recordSuccess(modelId: string): void {
    if (!this.enabled) return;
    const state = this.states.get(modelId);
    if (state) {
      state.consecutiveFailures = 0;
      state.trippedUntil = 0;
      this.states.set(modelId, state);
    }
  }

  /** 获取熔断状态（用于调试/日志） */
  getState(modelId: string): CircuitBreakerState | undefined {
    return this.states.get(modelId);
  }
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
  /** I8 修复：熔断器实例，按模型 ID 跟踪连续失败，熔断后短期拒绝调用 */
  private circuitBreaker: CircuitBreaker;
  /** Phase 42：推理模式（fast/balanced/accurate），影响 tier 选择 */
  private reasoningMode: ReasoningMode;

  constructor(
    config: RouterConfig,
    tracker: TokenTracker,
    providers: ProviderConfig[] = [],
    pluginRegistry?: PluginRegistry,
    /** I8 修复：可选传入执行配置，用于初始化熔断器参数；不传则用默认值 */
    executionConfig?: ExecutionConfig,
    /** Phase 42：推理模式，控制 tier 上下限 */
    reasoningMode?: ReasoningMode,
  ) {
    this.config = config;
    this.tracker = tracker;
    this.providers = providers;
    this.pluginRegistry = pluginRegistry;
    this.reasoningMode = reasoningMode ?? 'balanced';
    // I8 修复：初始化熔断器，使用 optional chaining + 默认值，未传 executionConfig 时用默认值
    this.circuitBreaker = new CircuitBreaker({
      enabled: executionConfig?.circuitBreaker ?? true,
      threshold: executionConfig?.circuitBreakerThreshold ?? 5,
      duration: executionConfig?.circuitBreakerDuration ?? 30000,
    });
    this.initializeModels();
    this.validateProviderConfig();
  }

  /**
   * Phase 42：设置推理模式
   * 支持运行时切换 fast / balanced / accurate
   */
  setReasoningMode(mode: ReasoningMode): void {
    this.reasoningMode = mode;
    logger.info('Reasoning mode updated', { mode });
  }

  /**
   * Phase 42：根据推理模式限制 tier 选择范围
   * - fast：限制最高 tier 为 medium（省钱模式）
   * - balanced：保持原 tier
   * - accurate：限制最低 tier 为 medium（高质量模式）
   */
  private clampTier(tier: ScenarioTier): ScenarioTier {
    const tierOrder: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
    const index = tierOrder.indexOf(tier);
    if (this.reasoningMode === 'fast') {
      // 最高 tier 不超过 medium
      const clamped = Math.min(index, tierOrder.indexOf('medium'));
      return tierOrder[clamped];
    }
    if (this.reasoningMode === 'accurate') {
      // 最低 tier 不低于 medium
      const clamped = Math.max(index, tierOrder.indexOf('medium'));
      return tierOrder[clamped];
    }
    return tier;
  }

  /**
   * I8 修复：记录模型调用失败（供 LLM 调用层在调用失败时调用）
   * 连续失败达到阈值后会触发熔断
   */
  recordModelFailure(modelId: string): void {
    this.circuitBreaker.recordFailure(modelId);
  }

  /**
   * I8 修复：记录模型调用成功（供 LLM 调用层在调用成功时调用）
   * 成功后重置该模型的失败计数
   */
  recordModelSuccess(modelId: string): void {
    this.circuitBreaker.recordSuccess(modelId);
  }

  /**
   * I8 修复：检查模型是否被熔断（供外部调用方查询）
   */
  isModelCircuitBroken(modelId: string): boolean {
    return !this.circuitBreaker.isAvailable(modelId);
  }

  /**
   * 初始化模型列表（从路由规则推断）
   */
  private initializeModels(): void {
    for (const rule of this.config.rules) {
      const modelId = rule.modelId;
      if (!modelId) {
        continue;
      }
      // 主模型
      this.models.set(modelId, {
        id: modelId,
        providerId: this.inferProviderId(modelId),
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

    for (const modelId of this.config.fallbackChain ?? []) {
      if (!this.models.has(modelId)) {
        this.models.set(modelId, {
          id: modelId,
          providerId: this.inferProviderId(modelId),
          tier: 'simple',
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
   *
   * Phase 32 Task 2：所有路由结果默认启用 Prompt 缓存（enableCache: true）
   * 通过 RoutingResult.enableCache 字段透传到 LLM 调用方
   *
   * Phase 40 Task 2：新增 deterministic 分支
   * 命中确定性规则时跳过正常路由决策链，返回 deterministic=true 标记
   * 调用方根据此标记跳过 LLM 调用，直接走确定性规则的 handler
   */
  async route(classification: ClassificationResult): Promise<DeterministicRoutingResult> {
    // Phase 40 Task 2：deterministic 路由分支
    // 命中确定性规则时跳过正常路由决策链，标记 deterministic=true 供调用方跳过 LLM 调用
    const detClassification = classification as DeterministicClassificationResult;
    if (detClassification.tier === 'deterministic') {
      // 使用最低成本模型（simple tier）作为占位
      // 调用方根据 deterministic 标记跳过 LLM 调用，model 字段仅用于审计/日志
      const simpleRule = this.findRule('simple');
      const placeholderModel = simpleRule?.modelId ? this.models.get(simpleRule.modelId) : null;
      if (placeholderModel) {
        logger.debug('Deterministic route hit, skipping LLM', {
          matchedRuleId: detClassification.matchedRuleId,
          placeholderModel: placeholderModel.id,
        });
        return {
          model: this.toModelConfig(placeholderModel),
          providerId: placeholderModel.providerId,
          fallbackUsed: false,
          originalTier: 'simple',
          degraded: false,
          enableCache: false,
          deterministic: true,
          matchedRuleId: detClassification.matchedRuleId,
        };
      }
      // 没有配置 simple tier 模型时，尝试任意可用模型作为占位
      const anyModel = this.getAvailableModels()[0];
      if (anyModel) {
        logger.debug('Deterministic route hit (fallback placeholder model)', {
          matchedRuleId: detClassification.matchedRuleId,
          placeholderModel: anyModel.id,
        });
        return {
          model: this.toModelConfig(anyModel),
          providerId: anyModel.providerId,
          fallbackUsed: false,
          originalTier: 'simple',
          degraded: false,
          enableCache: false,
          deterministic: true,
          matchedRuleId: detClassification.matchedRuleId,
        };
      }
      // 完全没有配置模型：抛错让调用方感知
      throw new Error('No available models for deterministic routing');
    }

    // Phase 42：根据推理模式调整 tier
    const clampedClassification: ClassificationResult = {
      ...classification,
      tier: this.clampTier(classification.tier),
    };
    if (clampedClassification.tier !== classification.tier) {
      logger.info('Tier clamped by reasoning mode', {
        originalTier: classification.tier,
        clampedTier: clampedClassification.tier,
        reasoningMode: this.reasoningMode,
      });
    }

    // Phase 27 Task 2：先询问 RouterPlugin
    const pluginResult = await this.tryPluginRoute(clampedClassification);
    if (pluginResult) {
      // Phase 32 Task 2：插件路由结果也启用缓存
      return { ...pluginResult, enableCache: true };
    }

    // 检查手动覆盖
    if (this.manualOverride) {
      const model = this.models.get(this.manualOverride);
      if (model) {
        return {
          model: this.toModelConfig(model),
          providerId: model.providerId,
          fallbackUsed: false,
          originalTier: clampedClassification.tier,
          degraded: false,
          enableCache: true,
        };
      }
    }

    // 检查预算
    const budgetOk = this.tracker.checkBudget();
    if (!budgetOk && this.config.budget.mode === 'enforce') {
      const result = this.degrade(clampedClassification.tier, 'budget_exceeded');
      // 修复：degrade 可能返回 null（最低 tier 模型也不可用），需抛错让调用方感知
      if (!result) {
        throw new Error('No available models for routing');
      }
      return { ...result, enableCache: true };
    }

    // 根据 tier 查找规则
    const rule = this.findRule(clampedClassification.tier);
    if (!rule) {
      // 找不到规则，降级到最低 tier
      const result = this.degrade(clampedClassification.tier, 'model_unavailable');
      // 修复：degrade 可能返回 null（最低 tier 模型也不可用），需抛错让调用方感知
      if (!result) {
        throw new Error('No available models for routing');
      }
      return { ...result, enableCache: true };
    }

    // 尝试主模型
    const mainModel = rule.modelId ? this.models.get(rule.modelId) : null;
    if (mainModel && this.isModelAvailable(mainModel)) {
      return {
        model: this.toModelConfig(mainModel),
        providerId: mainModel.providerId,
        fallbackUsed: false,
        originalTier: clampedClassification.tier,
        degraded: false,
        enableCache: true,
      };
    }

    // 尝试 fallback 模型
    // I6 修复：显式 null 检查 fallbackModelId 存在性后再使用
    if (rule.fallbackModelId && rule.fallbackModelId.length > 0) {
      const fallbackModel = this.models.get(rule.fallbackModelId);
      if (fallbackModel && this.isModelAvailable(fallbackModel)) {
        logger.info('Using fallback model', { original: rule.modelId, fallback: rule.fallbackModelId });
        return {
          model: this.toModelConfig(fallbackModel),
          providerId: fallbackModel.providerId,
          fallbackUsed: true,
          originalTier: clampedClassification.tier,
          degraded: true,
          degradationReason: 'Primary model unavailable',
          enableCache: true,
        };
      }
    }

    // I14 修复：fallbackChain 中每个 adapter 调用独立 try-catch 隔离
    // 单个 fallback 模型检查失败不应阻断后续 fallback 模型的尝试
    for (const modelId of this.config.fallbackChain ?? []) {
      try {
        const fallbackModel = this.models.get(modelId);
        if (fallbackModel && this.isModelAvailable(fallbackModel)) {
          logger.info('Using global fallback model', { original: rule.modelId, fallback: modelId });
          return {
            model: this.toModelConfig(fallbackModel),
            providerId: fallbackModel.providerId,
            fallbackUsed: true,
            originalTier: clampedClassification.tier,
            degraded: true,
            degradationReason: 'Global fallback chain',
            enableCache: true,
          };
        }
      } catch (err) {
        // I14 修复：单个 fallback 模型检查异常时记录警告，继续尝试下一个
        logger.warn('Fallback model check failed, continuing chain', {
          modelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 降级到更低 tier
    const result = this.degrade(clampedClassification.tier, 'model_unavailable');
    return { ...result, enableCache: true };
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
      const provider = this.providers.find(p => p.id === providerId);
      if (this.providers.length > 0 && !provider) {
        logger.warn('RouterPlugin selected unknown provider, fallback to default', {
          modelId: decision.modelId,
          providerId,
          reason: decision.reason,
        });
        return null;
      }
      if (provider && !provider.models.some(m => m.id === decision.modelId)) {
        logger.warn('RouterPlugin selected provider/model mismatch, fallback to default', {
          modelId: decision.modelId,
          providerId,
          expectedProviderId: model.providerId,
          reason: decision.reason,
        });
        return null;
      }
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
   *
   * I6 修复：降级到更低 tier 时，同时尝试该 tier 规则的 fallbackModelId（存在性检查后使用）
   */
  private degrade(originalTier: ScenarioTier, reason: DegradationReason): RoutingResult {
    const tierOrder: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
    const currentIndex = tierOrder.indexOf(originalTier);

    // 尝试降 tier
    for (let i = currentIndex - 1; i >= 0; i--) {
      const lowerTier = tierOrder[i];
      const rule = this.findRule(lowerTier);
      if (rule) {
        const model = rule.modelId ? this.models.get(rule.modelId) : null;
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
        // I6 修复：主模型不可用时，尝试该 tier 规则的 fallbackModelId（先检查存在性）
        if (rule.fallbackModelId && rule.fallbackModelId.length > 0) {
          const fallbackModel = this.models.get(rule.fallbackModelId);
          if (fallbackModel && this.isModelAvailable(fallbackModel)) {
            logger.warn('Degraded to lower tier fallback model', {
              originalTier,
              newTier: lowerTier,
              fallbackModelId: rule.fallbackModelId,
              reason,
            });
            return {
              model: this.toModelConfig(fallbackModel),
              providerId: fallbackModel.providerId,
              fallbackUsed: true,
              originalTier,
              degraded: true,
              degradationReason: `Degraded from ${originalTier} to ${lowerTier} (fallback)`,
            };
          }
        }
      }
    }

    const availableModel = this.getAvailableModels()[0];
    if (availableModel) {
      logger.warn('Forced to use lowest available model', {
        modelId: availableModel.id,
        originalTier,
        reason,
      });
      return {
        model: this.toModelConfig(availableModel),
        providerId: availableModel.providerId,
        fallbackUsed: false,
        originalTier,
        degraded: true,
        degradationReason: 'Forced to lowest available model',
      };
    }

    logger.error('No available models for routing after degradation', { originalTier, reason });
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
   *
   * I8 修复：同时检查熔断器状态，熔断期间模型不可用
   */
  private isModelAvailable(model: ModelDefinition): boolean {
    // I8 修复：先检查熔断器，熔断期间直接返回不可用
    if (!this.circuitBreaker.isAvailable(model.id)) {
      logger.warn(`模型 ${model.id} 处于熔断状态，跳过`);
      return false;
    }
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
   * 修复：从 provider 配置中透传 name/capabilities/latencyMs/available/fallbackModelId 字段
   */
  private toModelConfig(model: ModelDefinition): ModelConfig {
    // 修复：从 provider 配置中读取完整字段，透传 name/capabilities/latencyMs/available/fallbackModelId
    const provider = this.providers.find(p => p.id === model.providerId);
    const providerModel = provider?.models?.find(m => m.id === model.id);
    return {
      id: model.id,
      name: providerModel?.name ?? model.id,
      provider: model.providerId,
      tier: model.tier,
      contextWindow: providerModel?.contextWindow ?? 8192,
      capabilities: providerModel?.capabilities ?? [],
      latencyMs: providerModel?.latencyMs ?? 0,
      available: providerModel?.available ?? true,
      fallbackModelId: providerModel?.fallbackModelId,
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

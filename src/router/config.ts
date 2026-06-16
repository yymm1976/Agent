// src/router/config.ts
// 路由配置加载：桥接 config → router
// 将 AppConfig 转换为 RouterConfig + TokenBudget

import type { AppConfig, RouterRule, TokenBudget, RouterConfig, BudgetMode } from './types.js';
import type { ScenarioTier } from './types.js';

/**
 * 从 AppConfig 构建 RouterConfig
 */
export function buildRouterConfig(appConfig: AppConfig): RouterConfig {
  const rules = buildRouterRules(appConfig);
  const budget = buildTokenBudget(appConfig);

  return {
    rules,
    budget,
    classifierModel: appConfig.router.classifierModel,
    userPreference: appConfig.router.userPreference,
  };
}

/**
 * 构建路由规则
 */
function buildRouterRules(appConfig: AppConfig): RouterRule[] {
  const rules: RouterRule[] = [];
  const tiers: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];

  for (const tier of tiers) {
    const rule = buildRuleForTier(tier, appConfig);
    if (rule) {
      rules.push(rule);
    }
  }

  return rules;
}

/**
 * 为单个 tier 构建规则
 */
function buildRuleForTier(tier: ScenarioTier, appConfig: AppConfig): RouterRule | null {
  // 从配置中推断模型
  // 当前简化实现：根据 tier 选择预定义模型
  const modelId = getModelForTier(tier, appConfig);
  if (!modelId) return null;

  const fallbackModelId = getFallbackModelForTier(tier, appConfig);

  return {
    tier,
    modelId,
    fallbackModelId,
    maxTokensPerRequest: getMaxTokensForTier(tier),
  };
}

/**
 * 根据 tier 获取模型
 */
function getModelForTier(tier: ScenarioTier, appConfig: AppConfig): string | null {
  // 优先使用配置中指定的模型
  const routerConfig = appConfig.router;

  switch (tier) {
    case 'simple':
      return routerConfig.simpleModel || 'gpt-4o-mini';
    case 'medium':
      return routerConfig.mediumModel || 'gpt-4o';
    case 'complex':
      return routerConfig.complexModel || 'o3-mini';
    case 'reasoning':
      return routerConfig.reasoningModel || 'o3';
    default:
      return null;
  }
}

/**
 * 根据 tier 获取 fallback 模型
 */
function getFallbackModelForTier(tier: ScenarioTier, appConfig: AppConfig): string | undefined {
  // Fallback 策略：降级到下一个 tier 的模型
  switch (tier) {
    case 'reasoning':
      return getModelForTier('complex', appConfig) || undefined;
    case 'complex':
      return getModelForTier('medium', appConfig) || undefined;
    case 'medium':
      return getModelForTier('simple', appConfig) || undefined;
    case 'simple':
      return undefined; // 最低 tier 没有 fallback
    default:
      return undefined;
  }
}

/**
 * 根据 tier 获取最大 token 数
 */
function getMaxTokensForTier(tier: ScenarioTier): number {
  switch (tier) {
    case 'simple':
      return 2000;
    case 'medium':
      return 4000;
    case 'complex':
      return 8000;
    case 'reasoning':
      return 16000;
    default:
      return 4000;
  }
}

/**
 * 构建 Token 预算
 */
function buildTokenBudget(appConfig: AppConfig): TokenBudget {
  const routerConfig = appConfig.router;

  // 从配置中读取预算设置
  const mode: BudgetMode = routerConfig.budgetMode || 'track_only';
  const dailyLimit = routerConfig.dailyTokenLimit || 1000000; // 默认 100 万 tokens
  const degradationThreshold = routerConfig.budgetThreshold || 0.8;

  return {
    mode,
    dailyLimit,
    perRequestLimit: routerConfig.perRequestTokenLimit,
    degradationThreshold,
  };
}

// src/router/config.ts
// 路由配置加载：桥接 config → router
// 将 AppConfig 转换为 RouterConfig + TokenBudget

import type { AppConfig, RouterRule, TokenBudget, RouterConfig, BudgetMode, ScenarioTier } from './types.js';

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
 * 如果配置中有 rules，直接使用；否则使用默认规则
 */
function buildRouterRules(appConfig: AppConfig): RouterRule[] {
  // 如果配置中有 rules，直接使用
  if (appConfig.router.rules && appConfig.router.rules.length > 0) {
    return appConfig.router.rules;
  }

  // 否则使用默认规则
  const defaultRules: RouterRule[] = [
    { tier: 'simple', modelId: 'gpt-4o-mini', fallbackModelId: 'gpt-4o' },
    { tier: 'medium', modelId: 'gpt-4o', fallbackModelId: 'gpt-4o-mini' },
    { tier: 'complex', modelId: 'o3-mini', fallbackModelId: 'gpt-4o' },
    { tier: 'reasoning', modelId: 'o3', fallbackModelId: 'o3-mini' },
  ];

  return defaultRules;
}

/**
 * 构建 Token 预算
 */
function buildTokenBudget(appConfig: AppConfig): TokenBudget {
  const routerBudget = appConfig.router.budget;

  return {
    mode: routerBudget.mode,
    dailyLimit: routerBudget.dailyLimit,
    perRequestLimit: routerBudget.perRequestLimit,
    degradationThreshold: routerBudget.degradationThreshold,
  };
}

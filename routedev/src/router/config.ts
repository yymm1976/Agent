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
    fallbackChain: appConfig.router.fallbackChain ?? [],
  };
}

/**
 * 构建路由规则
 * 如果配置中有 rules，直接使用（但会修复无效的 modelId）
 * 否则使用默认规则
 *
 * 修复：当 rules 中的 modelId 为 'unconfigured' 或在 providers 中找不到时，
 * 自动用已配置的模型替换，避免路由器找不到可用模型导致对话失败
 */
function buildRouterRules(appConfig: AppConfig): RouterRule[] {
  // 收集所有已配置的模型 ID（从 providers[].models[] 中提取）
  const configuredModelIds = new Set<string>();
  // tier -> modelId 映射，用于按 tier 匹配
  const tierToModelId = new Map<ScenarioTier, string>();
  // 所有可用模型 ID 列表（按配置顺序）
  const allModelIds: string[] = [];

  for (const provider of appConfig.providers) {
    for (const model of provider.models) {
      configuredModelIds.add(model.id);
      allModelIds.push(model.id);
      if (model.tier) {
        // 记录每个 tier 的第一个模型，用于按 tier 匹配
        if (!tierToModelId.has(model.tier)) {
          tierToModelId.set(model.tier, model.id);
        }
      }
    }
  }

  // 如果配置中有 rules，修复无效的 modelId 后使用
  if (appConfig.router.rules && appConfig.router.rules.length > 0) {
    // 如果没有已配置的模型，无法修复，直接返回原始 rules
    if (allModelIds.length === 0) {
      return appConfig.router.rules;
    }
    const fixedRules = appConfig.router.rules.map((rule) => {
      let modelId = rule.modelId ?? tierToModelId.get(rule.tier) ?? allModelIds[0];
      let fallbackModelId = rule.fallbackModelId;

      // 修复主模型：unconfigured 或在 providers 中找不到时替换
      if (!modelId || modelId === 'unconfigured' || !configuredModelIds.has(modelId)) {
        const replacement = tierToModelId.get(rule.tier) ?? allModelIds[0];
        if (replacement) {
          modelId = replacement;
        }
      }

      // 修复 fallback 模型：unconfigured 或在 providers 中找不到时替换
      if (fallbackModelId && (fallbackModelId === 'unconfigured' || !configuredModelIds.has(fallbackModelId))) {
        // fallback 用第一个与主模型不同的可用模型，如果没有就置空
        const fallback = allModelIds.find((id) => id !== modelId);
        fallbackModelId = fallback ?? undefined;
      }

      return { ...rule, modelId, fallbackModelId };
    });

    return fixedRules;
  }

  // 如果没有配置 rules，但有已配置的模型，用已配置的模型生成默认规则
  if (allModelIds.length > 0) {
    const defaultTiers: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
    return defaultTiers.map((tier) => {
      const modelId = tierToModelId.get(tier) ?? allModelIds[0];
      const fallback = allModelIds.find((id) => id !== modelId);
      return { tier, modelId, fallbackModelId: fallback };
    });
  }

  // 完全没有配置模型时，使用硬编码默认规则（仅作为最后手段）
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

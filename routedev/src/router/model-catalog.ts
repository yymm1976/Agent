// src/router/model-catalog.ts
// Phase 96 P1-4：模型目录——内置常见模型的元数据（cost / contextWindow / capabilities）
//
// 职责：
//   - 提供 lookupModelCost(modelId) 查询模型定价（美元/百万 token）
//   - 提供 lookupModelMeta(modelId) 查询完整元数据（含 contextWindow / capabilities）
//   - 用户配置的 ModelConfig.cost 字段优先；缺省时从此 catalog 查找
//   - 价格数据基于 2025 年公开定价，可能随 provider 调整过期
//
// 设计权衡：
//   - 不做网络拉取（refreshModels 在 LLMClient.getModels 中实现，调用 provider API）
//   - 不做完整模型注册表（只覆盖常见模型，未覆盖的返回 undefined，视为 0 计费）
//   - 模型 ID 匹配采用"前缀匹配 + 别名表"策略，处理版本后缀（如 gpt-4o-2024-08-06）

import type { ModelCapability } from '../config/schema-router.js';

/** 模型定价（美元/百万 token） */
export interface ModelCostInfo {
  /** 输入价格 */
  input: number;
  /** 输出价格 */
  output: number;
  /** 缓存读取价格（缺省视为 input 的 50%，或 0） */
  cacheRead?: number;
}

/** 模型完整元数据 */
export interface ModelMeta {
  /** 模型 ID（不含版本后缀的基础 ID） */
  id: string;
  /** 显示名 */
  name: string;
  /** 上下文窗口（token） */
  contextWindow: number;
  /** 最大输出 token */
  maxOutputTokens?: number;
  /** 能力标签 */
  capabilities: ModelCapability[];
  /** 定价 */
  cost: ModelCostInfo;
  /** 别名/前缀匹配列表（用于匹配带版本后缀的模型 ID） */
  aliases?: string[];
}

/**
 * 内置模型目录（按 provider 分组）
 * 价格单位：美元/百万 token，基于 2025 年公开定价
 */
const CATALOG: ModelMeta[] = [
  // ===== OpenAI =====
  {
    id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 2.5, output: 10, cacheRead: 1.25 },
    aliases: ['gpt-4o-'],
  },
  {
    id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128_000, maxOutputTokens: 16_384,
    capabilities: ['code', 'multimodal', 'fast', 'cheap'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    aliases: ['gpt-4o-mini-'],
  },
  {
    id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1_047_576, maxOutputTokens: 32_768,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 2, output: 8, cacheRead: 0.5 },
    aliases: ['gpt-4.1-'],
  },
  {
    id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', contextWindow: 1_047_576, maxOutputTokens: 32_768,
    capabilities: ['code', 'multimodal', 'fast'],
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1 },
    aliases: ['gpt-4.1-mini-'],
  },
  {
    id: 'o1', name: 'o1', contextWindow: 200_000, maxOutputTokens: 100_000,
    capabilities: ['reasoning', 'code'],
    cost: { input: 15, output: 60, cacheRead: 7.5 },
    aliases: ['o1-'],
  },
  {
    id: 'o1-mini', name: 'o1-mini', contextWindow: 128_000, maxOutputTokens: 65_536,
    capabilities: ['reasoning', 'code'],
    cost: { input: 3, output: 12, cacheRead: 1.5 },
    aliases: ['o1-mini-'],
  },
  {
    id: 'o3', name: 'o3', contextWindow: 200_000, maxOutputTokens: 100_000,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 10, output: 40, cacheRead: 2.5 },
    aliases: ['o3-'],
  },
  {
    id: 'o3-mini', name: 'o3-mini', contextWindow: 200_000, maxOutputTokens: 100_000,
    capabilities: ['reasoning', 'code', 'fast'],
    cost: { input: 1.1, output: 4.4, cacheRead: 0.55 },
    aliases: ['o3-mini-'],
  },
  {
    id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextWindow: 128_000, maxOutputTokens: 4_096,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 10, output: 30 },
    aliases: ['gpt-4-turbo-', 'gpt-4-1106', 'gpt-4-0125'],
  },
  {
    id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', contextWindow: 16_385, maxOutputTokens: 4_096,
    capabilities: ['code', 'fast', 'cheap'],
    cost: { input: 0.5, output: 1.5 },
    aliases: ['gpt-3.5-turbo-'],
  },

  // ===== Anthropic =====
  {
    id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200_000, maxOutputTokens: 8_192,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 3, output: 15, cacheRead: 0.3 },
    aliases: ['claude-3-5-sonnet-', 'claude-3-5-sonnet-latest'],
  },
  {
    id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', contextWindow: 200_000, maxOutputTokens: 8_192,
    capabilities: ['code', 'fast', 'cheap'],
    cost: { input: 0.8, output: 4, cacheRead: 0.08 },
    aliases: ['claude-3-5-haiku-', 'claude-3-5-haiku-latest'],
  },
  {
    id: 'claude-3-opus', name: 'Claude 3 Opus', contextWindow: 200_000, maxOutputTokens: 4_096,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 15, output: 75, cacheRead: 1.5 },
    aliases: ['claude-3-opus-', 'claude-3-opus-latest'],
  },
  {
    id: 'claude-3-haiku', name: 'Claude 3 Haiku', contextWindow: 200_000, maxOutputTokens: 4_096,
    capabilities: ['code', 'fast', 'cheap'],
    cost: { input: 0.25, output: 1.25, cacheRead: 0.03 },
    aliases: ['claude-3-haiku-', 'claude-3-haiku-latest'],
  },

  // ===== Google Gemini =====
  {
    id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 8_192,
    capabilities: ['reasoning', 'code', 'multimodal', 'fast'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375 },
    aliases: ['gemini-2.5-flash-'],
  },
  {
    id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1_048_576, maxOutputTokens: 8_192,
    capabilities: ['code', 'multimodal', 'fast'],
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025 },
    aliases: ['gemini-2.0-flash-'],
  },
  {
    id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextWindow: 2_097_152, maxOutputTokens: 8_192,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 1.25, output: 5, cacheRead: 0.3125 },
    aliases: ['gemini-1.5-pro-'],
  },
  {
    id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 8_192,
    capabilities: ['code', 'multimodal', 'fast', 'cheap'],
    cost: { input: 0.075, output: 0.3, cacheRead: 0.01875 },
    aliases: ['gemini-1.5-flash-'],
  },

  // ===== DeepSeek =====
  // P0 修复：V4 系列为当前官方唯二模型（1M context / 384K 输出，2026-08 官方价格页核实）。
  // 旧 deepseek-chat / deepseek-reasoner 已退役（官方模型列表不再包含），保留仅用于
  // 历史配置兼容与明确退役提示。
  {
    id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_048_576, maxOutputTokens: 384_000,
    capabilities: ['reasoning', 'code', 'fast', 'cheap', 'tool_use', 'streaming', 'parallel_tool_calls'],
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 },
    aliases: ['deepseek-v4-flash-', 'deepseek-v4-flash-2507'],
  },
  {
    id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576, maxOutputTokens: 384_000,
    capabilities: ['reasoning', 'code', 'tool_use', 'streaming', 'parallel_tool_calls'],
    cost: { input: 0.435, output: 0.87, cacheRead: 0.003625 },
    aliases: ['deepseek-v4-pro-', 'deepseek-v4-pro-2507'],
  },
  {
    id: 'deepseek-chat', name: 'DeepSeek Chat（已退役，2026-07 结束兼容期）', contextWindow: 64_000, maxOutputTokens: 8_192,
    capabilities: ['code', 'fast', 'cheap'],
    cost: { input: 0.27, output: 1.1, cacheRead: 0.027 },
    aliases: ['deepseek-chat-'],
  },
  {
    id: 'deepseek-reasoner', name: 'DeepSeek Reasoner（已退役，2026-07 结束兼容期）', contextWindow: 64_000, maxOutputTokens: 32_768,
    capabilities: ['reasoning', 'code'],
    cost: { input: 0.55, output: 2.19, cacheRead: 0.055 },
    aliases: ['deepseek-reasoner-', 'deepseek-r1'],
  },

  // ===== Qwen (DashScope) =====
  {
    id: 'qwen-max', name: 'Qwen Max', contextWindow: 32_768, maxOutputTokens: 8_192,
    capabilities: ['reasoning', 'code'],
    cost: { input: 2.76, output: 8.28 },
    aliases: ['qwen-max-'],
  },
  {
    id: 'qwen-plus', name: 'Qwen Plus', contextWindow: 131_072, maxOutputTokens: 8_192,
    capabilities: ['code', 'fast'],
    cost: { input: 0.55, output: 1.65 },
    aliases: ['qwen-plus-'],
  },
  {
    id: 'qwen-turbo', name: 'Qwen Turbo', contextWindow: 1_000_000, maxOutputTokens: 8_192,
    capabilities: ['code', 'fast', 'cheap'],
    cost: { input: 0.28, output: 0.83 },
    aliases: ['qwen-turbo-'],
  },

  // ===== xAI =====
  {
    id: 'grok-3', name: 'Grok 3', contextWindow: 131_072, maxOutputTokens: 16_384,
    capabilities: ['reasoning', 'code', 'multimodal'],
    cost: { input: 3, output: 15 },
    aliases: ['grok-3-'],
  },
  {
    id: 'grok-3-mini', name: 'Grok 3 Mini', contextWindow: 131_072, maxOutputTokens: 16_384,
    capabilities: ['reasoning', 'code', 'fast'],
    cost: { input: 0.3, output: 0.9 },
    aliases: ['grok-3-mini-'],
  },
];

/** 模型 ID → ModelMeta 索引（精确匹配） */
const EXACT_INDEX = new Map<string, ModelMeta>(
  CATALOG.map((m) => [m.id, m]),
);

/**
 * 查找模型元数据
 * 匹配策略：
 *   1. 精确匹配 id
 *   2. 别名前缀匹配（处理带版本后缀的 ID，如 gpt-4o-2024-08-06）
 *   3. 小写归一化匹配
 */
export function lookupModelMeta(modelId: string): ModelMeta | undefined {
  if (!modelId) return undefined;
  const normalized = modelId.toLowerCase();

  // 1. 精确匹配
  const exact = EXACT_INDEX.get(modelId) ?? EXACT_INDEX.get(normalized);
  if (exact) return exact;

  // 2. 别名前缀匹配
  for (const meta of CATALOG) {
    if (!meta.aliases) continue;
    for (const alias of meta.aliases) {
      if (normalized.startsWith(alias.toLowerCase())) return meta;
    }
  }

  return undefined;
}

/** 查找模型定价（便捷方法） */
export function lookupModelCost(modelId: string): ModelCostInfo | undefined {
  return lookupModelMeta(modelId)?.cost;
}

// ===== B-14：运行时能力声明 =====

/** 内置模型默认具备的运行时能力（OpenAI 兼容协议均支持；catalog 条目已含 multimodal 标签） */
export const RUNTIME_CAPABILITIES: readonly ModelCapability[] = [
  'tool_use', 'streaming', 'parallel_tool_calls',
];

/**
 * B-14：模型运行时能力（catalog 能力 + 运行时默认）。
 * - catalog 覆盖的模型：catalog 标签 + 运行时默认（如 gpt-4o 含 multimodal）
 * - catalog 未覆盖的模型（用户自定义/Ollama 等本地端点）：返回协议级默认——
 *   OpenAI 兼容协议普遍支持工具/流式/并行；若某模型确实不支持，用户应在配置中
 *   显式声明 capabilities 以触发显式降级（审查 I4 修复：避免存量配置静默禁工具）
 */
export function runtimeCapabilities(modelId: string): ModelCapability[] {
  const meta = lookupModelMeta(modelId);
  if (!meta) return [...RUNTIME_CAPABILITIES];
  return [...new Set([...meta.capabilities, ...RUNTIME_CAPABILITIES])];
}

/**
 * Phase 96 P1-4：解析模型的最终定价
 *
 * 优先级：
 *   1. ModelConfig 中用户显式配置的 cost 字段
 *   2. ModelCatalog 中内置的 cost
 *   3. 均无则返回 undefined（视为 0 计费）
 *
 * @param model ModelConfig（可能含用户配置的 cost 字段）
 * @returns 合并后的 ModelCostInfo，或 undefined
 */
export function resolveModelCost(model: {
  id: string;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  cacheReadCostPerMillion?: number;
}): ModelCostInfo | undefined {
  // 1. 用户显式配置优先
  if (
    model.inputCostPerMillion !== undefined ||
    model.outputCostPerMillion !== undefined
  ) {
    return {
      input: model.inputCostPerMillion ?? 0,
      output: model.outputCostPerMillion ?? 0,
      cacheRead: model.cacheReadCostPerMillion,
    };
  }
  // 2. 回退到 catalog
  return lookupModelCost(model.id);
}

/**
 * Phase 96 P1-4：计算单次调用的费用（美元）
 *
 * @param model 模型配置
 * @param inputTokens 输入 token 数
 * @param outputTokens 输出 token 数
 * @param cacheReadTokens 缓存读取 token 数（可选）
 * @returns 费用（美元），无 cost 信息时返回 0
 */
export function calculateCallCost(
  model: {
    id: string;
    inputCostPerMillion?: number;
    outputCostPerMillion?: number;
    cacheReadCostPerMillion?: number;
  },
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
): number {
  const cost = resolveModelCost(model);
  if (!cost) return 0;
  const inputCost = (inputTokens / 1_000_000) * cost.input;
  const outputCost = (outputTokens / 1_000_000) * cost.output;
  const cacheCost = cacheReadTokens > 0 && cost.cacheRead !== undefined
    ? (cacheReadTokens / 1_000_000) * cost.cacheRead
    : 0;
  return inputCost + outputCost + cacheCost;
}

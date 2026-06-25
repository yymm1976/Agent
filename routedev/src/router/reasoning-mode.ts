// src/router/reasoning-mode.ts
// 推理模式
//
// 设计目标：
//   1. 提供三种推理模式：fast / balanced / accurate
//   2. 每种模式对应不同的 token 预算、重试次数、reasoning effort
//   3. getReasoningConfig 按模式返回配置
//   4. getDefaultMode 返回默认模式（balanced）

// ============================================================
// 类型定义
// ============================================================

export type ReasoningMode = 'fast' | 'balanced' | 'accurate';

export interface ReasoningConfig {
  mode: ReasoningMode;
  preferCheaper: boolean;
  maxRetries: number;
  reasoningEffort: 'low' | 'medium' | 'high';
  maxTokens: number;
}

// ============================================================
// 模式配置
// ============================================================

export const MODE_CONFIGS: Record<ReasoningMode, ReasoningConfig> = {
  fast: {
    mode: 'fast',
    preferCheaper: true,
    maxRetries: 1,
    reasoningEffort: 'low',
    maxTokens: 4096,
  },
  balanced: {
    mode: 'balanced',
    preferCheaper: false,
    maxRetries: 2,
    reasoningEffort: 'medium',
    maxTokens: 8192,
  },
  accurate: {
    mode: 'accurate',
    preferCheaper: false,
    maxRetries: 3,
    reasoningEffort: 'high',
    maxTokens: 16384,
  },
};

// ============================================================
// 公共 API
// ============================================================

/**
 * 按模式返回推理配置
 *
 * 未知模式回退到 balanced
 */
export function getReasoningConfig(mode: ReasoningMode): ReasoningConfig {
  return MODE_CONFIGS[mode] ?? MODE_CONFIGS.balanced;
}

/**
 * 返回默认推理模式
 */
export function getDefaultMode(): ReasoningMode {
  return 'balanced';
}

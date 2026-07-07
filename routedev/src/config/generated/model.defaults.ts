// 由 tools/config-gen.ts 自动生成——请勿手动编辑
// 源文件：tools/config-schema.yaml（module: model）
// Phase 75-B8：配置 schema 单一真相源试点产物

import type { ModelConfig } from './model.types.js';

/** AI 模型配置（模型 ID、上下文窗口、温度等）（默认值） */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  modelId: "gpt-4o-mini",
  fallbackModelId: "gpt-4o-mini",
  contextWindow: 128000,
  temperature: 0.7,
  maxTokens: 4096,
};

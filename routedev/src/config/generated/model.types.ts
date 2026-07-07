// 由 tools/config-gen.ts 自动生成——请勿手动编辑
// 源文件：tools/config-schema.yaml（module: model）
// Phase 75-B8：配置 schema 单一真相源试点产物

/** AI 模型配置（模型 ID、上下文窗口、温度等） */
export interface ModelConfig {
  /** 主模型 ID */
  modelId: string;
  /** 主模型不可用时的回退模型 */
  fallbackModelId?: string;
  /** 上下文窗口大小（token 数） */
  contextWindow: number;
  /** 采样温度（0-2） */
  temperature?: number;
  /** 单次响应最大 token 数 */
  maxTokens?: number;
}

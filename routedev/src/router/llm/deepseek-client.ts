// src/router/llm/deepseek-client.ts
// DeepSeek 客户端（OpenAI 兼容协议）
// API: https://api.deepseek.com/v1
// 认证：Bearer token via Authorization header
// 模型示例：deepseek-chat, deepseek-reasoner
//
// 最简实现：继承 OpenAIClient，覆盖 baseURL 和 apiKey
// apiKey 留空时自动回退到 DEEPSEEK_API_KEY 环境变量

import { OpenAIClient } from './openai.js';

/** DeepSeek API 默认 base URL */
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * DeepSeek 协议客户端
 * DeepSeek API 与 OpenAI 完全兼容，直接复用 OpenAIClient 实现
 * 仅覆盖 baseURL 和 apiKey 的默认值
 */
export class DeepSeekClient extends OpenAIClient {
  constructor(config: {
    providerId: string;
    baseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    super({
      providerId: config.providerId,
      baseUrl: config.baseUrl || DEFAULT_DEEPSEEK_BASE_URL,
      apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || '',
      timeoutMs: config.timeoutMs,
    });
  }
}

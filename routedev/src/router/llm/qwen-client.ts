// src/router/llm/qwen-client.ts
// Alibaba Qwen / 通义千问客户端（OpenAI 兼容协议，DashScope）
// API: https://dashscope.aliyuncs.com/compatible-mode/v1
// 认证：Bearer token via Authorization header
// 模型示例：qwen-plus, qwen-max, qwen-turbo
//
// 最简实现：继承 OpenAIClient，覆盖 baseURL 和 apiKey
// apiKey 留空时自动回退到 DASHSCOPE_API_KEY 环境变量

import { OpenAIClient } from './openai.js';

/** Qwen DashScope OpenAI 兼容模式默认 base URL */
const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/**
 * Qwen / 通义千问协议客户端
 * DashScope 提供 OpenAI 兼容模式，直接复用 OpenAIClient 实现
 * 仅覆盖 baseURL 和 apiKey 的默认值
 */
export class QwenClient extends OpenAIClient {
  constructor(config: {
    providerId: string;
    baseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    super({
      providerId: config.providerId,
      baseUrl: config.baseUrl || DEFAULT_QWEN_BASE_URL,
      apiKey: config.apiKey || process.env.DASHSCOPE_API_KEY || '',
      timeoutMs: config.timeoutMs,
    });
  }
}

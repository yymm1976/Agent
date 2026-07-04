// src/router/llm/ollama-client.ts
// Ollama 本地模型客户端（OpenAI 兼容协议）
// API: http://localhost:11434/v1
// 认证：无需 API key（本地部署，apiKey 固定为 "ollama" 占位以满足 OpenAIClient 就绪检查）
// 模型示例：llama3.2, qwen2.5-coder, deepseek-r1
//
// 最简实现：继承 OpenAIClient，覆盖 baseURL，apiKey 设为固定值 "ollama"
// baseURL 留空时回退到 OLLAMA_BASE_URL 环境变量，再回退到默认值

import { OpenAIClient } from './openai.js';

/** Ollama 默认 base URL */
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/** Ollama 不需要 API Key，用固定占位值满足 OpenAIClient 的就绪检查 */
const OLLAMA_API_KEY = 'ollama';

/**
 * Ollama 本地模型协议客户端
 * Ollama 提供 OpenAI 兼容接口，直接复用 OpenAIClient 实现
 * baseURL 可通过 OLLAMA_BASE_URL 环境变量覆盖，apiKey 固定为 "ollama"
 */
export class OllamaClient extends OpenAIClient {
  constructor(config: {
    providerId: string;
    baseUrl?: string;
    timeoutMs?: number;
  }) {
    super({
      providerId: config.providerId,
      baseUrl: config.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
      apiKey: OLLAMA_API_KEY,
      timeoutMs: config.timeoutMs,
    });
  }
}

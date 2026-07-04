// src/router/llm/index.ts
// LLM 客户端工厂 + 管理器
// 负责：根据协议创建客户端、管理多个 provider 的客户端

import type { ILLMClient } from '../types.js';
import { OpenAIClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { GeminiClient } from './gemini-client.js';
import { DeepSeekClient } from './deepseek-client.js';
import { QwenClient } from './qwen-client.js';
import { OllamaClient } from './ollama-client.js';
import { logger } from '../../utils/logger.js';
import type { Protocol } from '../../config/schema.js';

/**
 * 客户端类型标识
 * - openai/anthropic/gemini：与 protocol 一一对应
 * - deepseek/qwen/ollama：共享 'openai' protocol，通过 clientType 区分子类
 */
export type LLMClientType = Protocol | 'deepseek' | 'qwen' | 'ollama';

/** LLM 客户端配置 */
export interface LLMClientConfig {
  id: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /**
   * 客户端子类型标识（可选）
   * 当 protocol='openai' 时，可指定 'deepseek'/'qwen'/'ollama' 创建对应子类
   * 未指定时按 protocol 分发到基础客户端
   */
  clientType?: LLMClientType;
}

/**
 * 创建 LLM 客户端
 * 优先按 clientType 分发（区分 OpenAI 兼容子类），否则按 protocol 分发
 */
export function createLLMClient(config: LLMClientConfig): ILLMClient {
  // 优先按 clientType 分发：处理共享 'openai' protocol 的子类
  switch (config.clientType) {
    case 'gemini':
      return new GeminiClient({
        providerId: config.id,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      });
    case 'deepseek':
      return new DeepSeekClient({
        providerId: config.id,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      });
    case 'qwen':
      return new QwenClient({
        providerId: config.id,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      });
    case 'ollama':
      return new OllamaClient({
        providerId: config.id,
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
      });
    default:
      // clientType 未指定或与 protocol 同名时，回退到 protocol 分发
      break;
  }

  // 按 protocol 分发：处理 openai/anthropic/gemini 基础客户端
  switch (config.protocol) {
    case 'openai':
      return new OpenAIClient({
        providerId: config.id,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      });
    case 'anthropic':
      return new AnthropicClient({
        providerId: config.id,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      });
    case 'gemini':
      return new GeminiClient({
        providerId: config.id,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      });
    default:
      throw new Error(`Unsupported protocol: ${config.protocol}`);
  }
}

/**
 * LLM 客户端管理器
 * 管理多个 provider 的客户端实例
 */
export class LLMClientManager {
  private clients: Map<string, ILLMClient> = new Map();

  /**
   * 注册客户端
   */
  register(providerId: string, client: ILLMClient): void {
    this.clients.set(providerId, client);
    logger.debug('LLM client registered', { providerId, protocol: client.protocol });
  }

  /**
   * 注销客户端
   */
  unregister(providerId: string): void {
    this.clients.delete(providerId);
    logger.debug('LLM client unregistered', { providerId });
  }

  /**
   * 获取客户端
   */
  get(providerId: string): ILLMClient | undefined {
    return this.clients.get(providerId);
  }

  /**
   * 检查客户端是否就绪
   */
  isReady(providerId: string): boolean {
    const client = this.clients.get(providerId);
    return client?.isReady() ?? false;
  }

  /**
   * 列出所有客户端
   */
  listAll(): Map<string, ILLMClient> {
    return new Map(this.clients);
  }

  /**
   * 从配置初始化所有客户端
   */
  initializeFromConfig(configs: LLMClientConfig[]): void {
    for (const config of configs) {
      try {
        const client = createLLMClient(config);
        this.register(config.id, client);
      } catch (err) {
        logger.error('Failed to create LLM client', {
          providerId: config.id,
          protocol: config.protocol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('LLM clients initialized', { count: this.clients.size });
  }

  /**
   * 获取所有就绪的客户端
   */
  getReadyClients(): Array<{ providerId: string; client: ILLMClient }> {
    const result: Array<{ providerId: string; client: ILLMClient }> = [];
    for (const [providerId, client] of this.clients) {
      if (client.isReady()) {
        result.push({ providerId, client });
      }
    }
    return result;
  }

  /**
   * 清空所有客户端
   */
  clear(): void {
    this.clients.clear();
    logger.debug('LLM client manager cleared');
  }
}

// 导出所有相关类型和类
export { OpenAIClient } from './openai.js';
export { AnthropicClient } from './anthropic.js';
export { BaseLLMClient } from './base.js';
export { GeminiClient } from './gemini-client.js';
export { DeepSeekClient } from './deepseek-client.js';
export { QwenClient } from './qwen-client.js';
export { OllamaClient } from './ollama-client.js';

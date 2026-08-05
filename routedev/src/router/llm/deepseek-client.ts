// src/router/llm/deepseek-client.ts
// DeepSeek V4 客户端（OpenAI 兼容协议 + V4 thinking 模式适配）
// API: https://api.deepseek.com/v1
//
// V4 思考模式协议要点（官方 api-docs.deepseek.com，2026-08 核实）：
//   1. thinking 需显式开启：extra_body={"thinking":{"type":"enabled"}}
//   2. reasoning_effort 支持 low/high/max（普通请求默认 high）
//   3. thinking 模式下禁止发送 tool_choice（V4 直接拒绝该参数）
//   4. 工具轮次 assistant 的 reasoning_content 必须完整回传，否则 API 400
//      ——回传由 OpenAIClient.convertMessages 统一处理（msg.reasoningContent）
//   5. 工具调用 assistant 消息 content 必须非 null（openai.ts 已兜底空字符串）
//
// provider 特例只留在此适配器（B-14 原则），不污染通用 OpenAI 路径

import { OpenAIClient } from './openai.js';
import type { LLMRequestOptions } from '../types.js';

/** DeepSeek API 默认 base URL */
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * DeepSeek 协议客户端
 * 继承 OpenAIClient（协议兼容），覆盖 V4 思考模式参数注入。
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
    // P1 修复（复审）：显式开启 DeepSeek 专属扩展参数（thinking/reasoning_effort）
    this.supportsThinking = true;
    this.supportsReasoningEffort = true;
  }

  /**
   * V4 思考模式默认开启（官方要求显式 thinking.type=enabled），
   * effort 默认 high（官方默认），调用方可按操作档位覆盖。
   * 注意：不在此处发送 tool_choice——V4 thinking 模式拒绝该参数
   * （官方 Agent 集成文档明确要求 supportsToolChoice=false）。
   */
  override buildRequestParams(
    options: LLMRequestOptions,
    stream: boolean,
  ): ReturnType<OpenAIClient['buildRequestParams']> {
    const enhanced: LLMRequestOptions = {
      ...options,
      thinkingEnabled: options.thinkingEnabled ?? true,
      reasoningEffort: options.reasoningEffort ?? 'high',
    };
    return super.buildRequestParams(enhanced, stream);
  }
}

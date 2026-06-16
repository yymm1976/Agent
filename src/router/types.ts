// src/router/types.ts
// Router 层核心类型定义
// 包含：LLM 消息格式、工具调用、Token 使用、分类结果、路由结果、LLM 客户端抽象、LLM 错误

import type { ScenarioTier, Protocol, BudgetMode, ModelConfig } from '../config/schema.js';

// ============================================================
// LLM 消息格式（统一 OpenAI 风格，Anthropic 客户端内部转换）
// ============================================================

/** 文本内容块 */
export interface TextContent {
  type: 'text';
  text: string;
}

/** 工具调用内容块（assistant 消息中） */
export interface ToolCallContent {
  type: 'tool_use';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具结果内容块（user 消息中） */
export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

/** 图片内容块（多模态，Phase 2 仅定义类型，Phase 5+ 可用） */
export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    mediaType: string;
    data: string;
  };
}

/** 消息内容联合类型 */
export type ContentPart = TextContent | ToolCallContent | ToolResultContent | ImageContent;

/** LLM 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant';

/** 单条 LLM 消息 */
export interface LLMMessage {
  role: MessageRole;
  content: string | ContentPart[];
}

// ============================================================
// 工具调用（Tool Use）
// ============================================================

/** 工具调用请求（LLM 输出） */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具调用结果（执行后返回给 LLM） */
export interface ToolCallResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

// ============================================================
// Token 使用统计
// ============================================================

/** 单次请求的 Token 使用信息 */
export interface TokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  // 缓存相关（部分模型支持）
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** Token 预算配置（从 config 映射而来） */
export interface TokenBudget {
  mode: BudgetMode;
  dailyLimit: number;
  perRequestLimit?: number;
  degradationThreshold: number;
}

// ============================================================
// 场景分类结果
// ============================================================

/** 分类器输出 */
export interface ClassificationResult {
  tier: ScenarioTier;
  confidence: number;
  reasoning: string;
  source: 'rule' | 'llm';
}

/** 分类器输入 */
export interface ClassificationInput {
  query: string;
  context?: {
    projectType?: string;
    recentTools?: string[];
    hasGitChanges?: boolean;
  };
}

// ============================================================
// 路由结果
// ============================================================

/** 路由器输出（选中的模型 + 降级信息） */
export interface RoutingResult {
  model: ModelConfig;
  providerId: string;
  fallbackUsed: boolean;
  originalTier: ScenarioTier;
  degraded: boolean;
  degradationReason?: string;
}

/** 路由降级原因 */
export type DegradationReason =
  | 'budget_exceeded'
  | 'model_unavailable'
  | 'rate_limited'
  | 'manual_override';

// ============================================================
// LLM 客户端抽象接口（OpenAI / Anthropic 共同实现）
// ============================================================

/** LLM 请求参数 */
export interface LLMRequestOptions {
  model: string;
  messages: LLMMessage[];
  systemPrompt?: string;
  tools?: LLMToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  timeoutMs?: number;
}

/** 工具定义（传给 LLM 的 function schema） */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** 非流式响应 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  usage: TokenUsageInfo;
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  model: string;
}

/** 流式响应事件 */
export type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; toolCall: { id: string; name: string } }
  | { type: 'tool_call_delta'; toolCallId: string; argumentsDelta: string }
  | { type: 'tool_call_end'; toolCallId: string }
  | { type: 'usage'; usage: TokenUsageInfo }
  | { type: 'done'; finishReason: 'stop' | 'tool_use' | 'length' };

/** LLM 客户端接口（OpenAI / Anthropic 共同实现） */
export interface ILLMClient {
  readonly protocol: Protocol;
  readonly providerId: string;

  /** 非流式调用 */
  complete(options: LLMRequestOptions): Promise<LLMResponse>;

  /** 流式调用（返回 AsyncGenerator） */
  stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown>;

  /** 检查客户端是否就绪（API Key 已配置） */
  isReady(): boolean;
}

// ============================================================
// LLM 错误
// ============================================================

/** LLM 错误类型 */
export type LLMErrorType =
  | 'auth_error'
  | 'rate_limit'
  | 'timeout'
  | 'network_error'
  | 'invalid_request'
  | 'model_not_found'
  | 'content_filter'
  | 'unknown';

/**
 * LLM 错误类
 * 统一 OpenAI 和 Anthropic 的错误格式
 */
export class LLMError extends Error {
  readonly type: LLMErrorType;
  readonly statusCode?: number;
  readonly model?: string;
  readonly cause?: Error;

  constructor(
    message: string,
    statusCode: number | undefined,
    model: string | undefined,
    cause?: Error,
  ) {
    super(message);
    this.name = 'LLMError';
    this.statusCode = statusCode;
    this.model = model;
    this.cause = cause;
    this.type = LLMError.inferType(statusCode, message);
  }

  /** 根据状态码和消息推断错误类型 */
  private static inferType(statusCode: number | undefined, message: string): LLMErrorType {
    if (statusCode === 401 || statusCode === 403) return 'auth_error';
    if (statusCode === 429) return 'rate_limit';
    if (statusCode === 408) return 'timeout';
    if (statusCode === 404) return 'model_not_found';
    if (statusCode === 400 && message.includes('content')) return 'content_filter';
    if (statusCode === 400) return 'invalid_request';
    if (message.includes('timeout') || message.includes('ETIMEDOUT')) return 'timeout';
    if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) return 'network_error';
    return 'unknown';
  }

  /** 是否为速率限制错误 */
  get isRateLimited(): boolean {
    return this.type === 'rate_limit';
  }

  /** 是否为认证错误 */
  get isAuthError(): boolean {
    return this.type === 'auth_error';
  }

  /** 是否为超时错误 */
  get isTimeout(): boolean {
    return this.type === 'timeout';
  }
}

// ============================================================
// 路由层配置接口（从 config 映射）
// ============================================================

/** 路由规则（单条） */
export interface RouterRule {
  tier: ScenarioTier;
  modelId: string;
  fallbackModelId?: string;
  maxTokensPerRequest?: number;
}

/** 路由器配置 */
export interface RouterConfig {
  rules: RouterRule[];
  budget: TokenBudget;
  classifierModel: string;
  userPreference: 'saving' | 'balanced' | 'premium';
}

// src/router/types.ts
// Router 层核心类型定义
// 包含：LLM 消息格式、工具调用、Token 使用、分类结果、路由结果、LLM 客户端抽象、LLM 错误

import type { ScenarioTier, Protocol, BudgetMode, ModelConfig } from '../config/schema.js';

// 重新导出 config/schema 中的类型
export type { ScenarioTier, Protocol, BudgetMode, ModelConfig };

// 重新导出 AppConfig
export type { AppConfig } from '../config/schema.js';

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

/**
 * 分类结果来源
 * TD-13：统一 deterministic 与非 deterministic 路径的类型，消除 classifier.ts 中的 as unknown as 断言
 */
export type ClassificationSource = 'rule' | 'llm' | 'deterministic';

/**
 * 分类器输出（统一支持 deterministic 与非 deterministic 路径）
 * - 非 deterministic 路径：tier 为 ScenarioTier，source 为 'rule' | 'llm'
 * - deterministic 路径：tier 为 'deterministic'，source 为 'deterministic'，matchedRuleId 携带规则 ID
 */
export interface ClassificationResult {
  /** 场景等级；deterministic 规则命中时为 'deterministic'（不在 ScenarioTier 枚举中，通过联合类型扩展） */
  tier: ScenarioTier | 'deterministic';
  confidence: number;
  reasoning: string;
  source: ClassificationSource;
  /** deterministic 命中时携带的规则 ID，供路由层透传；其他路径无此字段 */
  matchedRuleId?: string;
  /** Phase 94：任务形状（单步实现 / 多步实现 / 调查 / 问答），用于驱动 spawn_agent 分发策略 */
  taskShape?: 'single-step' | 'multi-step-impl' | 'investigation' | 'qa';
}

/** 分类器上下文（Phase 32 Task 4.6：为 LLM 分类提供项目背景信息） */
export interface ClassificationContext {
  /** 项目类型（如 nodejs/java-maven/unknown） */
  projectType?: string;
  /** 最近使用的工具列表 */
  recentTools?: string[];
  /** 是否有未提交的 git 更改 */
  hasGitChanges?: boolean;
}

/** 分类器输入 */
export interface ClassificationInput {
  query: string;
  /** Phase 32 Task 4.6：可选的上下文信息，帮助 LLM 分类器做出更准确的判断 */
  context?: ClassificationContext;
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
  /**
   * Phase 32 Task 2：是否启用 Prompt 缓存
   * 默认 true——所有通过路由器发起的 LLM 调用自动启用缓存
   * Anthropic 使用 cache_control，OpenAI 使用 prompt_cache_key
   * 调用方应将此字段透传到 LLMRequestOptions.enableCache
   */
  enableCache?: boolean;
}

/** 路由降级原因 */
export type DegradationReason =
  | 'budget_exceeded'
  | 'model_unavailable'
  | 'rate_limited'
  | 'manual_override';

/**
 * 路由插件决策结果（Phase 27 Task 2）
 * 插件返回此结构表示由插件决定使用的模型，宿主据此构造 RoutingResult
 */
export interface RouteDecision {
  /** 选中的模型 ID */
  modelId: string;
  /** Provider ID（可选，不传则由路由器推断） */
  providerId?: string;
  /** 决策原因（用于日志/审计） */
  reason?: string;
}

// ============================================================
// LLM 客户端抽象接口（OpenAI / Anthropic 共同实现）
// ============================================================

/** LLM 请求参数 */
export interface LLMRequestOptions {
  model: string;
  messages: LLMMessage[];
  systemPrompt?: string;
  /**
   * Phase 55：结构化 system blocks（支持 Anthropic cache_control: ephemeral）
   * 传入时 LLM 客户端优先使用，未传时回退到 systemPrompt 字符串（向后兼容）
   * 用于 WorkerExecutor 把固定前缀 + 可变后缀拆分为多个 block，固定前缀打 cache_control 跨 Worker 命中缓存
   * 字段结构与 agent/loop.ts 的 SystemBlock 一致（type/text/cache_control）
   */
  systemBlocks?: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  tools?: LLMToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  timeoutMs?: number;
  /** P2-10：是否启用 Prompt 缓存（Anthropic 使用 cache_control，OpenAI 使用 prompt_cache_key） */
  enableCache?: boolean;
  /**
   * V2-021 修复：可选的 AbortSignal，传递给底层 HTTP 请求，支持流式取消
   * OpenAI/Anthropic 客户端透传到 SDK 的 requestOptions.signal；
   * Gemini 客户端在 SSE 读取循环中检查 signal.aborted 并 break
   */
  signal?: AbortSignal;
  /** P2-11：结构化输出格式（OpenAI 使用 response_format json_schema） */
  responseFormat?: {
    type: 'json_schema';
    jsonSchema: {
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
  /**
   * Phase 96 P1-2：Anthropic extended thinking 等级
   *
   * 七档分级（参考 PI Agent 实现）：
   *   - 'off'      关闭 thinking
   *   - 'minimal'  极简（~1k budget tokens）
   *   - 'low'      低（~5k budget tokens）
   *   - 'medium'   中（~10k budget tokens）
   *   - 'high'     高（~32k budget tokens）
   *   - 'xhigh'    极高（~64k budget tokens）
   *   - 'max'      最大（~128k budget tokens，需 max_tokens 配合上调）
   *
   * 仅 Anthropic Claude 3.7+ 支持；其他 provider 忽略此字段（不报错）
   */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Phase 96 P1-2：Anthropic extended thinking 等级
 *
 * 与 PI Agent 对齐的七档分级；每档对应 Anthropic API 的 budget_tokens 上限
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Phase 96 P1-2：thinking level → budget_tokens 映射
 *
 * budget_tokens 是 Anthropic API 的 thinking.budget_tokens 字段，
 * 表示允许模型在最终回复前用于内部推理的最大 token 数
 */
export const THINKING_BUDGET_TOKENS: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1024,
  low: 5120,
  medium: 10240,
  high: 32768,
  xhigh: 65536,
  max: 131072,
};

/** 工具定义（传给 LLM 的 function schema） */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /**
   * Phase 96 P1-6：是否启用 Structured Outputs / Constrained Sampling
   *
   * - OpenAI（Chat Completions + Responses API）：透传到 tools[i].function.strict / tools[i].strict
   *   启用后模型输出严格遵循 parameters 定义的 JSON Schema（不支持的字段会被拒绝）
   * - Anthropic / Gemini：协议无 strict 字段，input_schema / parameters 本身即约束，忽略此字段
   * - Ollama：可在 format 字段做 JSON Schema 强约束（暂未实现）
   *
   * 缺省为 undefined，由 client 默认行为决定（OpenAI 默认 false，OpenAI Responses 默认 null）
   */
  strict?: boolean;
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
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; toolCall: { id: string; name: string } }
  | { type: 'tool_call_delta'; toolCallId: string; argumentsDelta: string }
  | { type: 'tool_call_end'; toolCallId: string }
  | { type: 'usage'; usage: TokenUsageInfo }
  | { type: 'done'; finishReason: 'stop' | 'tool_use' | 'length' | 'error' };

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

  /**
   * Phase 96 P1-4：从 provider API 拉取可用模型列表
   * 调用各 provider 的 list models 端点（如 /v1/models、/v1beta/models）
   * 返回模型 ID 数组；不支持列表 API 的 provider 返回空数组
   */
  getModels?(): Promise<string[]>;
}

/**
 * Phase 96 P1-4：模型列表条目（从 provider API 拉取的原始信息）
 */
export interface RemoteModelInfo {
  /** 模型 ID（provider 返回的原始 ID） */
  id: string;
  /** 模型展示名（缺省时回退到 id） */
  name?: string;
  /** 上下文窗口（provider 返回时才有，缺省为 0 表示未知） */
  contextWindow?: number;
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
  modelId?: string;
  fallbackModelId?: string;
  maxTokensPerRequest?: number;
}

/** 路由器配置 */
export interface RouterConfig {
  rules: RouterRule[];
  budget: TokenBudget;
  classifierModel: string;
  userPreference: 'saving' | 'balanced' | 'premium';
  fallbackChain?: string[];
  /**
   * Phase 81 Task 2：三级路由简化开关（默认 true）
   * 启用后 medium/reasoning tier 收敛为 complex，仅保留 simple/complex 二分路由
   * 关闭时回退到原始四级 tier 路由
   */
  simpleRoutingEnabled?: boolean;
  /**
   * Phase 81 Task 2：置信度阈值微调层开关（默认 false，旁路）
   * 启用后 clampTier 生效；旁路时 clampTier 直接返回原 tier（恒等映射）
   * 保留 clampTier 源码，通过此开关守卫，默认不执行
   */
  confidenceThresholdEnabled?: boolean;
}

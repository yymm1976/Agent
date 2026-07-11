// src/config/schema-router.ts
// 模型路由相关配置：LLM 提供商、路由规则、Token 预算、信道、MCP、推理模式、闭环路由
// 从 schema.ts 拆分而来（TD-11），保持 Schema 定义完全等价

import { z } from 'zod';

// --- 基础枚举（路由相关） ---

// 任务复杂度分级：四级路由的目标
export const ScenarioTierSchema = z.enum(['simple', 'medium', 'complex', 'reasoning']);
export type ScenarioTier = z.infer<typeof ScenarioTierSchema>;

// LLM 协议：决定调用哪种客户端实现
// - openai: OpenAI 兼容协议（OpenAI / DeepSeek / Qwen / Ollama 等共享）
// - anthropic: Anthropic 原生协议
// - gemini: Google Gemini 原生协议（contents/parts/candidates）
export const ProtocolSchema = z.enum(['openai', 'anthropic', 'gemini']);
export type Protocol = z.infer<typeof ProtocolSchema>;

// Token 预算执行模式：仅追踪 vs 强制执行
export const BudgetModeSchema = z.enum(['track_only', 'enforce']);
export type BudgetMode = z.infer<typeof BudgetModeSchema>;

// 用户偏好：省钱 / 平衡 / 高质量
export const UserPreferenceSchema = z.enum(['saving', 'balanced', 'premium']);
export type UserPreference = z.infer<typeof UserPreferenceSchema>;

// --- 提供商与模型配置 ---

// 模型能力标签（用于路由选择）
export const ModelCapabilitySchema = z.enum([
  'reasoning', 'code', 'multimodal', 'fast', 'cheap',
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

// 单个模型的配置
export const ModelConfigSchema = z.object({
  id: z.string().min(1),                      // 模型唯一标识
  name: z.string().min(1),                    // 模型展示名
  provider: z.string().min(1),                // 所属 provider id
  tier: ScenarioTierSchema,                   // 该模型擅长的任务等级
  contextWindow: z.number().positive().int(), // 上下文窗口 token 数
  capabilities: z.array(ModelCapabilitySchema).default([]), // 能力标签
  latencyMs: z.number().nonnegative().default(0),            // 历史平均延迟
  available: z.boolean().default(true),       // 是否可用（可被人工关闭）
  fallbackModelId: z.string().optional(),     // 失败时的降级模型
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

// LLM 提供商配置（OpenAI / Anthropic 双协议）
export const ProviderConfigSchema = z.object({
  id: z.string().min(1),            // provider 唯一标识
  name: z.string().min(1),          // provider 展示名
  protocol: ProtocolSchema,         // 协议类型
  baseUrl: z.string().url(),        // API base URL（不含路径，SDK 自行拼接）
  apiKey: z.string().min(1),        // API Key（支持 ${ENV_VAR} 引用）
  models: z.array(ModelConfigSchema).default([]), // 该 provider 下的模型列表
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// --- 新增 provider 便捷配置（Gemini / DeepSeek / Qwen / Ollama） ---
// 与 providers 数组并存：providers 数组用于自定义任意 provider，
// llmProviders 提供 4 个常见 provider 的快捷配置（apiKey/baseURL/defaultModel）
// 客户端构造时优先使用 providers 数组中的配置，回退到 llmProviders，再回退到环境变量
// 状态：已定义未消费 — 预留字段，客户端构造实际未读取此配置（仅 schema 定义）
export const LLMProvidersConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** Google Gemini 配置（原生协议） */
  gemini: z.preprocess((v) => v ?? {}, z.object({
    apiKey: z.string().default(''),      // 留空时回退到 GEMINI_API_KEY 环境变量
    baseUrl: z.string().default('https://generativelanguage.googleapis.com/v1beta'),
    defaultModel: z.string().default('gemini-2.5-flash'),
  })),
  /** DeepSeek 配置（OpenAI 兼容协议） */
  deepseek: z.preprocess((v) => v ?? {}, z.object({
    apiKey: z.string().default(''),      // 留空时回退到 DEEPSEEK_API_KEY 环境变量
    baseUrl: z.string().default('https://api.deepseek.com/v1'),
    defaultModel: z.string().default('deepseek-chat'),
  })),
  /** Alibaba Qwen / 通义千问配置（OpenAI 兼容协议，DashScope） */
  qwen: z.preprocess((v) => v ?? {}, z.object({
    apiKey: z.string().default(''),      // 留空时回退到 DASHSCOPE_API_KEY 环境变量
    baseUrl: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    defaultModel: z.string().default('qwen-plus'),
  })),
  /** Ollama 本地模型配置（OpenAI 兼容协议，无需 API Key） */
  ollama: z.preprocess((v) => v ?? {}, z.object({
    baseUrl: z.string().default('http://localhost:11434/v1'),  // 回退到 OLLAMA_BASE_URL 环境变量
    defaultModel: z.string().default('llama3.2'),
  })),
}));
export type LLMProvidersConfig = z.infer<typeof LLMProvidersConfigSchema>;

// --- 路由配置 ---

// 路由规则：把任务等级映射到具体模型
export const RouterRuleSchema = z.object({
  tier: ScenarioTierSchema,                              // 任务等级
  modelId: z.preprocess((v) => v === '' ? undefined : v, z.string().min(1).optional()),                // 主选模型 id（缺省时由 buildRouterConfig 从 providers 修复）
  fallbackModelId: z.preprocess((v) => v === '' ? undefined : v, z.string().optional()),                // 降级模型 id
  maxTokensPerRequest: z.number().positive().int().optional(), // 单次请求上限
});
export type RouterRule = z.infer<typeof RouterRuleSchema>;

// Token 预算
export const TokenBudgetSchema = z.object({
  mode: BudgetModeSchema.default('track_only'),  // 预算执行模式
  dailyLimit: z.number().positive().int().default(500000), // 日 token 上限
  perRequestLimit: z.number().positive().int().optional(),  // 单次请求上限
  degradationThreshold: z.number().min(0).max(1).default(0.8), // 达到此比例后开始降级
});
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;

// 路由层配置
export const RouterConfigSchema = z.object({
  rules: z.array(RouterRuleSchema).default([]),                       // 路由规则表
  budget: z.preprocess((v) => v ?? {}, TokenBudgetSchema),         // Token 预算
  classifierModel: z.preprocess((v) => v === '' ? undefined : v, z.string().min(1).default('deepseek-v4-flash')),   // 分类器模型（应选最便宜）
  userPreference: UserPreferenceSchema.default('balanced'),          // 用户偏好
  fallbackChain: z.array(z.string()).default([]),                    // 全局降级模型链
});
export type RouterConfig = z.infer<typeof RouterConfigSchema>;

// --- 推理模式配置（Phase 42） ---
// fast（快速）/ balanced（均衡）/ accurate（精准）
// 状态：已定义未消费 — router.ts 注释明确说明未接入后端
export const ReasoningModeSchema = z.enum(['fast', 'balanced', 'accurate']).default('balanced');
export type ReasoningMode = z.infer<typeof ReasoningModeSchema>;

// --- MCP 配置 ---

/**
 * MCP 传输协议（Phase 48 Task 4 扩展）
 * 蓝图要求覆盖 APIX / SonettoHere 已验证的全部传输：
 *   - stdio：Claude Code / SonettoHere 基础类型
 *   - http：Claude Code / SonettoHere HTTP(SSE) 类型
 *   - sse：独立 SSE 传输（SonettoHere 验证）
 *   - streamable_http：MCP 2025-03-26 规范
 *   - websocket：SonettoHere 验证
 * 陷阱 #137：导入前必须校验 transport 是否被当前运行时支持，不支持的明确禁用
 */
export const MCPTransportSchema = z.enum(['stdio', 'http', 'sse', 'streamable_http', 'websocket']);
export type MCPTransport = z.infer<typeof MCPTransportSchema>;

export const MCPServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  // Phase 48 Task 4：SSE 独立传输（与 http 区分：http 是请求-响应，sse 是单向流）
  z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  // Phase 48 Task 4：MCP 2025-03-26 Streamable HTTP（双向流式 HTTP）
  z.object({
    transport: z.literal('streamable_http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  // Phase 48 Task 4：WebSocket 传输
  z.object({
    transport: z.literal('websocket'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

/** MCP 会话生命周期策略（Phase 48 Task 4，受 APIX 启发） */
export const MCPLifecyclePolicySchema = z.enum(['per-call', 'per-session', 'persistent']);
export type MCPLifecyclePolicy = z.infer<typeof MCPLifecyclePolicySchema>;

export const MCPServerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  config: MCPServerConfigSchema,
  connectTimeout: z.number().optional(),
  /** Phase 48 Task 4：会话生命周期策略（未指定时使用全局 mcp.lifecyclePolicy） */
  lifecyclePolicy: MCPLifecyclePolicySchema.optional(),
  /** 来源标注（导入时填写，便于在 UI 中显示来源） */
  origin: z.string().optional(),
});

export const MCPConfigSchema = z.object({
  servers: z.array(MCPServerEntrySchema).default([]),
  autoConnect: z.boolean().default(true),
  /** 自动重连：MCP 连接断开后是否自动重连 */
  autoReconnect: z.boolean().default(true),
  /** 连接超时（毫秒），全局默认值 */
  connectTimeout: z.number().int().min(1000).default(30000),
  /** Phase 48 Task 4：默认会话生命周期策略（Claude Code .mcp.json 未声明时使用 per-session） */
  lifecyclePolicy: MCPLifecyclePolicySchema.default('per-session'),
});

export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type MCPServerEntryConfig = z.infer<typeof MCPServerEntrySchema>;

// --- Phase 61：ACRouter 闭环模型路由配置 ---

/**
 * 闭环路由配置（Phase 61）
 * ACRouter C-A-F 循环：Context → Action → Feedback → Context
 * 所有子模块默认关闭，由总开关和子开关分别守护
 */
export const ClosedLoopRoutingConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 总开关（默认关闭） */
  enabled: z.boolean().default(true),
  /** RoutingHistory 配置 */
  history: z.preprocess((v) => v ?? {}, z.object({
    maxRecords: z.number().int().default(20000),
    persistPath: z.string().default('.routedev/routing-history.jsonl'),
  })),
  /** RoutingMemory 配置 */
  memory: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    topK: z.number().int().min(1).max(50).default(10),
    minSimilarity: z.number().min(0).max(1).default(0.3),
    embeddingProvider: z.enum(['openai', 'hash']).default('hash'),
  })),
  /** Orchestrator 配置 */
  orchestrator: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    neighborWeight: z.number().min(0).max(1).default(0.6),
    priorWeight: z.number().min(0).max(1).default(0.3),
    baseWeight: z.number().min(0).max(1).default(0.1),
  })),
  /** ExecutionVerifier 配置 */
  verifier: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    signals: z.array(z.enum(['compile', 'test', 'typecheck', 'latency'])).default(['compile', 'typecheck', 'latency']),
    timeoutMs: z.number().int().default(30000),
  })),
}));
export type ClosedLoopRoutingConfig = z.infer<typeof ClosedLoopRoutingConfigSchema>;

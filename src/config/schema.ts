// src/config/schema.ts
// 全局配置类型定义（Zod Schema）
// 本文件是整个配置系统的"宪法"——所有模块从这里获取类型
// 任何新增字段必须先在此处定义，再被其它模块引用

import { z } from 'zod';

// --- 基础枚举 ---

// 任务复杂度分级：四级路由的目标
export const ScenarioTierSchema = z.enum(['simple', 'medium', 'complex', 'reasoning']);
export type ScenarioTier = z.infer<typeof ScenarioTierSchema>;

// LLM 协议：决定调用 OpenAI SDK 还是 Anthropic SDK
export const ProtocolSchema = z.enum(['openai', 'anthropic']);
export type Protocol = z.infer<typeof ProtocolSchema>;

// Token 预算执行模式：仅追踪 vs 强制执行
export const BudgetModeSchema = z.enum(['track_only', 'enforce']);
export type BudgetMode = z.infer<typeof BudgetModeSchema>;

// Agent 自主度（auto 全自动 / semi 关键步骤确认 / manual 逐步确认）
export const AutonomyModeSchema = z.enum(['auto', 'semi', 'manual']);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

// 敏感文件保护策略：只读 vs 禁止访问
export const SensitiveFilePolicySchema = z.enum(['readonly', 'deny']);
export type SensitiveFilePolicy = z.infer<typeof SensitiveFilePolicySchema>;

// 用户偏好：省钱 / 平衡 / 高质量
export const UserPreferenceSchema = z.enum(['saving', 'balanced', 'premium']);
export type UserPreference = z.infer<typeof UserPreferenceSchema>;

// CLI 主题
export const ThemeSchema = z.enum(['dark', 'light']);
export type Theme = z.infer<typeof ThemeSchema>;

// CLI 语言
export const LanguageSchema = z.enum(['zh-CN', 'en-US']);
export type Language = z.infer<typeof LanguageSchema>;

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

// --- 路由配置 ---

// 路由规则：把任务等级映射到具体模型
export const RouterRuleSchema = z.object({
  tier: ScenarioTierSchema,                              // 任务等级
  modelId: z.string().min(1),                            // 主选模型 id
  fallbackModelId: z.string().optional(),                // 降级模型 id
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
  classifierModel: z.string().min(1).default('deepseek-v4-flash'),   // 分类器模型（应选最便宜）
  userPreference: UserPreferenceSchema.default('balanced'),          // 用户偏好
});
export type RouterConfig = z.infer<typeof RouterConfigSchema>;

// --- Checkpoint 配置 ---

// Checkpoint 触发条件
export const CheckpointTriggerSchema = z.object({
  level: z.number().min(1).max(100),  // Agent 嵌套深度 / 步骤数
  action: z.enum(['initial', 'incremental', 'compress']), // 触发动作
});

// 增量 Checkpoint 配置（MiMo Code 风格，用于压缩记忆）
export const CheckpointConfigSchema = z.object({
  enabled: z.boolean().default(true),
  triggers: z.array(CheckpointTriggerSchema).default([
    { level: 20, action: 'initial' },
    { level: 45, action: 'incremental' },
    { level: 70, action: 'compress' },
  ]),
  modelId: z.string().default('deepseek-v4-flash'),
  maxTokensPerCheckpoint: z.number().positive().int().default(500),
});
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>;

// --- 渠道配置（Phase 13） ---

export const ChannelTypeSchema = z.enum(['wechat-work', 'telegram', 'slack', 'discord']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const ChannelEntrySchema = z.object({
  id: z.string().min(1),
  type: ChannelTypeSchema,
  enabled: z.boolean().default(true),
  options: z.record(z.string(), z.string()).default({}),
});

export const ChannelsConfigSchema = z.object({
  entries: z.array(ChannelEntrySchema).default([]),
  port: z.number().positive().int().default(9800),
  publicUrl: z.string().optional(),
  maxResponseLength: z.number().positive().int().default(2000),
  requestTimeout: z.number().positive().int().default(60000),
});
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;
export type ChannelEntryConfig = z.infer<typeof ChannelEntrySchema>;

// --- GoalVerifier 配置 ---

// 目标验证器（验证 /goal 是否完成）
export const GoalVerifierConfigSchema = z.object({
  enabled: z.boolean().default(true),
  modelId: z.string().default('kimi-k2.7'),
  maxTokensPerVerification: z.number().positive().int().default(1000),
  autoVerify: z.boolean().default(true),  // 完成后是否自动验证
});
export type GoalVerifierConfig = z.infer<typeof GoalVerifierConfigSchema>;

// --- 安全配置 ---

// 7 层安全模型中的配置层（参见蓝图决策 4）
export const SecurityConfigSchema = z.object({
  directoryBoundary: z.boolean().default(true),                       // 目录边界限制
  commandBlacklist: z.array(z.string()).default(['rm -rf', 'format', 'del /s']), // 危险命令黑名单
  commandWhitelist: z.array(z.string()).default([]),                   // 白名单（空 = 不限制）
  sensitiveFiles: z.array(z.string()).default(['.env', 'credentials.json', '*.key']), // 敏感文件 pattern
  sensitiveFilePolicy: SensitiveFilePolicySchema.default('readonly'),  // 敏感文件策略
  networkConfirm: z.boolean().default(true),                           // 网络请求前确认
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

// --- 自主度配置 ---

export const AutonomyConfigSchema = z.object({
  defaultMode: AutonomyModeSchema.default('semi'),
  /** 无论什么模式下都自动批准的工具 pattern（如 ["file_read", "code_search"]） */
  autoApprovePatterns: z.array(z.string()).default([]),
  /** 确认超时时间（毫秒）。超时后按模式自动决定：auto/semi → 批准，manual → 拒绝 */
  confirmTimeout: z.number().positive().int().default(30000),
});
export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;

// --- 提示音配置 ---

export const SoundsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  completion: z.string().default('default'),
  error: z.string().default('warning'),
  approval: z.string().default('notification'),
});
export type SoundsConfig = z.infer<typeof SoundsConfigSchema>;

// --- 更新配置 ---

export const UpdatesConfigSchema = z.object({
  checkOnStartup: z.boolean().default(true),
  autoUpdate: z.boolean().default(false),
});
export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;

// --- MCP 配置 ---

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
]);

export const MCPServerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  config: MCPServerConfigSchema,
  connectTimeout: z.number().optional(),
});

export const MCPConfigSchema = z.object({
  servers: z.array(MCPServerEntrySchema).default([]),
  autoConnect: z.boolean().default(true),
});

export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type MCPServerEntryConfig = z.infer<typeof MCPServerEntrySchema>;

// --- Prompt 模板配置（Phase 16） ---

export const PromptConfigSchema = z.object({
  userTemplatesDir: z.string().optional(),
  projectOverrides: z.boolean().default(true),
  cacheTtlSeconds: z.number().int().min(0).default(0),
});
export type PromptConfigType = z.infer<typeof PromptConfigSchema>;

export const ProjectMemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxMemorySize: z.number().int().min(100).default(10000),
  maxDecisions: z.number().int().min(10).default(100),
  autoInject: z.boolean().default(true),
});
export type ProjectMemoryConfigType = z.infer<typeof ProjectMemoryConfigSchema>;

// --- 通用配置 ---

export const GeneralConfigSchema = z.object({
  language: LanguageSchema.default('zh-CN'),
  theme: ThemeSchema.default('dark'),
  startupBehavior: z.enum(['restore', 'project_select']).default('restore'),
});
export type GeneralConfig = z.infer<typeof GeneralConfigSchema>;

// --- 全局配置（完整 schema） ---
// 顶层 AppConfig：所有配置的根节点
// 注：Zod 4 严格化后，`.default({})` 不接受空对象字面量。
// 用 `z.preprocess((v) => v ?? {}, schema)` 实现"未指定则用 schema 内默认值"的语义。
export const AppConfigSchema = z.object({
  version: z.number().int().default(1),                                // 配置 schema 版本
  general: z.preprocess((v) => v ?? {}, GeneralConfigSchema),
  providers: z.array(ProviderConfigSchema).default([]),                // 所有 LLM 提供商
  router: z.preprocess((v) => v ?? {}, RouterConfigSchema),            // 路由层配置
  checkpoint: z.preprocess((v) => v ?? {}, CheckpointConfigSchema),    // 增量 Checkpoint
  goalVerifier: z.preprocess((v) => v ?? {}, GoalVerifierConfigSchema), // 目标验证
  security: z.preprocess((v) => v ?? {}, SecurityConfigSchema),        // 安全策略
  channels: z.preprocess((v) => v ?? {}, ChannelsConfigSchema),         // 渠道集成（Phase 13）
  autonomy: z.preprocess((v) => v ?? {}, AutonomyConfigSchema),        // 自主度
  sounds: z.preprocess((v) => v ?? {}, SoundsConfigSchema),            // 提示音
  updates: z.preprocess((v) => v ?? {}, UpdatesConfigSchema),          // 更新策略
  mcp: z.preprocess((v) => v ?? {}, MCPConfigSchema),                  // MCP 客户端配置
  prompts: z.preprocess((v) => v ?? {}, PromptConfigSchema),            // Prompt 模板系统（Phase 16）
  projectMemory: z.preprocess((v) => v ?? {}, ProjectMemoryConfigSchema), // 项目记忆（Phase 16）
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

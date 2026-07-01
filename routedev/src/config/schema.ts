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

// Phase 34：输出样式（信息密度控制权交给用户）
export const OutputStyleSchema = z.enum(['minimal', 'standard', 'verbose']);
export type OutputStyle = z.infer<typeof OutputStyleSchema>;

// GUI 外观主题：黑白灰蓝四套配色
export const AppearanceThemeSchema = z.enum(['white', 'black', 'gray', 'blue']);
export type AppearanceTheme = z.infer<typeof AppearanceThemeSchema>;

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

export const ChannelTypeSchema = z.enum(['wechat-work', 'telegram', 'slack']);
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
  /**
   * Webhook Bearer Token 认证（Phase 53 接线修复）
   * 配置后所有 webhook 请求需带 `Authorization: Bearer <token>` 头；
   * 未配置时为开发模式，跳过认证（由 devModeAuth 控制是否要求认证）
   */
  authToken: z.string().optional(),
  /**
   * 是否信任 X-Forwarded-For 头（Phase 53 接线修复）
   * 反向代理场景才应启用；直连时禁用以防客户端伪造 IP 绕过速率限制
   */
  trustProxy: z.boolean().default(false),
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
  /**
   * 迭代闭环配置（借鉴 kimi-code 的"迭代到目标达成为止"模式）
   * 启用后，验证失败时会自动调用 GoalParser 生成补救步骤并继续执行，
   * 直到验证通过或达到最大迭代次数
   */
  iterative: z.object({
    /** 是否启用迭代闭环 */
    // Phase 54 修复：默认 true——验证失败时自动生成补救步骤，交叉验证的闭环保障
    enabled: z.boolean().default(true),
    /** 最大迭代轮数（1-10，默认 3） */
    maxRounds: z.number().int().min(1).max(10).default(3),
  }).default({ enabled: true, maxRounds: 3 }),
});
export type GoalVerifierConfig = z.infer<typeof GoalVerifierConfigSchema>;

// --- 对抗性验证配置（Phase 21 Task 4） ---

/**
 * 对抗性验证配置
 * 启用后用独立 LLM 客户端（fast tier 廉价模型）尝试推翻主验证结论
 */
export const AdversarialConfigSchema = z.object({
  /** 是否启用对抗性验证 */
  enabled: z.boolean().default(false),
  /** 严重度阈值（0-1，低于此值的质疑不返回，默认 0.5） */
  threshold: z.number().min(0).max(1).default(0.5),
  /** 模型层级：fast（廉价快速）/ main（与主 Agent 相同） */
  modelTier: z.enum(['fast', 'main']).default('fast'),
});
export type AdversarialConfig = z.infer<typeof AdversarialConfigSchema>;

// --- 安全配置 ---

// Phase 47 Task 4：沙箱级与审批级
/** 沙箱级：决定工具能做多少 */
export const SandboxLevelSchema = z.enum(['read-only', 'workspace-write', 'full-access']);
export type SandboxLevel = z.infer<typeof SandboxLevelSchema>;

/** 审批级：决定是否询问用户 */
export const ApprovalLevelSchema = z.enum(['always-ask', 'on-request', 'never-ask']);
export type ApprovalLevel = z.infer<typeof ApprovalLevelSchema>;

/** 工具分类 */
export const ToolCategorySchema = z.enum([
  'read', 'write', 'shell', 'network', 'git-read', 'git-write', 'agent', 'mcp',
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

// 7 层安全模型中的配置层（参见蓝图决策 4）
export const SecurityConfigSchema = z.object({
  directoryBoundary: z.boolean().default(true),                       // 目录边界限制
  commandBlacklist: z.array(z.string()).default(['rm -rf', 'format', 'del /s']), // 危险命令黑名单
  commandWhitelist: z.array(z.string()).default([]),                   // 白名单（空 = 不限制）
  /** 工具黑名单：匹配的工具一律禁止调用（支持通配符 pattern，如 file_write, mcp_*） */
  toolBlacklist: z.array(z.string()).default([]),
  /** 工具白名单：仅允许调用的工具（空 = 不限制；非空时黑名单仍优先生效） */
  toolWhitelist: z.array(z.string()).default([]),
  sensitiveFiles: z.array(z.string()).default(['.env', 'credentials.json', '*.key']), // 敏感文件 pattern
  sensitiveFilePolicy: SensitiveFilePolicySchema.default('readonly'),  // 敏感文件策略
  // 修复：默认 false，避免 web_search/web_fetch 等只读网络工具每次都需要用户确认
  // 写入/执行类工具仍通过 requiresApproval + ToolExecutionContext 确认回调控制
  networkConfirm: z.boolean().default(false),                          // 网络请求前确认
  /** SSRF 防护开关：拦截对内网地址的访问请求 */
  ssrfProtection: z.boolean().default(true),
  /** 严格 Bash 模式：检测到命令注入时阻断执行 */
  strictBashMode: z.boolean().default(false),
  /** 强制 HTTPS：仅允许 HTTPS 协议的网络请求 */
  httpsOnly: z.boolean().default(true),
  /** 速率限制 Map 上限（条目数） */
  rateLimitMaxSize: z.number().int().min(100).default(10000),
  /** 开发模式认证：开发环境下是否要求认证 */
  devModeAuth: z.boolean().default(false),
  /** Phase 47 Task 4：沙箱级 — 决定工具能做多少（默认 workspace-write） */
  sandbox: SandboxLevelSchema.default('workspace-write'),
  /** Phase 47 Task 4：审批级覆盖 — 按工具类别覆盖默认审批级（可选，部分覆盖） */
  approval: z.record(z.string(), ApprovalLevelSchema).optional(),
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

/**
 * Phase 54 Task 5：自主度模式行为定义
 * 把 auto/semi/manual 三档映射到具体行为开关，供 GoalRunner 在 handleGoalCommand 中统一判定
 *
 * - requirePlanConfirmation：是否需要用户确认执行计划（auto 跳过，semi/manual 需确认）
 * - requireToolConfirmation：是否需要用户确认单个工具调用（manual 需确认，auto/semi 跳过）
 * - requireHumanAcceptance：是否需要人工最终确认验收（所有模式都需——这是"严苛验收"核心价值的体现）
 */
export const AUTONOMY_BEHAVIOR: Record<AutonomyMode, {
  requirePlanConfirmation: boolean;
  requireToolConfirmation: boolean;
  requireHumanAcceptance: boolean;
}> = {
  // auto：全自动执行，但关键验收仍需人工把关
  auto: {
    requirePlanConfirmation: false,
    requireToolConfirmation: false,
    requireHumanAcceptance: true,
  },
  // semi：半自动——需用户确认计划，工具调用自动批准，验收需人工确认
  semi: {
    requirePlanConfirmation: true,
    requireToolConfirmation: false,
    requireHumanAcceptance: true,
  },
  // manual：全手动——计划确认 + 工具确认 + 验收确认都需人工
  manual: {
    requirePlanConfirmation: true,
    requireToolConfirmation: true,
    requireHumanAcceptance: true,
  },
};

// --- 提示音配置 ---

export const SoundsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  completion: z.string().default('default'),
  error: z.string().default('warning'),
  approval: z.string().default('notification'),
});
export type SoundsConfig = z.infer<typeof SoundsConfigSchema>;

// --- UI 配置（Phase 25 / Phase 34） ---

/**
 * Phase 50 Task 7：CLI 组件开关配置
 * 控制 7 个 React 组件是否接入 UI（关闭时回退到纯文本渲染函数）
 */
export const UIComponentsSchema = z.preprocess((v) => v ?? {}, z.object({
  /** BranchSwitcher：分支树可视化（状态栏区域） */
  branchSwitcher: z.boolean().default(true),
  /** ResumePicker：恢复执行选择器（/resume 命令） */
  resumePicker: z.boolean().default(true),
  /** ProgressBar：通用进度条（goal 执行进度） */
  progressBar: z.boolean().default(true),
  /** TracePanel：Trace 时间线（/trace 命令） */
  tracePanel: z.boolean().default(false),
  /** DisclosureLevel：渐进披露容器（消息列表） */
  disclosureLevel: z.boolean().default(true),
  /** DiffView：diff 可视化（/diff 命令） */
  diffView: z.boolean().default(true),
  /** ConfigReloadNotice：配置变更通知卡片 */
  configReloadNotice: z.boolean().default(true),
}));
export type UIComponentsConfig = z.infer<typeof UIComponentsSchema>;

export const UIConfigSchema = z.preprocess(
  (v) => {
    // Phase 34：向后兼容旧版 ui.disclosureLevel 数字 1/2/3
    if (v && typeof v === 'object' && !Array.isArray(v) && 'disclosureLevel' in v) {
      const obj = v as Record<string, unknown>;
      const level = obj.disclosureLevel;
      let style: string | undefined;
      if (level === 1 || level === '1') style = 'minimal';
      else if (level === 2 || level === '2') style = 'standard';
      else if (level === 3 || level === '3') style = 'verbose';
      if (style) {
        const { disclosureLevel: _, ...rest } = obj;
        return { ...rest, outputStyle: style };
      }
    }
    return v;
  },
  z.object({
    /** Phase 34：输出样式，控制信息密度与展示方式 */
    outputStyle: OutputStyleSchema.default('standard'),
    /** 是否启用 critical 通知的终端 bell */
    bell: z.boolean().default(true),
    /** 空闲提示触发秒数 */
    idleHintSeconds: z.number().positive().int().default(30),
    /** 配置热重载提示开关：开启后配置变更时显示提示 */
    hotReloadNotify: z.boolean().default(true),
    /** Phase 50 Task 7：组件级开关，控制 7 个 React 组件接入 */
    components: UIComponentsSchema,
  }),
);
export type UIConfig = z.infer<typeof UIConfigSchema>;

// --- 更新配置 ---

export const UpdatesConfigSchema = z.object({
  checkOnStartup: z.boolean().default(true),
  autoUpdate: z.boolean().default(false),
});
export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;

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

// --- 优化配置（Phase 30：可观测性与上下文优化） ---

/**
 * Token 可观测性配置
 * 默认开启——可观测性不应是实验性的
 */
export const TokenTrackingConfigSchema = z.object({
  /** 是否启用 Token Profiling（分组件估算） */
  enabled: z.boolean().default(true),
  /** 是否将会话快照写入磁盘 */
  persistSession: z.boolean().default(true),
  /** 快照输出目录（相对于工作目录） */
  outputDir: z.string().default('.routedev/token-logs'),
});
export type TokenTrackingConfig = z.infer<typeof TokenTrackingConfigSchema>;

// --- 统一工作流编排配置（Phase 31 Task 1） ---

/**
 * 统一工作流编排配置
 * 把三条执行路径（chat/goal/compose）合并为一条智能流水线
 */
export const WorkflowConfigSchema = z.object({
  /** 是否启用统一流水线（默认开启——核心改进） */
  unifiedPipeline: z.boolean().default(true),
  /** 是否自动判断"需要确认需求"还是"直接执行" */
  autoRequirements: z.boolean().default(true),
  /** 任务完成后是否自动审查 */
  reviewOnComplete: z.boolean().default(true),
  /** 审查模式：builtin（内置 Worker）/ ocr（外部 open-code-review）/ none */
  reviewMode: z.enum(['builtin', 'ocr', 'none']).default('builtin'),
  /** 审查使用的模型：'auto' 用路由器选择，或指定具体模型 id */
  reviewModel: z.string().default('auto'),
  /** 审查严格度 */
  reviewStrictness: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

// --- 生产安全防护配置（Phase 31 Task 6） ---

/**
 * 生产安全防护配置
 * 包含先读后写、工具输出截断、独立验证门等
 */
export const SafetyConfigSchema = z.object({
  /** 是否启用"先读后写"强制（file_write/file_edit 前必须 file_read 过） */
  readBeforeWrite: z.boolean().default(true),
  /** 工具输出最大字符数（超过则智能截断，优先保留错误区域） */
  maxToolOutputChars: z.number().int().min(1000).max(100000).default(16000),
  /** 是否启用独立代码验证门（typecheck/lint/tests） */
  completionGate: z.boolean().default(true),
  /** 验证门总超时（毫秒） */
  gateTimeout: z.number().int().min(10000).max(600000).default(180000),
  /** 验证门失败后最多重试次数 */
  gateRetry: z.number().int().min(0).max(5).default(1),
});
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

// --- Worker 上下文选择性传递配置（Phase 35 Task 1） ---

/**
 * Worker 上下文过滤策略
 * - tail：保留最近 N 条消息 + Blackboard 注入（简单可预测）
 * - keyword：从 task.description 提取关键词，保留包含关键词的消息（精准）
 * - budget：从最新消息向前累积，超出 token 预算则停止（token 可控）
 */
export const WorkerContextStrategySchema = z.enum(['tail', 'keyword', 'budget']);
export type WorkerContextStrategy = z.infer<typeof WorkerContextStrategySchema>;

/**
 * Worker 上下文选择性传递配置（Phase 35 Task 1）
 * 默认启用 tail 策略，保留最近 5 条消息 + Blackboard 注入
 * 关闭时（enabled=false）回退到完整 conversationHistory 透传（向后兼容）
 */
export const WorkerContextConfigSchema = z.object({
  /** 是否启用上下文过滤（关闭时回退到完整历史透传） */
  enabled: z.boolean().default(true),
  /** 过滤策略 */
  strategy: WorkerContextStrategySchema.default('tail'),
  /** tail 策略：保留最近消息数 */
  maxMessages: z.number().int().min(1).max(50).default(5),
  /** budget 策略：token 上限 */
  maxTokens: z.number().int().min(500).max(32000).default(4000),
  /** 过滤失败时是否用完整上下文重试（向后兼容保护） */
  fallbackToFull: z.boolean().default(true),
});
export type WorkerContextConfig = z.infer<typeof WorkerContextConfigSchema>;

// --- 需求澄清配置（Phase 37 Task 1） ---

/**
 * 需求澄清配置
 * 控制 RequirementsClarifier 的行为：模糊度阈值、最大问题数、是否自动跳过
 */
export const ClarificationConfigSchema = z.object({
  /** 是否启用需求澄清 */
  enabled: z.boolean().default(true),
  /** 模糊度阈值（0-1，达到此值才追问，默认 0.4） */
  threshold: z.number().min(0).max(1).default(0.4),
  /** 最多追问问题数（1-5，默认 3） */
  maxQuestions: z.number().int().min(1).max(5).default(3),
  /** 置信度高时是否自动跳过（默认 true） */
  skipIfConfident: z.boolean().default(true),
});
export type ClarificationConfig = z.infer<typeof ClarificationConfigSchema>;

/**
 * 优化配置（Phase 30）
 * 包含可观测性、三个实验性上下文优化功能、统一工作流编排（Phase 31）和生产安全防护（Phase 31 Task 6）
 * Phase 35 Task 1：新增 workerContext（Worker 上下文选择性传递）
 * Phase 37 Task 1：新增 clarification（需求澄清）
 */
export const OptimizationConfigSchema = z.object({
  /** Token 可观测性（默认开启） */
  tokenTracking: z.preprocess((v) => v ?? {}, TokenTrackingConfigSchema),
  /** 结构化实体状态（实验性，默认关闭） */
  structuredState: z.object({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
  /** 声明式上下文获取（实验性，默认关闭） */
  declarativeContext: z.object({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
  /** 简洁思考约束（实验性，默认关闭） */
  conciseThinking: z.object({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
  /** 统一工作流编排（Phase 31 Task 1） */
  workflow: z.preprocess((v) => v ?? {}, WorkflowConfigSchema),
  /** 生产安全防护（Phase 31 Task 6） */
  safety: z.preprocess((v) => v ?? {}, SafetyConfigSchema),
  /** Worker 上下文选择性传递（Phase 35 Task 1） */
  workerContext: z.preprocess((v) => v ?? {}, WorkerContextConfigSchema),
  /** 需求澄清（Phase 37 Task 1） */
  clarification: z.preprocess((v) => v ?? {}, ClarificationConfigSchema),
});
export type OptimizationConfig = z.infer<typeof OptimizationConfigSchema>;

// --- 调度器配置（Phase 37 Task 2） ---

/**
 * 调度器配置
 * 控制定时任务引擎的行为：是否启用、最大任务数、默认时区
 */
export const SchedulerConfigSchema = z.object({
  /** 是否启用调度器 */
  enabled: z.boolean().default(true),
  /** 最大任务数（1-100） */
  maxTasks: z.number().int().min(1).max(100).default(20),
  /** 默认时区 */
  defaultTimezone: z.string().default('Asia/Shanghai'),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

// --- 后台行为配置（Phase 37 Task 2） ---

/**
 * 后台行为配置
 * 控制应用关闭时的行为以及有活跃任务时的处理策略
 * 组合校验：exit 模式下 activeTaskOnClose 必须为 terminate
 */
export const BackgroundBehaviorConfigSchema = z.object({
  /** 关闭时的行为：exit（退出）/ minimize-to-tray（最小化到托盘）/ ask（询问） */
  backgroundBehavior: z.enum(['exit', 'minimize-to-tray', 'ask']).default('ask'),
  /** 有活跃任务时的处理：terminate（终止）/ continue-in-background（后台继续）/ prompt（提示） */
  activeTaskOnClose: z.enum(['terminate', 'continue-in-background', 'prompt']).default('prompt'),
}).refine((data) => {
  // 组合校验：exit 模式下 activeTaskOnClose 必须为 terminate
  if (data.backgroundBehavior === 'exit' && data.activeTaskOnClose !== 'terminate') {
    return false;
  }
  return true;
}, { message: 'backgroundBehavior=exit 时 activeTaskOnClose 必须为 terminate' });
export type BackgroundBehaviorConfig = z.infer<typeof BackgroundBehaviorConfigSchema>;

// --- 知识图谱配置（Phase 38 Task 4） ---

/**
 * 知识图谱配置
 * 控制持久化、自动遗忘和多策略召回的默认行为
 */
export const KnowledgeGraphConfigSchema = z.object({
  /** 持久化配置 */
  persistence: z.preprocess((v) => v ?? {}, z.object({
    /** 是否启用磁盘持久化 */
    enabled: z.boolean().default(true),
    /** 持久化文件路径（相对于工作目录） */
    path: z.string().default('.routedev/memory/knowledge-graph.json'),
  })),
  /** 自动遗忘配置 */
  autoForget: z.preprocess((v) => v ?? {}, z.object({
    /** 未使用天数阈值（超过此天数未使用且 unusedCount>0 则遗忘） */
    unusedDays: z.number().int().min(1).default(60),
    /** 过期天数阈值（超过此天数未更新则遗忘） */
    staleDays: z.number().int().min(1).default(90),
  })),
  /** 多策略召回配置 */
  recall: z.preprocess((v) => v ?? {}, z.object({
    /** 默认召回策略（auto 表示自动路由） */
    defaultStrategy: z.enum(['auto', 'semantic', 'graph', 'temporal', 'type_weighted', 'hybrid']).default('auto'),
    /** 默认最大返回结果数 */
    maxResults: z.number().int().min(1).max(100).default(10),
  })),
});
export type KnowledgeGraphConfig = z.infer<typeof KnowledgeGraphConfigSchema>;

// --- 中间件配置（Phase 38 Task 1） ---

/**
 * 循环检测中间件配置
 * 控制 LoopDetectionMiddleware 的行为：滑动窗口大小、最大重复次数
 */
export const LoopDetectionConfigSchema = z.object({
  /** 是否启用循环检测 */
  enabled: z.boolean().default(true),
  /** 滑动窗口大小（3-50，记录最近 N 次工具调用） */
  windowSize: z.number().int().min(3).max(50).default(10),
  /** 窗口内允许的最大重复次数（2-10，超过则判定为循环） */
  maxRepeats: z.number().int().min(2).max(10).default(3),
});
export type LoopDetectionConfig = z.infer<typeof LoopDetectionConfigSchema>;

/**
 * 中间件配置（Phase 38 Task 1）
 * 与 optimization/security 平级，聚合各中间件的开关与参数
 */
export const MiddlewareConfigSchema = z.object({
  /** 循环检测中间件 */
  loopDetection: z.preprocess((v) => v ?? {}, LoopDetectionConfigSchema),
});
export type MiddlewareConfig = z.infer<typeof MiddlewareConfigSchema>;

// --- Agent 配置（Phase 38 Task 2） ---

/**
 * Agent 全局配置
 * 控制子 Agent 派遣的并行上限等行为
 * 注：Zod 4 严格化后 `.default({})` 不接受空对象字面量，
 *     依赖 AppConfigSchema 中的 `z.preprocess((v) => v ?? {}, AgentConfigSchema)` 填充默认值
 */
export const AgentConfigSchema = z.object({
  /** 最大并行子 Agent 数（1-10，默认 3） */
  // 修复：默认值从 3 提升到 5，避免并行调研多个框架时立即被拒绝
  maxConcurrentSubAgents: z.number().int().min(1).max(10).default(5),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// --- 执行配置 ---

/**
 * 执行配置
 * 控制并发数、熔断机制与检查点提示等运行时行为
 */
export const ExecutionConfigSchema = z.object({
  /** 最大并发数（1-20，默认 3） */
  maxConcurrency: z.number().int().min(1).max(20).default(3),
  /** 是否启用熔断机制 */
  circuitBreaker: z.boolean().default(true),
  /** 熔断阈值：连续失败次数达到此值后熔断 */
  circuitBreakerThreshold: z.number().int().min(1).default(5),
  /** 熔断持续时间（毫秒） */
  circuitBreakerDuration: z.number().int().min(1000).default(30000),
  /** 检查点提示开关：开启后保存检查点时显示提示 */
  checkpointNotify: z.boolean().default(true),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

// --- 权限规则配置（Permission Profile，glob 级权限规则） ---

/**
 * 文件系统权限规则
 * - pattern: glob 模式（如所有 .env 文件、secrets 目录下文件等）
 * - access: read（只读）/ write（可读写）/ deny（禁止访问）
 */
export const FilesystemPermissionRuleSchema = z.object({
  /** glob 模式（匹配文件路径，支持通配符） */
  pattern: z.string().min(1),
  /** 访问级别：read=只读，write=可读写，deny=禁止访问 */
  access: z.enum(['read', 'write', 'deny']),
});
export type FilesystemPermissionRule = z.infer<typeof FilesystemPermissionRuleSchema>;

/**
 * 权限规则配置（Permission Profile）
 * 借鉴 Open Interpreter 的 Permission Profile，用 glob 规则精细控制文件系统和网络访问权限
 * 替代扁平的 security.sensitiveFiles 配置，支持按文件路径模式分级授权
 */
export const PermissionProfileSchema = z.object({
  /** Profile 名称（用于多 Profile 场景识别，当前仅支持 default） */
  name: z.string().default('default'),
  /** 文件系统权限规则列表（按顺序匹配，命中第一条即生效） */
  filesystem: z.array(FilesystemPermissionRuleSchema).default([]),
  /** 网络域名规则 */
  network: z.object({
    /** 域名白名单（支持通配符，如 "*.github.com"） */
    allow: z.array(z.string()).default([]),
    /** 域名黑名单（支持通配符） */
    deny: z.array(z.string()).default([]),
  }).default({ allow: [], deny: [] }),
});
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

// --- 网络搜索配置 ---

/**
 * 网络搜索配置（借鉴 PilotDeck + DeepSeek-Reasonix 方案）
 * 支持多引擎回退，按中国可用性排序：
 *   中国直连：GLM、Metaso、Baidu、Bing CN HTML、SearXNG(自建)
 *   需翻墙：Tavily、Bing API、Perplexity、Exa、Brave、DuckDuckGo
 *
 * API Key 也可通过环境变量配置：
 *   GLM_WEB_SEARCH_API_KEY / ZAI_API_KEY / METASO_API_KEY / BAIDU_API_KEY / QIANFAN_API_KEY
 *   TAVILY_API_KEY / BING_SEARCH_API_KEY / PERPLEXITY_API_KEY / EXA_API_KEY / BRAVE_SEARCH_API_KEY
 */
export const WebSearchConfigSchema = z.object({
  /** 智谱 GLM web_search API Key（中国直连可用，推荐） */
  glmApiKey: z.string().default(''),
  /** 秘塔搜索 API Key（中国直连可用） */
  metasoApiKey: z.string().default(''),
  /** 百度千帆 AI 搜索 API Key（中国直连可用） */
  baiduApiKey: z.string().default(''),
  /** Tavily API Key（需翻墙） */
  tavilyApiKey: z.string().default(''),
  /** Bing Web Search API Key（需翻墙） */
  bingApiKey: z.string().default(''),
  /** Perplexity API Key（AI 原生搜索，需翻墙） */
  perplexityApiKey: z.string().default(''),
  /** Exa API Key（AI 原生搜索，需翻墙） */
  exaApiKey: z.string().default(''),
  /** Brave Search API Key（需翻墙） */
  braveApiKey: z.string().default(''),
  /** SearXNG 实例 URL（自托管，中国可用） */
  searxngEndpoint: z.string().default(''),
});
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

// --- 通用配置 ---

export const GeneralConfigSchema = z.object({
  language: LanguageSchema.default('zh-CN'),
  theme: ThemeSchema.default('dark'),
  startupBehavior: z.enum(['restore', 'project_select']).default('restore'),
  /** 首次启动向导是否被跳过（允许空 Provider 进入主界面） */
  setupSkipped: z.boolean().default(false),
  /** GUI 外观主题：white/black/gray/blue */
  appearanceTheme: AppearanceThemeSchema.default('black'),
  /** 全局字体大小（px），影响整个 GUI 的基准字号 */
  fontSize: z.number().int().min(12).max(24).default(14),
  /** 自定义主题色（HEX 格式，覆盖预设主题的 primary 色；空字符串表示用预设） */
  accentColor: z.string().default(''),
  /** 后台行为配置（Phase 37 Task 2） */
  backgroundBehavior: z.preprocess((v) => v ?? {}, BackgroundBehaviorConfigSchema),
});
export type GeneralConfig = z.infer<typeof GeneralConfigSchema>;

// --- Phase 39：代码地图 / 实验 / Hooks 配置 ---

/**
 * 代码地图配置（Phase 39）
 * 双轨制：内置轻量引擎 + CodeGraph MCP 外接
 */
export const CodeGraphConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 CodeGraph 增强引擎（默认关闭，使用内置轻量引擎） */
  enabled: z.boolean().default(false),
  /** 工作区路径（默认当前目录） */
  workspace: z.string().default('.'),
  /** 是否自动索引（开启后文件变更自动重建索引） */
  autoIndex: z.boolean().default(true),
}));
export type CodeGraphConfig = z.infer<typeof CodeGraphConfigSchema>;

/**
 * 实验分支配置（Phase 39）
 * 控制 Git Worktree 实验分支的并发上限与自动清理
 */
export const ExperimentsConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 最大活跃 worktree 数量（1-20，默认 5） */
  maxActiveWorktrees: z.number().int().min(1).max(20).default(5),
  /** 实验结束后是否自动清理 worktree（默认 true） */
  autoCleanup: z.boolean().default(true),
}));
export type ExperimentsConfig = z.infer<typeof ExperimentsConfigSchema>;

/**
 * Hooks 配置（Phase 39）
 * 控制 Hook 系统的启用状态与配置文件路径
 */
export const HooksConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 Hook 系统（默认 true） */
  enabled: z.boolean().default(true),
  /** Hook 配置文件路径（相对于工作目录） */
  configPath: z.string().default('.routedev/hooks.json'),
}));
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

// --- Phase 40：渐进式信任 / 质量监测 / 用户经验 ---

/**
 * 渐进式信任配置（Phase 40）
 * 借鉴 Claude Code 的 7 级信任梯度，控制临时授权与偏好持久化
 */
export const TrustConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 基础信任级别（7 级梯度） */
  baseLevel: z.enum(['plan', 'default', 'acceptEdits', 'acceptAll', 'auto', 'bypassPermissions', 'trusted']).default('default'),
  /** 是否启用临时授权（会话级，resume 时不恢复） */
  enableTemporaryGrants: z.boolean().default(true),
  /** 临时授权 TTL（分钟） */
  grantTTLMinutes: z.number().int().min(1).default(30),
  /** 是否启用偏好持久化（跨会话保留） */
  enablePersistentPreferences: z.boolean().default(false),
  /** 偏好最大条目数 */
  maxPersistentGrants: z.number().int().min(1).default(200),
}));
export type TrustConfig = z.infer<typeof TrustConfigSchema>;

/**
 * 质量监测配置（Phase 40）
 * 控制隐式反馈检测、信号保留与知识图谱自动改进
 */
export const QualityConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用隐式反馈检测 */
  enableImplicitFeedback: z.boolean().default(true),
  /** 负面信号降级阈值（0-1，达到此值触发降级） */
  negativeSignalThreshold: z.number().min(0).max(1).default(0.4),
  /** 信号保留天数 */
  signalRetentionDays: z.number().int().min(1).default(30),
  /** 是否自动改进知识图谱 */
  autoImproveKnowledgeGraph: z.boolean().default(true),
  /** 去抖时间（毫秒） */
  debounceMs: z.number().int().min(0).default(3000),
}));
export type QualityConfig = z.infer<typeof QualityConfigSchema>;

/**
 * 用户经验配置（Phase 40）
 * 三级经验等级，控制行为差异化与 System Prompt 注入
 */
export const ExpertiseConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 经验等级 */
  level: z.enum(['beginner', 'intermediate', 'expert']).default('intermediate'),
  /** 是否启用自动建议 */
  enableAutoSuggestion: z.boolean().default(true),
  /** 输出风格覆盖（null 表示不覆盖） */
  outputStyleOverride: z.string().nullable().default(null),
}));
export type ExpertiseConfig = z.infer<typeof ExpertiseConfigSchema>;

// --- Phase 41-42：代码地图升级 / 策略引擎 / 市场 / 推理模式 ---

/**
 * 代码地图配置（升级版，Phase 41）
 * 自研引擎：tree-sitter (WASM) + SQLite + PageRank + Aider 风格渲染
 * 与现有 codegraph 配置段并存（codegraph 为 CodeGraph MCP 外接，codeMap 为自研引擎）
 */
export const CodeMapConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 解析引擎：tree-sitter（WASM 精确解析）/ regex（轻量回退）/ disabled（关闭） */
  engine: z.enum(['tree-sitter', 'regex', 'disabled']).default('tree-sitter'),
  /** Token 预算（RepoDistill 压缩后的目标 token 数） */
  budgetTokens: z.number().int().min(256).default(2048),
  /** HCGS（Hierarchical Call Graph Summary）实验性开关 */
  enableHCGS: z.boolean().default(false),
  /** 语义边实验性开关（跨文件符号引用关系） */
  enableSemanticEdges: z.boolean().default(false),
  /** 索引排除目录（glob 模式） */
  indexExclude: z.array(z.string()).default(['node_modules', '.git', 'dist', 'release-v*']),
  /** 最大上下文符号数（注入 system prompt 的符号上限） */
  maxContextSymbols: z.number().int().min(10).default(50),
  /** 自动索引（文件变更时自动重建索引） */
  autoIndex: z.boolean().default(true),
}));
export type CodeMapConfig = z.infer<typeof CodeMapConfigSchema>;

/**
 * 市场配置（Phase 42）
 * 控制 Skill / Hook 的发布、导入、导出
 * Phase 43：新增 registryUrl / registryToken，支持远程 Registry 拉取
 */
export const MarketConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用市场 */
  enabled: z.boolean().default(true),
  /** 自动发布（Skill/Hook 创建后自动发布到市场） */
  autoPublish: z.boolean().default(false),
  /** 远程 Registry URL（未配置时不连接远程注册表） */
  registryUrl: z.string().optional(),
  /** Registry 认证 Token（可选，配合 registryUrl 使用） */
  registryToken: z.string().optional(),
}));
export type MarketConfig = z.infer<typeof MarketConfigSchema>;

/**
 * 策略引擎配置（Phase 42）
 * Intent Guard + Playbook + Tool Guide + Tool Approval
 */
export const PoliciesConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用策略引擎 */
  enabled: z.boolean().default(true),
  /** 意图护栏（检测危险意图并阻止） */
  intentGuard: z.boolean().default(true),
  /** SOP 注入（根据意图注入标准操作流程） */
  playbook: z.boolean().default(true),
  /** 工具增强（为工具调用注入使用指南） */
  toolGuide: z.boolean().default(true),
  /** 工具审批（工具调用前需审批） */
  toolApproval: z.boolean().default(false),
  /** 审批模式：always（全部审批）/ risky-only（仅高风险）/ minimal（最小化） */
  approvalMode: z.enum(['always', 'risky-only', 'minimal']).default('risky-only'),
}));
export type PoliciesConfig = z.infer<typeof PoliciesConfigSchema>;

/**
 * 推理模式配置（Phase 42）
 * fast（快速）/ balanced（均衡）/ accurate（精准）
 */
export const ReasoningModeSchema = z.enum(['fast', 'balanced', 'accurate']).default('balanced');
export type ReasoningMode = z.infer<typeof ReasoningModeSchema>;

// --- Phase 43：子 Agent / Goal / Hook 增强 配置 ---

/**
 * 子 Agent 配置（Phase 43）
 * 控制子 Agent 派遣的并行上限、默认角色与门控规则
 * 与现有 agent.maxConcurrentSubAgents 并存——agent 是全局上限，subAgents 是细粒度角色门控
 */
export const SubAgentsConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用子 Agent 派遣 */
  enabled: z.boolean().default(true),
  /** 最大并行子 Agent 数（1-10，默认 3） */
  maxParallel: z.number().int().min(1).max(10).default(3),
  /** 默认角色 */
  defaultRole: z.enum(['researcher', 'executor', 'reviewer', 'custom']).default('executor'),
  /** 角色门控规则（每种角色的并行上限） */
  gateRules: z.object({
    researcherMaxParallel: z.number().int().default(3),
    executorMaxParallel: z.number().int().default(2),
    reviewerMaxParallel: z.number().int().default(2),
  }).optional(),
}));
export type SubAgentsConfig = z.infer<typeof SubAgentsConfigSchema>;

/**
 * Goal 配置（Phase 43）
 * 控制 /goal 流程的需求澄清、确认、审计模式与 token 预算
 */
export const GoalConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用需求澄清 */
  clarify: z.boolean().default(true),
  /** 是否要求用户确认（分解后的计划需用户确认才执行） */
  requireConfirmation: z.boolean().default(true),
  /** 审计模式：none（跳过）/ completion_gate_first（验证门优先）/ reviewer_first（审查器优先）/ all_must_pass（全部通过） */
  auditMode: z.enum(['none', 'completion_gate_first', 'reviewer_first', 'all_must_pass']).default('completion_gate_first'),
  /** 单次 /goal 的 token 预算（最低 1000） */
  tokenBudget: z.number().int().min(1000).default(50000),
  /** 软停止比例（达到预算此比例时提示用户，0.5-1.0） */
  softStopRatio: z.number().min(0.5).max(1.0).default(0.9),
  /**
   * Phase 55 Task 4：/goal 执行路径路由器配置
   * 字段与 ExecutionRouterOptions 接口保持一致（单一数据源）
   */
  executionRouter: z.object({
    /** 判定模式：auto（自动判定）/ legacy（强制旧路径）/ explicit（显式指定） */
    mode: z.enum(['auto', 'legacy', 'explicit']).default('auto'),
    /** mode=explicit 时生效，指定具体路径 */
    explicitRoute: z.enum(['single', 'dag', 'compose', 'legacy']).optional(),
    /** 单 Agent 路径的最大步数（1-5，默认 2） */
    singleAgentMaxSteps: z.number().int().min(1).max(5).default(2),
    /** DAG 路径的最大领域数（超过则升级到 compose，1-5，默认 1） */
    dagMaxDomains: z.number().int().min(1).max(5).default(1),
  }).default({ mode: 'auto', singleAgentMaxSteps: 2, dagMaxDomains: 1 }),
  difficultyRouting: z.object({
    enabled: z.boolean().default(false),
    refineLevelAtExecution: z.boolean().default(true),
    dynamicLevelSwitchEnabled: z.boolean().default(false),
    confidenceThreshold: z.number().min(0).max(1).default(0.6),
  }).default({
    enabled: false,
    refineLevelAtExecution: true,
    dynamicLevelSwitchEnabled: false,
    confidenceThreshold: 0.6,
  }),
}));
export type GoalConfig = z.infer<typeof GoalConfigSchema>;

/**
 * Phase 55 Task 9：CCR 可逆压缩配置
 * 让 compact 从破坏性变可逆——compact 前缓存原始消息，LLM 可通过 ccr_retrieve 工具取回
 */
export const CCRCompressionConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 CCR 可逆压缩 */
  enabled: z.boolean().default(false),
  /** LRU cache 最大条目数 */
  maxCacheSize: z.number().int().min(1).max(500).default(50),
}));
export type CCRCompressionConfig = z.infer<typeof CCRCompressionConfigSchema>;

/**
 * Hook 增强配置（Phase 43）
 * 控制函数级 Hook、沙箱、试用期与 Hook 分组
 */
export const HookEnhancementConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用函数级 Hook（精细到函数入口/出口） */
  functionHooks: z.boolean().default(false),
  /** 是否启用沙箱（Hook 在隔离环境执行） */
  sandbox: z.boolean().default(true),
  /** 试用期天数（1-30，默认 7） */
  trialDays: z.number().int().min(1).max(30).default(7),
  /** 是否启用 Hook 分组（按事件类型分组管理） */
  hookGroups: z.boolean().default(true),
}));
export type HookEnhancementConfig = z.infer<typeof HookEnhancementConfigSchema>;

// --- Phase 44：消息节点持久化 / 分支联动 / 并行实验 配置 ---

/**
 * 对话消息树持久化配置（Phase 44）
 * 控制 JSONL 持久化、节点上限、自动快照与撤销栈大小
 */
export const ConversationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否持久化消息树到磁盘 */
  persistTree: z.boolean().default(true),
  /** 最大节点数（100-∞，默认 5000） */
  maxNodes: z.number().int().min(100).default(5000),
  /** 最大分支数（5-∞，默认 100） */
  maxBranches: z.number().int().min(5).default(100),
  /** 是否自动快照（节点变更时自动写入） */
  autoSnapshot: z.boolean().default(true),
  /** 撤销栈大小（0 表示禁用撤销） */
  undoStackSize: z.number().int().min(0).default(50),
}));
export type ConversationConfig = z.infer<typeof ConversationConfigSchema>;

/**
 * 并行实验配置（Phase 44）
 * 控制多分支并行实验的启用、并行上限、冲突检测与自动清理
 */
export const ExperimentConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用并行实验 */
  parallelEnabled: z.boolean().default(false),
  /** 最大并行实验数（2-5，默认 3） */
  maxParallel: z.number().int().min(2).max(5).default(3),
  /** 是否启用文件冲突检测 */
  conflictDetection: z.boolean().default(true),
  /** 自动清理天数（0 表示不自动清理） */
  autoCleanupDays: z.number().int().min(0).default(7),
}));
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

// --- Phase 45：人格 / 语音 / 记忆 / 发现 配置 ---

/**
 * 人格配置（Phase 45）
 * 控制 PersonaEngine 的启用状态、强度与当前人格 ID
 */
export const PersonaConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用人格引擎 */
  enabled: z.boolean().default(true),
  /** 人格强度：none（关闭）/ low（轻度）/ medium（中度）/ high（高度） */
  intensity: z.enum(['none', 'low', 'medium', 'high']).default('medium'),
  /** 当前人格 ID（默认 'collaborator'） */
  currentId: z.string().default('collaborator'),
}));
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

/**
 * 语音配置（Phase 45）
 * 控制语音输入（STT）和语音输出（TTS）的提供商与语言
 */
export const VoiceConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 输入提供商（STT）：web-speech / whisper-local / openai-whisper / off */
  inputProvider: z.enum(['web-speech', 'whisper-local', 'openai-whisper', 'off']).default('off'),
  /** 输出提供商（TTS）：system / openai / off */
  outputProvider: z.enum(['system', 'openai', 'off']).default('off'),
  /** 语言代码（'zh-CN' | 'en-US'） */
  language: z.string().default('zh-CN'),
  /** 是否自动朗读最终回复 */
  autoPlay: z.boolean().default(false),
}));
export type VoiceConfigType = z.infer<typeof VoiceConfigSchema>;

/**
 * 记忆配置（Phase 45）
 * 控制记忆推理、自动学习与注入阈值
 */
export const MemoryConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用记忆推理 */
  inference: z.boolean().default(true),
  /** 是否启用自动学习 */
  autoLearn: z.boolean().default(true),
  /** 注入阈值（0-1，达到此相关度才注入记忆） */
  injectThreshold: z.number().min(0).max(1).default(0.7),
}));
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * 发现配置（Phase 45）
 * 控制功能发现与启动时提示
 */
export const DiscoveryConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用功能发现 */
  enabled: z.boolean().default(true),
  /** 是否在启动时显示发现提示 */
  showOnStartup: z.boolean().default(false),
}));
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

// --- Phase 48 Task 1：引用系统配置 ---

/**
 * 引用系统配置（Phase 48 Task 1）
 * 控制 CiteManager 与 CiteResolver 的行为：启用状态、标签上限、文本截断、preflight token 预算
 *
 * - enabled：是否启用引用系统
 * - maxTags：单次最多引用标签数（陷阱 #126：超过时折叠显示，避免输入框被挤压）
 * - maxTextCiteLength：text 引用最大字符数（陷阱 #127：超过时提示用户而非静默截断）
 * - maxPreflightTokens：preflight 工具调用结果的 token 上限
 * - autoRunPreflight：是否自动执行 preflight 工具（陷阱 #135：自动执行也需经过 PermissionEngine）
 */
export const CiteConfigSchema = z.object({
  /** 是否启用引用系统 */
  enabled: z.boolean().default(true),
  /** 单次最多引用标签数（1-20，默认 10） */
  maxTags: z.number().int().min(1).max(20).default(10),
  /** text 引用最大字符数（100-10000，默认 2000） */
  maxTextCiteLength: z.number().int().min(100).max(10000).default(2000),
  /** preflight 工具调用结果的 token 上限（1000-50000，默认 8000） */
  maxPreflightTokens: z.number().int().min(1000).max(50000).default(8000),
  /** 是否自动执行 preflight 工具 */
  autoRunPreflight: z.boolean().default(true),
});
export type CiteConfigType = z.infer<typeof CiteConfigSchema>;

// --- Phase 47 Task 8：项目文档（AGENTS.md / CLAUDE.md）多文件名 fallback 配置 ---

/**
 * 项目文档配置（Phase 47 Task 8）
 * 控制项目级文档（AGENTS.md / CLAUDE.md）的多文件名 fallback 加载行为
 *
 * 加载优先级：
 *   1. 若 filenames 中存在 override 文件（默认 AGENTS.override.md），则跳过基础文件，
 *      只加载 override + local（陷阱 #140：override 语义是「跳过」而非「合并」）
 *   2. 否则加载基础文件 + local 文件（合并，local 在后覆盖）
 *   3. 以上都不存在时，fallback 到 fallbackFilenames 中的文件（同样支持 base + local 合并）
 *
 * maxBytes 对齐 Codex 32KiB 上限，超过时截断并 warn
 */
export const ProjectDocConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 主加载文件名列表（按顺序尝试，第一个为 base，第二个为 local 覆盖） */
  filenames: z.array(z.string().min(1)).default(['AGENTS.md', 'AGENTS.local.md', 'AGENTS.override.md']),
  /** fallback 文件名列表（主列表全部不存在时使用，第一个为 base，第二个为 local 覆盖） */
  fallbackFilenames: z.array(z.string().min(1)).default(['CLAUDE.md', 'CLAUDE.local.md']),
  /** 单文件最大字节数（超过则截断并 warn，默认 32768 = 32KiB，对齐 Codex） */
  maxBytes: z.number().int().min(1024).default(32768),
}));
export type ProjectDocConfig = z.infer<typeof ProjectDocConfigSchema>;

// --- Phase 48 Task 5：Macro 配置 ---

/**
 * Macro 配置（Phase 48 Task 5）
 * 控制轻量工作流宏的启用与存储路径
 * Macro 是比 Skill 更轻量的流程指引，纯 Markdown，通过 `!` 触发器引用
 */
export const MacrosConfigSchema = z.object({
  /** 是否启用 Macro 系统 */
  enabled: z.boolean().default(true),
  /** Macro 目录（相对于工作目录，默认 .routedev/macros） */
  dir: z.string().default('.routedev/macros'),
});
export type MacrosConfig = z.infer<typeof MacrosConfigSchema>;

// --- Phase 48 Task 2/3：外部生态导入配置 ---

/**
 * Codex Instructions 导入模式（Phase 48 Task 3）
 *   - system_prompt：追加到 PromptManager 的项目级 system prompt
 *   - project_memory：按段落写入项目记忆，打 codex-instruction 标签
 *   - ignore：记录用户选择，不再提示（除非文件更新）
 * 陷阱 #130：导入时必须提示用户选择，不能默默覆盖已有记忆
 */
export const CodexInstructionsModeSchema = z.enum(['system_prompt', 'project_memory', 'ignore']);
export type CodexInstructionsMode = z.infer<typeof CodexInstructionsModeSchema>;

/**
 * 外部生态导入配置（Phase 48 Task 2/3）
 * 控制 Anthropic Skills / Claude Code Plugin / Codex Instructions 的导入行为
 *
 * 陷阱 #129：社区来源的 Hook/Skill 默认不直接启用，需用户确认或沙箱试用
 * 陷阱 #132：未映射的工具必须禁用并提示，不能静默失败
 */
export const ImportConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /**
   * 是否自动启用 anthropic_skills/ 目录下扫描到的 Skill
   * 默认 false：社区来源默认不启用，需用户在设置页或 /plugin 命令中确认
   */
  anthropicSkillsAutoEnable: z.boolean().default(false),
  /**
   * 是否自动启用导入的 Claude Code Plugin
   * 默认 false：plugin 中的 Hook/MCP 进入沙箱试用模式
   */
  claudePluginAutoEnable: z.boolean().default(false),
  /**
   * Codex Instructions 导入模式（默认 project_memory，避免 system prompt 过长）
   */
  codexInstructions: CodexInstructionsModeSchema.default('project_memory'),
  /**
   * Codex Instructions 导入后存放的标签（项目记忆模式用）
   */
  codexMemoryTag: z.string().default('codex-instruction'),
}));
export type ImportConfig = z.infer<typeof ImportConfigSchema>;

// --- Phase 50：核心模块接入开关配置 ---

/**
 * Goal 流程接入配置（Phase 50 Task 1）
 * 控制 /goal 流程中四个核心模块的渐进式接入，默认全部关闭
 * - auditEnabled：GoalAuditor 三层独立审计
 * - persistenceEnabled：GoalPersistence 持久化与续跑
 * - promptBuilderEnabled：GoalPromptBuilder 五段式规范构造
 * - requirementChangeEnabled：RequirementChangeAnalyzer 需求变更分析
 */
export const GoalIntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  // Phase 54 修复：auditEnabled 默认 true——三层独立审计是交叉验证的核心保障
  auditEnabled: z.boolean().default(true),
  // Phase 47 P1-2 修复：persistenceEnabled 默认 true——GoalPersistence 装配完整但默认关闭导致永不生效，
  // 目标执行状态不落盘，崩溃后无法恢复。开启后写入 .routedev/goals/<id>.json，与 defaults.ts 对齐
  persistenceEnabled: z.boolean().default(true),
  promptBuilderEnabled: z.boolean().default(false),
  requirementChangeEnabled: z.boolean().default(false),
}));
export type GoalIntegrationConfig = z.infer<typeof GoalIntegrationConfigSchema>;

/**
 * 多 Agent 编排接入配置（Phase 50 Task 2）
 * 控制 orchestrator.ts 中三个核心模块的渐进式接入，默认全部关闭
 * - strategyEnabled：StrategySelector 按复杂度选择策略
 * - stateGraphEnabled：ExecutionStateGraph 步骤状态管理
 * - branchOrchestrationEnabled：BranchOrchestrator 并行分支调度
 */
export const OrchestrationIntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  strategyEnabled: z.boolean().default(false),
  stateGraphEnabled: z.boolean().default(false),
  branchOrchestrationEnabled: z.boolean().default(false),
}));
export type OrchestrationIntegrationConfig = z.infer<typeof OrchestrationIntegrationConfigSchema>;

/**
 * 子 Agent 委托体系接入配置（Phase 50 Task 3）
 * 控制 spawn-agent.ts 中五个核心模块的渐进式接入，默认全部关闭
 * - contextPackerEnabled：ContextPacker 按角色打包上下文
 * - delegationGateEnabled：DelegationGate 委托前检查资格
 * - delegationEnforcerEnabled：DelegationEnforcer 执行中校验工具调用
 * - lifecycleEnabled：SubAgentLifecycle + AntiAbuseDetector 生命周期与反滥用
 * - scoreCardEnabled：SubAgentScoreCardCollector 执行后收集评分
 */
export const DelegationIntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  contextPackerEnabled: z.boolean().default(true),
  delegationGateEnabled: z.boolean().default(true),
  delegationEnforcerEnabled: z.boolean().default(true),
  lifecycleEnabled: z.boolean().default(true),
  scoreCardEnabled: z.boolean().default(true),
}));
export type DelegationIntegrationConfig = z.infer<typeof DelegationIntegrationConfigSchema>;

// --- Phase 50 Task 5/6：Phase 48/49 模块接入确认配置 ---

/**
 * Phase 48 模块接入确认配置（Phase 50 Task 5）
 * 聚合 cite/import/macros/mcp 四模块的顶层接入开关
 * 各子模块自身的配置（cite/macros/import/mcp）已存在，此处仅控制是否在生产路径接入
 * 默认全部 true——这些模块在 Phase 48 已实现，Phase 50 确认接入
 */
export const Phase48IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** cite 引用系统接入（CiteResolver 注入 chat-runner） */
  citeEnabled: z.boolean().default(true),
  /** import 外部生态导入接入（ClaudePluginImporter / CodexInstructionImporter） */
  importEnabled: z.boolean().default(true),
  /** macros 宏系统接入（MacroManager `!` 触发器） */
  macrosEnabled: z.boolean().default(true),
  /** mcp 桥接接入（ClaudeMCPBridge） */
  mcpBridgeEnabled: z.boolean().default(true),
}));
export type Phase48IntegrationConfig = z.infer<typeof Phase48IntegrationConfigSchema>;

/**
 * Phase 49 模块接入确认配置（Phase 50 Task 6）
 * 聚合 DualLoop/QualityGate/ContextUsagePanel/EvaluationFramework 等模块（SkillFlow/RoutingFunnel 已移除）
 * 默认全部 false——这些模块为实验性功能，需显式开启
 */
export const Phase49IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** SkillFlow 引擎接入（Skill 执行时可选调用） */
  skillFlowEnabled: z.boolean().default(false),
  /** 双循环编排器接入（/goal 执行时可选调用） */
  dualLoopEnabled: z.boolean().default(true),
  /** Skill 质量门接入（Skill 生成时可选调用） */
  qualityGateEnabled: z.boolean().default(true),
  /** 上下文占用率面板接入（context-compaction 调用） */
  contextUsagePanelEnabled: z.boolean().default(false),
  /** 评估集框架接入（Skill 生成或 /goal 完成时可选调用） */
  evaluationFrameworkEnabled: z.boolean().default(false),
  /** 意图路由漏斗接入（router 调用） */
  routingFunnelEnabled: z.boolean().default(false),
}));
export type Phase49IntegrationConfig = z.infer<typeof Phase49IntegrationConfigSchema>;

// --- Phase 51：外部开源借鉴落地配置 ---

/** Reviewer 分级策略（Phase 51 Task 1/7） */
export const ReviewerPolicySchema = z.preprocess((v) => v ?? {}, z.object({
  tieredReviewEnabled: z.boolean().default(true),
  tinyTaskStepThreshold: z.number().int().min(1).max(20).default(5),
  bigTaskStepThreshold: z.number().int().min(10).max(100).default(30),
  midWorkReviewRatio: z.number().min(0.3).max(0.8).default(0.5),
  autoCrossModelForHighRisk: z.boolean().default(true),
  crossModelReviewerId: z.string().default(''),
  enforceEvidenceProtocol: z.boolean().default(false),
  highRiskThreshold: z.number().int().min(20).max(100).default(40),
  autoSelectCrossModel: z.boolean().default(true),
  failureEscalationThreshold: z.number().int().min(1).max(10).default(2),
  contextTokenEscalationRatio: z.number().min(0.5).max(0.95).default(0.8),
}));
export type ReviewerPolicyConfig = z.infer<typeof ReviewerPolicySchema>;

/** 委托四维约束+三态策略（Phase 51 Task 2/3/4） */
export const DelegationPolicySchema = z.preprocess((v) => v ?? {}, z.object({
  boundedDelegationEnabled: z.boolean().default(true),
  maxDepth: z.number().int().min(0).max(5).default(1),
  maxParallel: z.number().int().min(1).max(10).default(4),
  delegationTargets: z.record(z.string(), z.array(z.string())).default({}),
  subprocessTools: z.record(z.string(), z.array(z.string())).default({}),
  depthPassingMode: z.enum(['env', 'counter']).default('counter'),
  hardDelegationTypes: z.array(z.string()).default(['research', 'review']),
  refuseIfSpecialistUnavailable: z.boolean().default(false),
  specialistAvailabilityOverride: z.record(z.string(), z.boolean()).default({}),
  toolCallGuardEnabled: z.boolean().default(false),
  detachedSessionEnabled: z.boolean().default(true),
  fullContextIsolation: z.boolean().default(true),
  subAgentMaxContextTokens: z.number().int().min(1000).max(200000).default(32000),
  propagateToolCallsToParent: z.boolean().default(false),
}));
export type DelegationPolicyConfig = z.infer<typeof DelegationPolicySchema>;

/** Agent 活动面板（Phase 51 Task 5） */
export const ActivityPanelSchema = z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  maxActiveDisplay: z.number().int().min(1).max(10).default(4),
  maxRecentDisplay: z.number().int().min(0).max(20).default(3),
  taskPreviewLength: z.number().int().min(20).max(200).default(72),
  showToolCallStats: z.boolean().default(true),
  showThinkingLevel: z.boolean().default(true),
}));
export type ActivityPanelConfig = z.infer<typeof ActivityPanelSchema>;

/** 三层抽象 Instance/Harness/Session（Phase 51 Task 6） */
export const InstanceHarnessSchema = z.preprocess((v) => v ?? {}, z.object({
  threeTierAbstractionEnabled: z.boolean().default(false),
  defaultInstanceId: z.string().default(''),
  defaultHarnessName: z.string().default('default'),
  scopeAbortCascadeEnabled: z.boolean().default(false),
}));
export type InstanceHarnessConfig = z.infer<typeof InstanceHarnessSchema>;

/** 项目级配置分层（Phase 51 Task 8） */
export const ConfigLayeringSchema = z.preprocess((v) => v ?? {}, z.object({
  // 旧字段(保留向后兼容)
  enabled: z.boolean().default(false),
  projectConfigPath: z.string().default('.routedev/config.json'),
  globalConfigPath: z.string().default(''),
  mergeStrategy: z.enum(['deep', 'shallow']).default('deep'),
  // 新字段(Phase 51 蓝图对齐)
  projectConfigEnabled: z.boolean().default(false),
  globalConfigDir: z.string().default(''),
  arrayMergeStrategy: z.enum(['replace', 'merge']).default('replace'),
}));
export type ConfigLayeringConfig = z.infer<typeof ConfigLayeringSchema>;

/** 错误显示配置（Phase 51 Task 9） */
export const ErrorDisplaySchema = z.preprocess((v) => v ?? {}, z.object({
  // 旧字段
  showDevDetails: z.boolean().default(false),
  showStackTrace: z.boolean().default(false),
  maxDetailsLength: z.number().int().min(100).max(10000).default(2000),
  // 新字段(Phase 51 蓝图对齐)
  errorDisplayMode: z.enum(['user', 'dev']).default('user'),
  includeStackTrace: z.boolean().default(false),
  logErrorsToFile: z.boolean().default(true),
}));
export type ErrorDisplayConfig = z.infer<typeof ErrorDisplaySchema>;

/** Result Schema 配置（Phase 51 Task 10） */
export const ResultSchemaConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  // 旧字段
  enabled: z.boolean().default(false),
  strictValidation: z.boolean().default(false),
  fallbackToText: z.boolean().default(true),
  // 新字段(Phase 51 蓝图对齐)
  resultSchemaEnabled: z.boolean().default(false),
  enforceFinishProtocol: z.boolean().default(false),
  maxSubAgentSteps: z.number().int().min(5).max(200).default(50),
}));
export type ResultSchemaConfig = z.infer<typeof ResultSchemaConfigSchema>;

/** 模型显示配置（Phase 51 Task 11） */
export const ModelDisplaySchema = z.preprocess((v) => v ?? {}, z.object({
  // 旧字段
  showThinkingLevel: z.boolean().default(true),
  showProviderPrefix: z.boolean().default(false),
  thinkingLevelLabels: z.record(z.string(), z.string()).default({}),
  // 新字段(Phase 51 蓝图对齐)
  splitThinkingLabel: z.boolean().default(true),
  thinkingLabelStyle: z.enum(['badge', 'text', 'icon']).default('badge'),
}));
export type ModelDisplayConfig = z.infer<typeof ModelDisplaySchema>;

// --- Phase 52：MUSE-Autoskill 集成配置 ---

/**
 * Skill 生命周期配置（Phase 52 Task 1）
 * 实现 MUSE-Autoskill 论文的五阶段生命周期：Creation / Memory / Management / Evaluation / Refinement
 *
 * 默认全部关闭——这些功能为实验性自主能力，需显式开启
 * 陷阱 #171：memoryRetentionDays 必须严格执行，过期记忆立即清理
 */
export const SkillLifecycleConfigSchema = z.object({
  /** 是否启用 Skill 生命周期管理 */
  enabled: z.boolean().default(false),
  /** 触发创建的相似任务次数阈值（2-10，默认 3） */
  creationTriggerThreshold: z.number().int().min(2).max(10).default(3),
  /** 记忆保留天数（1-365，默认 30，陷阱 #171） */
  memoryRetentionDays: z.number().int().min(1).max(365).default(30),
  /** 是否自动应用优化建议（默认 false——必须用户审批） */
  autoApplyRefinement: z.boolean().default(false),
});
export type SkillLifecycleConfig = z.infer<typeof SkillLifecycleConfigSchema>;

// --- Phase 52 Task 7：评估集饱和监测配置 ---

/**
 * 评估集饱和监测配置（Phase 52 Task 7）
 *
 * 来自 Benchmark Saturation 论文——评估集区分度会随模型升级而下降，
 * 当模型在评估集上的得分接近天花板时，评估集就不再具备区分能力。
 *
 * SaturationMonitor 持续监测 passRate / scoreVariance / discrimination，
 * 在饱和时给出 add_difficult_cases / retire_easy_cases / replace_evaluation 建议。
 *
 * 默认关闭——开启后由 EvaluationFramework 在每次 runEvaluation 后调用 SaturationMonitor。
 */
export const SaturationMonitorConfigSchema = z.object({
  /** 是否启用饱和监测 */
  enabled: z.boolean().default(false),
  /** 通过率阈值（高于此值且方差低于阈值时判定为 saturated，默认 0.95） */
  passRateThreshold: z.number().min(0.5).max(1).default(0.95),
  /** 方差阈值（低于此值且通过率高于阈值时判定为 saturated，默认 0.05） */
  varianceThreshold: z.number().min(0).max(0.5).default(0.05),
  /** 检查间隔：至少积累多少次运行结果才开始评估（5-100，默认 10） */
  checkInterval: z.number().int().min(5).max(100).default(10),
});
export type SaturationMonitorConfig = z.infer<typeof SaturationMonitorConfigSchema>;

/**
 * MCP 安全形式化框架配置（Phase 52 Task 10）
 * 来自 MCPSHIELD 论文——4 层深度防御 + 7 类威胁检测
 */
export const MCPSecurityConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 MCP 安全框架 */
  enabled: z.boolean().default(false),
  /** 严格度级别：permissive(宽松) / standard(标准) / strict(严格) */
  strictness: z.enum(['permissive', 'standard', 'strict']).default('standard'),
  /** L1 能力层防御：工具能力校验 */
  l1CapabilityCheck: z.boolean().default(true),
  /** L2 证明层防御：工具来源验证 */
  l2AttestationCheck: z.boolean().default(false),
  /** L3 信息流层防御：数据流追踪 */
  l3InfoFlowTracking: z.boolean().default(true),
  /** L4 运行时层防御：运行时行为监控 */
  l4RuntimeMonitoring: z.boolean().default(true),
}));
export type MCPSecurityConfig = z.infer<typeof MCPSecurityConfigSchema>;

// --- Phase 52 Task 3：长程工作流有界局部恢复配置 ---

/**
 * 有界局部恢复配置（Phase 52 Task 3）
 * 来自 BCER Agent 论文：失败时不全局重跑，回退到最近 checkpoint 只重跑失败步骤
 *
 * - enabled：是否启用有界局部恢复（默认 false，由接入层控制）
 * - maxBacktrack：最大回溯步数（含失败步骤本身，1-10，默认 3）
 * - artifactBinding：是否启用工件绑定（注册 StepArtifact 以追踪依赖）
 * - validateConsistency：恢复后是否验证工件一致性（陷阱 #173）
 *
 * 注：即使 enabled=false，BoundedRecoveryManager 仍可被实例化（测试场景），
 *     接入层根据此开关决定是否调用 computeRecoveryScope
 */
export const BoundedRecoveryConfigSchema = z.object({
  /** 是否启用有界局部恢复 */
  enabled: z.boolean().default(false),
  /** 最大回溯步数（含失败步骤本身，1-10，默认 3） */
  maxBacktrack: z.number().int().min(1).max(10).default(3),
  /** 是否启用工件绑定（注册 StepArtifact 以追踪依赖） */
  artifactBinding: z.boolean().default(true),
  /** 恢复后是否验证工件一致性（陷阱 #173） */
  validateConsistency: z.boolean().default(true),
});
export type BoundedRecoveryConfig = z.infer<typeof BoundedRecoveryConfigSchema>;

/**
 * Phase 52 集成配置（聚合所有 Phase 52 Task 的配置）
 * 各子配置已由 Phase 52 Task 实现为完整 schema，默认 enabled=false（保守启用）
 */
export const Phase52IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** Task 1：Skill 生命周期管理 */
  skillLifecycle: z.preprocess((v) => v ?? {}, SkillLifecycleConfigSchema),
  /** Task 2：过程评估 */
  processEvaluation: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    sensitivity: z.enum(['low', 'medium', 'high']).default('medium'),
    showProcessGrade: z.boolean().default(true),
    controlPreservationThreshold: z.number().min(0).max(1).default(0.7),
  })),
  /** Task 3：有界恢复 */
  boundedRecovery: z.preprocess((v) => v ?? {}, BoundedRecoveryConfigSchema),
  /** Task 4：组合式路由 */
  compositionalRouting: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(true),
    maxDecompositionIterations: z.number().int().min(1).max(5).default(2),
    semanticRetrieval: z.boolean().default(true),
    maxParallelSkills: z.number().int().min(1).max(4).default(2),
  })),
  /** Task 5：自演化 */
  selfEvolution: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(true),
    // Phase 53 收尾修复：targets/trigger 需要 preprocess 包裹，否则 AppConfigSchema.parse({}) 失败
    targets: z.preprocess((v) => v ?? {}, z.object({
      prompt: z.boolean().default(true),
      memory: z.boolean().default(true),
      tools: z.boolean().default(false),
      workflow: z.boolean().default(true),
      communication: z.boolean().default(false),
    })),
    trigger: z.preprocess((v) => v ?? {}, z.object({
      failureThreshold: z.number().int().min(2).max(20).default(5),
      qualityDropThreshold: z.number().min(0).max(1).default(0.3),
      evaluationInterval: z.number().int().min(5).max(100).default(20),
    })),
  })),
  /** Task 6：架构感知指标 */
  archAwareMetrics: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    anomalySensitivity: z.enum(['low', 'medium', 'high']).default('medium'),
    showInQualityCommand: z.boolean().default(true),
  })),
  /** Task 7：饱和度监测（Phase 52 Task 7 完整 schema） */
  saturationMonitor: z.preprocess((v) => v ?? {}, SaturationMonitorConfigSchema),
  /** Task 8：Gödel 提议器 */
  godelProposer: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(true),
    maxProposalsPerRun: z.number().int().min(1).max(20).default(5),
    autoApplyLowRisk: z.boolean().default(false),
    requireUserApproval: z.boolean().default(true),
    // 新字段（Phase 52 蓝图对齐）
    /** 提议运行间隔（收集多少次信号后产出一轮提议，10-200，默认 50） */
    proposalInterval: z.number().int().min(10).max(200).default(50),
    /** 是否允许高风险提案（默认 false——高风险提案默认不产出） */
    allowHighRiskProposals: z.boolean().default(false),
    /** 提案保留天数（1-90，默认 14，超期清理） */
    proposalRetentionDays: z.number().int().min(1).max(90).default(14),
  })),
  /** Task 9：自安全套件 */
  selfHarness: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(true),
    weaknessDetectionSensitivity: z.enum(['low', 'medium', 'high']).default('medium'),
    maxProposalsPerCycle: z.number().int().min(1).max(20).default(5),
    requireRegressionTest: z.boolean().default(true),
    autoApplyLowRiskProposals: z.boolean().default(false),
    // 新字段（Phase 52 蓝图对齐）
    /** 弱点挖掘样本量（10-500，默认 50——历史失败日志采样数） */
    miningSampleSize: z.number().int().min(10).max(500).default(50),
    /** 模式频率阈值（2-20，默认 3——出现次数达到此值才视为模式） */
    patternFrequencyThreshold: z.number().int().min(2).max(20).default(3),
    /** 是否自动应用已通过验证的提案（默认 false——仍需用户确认） */
    autoApplyValidated: z.boolean().default(false),
    /** 回归测试存放目录（相对路径，默认 '.routedev/regression-tests/'） */
    regressionTestPath: z.string().default('.routedev/regression-tests/'),
  })),
  /** Task 10：MCP 安全形式化框架（4 层深度防御 + 7 类威胁检测） */
  mcpSecurity: z.preprocess((v) => v ?? {}, MCPSecurityConfigSchema),
}));
export type Phase52IntegrationConfig = z.infer<typeof Phase52IntegrationConfigSchema>;

// --- Phase 53：代码卫生与安全治理加固 ---

/**
 * Phase 53 Task 3：策略引擎配置（动作级 fail-closed）
 * 借鉴 microsoft/agent-governance-toolkit 的 PolicyEngine
 * enabled=false 时退回原行为（向后兼容）
 */
export const PolicyEngineConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用策略引擎（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 默认策略：无匹配规则时 deny（fail-closed）或 allow */
  defaultPolicy: z.enum(['deny', 'allow']).default('deny'),
  /** 冲突解决策略（当前仅实现 deny-overrides，其他枚举值供未来扩展） */
  conflictResolution: z.enum([
    'deny-overrides',
    'allow-overrides',
    'priority-first-match',
    'most-specific-wins',
  ]).default('deny-overrides'),
  /** 策略规则文件路径（YAML，预留字段，当前策略通过 addPolicy API 注入） */
  rulesFile: z.string().default('.routedev/policies.yaml'),
}));
export type PolicyEngineConfig = z.infer<typeof PolicyEngineConfigSchema>;

/**
 * Phase 53 Task 4：哈希链审计配置
 * enabled=true 时 AuditLogger 写入 SHA-256 链式哈希
 */
export const AuditChainConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用哈希链（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 审计日志文件路径（可选，默认沿用 AuditLogger 的 storageDir） */
  logFile: z.string().default('.routedev/audit-chain.jsonl'),
  /** 溢出时保留的接缝哈希数 */
  overflowSealCount: z.number().int().min(1).default(1),
}));
export type AuditChainConfigType = z.infer<typeof AuditChainConfigSchema>;

/**
 * Phase 53 Task 5：MCP 安全扫描配置
 * 在 MCP 工具注册到 ToolRegistry 之前扫描 4 类威胁
 */
export const McpSecurityScanConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 MCP 安全扫描（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 阻断阈值：severity >= 此级别的发现阻止注册 */
  blockThreshold: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  /** 已知工具名列表（用于仿冒检测） */
  knownToolNames: z.array(z.string()).default([]),
}));
export type McpSecurityScanConfig = z.infer<typeof McpSecurityScanConfigSchema>;

/**
 * Phase 53 Task 6：技能安全门控配置
 * 第三方技能安装前通过 17 类漏洞扫描
 */
export const SkillSecurityGateConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用技能安全扫描（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 自动安装的分数阈值（>此值需用户确认） */
  autoInstallThreshold: z.number().int().min(0).max(100).default(50),
  /** 基线抑制文件（Glob + SHA-256 指纹，预留字段） */
  baselineFile: z.string().default('.routedev/skill-baseline.json'),
}));
export type SkillSecurityGateConfig = z.infer<typeof SkillSecurityGateConfigSchema>;

/**
 * Phase 53 Task 7：配置保护守卫配置
 * 阻止 Agent 弱化自身的安全约束
 */
export const ConfigGuardConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用配置保护（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 首次触发时是否降级为 info（避免首次误报阻塞） */
  warnOnFirst: z.boolean().default(true),
  /** 受保护文件 pattern（用户可扩展，追加到默认 pattern） */
  protectedPatterns: z.array(z.string()).default([]),
}));
export type ConfigGuardConfig = z.infer<typeof ConfigGuardConfigSchema>;

/**
 * Phase 53 Task 8：前缀感知缓存配置
 * 借鉴 LMCache 的内容可寻址分块缓存
 */
export const PrefixCacheConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用前缀感知缓存（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 分块大小（Token 数，64-1024） */
  blockSize: z.number().int().min(64).max(1024).default(256),
  /** L1 内存缓存最大块数 */
  l1MaxSize: z.number().int().min(100).default(1000),
  /** 是否对齐 Anthropic prompt caching API（预留字段） */
  alignAnthropicApi: z.boolean().default(true),
}));
export type PrefixCacheConfig = z.infer<typeof PrefixCacheConfigSchema>;

/**
 * Phase 53 Task 9：上下文预算监控配置
 * Token 耗尽、成本超支、范围蔓延、工具循环时注入告警
 */
export const BudgetMonitorConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用预算监控（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** Token 预警比例（0.1-1，达到此值触发 warn 级告警） */
  tokenWarnRatio: z.number().min(0.1).max(1).default(0.75),
  /** 会话成本上限（美元） */
  costLimitPerSession: z.number().positive().default(10),
  /** 工具循环阈值（连续相同工具调用次数） */
  toolLoopThreshold: z.number().int().min(3).default(5),
}));
export type BudgetMonitorConfig = z.infer<typeof BudgetMonitorConfigSchema>;

/**
 * Phase 53 Task 10：DAG 工作流引擎配置
 * 拓扑排序 + 并行执行 + 变量替换
 */
export const DagEngineConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 DAG 工作流（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 最大并行度（1-10） */
  maxParallel: z.number().int().min(1).max(10).default(3),
  /** 重试上限（0-5） */
  retryLimit: z.number().int().min(0).max(5).default(2),
  /** 人类升级阈值：连续失败 N 次后请求人类介入 */
  humanEscalationThreshold: z.number().int().min(1).default(3),
}));
export type DagEngineConfig = z.infer<typeof DagEngineConfigSchema>;

/**
 * Phase 53 Task 11：熔断器配置
 * 三态机：closed / open / half_open
 */
export const CircuitBreakerConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用熔断器（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 连续失败 N 次后熔断 */
  failureThreshold: z.number().int().min(1).default(5),
  /** 熔断后多久尝试恢复（毫秒） */
  resetTimeout: z.number().int().min(1000).default(60000),
  /** HALF-OPEN 状态最多试探次数 */
  halfOpenMaxAttempts: z.number().int().min(1).default(1),
}));
export type CircuitBreakerConfigType = z.infer<typeof CircuitBreakerConfigSchema>;

/**
 * Phase 53 Task 12：Doctor 健康检查配置
 */
export const DoctorConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 探测超时（毫秒） */
  probeTimeout: z.number().int().min(1000).default(10000),
  /** 是否在启动时自动运行 doctor */
  runOnStartup: z.boolean().default(false),
}));
export type DoctorConfig = z.infer<typeof DoctorConfigSchema>;

/**
 * Phase 53 聚合配置：把 10 个子 schema 合并到一个对象
 * 便于在 app-init.ts 中统一读取
 */
export const Phase53IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** Task 3：策略引擎接入 */
  policyEngine: PolicyEngineConfigSchema,
  /** Task 4：哈希链审计 */
  auditChain: AuditChainConfigSchema,
  /** Task 5：MCP 安全扫描 */
  mcpSecurityScan: McpSecurityScanConfigSchema,
  /** Task 6：技能安全门控 */
  skillSecurityGate: SkillSecurityGateConfigSchema,
  /** Task 7：配置保护守卫 */
  configGuard: ConfigGuardConfigSchema,
  /** Task 8：前缀感知缓存 */
  prefixCache: PrefixCacheConfigSchema,
  /** Task 9：预算监控 */
  budgetMonitor: BudgetMonitorConfigSchema,
  /** Task 10：DAG 引擎 */
  dagEngine: DagEngineConfigSchema,
  /** Task 11：熔断器 */
  circuitBreaker: CircuitBreakerConfigSchema,
  /** Task 12：Doctor */
  doctor: DoctorConfigSchema,
}));
export type Phase53IntegrationConfig = z.infer<typeof Phase53IntegrationConfigSchema>;

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
  adversarial: z.preprocess((v) => v ?? {}, AdversarialConfigSchema),    // 对抗性验证（Phase 21 Task 4）
  ui: z.preprocess((v) => v ?? {}, UIConfigSchema),                       // UI/UX 设置（Phase 25）
  optimization: z.preprocess((v) => v ?? {}, OptimizationConfigSchema),   // 优化配置（Phase 30）
  scheduler: z.preprocess((v) => v ?? {}, SchedulerConfigSchema),         // 调度器配置（Phase 37 Task 2）
  agent: z.preprocess((v) => v ?? {}, AgentConfigSchema),                 // Agent 配置（Phase 38 Task 2）
  execution: z.preprocess((v) => v ?? {}, ExecutionConfigSchema),          // 执行配置（并发/熔断/检查点提示）
  middleware: z.preprocess((v) => v ?? {}, MiddlewareConfigSchema),        // 中间件配置（Phase 38 Task 1）
  knowledgeGraph: z.preprocess((v) => v ?? {}, KnowledgeGraphConfigSchema), // 知识图谱配置（Phase 38 Task 4）
  webSearch: z.preprocess((v) => v ?? {}, WebSearchConfigSchema),          // 网络搜索配置
  // 权限规则（Permission Profile，glob 级权限规则，替代扁平 security 配置）
  permissionProfile: z.preprocess((v) => v ?? {}, PermissionProfileSchema),
  // Phase 39：代码地图配置（双轨制：内置轻量 + CodeGraph MCP 外接）
  codegraph: CodeGraphConfigSchema,
  // Phase 39：实验分支配置（Git Worktree 隔离 + 选择性合并）
  experiments: ExperimentsConfigSchema,
  // Phase 39：Hooks 配置（模板库 + AI 自动生成）
  hooks: HooksConfigSchema,
  // Phase 40：渐进式信任配置（7 级信任梯度 + 临时授权 + 偏好持久化）
  trust: TrustConfigSchema,
  // Phase 40：质量监测配置（隐式反馈检测 + 信号保留 + 知识图谱自动改进）
  quality: QualityConfigSchema,
  // Phase 40：用户经验配置（三级经验等级 + 行为差异化 + System Prompt 注入）
  expertise: ExpertiseConfigSchema,
  // Phase 41：代码地图配置（升级版自研引擎：tree-sitter + SQLite + PageRank）
  // 注：与 codegraph 并存——codegraph 控制 CodeGraph MCP 外接，codeMap 控制自研引擎
  codeMap: CodeMapConfigSchema,
  // Phase 42：市场配置（Skill/Hook 发布、导入、导出）
  market: MarketConfigSchema,
  // Phase 42：策略引擎配置（Intent Guard + Playbook + Tool Guide + Tool Approval）
  policies: PoliciesConfigSchema,
  // Phase 42：推理模式（fast / balanced / accurate）
  reasoningMode: ReasoningModeSchema,
  // Phase 43：子 Agent 配置（并行上限 + 角色门控）
  subAgents: SubAgentsConfigSchema,
  // Phase 43：Goal 配置（澄清 + 确认 + 审计模式 + token 预算）
  goal: GoalConfigSchema,
  // Phase 55 Task 9：CCR 可逆压缩
  ccrCompression: CCRCompressionConfigSchema,
  // Phase 43：Hook 增强（函数级 Hook + 沙箱 + 试用期 + 分组）
  hookEnhancement: HookEnhancementConfigSchema,
  // Phase 44：对话消息树持久化（JSONL + 备份 + 快照 + 撤销栈）
  conversation: ConversationConfigSchema,
  // Phase 44：并行实验（多分支并行 + 冲突检测 + 自动清理）
  experiment: ExperimentConfigSchema,
  // Phase 45：人格配置（PersonaEngine 启用/强度/当前人格 ID）
  persona: PersonaConfigSchema,
  // Phase 45：语音配置（STT/TTS 提供商/语言/自动朗读）
  voice: VoiceConfigSchema,
  // Phase 45：记忆配置（推理/自动学习/注入阈值）
  memory: MemoryConfigSchema,
  // Phase 45：发现配置（功能发现/启动提示）
  discovery: DiscoveryConfigSchema,
  // Phase 47 Task 8：项目文档配置（AGENTS.md / CLAUDE.md 多文件名 fallback）
  projectDoc: ProjectDocConfigSchema,
  // Phase 48 Task 1：引用系统配置（CiteManager + CiteResolver）
  cite: z.preprocess((v) => v ?? {}, CiteConfigSchema),
  // Phase 48 Task 5：Macro 配置（轻量工作流宏，通过 `!` 触发器引用）
  macros: z.preprocess((v) => v ?? {}, MacrosConfigSchema),
  // Phase 48 Task 2/3：外部生态导入配置（Anthropic Skills / Claude Plugin / Codex）
  import: ImportConfigSchema,
  // Phase 50 Task 1：Goal 流程模块接入开关（默认全部 false）
  goalIntegration: GoalIntegrationConfigSchema,
  // Phase 50 Task 2：多 Agent 编排模块接入开关（默认全部 false）
  orchestrationIntegration: OrchestrationIntegrationConfigSchema,
  // Phase 50 Task 3：子 Agent 委托体系模块接入开关（默认全部 false）
  delegationIntegration: DelegationIntegrationConfigSchema,
  // Phase 50 Task 5：Phase 48 模块接入确认开关（默认全部 true）
  phase48Integration: Phase48IntegrationConfigSchema,
  // Phase 50 Task 6：Phase 49 模块接入确认开关（默认全部 false，实验性）
  phase49Integration: Phase49IntegrationConfigSchema,
  // Phase 52 Task 3：有界局部恢复配置（默认 enabled=false，由接入层控制）
  // 注：Task 1 后续可将其重构进 phase52Integration 聚合结构
  boundedRecovery: z.preprocess((v) => v ?? {}, BoundedRecoveryConfigSchema),
  // Phase 52：MUSE-Autoskill 集成（聚合所有 Phase 52 Task 的配置）
  phase52Integration: z.preprocess((v) => v ?? {}, Phase52IntegrationConfigSchema),
  // Phase 51 配置
  reviewerPolicy: z.preprocess((v) => v ?? {}, ReviewerPolicySchema),
  delegationPolicy: z.preprocess((v) => v ?? {}, DelegationPolicySchema),
  activityPanel: z.preprocess((v) => v ?? {}, ActivityPanelSchema),
  instanceHarness: z.preprocess((v) => v ?? {}, InstanceHarnessSchema),
  configLayering: z.preprocess((v) => v ?? {}, ConfigLayeringSchema),
  errorDisplay: z.preprocess((v) => v ?? {}, ErrorDisplaySchema),
  resultSchema: z.preprocess((v) => v ?? {}, ResultSchemaConfigSchema),
  modelDisplay: z.preprocess((v) => v ?? {}, ModelDisplaySchema),
  // Phase 53：代码卫生与安全治理加固（聚合 10 个子配置）
  phase53Integration: z.preprocess((v) => v ?? {}, Phase53IntegrationConfigSchema),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

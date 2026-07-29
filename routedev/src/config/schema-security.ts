// src/config/schema-security.ts
// 安全相关配置：沙箱、权限、信任、策略引擎、审计、MCP 安全、技能门控、配置守卫、导入安全
// 从 schema.ts 拆分而来（TD-11），保持 Schema 定义完全等价

import { z } from 'zod';

// 敏感文件保护策略：只读 vs 禁止访问
export const SensitiveFilePolicySchema = z.enum(['readonly', 'deny']);
export type SensitiveFilePolicy = z.infer<typeof SensitiveFilePolicySchema>;

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
  // 默认 false — SecurityChecker 未实现目录边界检查
  directoryBoundary: z.boolean().default(false),                      // 目录边界限制
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
  devModeAuth: z.boolean().default(true),
  /** Phase 47 Task 4：沙箱级 — 决定工具能做多少（默认 workspace-write） */
  sandbox: SandboxLevelSchema.default('workspace-write'),
  /** Phase 47 Task 4：审批级覆盖 — 按工具类别覆盖默认审批级（可选，部分覆盖） */
  approval: z.record(z.string(), ApprovalLevelSchema).optional(),
  /** 依赖完整性校验开关：启用后对 Skill/Plugin/Anthropic Skills 计算 SHA-256 并在加载时校验 */
  integrityCheck: z.boolean().default(true),
  /** 严格模式：true 时校验失败抛错阻断；false 时只 warn（fail-open） */
  integrityStrict: z.boolean().default(false),
  /** IntegrityManifest 持久化路径（相对工作目录） */
  integrityManifestPath: z.string().default('.routedev/integrity-manifest.json'),
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

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

// --- 渐进式信任配置（Phase 40） ---

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

// --- 策略引擎配置（Phase 42） ---

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

// --- Phase 53：代码卫生与安全治理加固 ---

/**
 * Phase 53 Task 3：策略引擎配置（动作级 fail-closed）
 * 借鉴 microsoft/agent-governance-toolkit 的 PolicyEngine
 *
 * Phase 59 Task 2：默认 true——Intent Guard + Playbook 是安全核心
 */
export const PolicyEngineConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用策略引擎（Phase 59 默认 true） */
  enabled: z.boolean().default(true),
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
 *
 * Phase 59 Task 2：默认 true——审计链路是合规核心
 */
export const AuditChainConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用哈希链（Phase 59 默认 true） */
  enabled: z.boolean().default(true),
  /** 审计日志文件路径（可选，默认沿用 AuditLogger 的 storageDir） */
  logFile: z.string().default('.routedev/audit-chain.jsonl'),
  /** 溢出时保留的接缝哈希数 */
  overflowSealCount: z.number().int().min(1).default(1),
}));
export type AuditChainConfigType = z.infer<typeof AuditChainConfigSchema>;

/**
 * Phase 53 Task 5：MCP 安全扫描配置
 * 在 MCP 工具注册到 ToolRegistry 之前扫描 4 类威胁
 *
 * Phase 59 Task 2：默认 true——默认关等于不扫描
 */
export const McpSecurityScanConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 MCP 安全扫描（Phase 59 默认 true） */
  enabled: z.boolean().default(true),
  /** 阻断阈值：severity >= 此级别的发现阻止注册 */
  blockThreshold: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  /** 已知工具名列表（用于仿冒检测） */
  knownToolNames: z.array(z.string()).default([]),
}));
export type McpSecurityScanConfig = z.infer<typeof McpSecurityScanConfigSchema>;

/**
 * Phase 53 Task 6：技能安全门控配置
 * 第三方技能安装前通过 17 类漏洞扫描
 *
 * Phase 59 Task 2：默认 true——默认关等于不校验
 */
export const SkillSecurityGateConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用技能安全扫描（Phase 59 默认 true） */
  enabled: z.boolean().default(true),
  /** 自动安装的分数阈值（>此值需用户确认） */
  autoInstallThreshold: z.number().int().min(0).max(100).default(50),
  /** 基线抑制文件（Glob + SHA-256 指纹，预留字段） */
  baselineFile: z.string().default('.routedev/skill-baseline.json'),
}));
export type SkillSecurityGateConfig = z.infer<typeof SkillSecurityGateConfigSchema>;

/**
 * Phase 53 Task 7：配置保护守卫配置
 * 阻止 Agent 弱化自身的安全约束
 *
 * Phase 59 Task 2：默认 true——默认关等于不守护
 */
export const ConfigGuardConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用配置保护（Phase 59 默认 true） */
  enabled: z.boolean().default(true),
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

// src/config/schema-agent.ts
// Agent 行为配置：自主度、执行、委托、子 Agent、Goal、工作流、调度、恢复、
//   实验、工具、Hook、人格、视觉、语音、Cite、Macro、市场、Reviewer、Plan 等
// 从 schema.ts 拆分而来（TD-11），保持 Schema 定义完全等价

import { z } from 'zod';

// --- 自主度配置 ---

// Agent 自主度（auto 全自动 / semi 关键步骤确认 / manual 逐步确认）
export const AutonomyModeSchema = z.enum(['auto', 'semi', 'manual']);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

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
 * 把 auto/semi/manual 三档映射到具体行为开关，供 Goal Runner 在 handleGoalCommand 中统一判定
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

// --- Token 可观测性配置（Phase 30） ---

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
  /** 审查使用的模型：'auto' 用路由器选择，或指定具体模型 id — 预留字段，当前未消费 */
  reviewModel: z.string().default('auto'),
  /** 审查严格度 — 预留字段，当前未消费 */
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
 * 控制需求澄清模块的行为：模糊度阈值、最大问题数、是否自动跳过
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
  /** 简洁思考约束（实验性，默认关闭） */
  conciseThinking: z.object({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
  /**
   * Phase 72 Task B2：内容路由压缩（按内容类型分派）
   * 启用后 ToolOutputPipeline 会在 Sanitizer 之后调用 ContentRouter：
   *   - JSON 走统计采样、代码走 AST/正则摘要、散文走 ksentence、<200 token 直通
   */
  contentRouting: z.object({
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

// --- 调度器配置（Phase 37 Task 2）---

/**
 * 调度器配置
 * 控制定时任务引擎的启用状态、容量上限与默认时区

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
  /** I10 修复：单个 Worker 执行超时（毫秒），超时后终止该 Worker，避免阻塞整个并行组 */
  workerTimeoutMs: z.number().int().min(1000).default(300000),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

// --- Phase 39：实验分支配置 ---

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

// --- Phase 42：市场配置 ---

/**
 * 市场配置（Phase 42）
 * 控制 Skill / Hook 的发布、导入、导出
 * Phase 43：新增 registryUrl / registryToken，支持远程 Registry 拉取
 * 状态：已定义未消费 — Phase 42 预留字段，运行时无市场服务器消费
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
 *
 * Phase 83: parallel scheduling frozen —— 并行调度与冲突检测已冻结
 *   - 并行调度路径（executePlanWithMultiAgent）在 Phase 58 已删除，当前仅 single/dag/compose
 *   - 冲突检测在 goal 路径中无调用点（ExperimentConfigSchema.conflictDetection 独立，不属于 goal）
 *   - 冻结策略：不新增 goal.parallel.enabled 配置字段，避免误以为可启用并行调度
 *   - 如需恢复并行调度，重新接线 PathRouter 并恢复 executePlanWithMultiAgent
 */
export const GoalConfigSchema = z.preprocess((v) => v ?? {}, z.object({
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
   * 字段与 ExecutionRouterOptions 接口保持一致（单一数据源，Phase 58 起定义在 path-router.ts）
   * Phase 58：mode 移除 'legacy'（legacy 路径已删除），旧配置 'legacy' 通过 preprocess 自动迁移为 'auto'
   */
  executionRouter: z.preprocess((v) => {
    // Phase 58 向后兼容：mode='legacy' → 'auto'；explicitRoute='legacy' → 删除（回退到 undefined）
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      if (obj.mode === 'legacy') obj.mode = 'auto';
      if (obj.explicitRoute === 'legacy') delete obj.explicitRoute;
    }
    return v;
  }, z.object({
    /** 判定模式：auto（自动判定）/ explicit（显式指定）/ single（强制单 Agent，goalAdvanced 未启用时使用） */
    mode: z.enum(['auto', 'explicit', 'single']).default('auto'),
    /** mode=explicit 时生效，指定具体路径 */
    explicitRoute: z.enum(['single', 'dag', 'compose']).optional(),
    /** 单 Agent 路径的最大步数（1-5，默认 2） */
    singleAgentMaxSteps: z.number().int().min(1).max(5).default(2),
    /** DAG 路径的最大领域数（超过则升级到 compose，1-5，默认 1） */
    dagMaxDomains: z.number().int().min(1).max(5).default(1),
  }).default({ mode: 'auto', singleAgentMaxSteps: 2, dagMaxDomains: 1 })),
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

// --- Phase 44：并行实验配置 ---

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

// --- Phase 45：人格 / 语音 / 发现 配置 ---

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
  /** Phase 57：替代硬编码 persona-templates，用户可自定义 system prompt 片段 */
  systemPromptAppend: z.string().default(''),
}));
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

/**
 * 视觉配置（Phase 57）
 * 控制是否启用 VisionAssistant（截图分析），默认关闭
 */
export const VisionConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用视觉助手（默认 false，启用时才装配 VisionAssistant） */
  enabled: z.boolean().default(false),
}));
export type VisionConfig = z.infer<typeof VisionConfigSchema>;

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

// --- Phase 50：核心模块接入开关配置 ---

/**
 * Goal 流程接入配置（Phase 50 Task 1）
 * 控制 /goal 流程中核心模块的渐进式接入
 * - auditEnabled：GoalAuditor 三层独立审计
 * - persistenceEnabled：GoalPersistence 持久化与续跑
 *
 * Phase 59：promptBuilderEnabled/requirementChangeEnabled 已删除（批次1 无价值 Integration）
 * 旧配置中的这两个字段会被 Zod safe-parse 忽略（zod v4 默认忽略未知字段）
 */
export const GoalIntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  // Phase 54 修复：auditEnabled 默认 true——三层独立审计是交叉验证的核心保障
  auditEnabled: z.boolean().default(true),
  // Phase 47 P1-2 修复：persistenceEnabled 默认 true——GoalPersistence 装配完整但默认关闭导致永不生效，
  // 目标执行状态不落盘，崩溃后无法恢复。开启后写入 .routedev/goals/<id>.json，与 defaults.ts 对齐
  persistenceEnabled: z.boolean().default(true),
}));
export type GoalIntegrationConfig = z.infer<typeof GoalIntegrationConfigSchema>;

/**
 * 多 Agent 编排接入配置（Phase 50 Task 2）
 * 控制 orchestrator.ts 中核心模块的渐进式接入，默认全部关闭
 * - strategyEnabled：StrategySelector 按复杂度选择策略
 * - stateGraphEnabled：ExecutionStateGraph 步骤状态管理
 * - conflictDetectionEnabled：ConflictDetector 冲突检测接入生产调度（Phase 83 Task 2 冻结，默认 false）
 */
export const OrchestrationIntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  strategyEnabled: z.boolean().default(false),
  stateGraphEnabled: z.boolean().default(false),
  conflictDetectionEnabled: z.boolean().default(false),
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
 * 聚合 DualLoop/QualityGate 等模块
 * 默认全部 false——这些模块为实验性功能，需显式开启
 *
 * Phase 59：routingFunnelEnabled 已删除（批次1，routing-funnel.ts Phase 50 已删，僵尸配置）
 * Phase 59：skillFlowEnabled/contextUsagePanelEnabled/evaluationFrameworkEnabled 已删除（对应模块已删，开关无效）
 */
export const Phase49IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 双循环编排器接入（/goal 执行时可选调用） */
  dualLoopEnabled: z.boolean().default(true),
  /**
   * Skill 质量门接入（Skill 生成时可选调用）
   * @deprecated Phase 49 Task 3.5 已删除 qualityGate.check，此配置无运行时消费方
   */
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
  detachedSessionEnabled: z.boolean().default(true),
  subAgentMaxContextTokens: z.number().int().min(1000).max(200000).default(32000),
}));
export type DelegationPolicyConfig = z.infer<typeof DelegationPolicySchema>;

/** 项目级配置分层（Phase 51 Task 8）
 *  状态：已定义未消费 — Phase 51 Task 8 预留字段，运行时未实现分层合并逻辑
 */
export const ConfigLayeringSchema = z.preprocess((v) => v ?? {}, z.object({
  // 旧字段(保留向后兼容)
  // 默认 true：启用项目级配置覆盖全局配置（Phase 60 接线后保持原有合并行为）
  enabled: z.boolean().default(true),
  projectConfigPath: z.string().default('.routedev/config.json'),
  globalConfigPath: z.string().default(''),
  mergeStrategy: z.enum(['deep', 'shallow']).default('deep'),
  // 新字段(Phase 51 蓝图对齐)
  projectConfigEnabled: z.boolean().default(false),
  globalConfigDir: z.string().default(''),
  arrayMergeStrategy: z.enum(['replace', 'merge']).default('replace'),
}));
export type ConfigLayeringConfig = z.infer<typeof ConfigLayeringSchema>;

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

// Phase 59：SaturationMonitorConfigSchema 已删除（批次1，孤儿 schema——字段已从 Phase52Integration 删除，原 evaluation 文件已删除，schema 仅保留历史标注）
// Phase 59：MCPSecurityConfigSchema 已删除（批次3，与 phase53 McpSecurityScanConfigSchema 重复）
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
  enabled: z.boolean().default(true),
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
 *
 * Phase 59：processEvaluation/archAwareMetrics/saturationMonitor 已删除（批次1 无价值学术指标）
 * 旧配置中的这三个字段会被 Zod safe-parse 忽略
 * 注：architecture-aware-metrics.ts 源文件已删除（Phase 59 死链清理）
 */
export const Phase52IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** Task 1：Skill 生命周期管理 */
  skillLifecycle: z.preprocess((v) => v ?? {}, SkillLifecycleConfigSchema),
  /** Task 3：有界恢复 */
  boundedRecovery: z.preprocess((v) => v ?? {}, BoundedRecoveryConfigSchema),
  /** Task 4：组合式路由 */
  compositionalRouting: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(true),
    maxDecompositionIterations: z.number().int().min(1).max(5).default(2),
    semanticRetrieval: z.boolean().default(true),
    maxParallelSkills: z.number().int().min(1).max(4).default(2),
  })),
  // Phase 59 Task 4：mcpSecurity 字段已删除（与 phase53Integration.mcpSecurityScan 重复）
}));
export type Phase52IntegrationConfig = z.infer<typeof Phase52IntegrationConfigSchema>;

// --- 工具层配置（Phase 73：file-edit 增强，对齐 Aider 编辑体验） ---

/**
 * file_edit 工具配置
 * - requireConfirmation：启用编辑确认流程（diff 预览 + 用户确认后再写入）
 *   默认 false，向后兼容。启用后仍需 ToolExecutionContext.requestConfirmation 存在才会触发确认
 *   （无回调时直接应用，避免 headless 场景下卡住）
 */
export const FileEditConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 编辑前是否要求用户确认（diff 预览 + 确认） */
  requireConfirmation: z.boolean().default(false),
}));
export type FileEditConfig = z.infer<typeof FileEditConfigSchema>;

/**
 * 工具注册档位（Phase 81 Task 1）
 * - core: ≤10 个核心工具，默认值——编程场景基础能力
 * - full: 兼容旧行为（全部工具），仅调试用
 */
export type ToolProfile = 'core' | 'full';
export const ToolProfileSchema = z.enum(['core', 'full']).default('core');

/**
 * 工具层配置聚合
 * 当前包含 profile（注册档位）和 fileEdit；后续可扩展更多工具的细粒度配置
 */
export const ToolsConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 工具注册档位（默认 core，仅注册核心工具；full 恢复全部工具） */
  profile: ToolProfileSchema,
  /** file_edit 工具配置 */
  fileEdit: FileEditConfigSchema,
}));
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

// --- Phase 71：Plan diff + 遗漏点分析配置 ---
// 原 AppConfigSchema 中的内联 schema，抽出到此文件并命名
// 控制计划修订前后 diff 视图、LLM 遗漏点检查与修订历史持久化
export const PlanConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 遗漏点检查使用的模型 id（默认 'fast'——廉价快速模型） */
  omissionCheckModel: z.string().default('fast'),
  /** Plan 修订历史持久化目录（相对于工作目录，默认 '.routedev/plan-revisions/'） */
  revisionHistoryPath: z.string().default('.routedev/plan-revisions/'),
}));

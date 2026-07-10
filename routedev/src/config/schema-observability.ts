// src/config/schema-observability.ts
// 可观测性与展示配置：UI、通用设置、声音、更新、后台行为、OTel exporter、
//   错误/模型/活动面板显示、质量监测、用户经验、Phase68 溯源、Phase70 上下文压缩监控
// 从 schema.ts 拆分而来（TD-11），保持 Schema 定义完全等价

import { z } from 'zod';

// --- 基础枚举（UI/通用） ---

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

// --- Phase 40：质量监测 / 用户经验 ---

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

// --- Phase 51：Agent 活动面板 / 错误显示 / 模型显示 ---

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

/** 错误显示配置（Phase 51 Task 9）
 *  状态：已定义未消费 — Phase 51 Task 9 预留字段，运行时错误展示未读取此配置
 */
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

/** 模型显示配置（Phase 51 Task 11）
 *  状态：已定义未消费 — Phase 51 Task 11 预留字段，运行时模型展示未读取此配置
 */
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

// --- 可观测性外部接入配置（OpenTelemetry exporter） ---

/**
 * 可观测性外部接入配置
 * 启用后把 Agent 执行 span 通过 OTLP HTTP/JSON 导出到外部 collector（如 Jaeger / Tempo）
 *
 * - enabled：是否启用 OTel exporter（默认 false，向后兼容）
 * - serviceName：服务名（默认 'routedev'，由 OtelExporter 兜底）
 * - endpoint：OTLP HTTP/JSON endpoint，默认 http://localhost:4318/v1/traces
 * - headers：自定义 headers（如认证 token）
 * - exportIntervalMs：批量导出间隔（ms，默认 5000）
 */
export const ObservabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  serviceName: z.string().optional(),
  endpoint: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  exportIntervalMs: z.number().optional(),
}).optional();
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

// --- Phase 68：检索/搜索/发现三分与知识图谱（v4.6.7） ---
// 原 AppConfigSchema 中的内联 schema，抽出到此文件并命名
export const Phase68IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  operationClassification: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    logRegimeTransition: z.boolean().default(true),
  })),
  provenanceGraph: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    persistPath: z.string().default('.routedev/provenance.jsonl'),
    maxArtifacts: z.number().int().min(100).default(10000),
  })),
  kanObstacleChecker: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    blockOnObstacle: z.boolean().default(false),
  })),
  quantitativeGate: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    mdlWeight: z.number().min(0).max(1).default(0.4),
    aicWeight: z.number().min(0).max(1).default(0.6),
    acceptThreshold: z.number().min(0).max(1).default(0.7),
    rejectThreshold: z.number().min(0).max(1).default(0.3),
    complexityPenalty: z.number().min(0).default(0.01),
  })),
}));
export type Phase68IntegrationConfig = z.infer<typeof Phase68IntegrationConfigSchema>;

// --- Phase 70：上下文压缩技术深度优化（v4.7.1） ---
// 原 AppConfigSchema 中的内联 schema，抽出到此文件并命名
export const Phase70IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  toolOutputBudget: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    maxCharsPerOutput: z.number().int().min(500).default(2000),
    previewHeadChars: z.number().int().min(100).default(500),
    previewTailChars: z.number().int().min(100).default(500),
    offloadDir: z.string().default('.routedev/offloaded'),
  })),
  microCompact: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    cleanBeforeRounds: z.number().int().min(1).default(5),
    keepRecentRounds: z.number().int().min(1).default(3),
  })),
  contextCollapse: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    minToolCallsForChain: z.number().int().min(2).default(3),
  })),
  autoCompactGuardian: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(true),
    contextWindow: z.number().int().min(10000).default(200000),
    reservedTokensForSummary: z.number().int().min(1000).default(20000),
    autoCompactBuffer: z.number().int().min(1000).default(13000),
    warningBuffer: z.number().int().min(1000).default(20000),
    errorBuffer: z.number().int().min(1000).default(20000),
    maxConsecutiveFailures: z.number().int().min(1).default(3),
  })),
  compactPrompt: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    defaultDirection: z.enum(['base', 'partial', 'up_to']).default('base'),
  })),
  sessionMemory: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    maxMemories: z.number().int().min(10).default(100),
  })),
}));
export type Phase70IntegrationConfig = z.infer<typeof Phase70IntegrationConfigSchema>;

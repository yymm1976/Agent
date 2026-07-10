// src/config/schema-memory.ts
// 记忆子系统配置：Checkpoint、项目记忆、知识图谱、CCR 压缩、对话树、记忆推理、
//   代码地图、上下文外部化、记忆系统
// 从 schema.ts 拆分而来（TD-11），保持 Schema 定义完全等价

import { z } from 'zod';

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

// --- 知识图谱配置（Phase 38 Task 4） ---

/**
 * 知识图谱配置
 * 控制持久化、自动遗忘和多策略召回的默认行为
 * 状态：已定义未消费 — Phase 38 Task 4 预留字段，运行时无消费方
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

// --- Phase 55 Task 9：CCR 可逆压缩配置 ---
/**
 * CCR 可逆压缩配置
 * 让 compact 从破坏性变可逆——compact 前缓存原始消息，LLM 可通过 ccr_retrieve 工具取回
 */
export const CCRCompressionConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 CCR 可逆压缩 */
  enabled: z.boolean().default(false),
  /** LRU cache 最大条目数 */
  maxCacheSize: z.number().int().min(1).max(500).default(50),
}));
export type CCRCompressionConfig = z.infer<typeof CCRCompressionConfigSchema>;

// --- Phase 44：消息节点持久化配置 ---

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
  /** 撤销栈大小（0 表示禁用撤销） */
  undoStackSize: z.number().int().min(0).default(50),
}));
export type ConversationConfig = z.infer<typeof ConversationConfigSchema>;

// --- 记忆配置（Phase 45） ---

/**
 * 记忆配置（Phase 45）
 * 控制记忆推理、自动学习与注入阈值
 * 新增跨会话持久化记忆与 codebase-memory 开关
 * 注：新增字段用 .optional() 避免破坏 defaults.ts 等历史调用方，默认值在 app-init.ts 中通过 ?? 提供
 */
export const MemoryConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用记忆推理 */
  inference: z.boolean().default(true),
  /** 是否启用自动学习 */
  autoLearn: z.boolean().default(true),
  /** 注入阈值（0-1，达到此相关度才注入记忆） */
  injectThreshold: z.number().min(0).max(1).default(0.7),
  /** SessionMemoryStore 是否启用跨会话持久化（默认 true，由 app-init.ts 在读取时 ?? true 兜底） */
  sessionMemoryPersistent: z.boolean().optional(),
  /** SessionMemoryStore 持久化文件路径（相对工作目录，默认 .routedev/session-memory.jsonl） */
  sessionMemoryPath: z.string().optional(),
}));
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

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

// --- Phase 39：代码地图配置（双轨制：内置轻量 + CodeGraph MCP 外接） ---

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

// --- Phase 41：代码地图配置（升级版自研引擎） ---

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
  /** Phase 71 Task A5：watch mode（监听文件变更触发增量索引，默认关闭避免无谓 IO） */
  watchMode: z.boolean().default(false),
}));
export type CodeMapConfig = z.infer<typeof CodeMapConfigSchema>;

// --- Phase 63：上下文状态外部化（Harness-1 论文落地） ---
// 原 AppConfigSchema 中的内联 schema，抽出到此文件并命名
export const StateExternalizationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(true),
  kSentenceCompression: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    k: z.number().int().min(1).max(10).default(4),
    keywordWeight: z.number().min(0).max(1).default(0.5),
    lengthWeight: z.number().min(0).max(1).default(0.3),
    positionWeight: z.number().min(0).max(1).default(0.2),
  })),
  contentDedup: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    hashAlgorithm: z.enum(['sha256', 'md5']).default('sha256'),
    minLength: z.number().int().min(0).default(50),
    replaceWithReference: z.boolean().default(true),
  })),
  budgetAwareRendering: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    contextWindow: z.number().int().default(200000),
    softNotifyThreshold: z.number().min(0).max(1).default(0.5),
    triggerThreshold: z.number().min(0).max(1).default(0.8),
    forceThreshold: z.number().min(0).max(1).default(0.9),
    renderEveryTurn: z.boolean().default(true),
  })),
}));
export type StateExternalizationConfig = z.infer<typeof StateExternalizationConfigSchema>;

// --- Phase 65：记忆系统重构（v4.6.4） ---
// 原 AppConfigSchema 中的内联 schema，抽出到此文件并命名
export const MemorySystemConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(true),
  store: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    dbPath: z.string().default('.routedev/memory.db'),
    backend: z.enum(['sqlite', 'file']).default('sqlite'),
    embeddingProvider: z.enum(['bi-encoder', 'hash', 'none']).default('hash'),
  })),
  hybridRetriever: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    bm25Weight: z.number().min(0).max(1).default(0.4),
    embeddingWeight: z.number().min(0).max(1).default(0.6),
    timeDecayHalfLifeDays: z.number().int().min(1).default(30),
    topK: z.number().int().min(1).max(50).default(10),
  })),
  localMaintenance: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    triggerThreshold: z.number().int().min(50).default(500),
    reorganizeRatio: z.number().min(0.05).max(0.5).default(0.2),
    minAccessCount: z.number().int().min(0).default(2),
  })),
}));
export type MemorySystemConfig = z.infer<typeof MemorySystemConfigSchema>;

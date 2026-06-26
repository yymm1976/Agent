// src/config/defaults.ts
// 默认配置值
// 当配置文件缺少某些字段时，Zod schema 内部的 default() 会自动填充
// 此文件保留为"显式可读"的默认值备份，方便在代码中引用（如「恢复出厂设置」功能）

import type { AppConfig } from './schema.js';

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  general: {
    language: 'zh-CN',
    theme: 'dark',
    startupBehavior: 'restore',
    setupSkipped: false,
    appearanceTheme: 'black',
    fontSize: 14,
    accentColor: '',
    backgroundBehavior: {
      backgroundBehavior: 'ask',
      activeTaskOnClose: 'prompt',
    },
  },
  providers: [],
  router: {
    rules: [
      { tier: 'simple', modelId: 'deepseek-v4-flash' },
      { tier: 'medium', modelId: 'minimax-m3' },
      { tier: 'complex', modelId: 'qwen3.7-plus' },
      { tier: 'reasoning', modelId: 'kimi-k2.7', fallbackModelId: 'deepseek-v4-pro' },
    ],
    budget: {
      mode: 'track_only',
      dailyLimit: 500000,
      degradationThreshold: 0.8,
    },
    classifierModel: 'deepseek-v4-flash',
    userPreference: 'balanced',
    fallbackChain: [],
  },
  checkpoint: {
    enabled: true,
    triggers: [
      { level: 20, action: 'initial' },
      { level: 45, action: 'incremental' },
      { level: 70, action: 'compress' },
    ],
    modelId: 'deepseek-v4-flash',
    maxTokensPerCheckpoint: 500,
  },
  goalVerifier: {
    enabled: true,
    modelId: 'kimi-k2.7',
    maxTokensPerVerification: 1000,
    autoVerify: true,
    iterative: {
      enabled: false,
      maxRounds: 3,
    },
  },
  security: {
    directoryBoundary: true,
    commandBlacklist: ['rm -rf', 'format', 'del /s'],
    commandWhitelist: [],
    toolBlacklist: [],
    toolWhitelist: [],
    sensitiveFiles: ['.env', 'credentials.json', '*.key'],
    sensitiveFilePolicy: 'readonly',
    networkConfirm: false,
    ssrfProtection: true,
    strictBashMode: false,
    httpsOnly: true,
    rateLimitMaxSize: 10000,
    devModeAuth: false,
    // Phase 47 Task 4：沙箱级默认 workspace-write
    sandbox: 'workspace-write',
    // approval 为可选字段，不配置时使用引擎内置的 DEFAULT_APPROVAL
  },
  channels: {
    entries: [],
    port: 9800,
    maxResponseLength: 2000,
    requestTimeout: 60000,
  },
  autonomy: {
    defaultMode: 'semi',
    // 自动批准只读安全工具，避免频繁打断用户
    // 写入/执行类工具（file_write、file_edit、shell_exec、git_op、spawn_agent）仍需确认
    autoApprovePatterns: [
      'file_read',
      'file_search',
      'code_search',
      'list_directory',
      'repo_map',
      'web_search',
      'web_fetch',
      'notes',
      'todo_write',
    ],
    confirmTimeout: 30000,
  },
  sounds: {
    enabled: true,
    completion: 'default',
    error: 'warning',
    approval: 'notification',
  },
  updates: {
    checkOnStartup: true,
    autoUpdate: false,
  },
  mcp: {
    servers: [],
    autoConnect: true,
    autoReconnect: true,
    connectTimeout: 30000,
    // Phase 48 Task 4：默认会话生命周期策略（Claude Code .mcp.json 未声明时使用 per-session）
    lifecyclePolicy: 'per-session',
  },
  prompts: {
    projectOverrides: true,
    cacheTtlSeconds: 0,
  },
  projectMemory: {
    enabled: true,
    maxMemorySize: 10000,
    maxDecisions: 100,
    autoInject: true,
  },
  adversarial: {
    enabled: false,
    threshold: 0.5,
    modelTier: 'fast',
  },
  ui: {
    outputStyle: 'standard',
    bell: true,
    idleHintSeconds: 30,
    hotReloadNotify: true,
  },
  optimization: {
    tokenTracking: {
      enabled: true,
      persistSession: true,
      outputDir: '.routedev/token-logs',
    },
    structuredState: { enabled: false },
    declarativeContext: { enabled: false },
    conciseThinking: { enabled: false },
    workflow: {
      unifiedPipeline: true,
      autoRequirements: true,
      reviewOnComplete: true,
      reviewMode: 'builtin',
      reviewModel: 'auto',
      reviewStrictness: 'medium',
    },
    safety: {
      readBeforeWrite: true,
      maxToolOutputChars: 16000,
      completionGate: true,
      gateTimeout: 180000,
      gateRetry: 1,
    },
    workerContext: {
      enabled: true,
      strategy: 'tail',
      maxMessages: 5,
      maxTokens: 4000,
      fallbackToFull: true,
    },
    clarification: {
      enabled: true,
      threshold: 0.4,
      maxQuestions: 3,
      skipIfConfident: true,
    },
  },
  scheduler: {
    enabled: true,
    maxTasks: 20,
    defaultTimezone: 'Asia/Shanghai',
  },
  agent: {
    maxConcurrentSubAgents: 5,
  },
  execution: {
    maxConcurrency: 3,
    circuitBreaker: true,
    circuitBreakerThreshold: 5,
    circuitBreakerDuration: 30000,
    checkpointNotify: true,
  },
  middleware: {
    loopDetection: {
      enabled: true,
      windowSize: 10,
      maxRepeats: 3,
    },
  },
  knowledgeGraph: {
    persistence: {
      enabled: true,
      path: '.routedev/memory/knowledge-graph.json',
    },
    autoForget: {
      unusedDays: 60,
      staleDays: 90,
    },
    recall: {
      defaultStrategy: 'auto',
      maxResults: 10,
    },
  },
  webSearch: {
    // C7 修复：所有环境变量引用提供默认值，未设置时使用空字符串而非崩溃
    glmApiKey: process.env.GLM_WEB_SEARCH_API_KEY ?? process.env.ZAI_API_KEY ?? '',
    metasoApiKey: process.env.METASO_API_KEY ?? '',
    baiduApiKey: process.env.BAIDU_API_KEY ?? process.env.QIANFAN_API_KEY ?? '',
    tavilyApiKey: process.env.TAVILY_API_KEY ?? '',
    bingApiKey: process.env.BING_SEARCH_API_KEY ?? '',
    perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? '',
    exaApiKey: process.env.EXA_API_KEY ?? '',
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY ?? '',
    searxngEndpoint: process.env.SEARXNG_ENDPOINT ?? '',
  },
  // 权限规则（Permission Profile）：默认拒绝敏感文件访问
  // 借鉴 Open Interpreter 的 Permission Profile，用 glob 规则精细控制
  permissionProfile: {
    name: 'default',
    filesystem: [
      // 密钥与凭证文件：完全禁止访问
      { pattern: '**/*.env', access: 'deny' },
      { pattern: '**/*.pem', access: 'deny' },
      { pattern: '**/*.key', access: 'deny' },
      { pattern: '**/*.p12', access: 'deny' },
      { pattern: '**/*.pfx', access: 'deny' },
      // 凭证 JSON / YAML
      { pattern: '**/credentials.json', access: 'deny' },
      { pattern: '**/credentials.yaml', access: 'deny' },
      { pattern: '**/credentials.yml', access: 'deny' },
      // SSH / 云平台密钥
      { pattern: '**/.ssh/*', access: 'deny' },
      { pattern: '**/.aws/credentials', access: 'deny' },
      { pattern: '**/.gcp/*', access: 'deny' },
      // 通用密钥目录
      { pattern: '**/secrets/**', access: 'deny' },
      { pattern: '**/.secret', access: 'deny' },
    ],
    network: {
      // 默认不限制域名（allow 为空表示全部允许）
      allow: [],
      // 黑名单：禁止访问元数据端点等内部服务
      deny: [],
    },
  },
  // Phase 39：代码地图配置（双轨制：内置轻量引擎默认启用，CodeGraph 增强默认关闭）
  codegraph: {
    enabled: false,
    workspace: '.',
    autoIndex: true,
  },
  // Phase 39：实验分支配置（Git Worktree 隔离 + 选择性合并）
  experiments: {
    maxActiveWorktrees: 5,
    autoCleanup: true,
  },
  // Phase 39：Hooks 配置（模板库 + AI 自动生成）
  hooks: {
    enabled: true,
    configPath: '.routedev/hooks.json',
  },
  // Phase 40：渐进式信任配置（7 级信任梯度 + 临时授权 + 偏好持久化）
  trust: {
    baseLevel: 'default',
    enableTemporaryGrants: true,
    grantTTLMinutes: 30,
    enablePersistentPreferences: false,
    maxPersistentGrants: 200,
  },
  // Phase 40：质量监测配置（隐式反馈检测 + 信号保留 + 知识图谱自动改进）
  quality: {
    enableImplicitFeedback: true,
    negativeSignalThreshold: 0.4,
    signalRetentionDays: 30,
    autoImproveKnowledgeGraph: true,
    debounceMs: 3000,
  },
  // Phase 40：用户经验配置（三级经验等级 + 行为差异化 + System Prompt 注入）
  expertise: {
    level: 'intermediate',
    enableAutoSuggestion: true,
    outputStyleOverride: null,
  },
  // Phase 41：代码地图配置（升级版自研引擎：tree-sitter + SQLite + PageRank）
  codeMap: {
    engine: 'tree-sitter',
    budgetTokens: 2048,
    enableHCGS: false,
    enableSemanticEdges: false,
    indexExclude: ['node_modules', '.git', 'dist', 'release-v*'],
    maxContextSymbols: 50,
    autoIndex: true,
  },
  // Phase 42：市场配置（Skill/Hook 发布、导入、导出）
  market: {
    enabled: true,
    autoPublish: false,
  },
  // Phase 42：策略引擎配置（Intent Guard + Playbook + Tool Guide + Tool Approval）
  policies: {
    enabled: true,
    intentGuard: true,
    playbook: true,
    toolGuide: true,
    toolApproval: false,
    approvalMode: 'risky-only',
  },
  // Phase 42：推理模式（fast / balanced / accurate）
  reasoningMode: 'balanced',
  // Phase 43：子 Agent 配置（并行上限 + 角色门控）
  subAgents: {
    enabled: true,
    maxParallel: 3,
    defaultRole: 'executor',
    gateRules: {
      researcherMaxParallel: 3,
      executorMaxParallel: 2,
      reviewerMaxParallel: 2,
    },
  },
  // Phase 43：Goal 配置（澄清 + 确认 + 审计模式 + token 预算）
  goal: {
    clarify: true,
    requireConfirmation: true,
    auditMode: 'completion_gate_first',
    tokenBudget: 50000,
    softStopRatio: 0.9,
  },
  // Phase 43：Hook 增强（函数级 Hook + 沙箱 + 试用期 + 分组）
  hookEnhancement: {
    functionHooks: false,
    sandbox: true,
    trialDays: 7,
    hookGroups: true,
  },
  // Phase 44：对话消息树持久化（JSONL + 备份 + 快照 + 撤销栈）
  conversation: {
    persistTree: true,
    maxNodes: 5000,
    maxBranches: 100,
    autoSnapshot: true,
    undoStackSize: 50,
  },
  // Phase 44：并行实验（多分支并行 + 冲突检测 + 自动清理）
  experiment: {
    parallelEnabled: false,
    maxParallel: 3,
    conflictDetection: true,
    autoCleanupDays: 7,
  },
  // Phase 45：人格配置（PersonaEngine 启用/强度/当前人格 ID）
  persona: {
    enabled: true,
    intensity: 'medium',
    currentId: 'collaborator',
  },
  // Phase 45：语音配置（STT/TTS 提供商/语言/自动朗读）
  voice: {
    inputProvider: 'off',
    outputProvider: 'off',
    language: 'zh-CN',
    autoPlay: false,
  },
  // Phase 45：记忆配置（推理/自动学习/注入阈值）
  memory: {
    inference: true,
    autoLearn: true,
    injectThreshold: 0.7,
  },
  // Phase 45：发现配置（功能发现/启动提示）
  discovery: {
    enabled: true,
    showOnStartup: false,
  },
  // Phase 47 Task 8：项目文档配置（AGENTS.md / CLAUDE.md 多文件名 fallback）
  // 默认加载顺序：AGENTS.override.md 存在时跳过 AGENTS.md；
  //               否则 AGENTS.md + AGENTS.local.md 合并；
  //               以上都不存在时 fallback 到 CLAUDE.md + CLAUDE.local.md
  projectDoc: {
    filenames: ['AGENTS.md', 'AGENTS.local.md', 'AGENTS.override.md'],
    fallbackFilenames: ['CLAUDE.md', 'CLAUDE.local.md'],
    maxBytes: 32768, // 32KiB，对齐 Codex 上限
  },
  // Phase 48 Task 5：Macro 配置（轻量工作流宏，通过 `!` 触发器引用）
  macros: {
    enabled: true,
    dir: '.routedev/macros',
  },
  // Phase 48 Task 1：引用系统配置（CiteManager + CiteResolver）
  // 默认开启引用系统，最多 10 个标签，text 引用上限 2000 字符（陷阱 #127）
  cite: {
    enabled: true,
    maxTags: 10,
    maxTextCiteLength: 2000,
    maxPreflightTokens: 8000,
    autoRunPreflight: true,
  },
  // Phase 48 Task 2/3：外部生态导入配置
  // 默认全部「不自动启用」——社区来源需用户确认（陷阱 #129）
  // Codex Instructions 默认走项目记忆模式，避免 system prompt 过长
  import: {
    anthropicSkillsAutoEnable: false,
    claudePluginAutoEnable: false,
    codexInstructions: 'project_memory',
    codexMemoryTag: 'codex-instruction',
  },
};

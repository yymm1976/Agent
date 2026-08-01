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
      // Phase 54 修复：默认改为 true——验证失败时自动生成补救步骤并重新执行
      // 是交叉验证真正生效的保障：单次验证可能漏判，迭代闭环让失败步骤被重新处理
      enabled: true,
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
    // I3 修复：默认 true（要求认证），仅显式 false 时开发模式放行
    devModeAuth: true,
    // Phase 47 Task 4：沙箱级默认 workspace-write
    sandbox: 'workspace-write',
    // 依赖完整性校验：默认开启，fail-open（strict=false 时仅 warn）
    integrityCheck: true,
    integrityStrict: false,
    integrityManifestPath: '.routedev/integrity-manifest.json',
    // approval 为可选字段，不配置时使用引擎内置的 DEFAULT_APPROVAL
  },
  autonomy: {
    defaultMode: 'semi',
    // 自动批准只读安全工具，避免频繁打断用户
    // 写入/执行/网络类工具（file_write、file_edit、shell_exec、git_op、spawn_agent、web_search、web_fetch、todo_write）仍需确认
    autoApprovePatterns: [
      'file_read',
      'file_search',
      'code_search',
      'list_directory',
      'repo_map',
      'notes',
    ],
    confirmTimeout: 30000,
  },
  // TD-13 已清理：sounds 默认值已删除（全库零消费，2026-07-29）
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
  remote: {
    enabled: false,
    host: '127.0.0.1',
    port: 43117,
    pairingTtlMs: 300000,
    allowRemoteApprovals: false,
    allowAutonomyChange: false,
    deviceStorePath: '.routedev/remote/devices.json',
    transport: 'lan',
    lanBaseUrl: '',
    tailscaleBaseUrl: '',
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
    // TD-13 已清理：components 子字段已删除（全库零消费，2026-07-29）
  },
  optimization: {
    tokenTracking: {
      enabled: true,
      persistSession: true,
      outputDir: '.routedev/token-logs',
    },
    // 工具输出裁剪：>2000 字符时保留 800 首 + 800 尾，显著降低 token 占用
    conciseThinking: { enabled: true },
    // ContentRouter：JSON/代码/散文分派压缩（fail-open，失败降级后续裁剪）
      contentRouting: { enabled: true },
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
      // 硬上限从 16000 调到 8000，避免单条工具结果独占过多上下文
      maxToolOutputChars: 8000,
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
  agent: {
    maxConcurrentSubAgents: 5,
  },
  execution: {
    maxConcurrency: 3,
    circuitBreaker: true,
    circuitBreakerThreshold: 5,
    circuitBreakerDuration: 30000,
    workerTimeoutMs: 300000,
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
    // F-011：freeze 层 TrustGradient 配置清理——baseLevel 置 'default'（最保守），临时授权关闭
    baseLevel: 'default',
    enableTemporaryGrants: false,
    grantTTLMinutes: 30,
    enablePersistentPreferences: false,
    maxPersistentGrants: 200,
  },
  // Phase 40：质量监测配置（隐式反馈检测 + 信号保留 + 知识图谱自动改进）
  // Phase 81 Task 3：enableImplicitFeedback 默认 false（freeze 层 F-02，packs.trustGradient 可恢复）
  quality: {
    enableImplicitFeedback: false,
    negativeSignalThreshold: 0.4,
    signalRetentionDays: 30,
    autoImproveKnowledgeGraph: false,
    debounceMs: 3000,
  },
  // Phase 40：用户经验配置（三级经验等级 + 行为差异化 + System Prompt 注入）
  expertise: {
    level: 'intermediate',
    enableAutoSuggestion: false,
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
    // Phase 71 Task A5：watch mode 默认关闭，启用时监听文件变更触发增量索引
    watchMode: false,
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
  // TD-13 已清理：reasoningMode 默认值已删除（未接入后端，2026-07-29）
  // Phase 43：子 Agent 配置（并行上限 + 角色门控）
  subAgents: {
    enabled: false,
    maxParallel: 3,
    defaultRole: 'executor',
    gateRules: {
      researcherMaxParallel: 3,
      executorMaxParallel: 2,
      reviewerMaxParallel: 2,
    },
  },
  // Phase 43：Goal 配置（确认 + 审计模式 + token 预算）
  goal: {
    requireConfirmation: true,
    auditMode: 'completion_gate_first',
    tokenBudget: 50000,
    softStopRatio: 0.9,
    // Phase 55 Task 4：执行路径路由器默认值（explicitRoute 为 optional，不设置）
    executionRouter: {
      mode: 'single',
      singleAgentMaxSteps: 2,
      dagMaxDomains: 1,
    },
    difficultyRouting: {
      enabled: false,
      refineLevelAtExecution: true,
      dynamicLevelSwitchEnabled: false,
      confidenceThreshold: 0.6,
    },
  },
  // Phase 55 Task 9：CCR 可逆压缩
  ccrCompression: {
    enabled: false,
    maxCacheSize: 50,
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
    // Phase 57：替代硬编码 persona-templates，用户可自定义 system prompt 片段
    systemPromptAppend: '',
  },
  // Phase 57：vision 默认关闭，启用时才装配 VisionAssistant
  vision: {
    enabled: false,
  },
  // Phase 57：voice-manager 移到 optional/voice/，编程 CLI 非核心能力，默认 off
  // 桌面应用未来若启用语音，需在设置页显式开启
  voice: {
    inputProvider: 'off',
    outputProvider: 'off',
    language: 'zh-CN',
    autoPlay: false,
  },
  // Phase 45：记忆配置（推理/自动学习/注入阈值）
  // Phase 71：新增持久化配置
  memory: {
    inference: true,
    autoLearn: true,
    injectThreshold: 0.7,
    sessionMemoryPersistent: true,
    sessionMemoryPath: '.routedev/session-memory.jsonl',
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
  // Phase 50 Task 1：Goal 流程模块接入开关
  // Phase 54 修复：auditEnabled 默认改为 true——三层独立审计（completion_gate + verifier_llm + reviewer_agent）
  // 是用户质疑"不确定是不是真的交叉验证"的根因，默认关闭导致交叉验证形同虚设
  // Phase 47 P1-2 修复：persistenceEnabled 默认改为 true——原值 false 导致 GoalPersistence 模块
  // 装配完整但 executeGoalPlan 中 if 判定永远不进入，目标执行状态不落盘，崩溃后无法恢复
  goalIntegration: {
    auditEnabled: true,
    persistenceEnabled: true,
    // Phase 59：promptBuilderEnabled/requirementChangeEnabled 已删除（批次1 无价值 Integration）
  },
  // Phase 50 Task 2：多 Agent 编排模块接入开关（默认全部 false）
  // Phase 55 RISK 1 修复：原值 true 与 schema(default:false) 和注释矛盾，统一改为 false
  // 用户需在设置页显式开启（保守启用，配合 legacy fallback）
  // Phase 83 Task 2：conflictDetectionEnabled 冻结 conflict detector，默认 false 不接入生产调度
  orchestrationIntegration: {
    strategyEnabled: false,
    stateGraphEnabled: false,
    conflictDetectionEnabled: false,
  },
  // Phase 50 Task 3：子 Agent 委托体系模块接入开关（默认全部 false）
  delegationIntegration: {
    contextPackerEnabled: false,
    delegationGateEnabled: false,
    delegationEnforcerEnabled: false,
    lifecycleEnabled: false,
    scoreCardEnabled: false,
  },
  // Phase 50 Task 5：Phase 48 模块接入确认开关（默认全部 true）
  phase48Integration: {
    citeEnabled: true,
    importEnabled: true,
    macrosEnabled: true,
    mcpBridgeEnabled: true,
  },
  // Phase 50 Task 6：Phase 49 模块接入确认开关（默认全部 false，实验性）
  // Phase 59：routingFunnelEnabled 已删除（批次1，routing-funnel.ts Phase 50 已删，僵尸配置）
  // Phase 59：skillFlowEnabled/contextUsagePanelEnabled/evaluationFrameworkEnabled 已删除（对应模块已删，开关无效）
  phase49Integration: {
    dualLoopEnabled: false,
  },
  // Phase 51：外部开源借鉴落地配置（默认全部 false，保守启用）
  reviewerPolicy: {
    tieredReviewEnabled: false,
    tinyTaskStepThreshold: 5,
    bigTaskStepThreshold: 30,
    midWorkReviewRatio: 0.5,
    autoCrossModelForHighRisk: true,
    crossModelReviewerId: '',
    enforceEvidenceProtocol: false,
    highRiskThreshold: 40,
    failureEscalationThreshold: 2,
    contextTokenEscalationRatio: 0.8,
  },
  delegationPolicy: {
    boundedDelegationEnabled: true,
    maxDepth: 1,
    maxParallel: 4,
    delegationTargets: {},
    subprocessTools: {},
    depthPassingMode: 'counter',
    hardDelegationTypes: ['research', 'review'],
    refuseIfSpecialistUnavailable: false,
    specialistAvailabilityOverride: {},
    detachedSessionEnabled: true,
    subAgentMaxContextTokens: 32000,
  },
  activityPanel: {
    enabled: false,
    maxActiveDisplay: 4,
    maxRecentDisplay: 3,
    taskPreviewLength: 72,
    showToolCallStats: true,
    showThinkingLevel: true,
  },
  configLayering: {
    enabled: true,
    projectConfigPath: '.routedev/config.json',
    globalConfigPath: '',
    mergeStrategy: 'deep',
    projectConfigEnabled: false,
    globalConfigDir: '',
    arrayMergeStrategy: 'replace',
  },
  resultSchema: {
    enabled: false,
    strictValidation: false,
    fallbackToText: true,
    resultSchemaEnabled: false,
    enforceFinishProtocol: false,
    maxSubAgentSteps: 50,
  },
  // Phase 52：MUSE-Autoskill 集成（聚合所有 Phase 52 Task 配置，默认全部关闭）
  // Phase 59：processEvaluation/archAwareMetrics/saturationMonitor 已删除（批次1 无价值学术指标）
  phase52Integration: {
    // Task 1：Skill 生命周期管理
    skillLifecycle: {
      enabled: false,
      creationTriggerThreshold: 3,
      memoryRetentionDays: 30,
      autoApplyRefinement: false,
    },
    // Task 3：有界局部恢复
    boundedRecovery: { enabled: false, maxBacktrack: 3, artifactBinding: true, validateConsistency: true },
    // Task 4：组合技能路由
    compositionalRouting: {
      enabled: false,
      maxDecompositionIterations: 2,
      semanticRetrieval: true,
      maxParallelSkills: 2,
    },
    // Phase 59 Task 4：mcpSecurity 已删除（与 phase53Integration.mcpSecurityScan 重复，保留 53 的）
  },
  // Phase 53：代码卫生与安全治理加固
  // Phase 59 Task 2：安全相关 5 个字段默认启用（policyEngine/auditChain/mcpSecurityScan/skillSecurityGate/configGuard）
  // 依据：Phase 53 写了安全治理却默认关，等于没写。安全能力应默认启用。
  //       装配失败时 app-init.ts 中 try-catch fail-open 守卫保证不阻塞主流程
  phase53Integration: {
    // Task 3：策略引擎接入
    // Phase 59：默认 true——Intent Guard + Playbook 是安全核心
    // 修正：defaultPolicy 从 'deny' 改为 'allow'。
    //   原因：内置只注册了 git_op-guide / intent-guard（生产环境/force push/递归删除）
    //   等少量策略，绝大多数工具（file_read/list_directory/spawn_agent/...）都没有匹配规则。
    //   defaultPolicy='deny' 会让这些工具全部 fail-closed 被拒，导致 Agent 无法工作。
    //   改为 'allow' 后：未匹配规则的工具放行；已注册的 block 策略仍然生效（deny-overrides）。
    policyEngine: {
      enabled: true,
      defaultPolicy: 'allow',
      conflictResolution: 'deny-overrides',
      rulesFile: '.routedev/policies.yaml',
    },
    // Task 4：哈希链审计日志
    // Phase 59：默认 true——审计链路是合规核心，默认关导致操作无记录
    auditChain: {
      enabled: true,
      logFile: '.routedev/audit-chain.jsonl',
      overflowSealCount: 1,
    },
    // Task 5：MCP 安全扫描器
    // Phase 59：默认 true——MCP 工具安全扫描，默认关等于不扫描
    mcpSecurityScan: {
      enabled: true,
      blockThreshold: 'high',
      knownToolNames: [],
    },
    // Task 6：技能安全门控
    // Phase 59：默认 true——Skill 安全校验，默认关等于不校验
    skillSecurityGate: {
      enabled: true,
      autoInstallThreshold: 50,
      baselineFile: '.routedev/skill-baseline.json',
    },
    // Task 7：配置保护守卫
    // Phase 59：默认 true——配置守卫，默认关等于不守护
    configGuard: {
      enabled: true,
      warnOnFirst: true,
      protectedPatterns: [],
    },
    // Task 8：前缀感知上下文缓存
    prefixCache: {
      enabled: false,
      blockSize: 256,
      l1MaxSize: 1000,
      alignAnthropicApi: true,
    },
    // Task 9：上下文预算监控与告警
    budgetMonitor: {
      enabled: false,
      tokenWarnRatio: 0.75,
      costLimitPerSession: 10,
      toolLoopThreshold: 5,
    },
    // Task 10：DAG 工作流引擎
    dagEngine: {
      enabled: false,
      maxParallel: 3,
      retryLimit: 2,
      humanEscalationThreshold: 3,
    },
    // Task 11：熔断器模式
    circuitBreaker: {
      enabled: false,
      failureThreshold: 5,
      resetTimeout: 60000,
      halfOpenMaxAttempts: 1,
    },
    // Task 12：Doctor 健康检查
    doctor: {
      probeTimeout: 10000,
      runOnStartup: false,
    },
  },
  // Phase 61：ACRouter 闭环模型路由
  closedLoopRouting: {
    enabled: false,
    history: {
      maxRecords: 20000,
      persistPath: '.routedev/routing-history.jsonl',
    },
    memory: {
      enabled: true,
      topK: 10,
      minSimilarity: 0.3,
      embeddingProvider: 'hash',
    },
    orchestrator: {
      enabled: true,
      neighborWeight: 0.6,
      priorWeight: 0.3,
      baseWeight: 0.1,
    },
    verifier: {
      enabled: true,
      signals: ['compile', 'typecheck', 'latency'],
      timeoutMs: 30000,
    },
  },
  // Phase 62：动态工作流模式与隔离治理——已删除（ExecutionOrchestrator 死代码清理）
  stateExternalization: {
    enabled: false,
    kSentenceCompression: {
      enabled: false,
      k: 4,
      keywordWeight: 0.5,
      lengthWeight: 0.3,
      positionWeight: 0.2,
    },
    contentDedup: {
      enabled: false,
      hashAlgorithm: 'sha256' as const,
      minLength: 50,
      replaceWithReference: true,
    },
    budgetAwareRendering: {
      enabled: false,
      contextWindow: 200000,
      softNotifyThreshold: 0.5,
      triggerThreshold: 0.8,
      forceThreshold: 0.9,
      renderEveryTurn: true,
    },
  },
  // TD-26：Phase 65 记忆系统已退役（MemoryStore/HybridRetriever/LocalMaintenance）
  // 决策：保留 Core KnowledgeGraph，移除 HybridRetriever 接线
  // 接线已移除，此配置块仅为满足 AppConfig 类型（schema 保留向后兼容）
  memorySystem: {
    enabled: false,
    store: { enabled: false, dbPath: '.routedev/memory.db', backend: 'sqlite' as const, embeddingProvider: 'hash' as const },
    hybridRetriever: { enabled: false, bm25Weight: 0.4, embeddingWeight: 0.6, timeDecayHalfLifeDays: 30, topK: 10 },
    localMaintenance: { enabled: false, triggerThreshold: 500, reorganizeRatio: 0.2, minAccessCount: 2 },
  },
  // Phase 66：策略管道编号分段与治理——已删除（ExecutionOrchestrator 死代码清理）
  // Phase 67：推理质量诊断与SNR过滤——已删除（ExecutionOrchestrator 死代码清理）
  // Phase 68：检索/搜索/发现三分与知识图谱（v4.6.7）
  phase68Integration: {
    operationClassification: {
      enabled: false,
      logRegimeTransition: true,
    },
    provenanceGraph: {
      enabled: false,
      persistPath: '.routedev/provenance.jsonl',
      maxArtifacts: 10000,
    },
    kanObstacleChecker: {
      enabled: false,
      blockOnObstacle: false,
    },
    quantitativeGate: {
      enabled: false,
      mdlWeight: 0.4,
      aicWeight: 0.6,
      acceptThreshold: 0.7,
      rejectThreshold: 0.3,
      complexityPenalty: 0.01,
    },
  },
  // Phase 69：Worktree 隔离执行与多代理并行编排——已删除（ExecutionOrchestrator 死代码清理）
  // Phase 70：上下文压缩技术深度优化（v4.7.1）
  phase70Integration: {
    toolOutputBudget: {
      // 实时/压缩路径 offload：超长工具输出落盘 + preview，降低上下文体积
      enabled: true,
      maxCharsPerOutput: 2000,
      previewHeadChars: 500,
      previewTailChars: 500,
      offloadDir: '.routedev/offloaded',
    },
    microCompact: {
      // 装配 MessageGrouper，保护完整 user-assistant 对话轮
      enabled: true,
      cleanBeforeRounds: 5,
      keepRecentRounds: 3,
    },
    contextCollapse: {
      // 装配 ActionChainDetector，折叠重复工具调用链
      enabled: true,
      minToolCallsForChain: 3,
    },
    autoCompactGuardian: {
      // Phase 71 Task C2：启用（原 false）——Phase 70 已实现但默认关闭，造成配置僵尸
      enabled: true,
      // contextWindow 运行时会被当前模型窗口覆盖；此处仅作 fallback
      contextWindow: 200000,
      // 更早触发：接近上限前主动压，避免 552k/500k 才发现没压
      reservedTokensForSummary: 8000,
      autoCompactBuffer: 40000,
      warningBuffer: 60000,
      errorBuffer: 30000,
      maxConsecutiveFailures: 3,
    },
    compactPrompt: {
      enabled: false, // P2: 启用压缩提示词
      defaultDirection: 'base',
    },
    sessionMemory: {
      enabled: false, // P2: 待 Task B3/B4 接入
      maxMemories: 100,
    },
  },
  // Phase 71：Plan diff + 遗漏点分析
  plan: {
    omissionCheckModel: 'fast',
    revisionHistoryPath: '.routedev/plan-revisions/',
  },
  // Phase 81 Task 1：工具注册档位（默认 core，仅注册 ≤10 个核心工具；full 恢复全部工具）
  tools: {
    profile: 'core',
    fileEdit: {
      requireConfirmation: false,
    },
  },
  // Phase 81 Task 3+4：Pack 装配开关聚合
  // 默认全部 false——非 Core 模块退出默认装配（冷处理：保留源码，仅退出装配）
  // 用户在配置中显式 enabled:true 可恢复对应 Pack 的装配
  packs: {
    // Extended Pack
    goalAdvanced: { enabled: false },     // extended-pack
    // ReviewChain：开启 spawn_agent 工具装配，否则 subagentType=planner/coder/reviewer 无法调度
    multiAgent: { enabled: true },        // extended-pack（已启用）
    adversarial: { enabled: false },      // extended-pack
    skillLifecycle: { enabled: false },   // extended-pack
    // Standard Pack
    // Phase 96 M-1：删除 browserWeb / vfsPlan 死开关（全库零引用，工具注册由 tools.profile 控制）
    codeMap: { enabled: false },          // standard-pack
    ccrCompression: { enabled: false },   // standard-pack
    harness: { enabled: false },          // standard-pack
    integrity: { enabled: false },        // standard-pack
    compose: { enabled: false },          // standard-pack
    // Freeze
    trustGradient: { enabled: false },    // freeze
    kgAdvanced: { enabled: false },       // freeze
    // TD-25 解冻：ACRouter 从 freeze 提升为 standard-pack（默认装配，功能由 closedLoopRouting.enabled 控制）
    acRouter: { enabled: true },          // standard-pack（原 freeze，TD-25 解冻）
  },
  // Phase 97 Part F：自动化任务配置（默认空——用户显式添加任务后调度器才生效）
  automations: [],
  // Phase 97 Part I：轻量用户档案（默认空档案——渲染时安全降级为空字符串）
  userProfile: { mustRemember: [] },
};

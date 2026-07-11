// src/config/schema.ts
// 全局配置类型定义（Zod Schema）——聚合层
// 本文件是整个配置系统的"宪法"——所有模块从这里获取类型
// 任何新增字段必须先在此处定义，再被其它模块引用
//
// TD-11 拆分：子 Schema 按功能域拆分到 5 个文件，本文件仅保留聚合 + re-export
//   - schema-router.ts       模型路由 / LLM 提供商 / 预算 / 信道 / MCP / 闭环路由
//   - schema-agent.ts        Agent 行为 / 自主度 / 执行 / 委托 / Goal / 工作流 / 工具 / Hook / Plan
//   - schema-security.ts     安全 / 权限 / 沙箱 / 信任 / 策略引擎 / Phase53 安全治理
//   - schema-memory.ts       记忆 / CCR / 知识图谱 / 对话树 / 代码地图 / 上下文外部化
//   - schema-observability.ts UI / 通用设置 / OTel / 显示 / 质量监测 / Phase68 / Phase70

import { z } from 'zod';

// --- 聚合所需 Schema 引用 ---
import {
  ProviderConfigSchema,
  LLMProvidersConfigSchema,
  RouterConfigSchema,
  MCPConfigSchema,
  ReasoningModeSchema,
  ClosedLoopRoutingConfigSchema,
} from './schema-router.js';
import {
  SecurityConfigSchema,
  PermissionProfileSchema,
  WebSearchConfigSchema,
  TrustConfigSchema,
  PoliciesConfigSchema,
  ImportConfigSchema,
  Phase53IntegrationConfigSchema,
} from './schema-security.js';
import {
  CheckpointConfigSchema,
  PromptConfigSchema,
  ProjectMemoryConfigSchema,
  KnowledgeGraphConfigSchema,
  CCRCompressionConfigSchema,
  ConversationConfigSchema,
  MemoryConfigSchema,
  ProjectDocConfigSchema,
  CodeGraphConfigSchema,
  CodeMapConfigSchema,
  StateExternalizationConfigSchema,
  MemorySystemConfigSchema,
} from './schema-memory.js';
import {
  AutonomyConfigSchema,
  GoalVerifierConfigSchema,
  AdversarialConfigSchema,
  OptimizationConfigSchema,
  MiddlewareConfigSchema,
  AgentConfigSchema,
  ExecutionConfigSchema,
  ExperimentsConfigSchema,
  HooksConfigSchema,
  MarketConfigSchema,
  SubAgentsConfigSchema,
  GoalConfigSchema,
  HookEnhancementConfigSchema,
  ExperimentConfigSchema,
  PersonaConfigSchema,
  VisionConfigSchema,
  VoiceConfigSchema,
  DiscoveryConfigSchema,
  CiteConfigSchema,
  MacrosConfigSchema,
  GoalIntegrationConfigSchema,
  OrchestrationIntegrationConfigSchema,
  DelegationIntegrationConfigSchema,
  Phase48IntegrationConfigSchema,
  Phase49IntegrationConfigSchema,
  ReviewerPolicySchema,
  DelegationPolicySchema,
  ConfigLayeringSchema,
  ResultSchemaConfigSchema,
  Phase52IntegrationConfigSchema,
  ToolsConfigSchema,
  PlanConfigSchema,
} from './schema-agent.js';
import {
  SoundsConfigSchema,
  UIConfigSchema,
  UpdatesConfigSchema,
  GeneralConfigSchema,
  QualityConfigSchema,
  ExpertiseConfigSchema,
  ActivityPanelSchema,
  ErrorDisplaySchema,
  ModelDisplaySchema,
  ObservabilityConfigSchema,
  Phase68IntegrationConfigSchema,
  Phase70IntegrationConfigSchema,
  PacksConfigSchema,
} from './schema-observability.js';

// --- Re-export 所有子 Schema 及其类型，保持外部 import 路径不变 ---
export * from './schema-router.js';
export * from './schema-security.js';
export * from './schema-memory.js';
export * from './schema-agent.js';
export * from './schema-observability.js';

// --- Pack 分组配置（Phase 81 Task 3+4/5） ---
// PacksConfigSchema 和 PacksConfig 类型定义在 schema-observability.ts 中
// 此处仅保留注释说明分组归属（详见 schema-observability.ts 的 PacksConfigSchema）
// 分组归属：
//   browserWeb   → standard-pack（browser/web_search/web_fetch 装配层）
//   codeMap      → standard-pack（code-map / code_graph_query 装配层）
//   harness      → standard-pack（trace-replayer / scorecard）
//   integrity    → standard-pack（cite / import / macros / mcpBridge / IntegrityManifest）
//   compose      → standard-pack（compose-pipeline）
//   multiAgent   → extended-pack（orchestrator / spawn_agent / 多 Agent 体系）
//   adversarial  → extended-pack（cross-model-reviewer 对抗审查）
//   trustGradient→ freeze（TrustGradient + Implicit Feedback + ExpertisePrompt，Phase 40 freeze 组）
//   kgAdvanced   → freeze（KG 高级算法：社区检测等）

// --- 全局配置（完整 schema） ---
// 顶层 AppConfig：所有配置的根节点
// 注：Zod 4 严格化后，`.default({})` 不接受空对象字面量。
// 用 `z.preprocess((v) => v ?? {}, schema)` 实现"未指定则用 schema 内默认值"的语义。
export const AppConfigSchema = z.object({
  version: z.number().int().default(1),                                // 配置 schema 版本
  general: z.preprocess((v) => v ?? {}, GeneralConfigSchema),
  providers: z.array(ProviderConfigSchema).default([]),                // 所有 LLM 提供商
  // Gemini / DeepSeek / Qwen / Ollama 便捷配置（可选，留空时客户端回退到环境变量）
  llmProviders: LLMProvidersConfigSchema.optional(),
  router: z.preprocess((v) => v ?? {}, RouterConfigSchema),            // 路由层配置
  checkpoint: z.preprocess((v) => v ?? {}, CheckpointConfigSchema),    // 增量 Checkpoint
  goalVerifier: z.preprocess((v) => v ?? {}, GoalVerifierConfigSchema), // 目标验证
  security: z.preprocess((v) => v ?? {}, SecurityConfigSchema),        // 安全策略
  autonomy: z.preprocess((v) => v ?? {}, AutonomyConfigSchema),        // 自主度
  sounds: z.preprocess((v) => v ?? {}, SoundsConfigSchema),            // 提示音
  updates: z.preprocess((v) => v ?? {}, UpdatesConfigSchema),          // 更新策略
  mcp: z.preprocess((v) => v ?? {}, MCPConfigSchema),                  // MCP 客户端配置
  prompts: z.preprocess((v) => v ?? {}, PromptConfigSchema),            // Prompt 模板系统（Phase 16）
  projectMemory: z.preprocess((v) => v ?? {}, ProjectMemoryConfigSchema), // 项目记忆（Phase 16）
  adversarial: z.preprocess((v) => v ?? {}, AdversarialConfigSchema),    // 对抗性验证（Phase 21 Task 4）
  ui: z.preprocess((v) => v ?? {}, UIConfigSchema),                       // UI/UX 设置（Phase 25）
  optimization: z.preprocess((v) => v ?? {}, OptimizationConfigSchema),   // 优化配置（Phase 30）
  // Phase 37 Task 2：调度器配置（可选，未配置时使用默认值）
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
  // Phase 57：视觉配置（默认关闭，启用时才装配 VisionAssistant）
  vision: VisionConfigSchema,
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
  // Phase 50 Task 1：Goal 流程模块接入开关（默认全部 true——审计/持久化是核心保障，见 GoalIntegrationConfigSchema）
  goalIntegration: GoalIntegrationConfigSchema,
  // Phase 50 Task 2：多 Agent 编排模块接入开关（默认全部 false，实验性）
  orchestrationIntegration: OrchestrationIntegrationConfigSchema,
  // Phase 50 Task 3：子 Agent 委托体系模块接入开关（默认全部 true——delegate 全链路可观测，见 DelegationIntegrationConfigSchema）
  delegationIntegration: DelegationIntegrationConfigSchema,
  // Phase 50 Task 5：Phase 48 模块接入确认开关（默认全部 true）
  phase48Integration: Phase48IntegrationConfigSchema,
  // Phase 50 Task 6：Phase 49 模块接入确认开关（默认全部 false，实验性）
  phase49Integration: Phase49IntegrationConfigSchema,
  // Phase 52：MUSE-Autoskill 集成（聚合所有 Phase 52 Task 的配置）
  phase52Integration: z.preprocess((v) => v ?? {}, Phase52IntegrationConfigSchema),
  // Phase 51 配置
  reviewerPolicy: z.preprocess((v) => v ?? {}, ReviewerPolicySchema),
  delegationPolicy: z.preprocess((v) => v ?? {}, DelegationPolicySchema),
  activityPanel: z.preprocess((v) => v ?? {}, ActivityPanelSchema),
  configLayering: z.preprocess((v) => v ?? {}, ConfigLayeringSchema),
  errorDisplay: z.preprocess((v) => v ?? {}, ErrorDisplaySchema),
  resultSchema: z.preprocess((v) => v ?? {}, ResultSchemaConfigSchema),
  modelDisplay: z.preprocess((v) => v ?? {}, ModelDisplaySchema),
  // Phase 53：代码卫生与安全治理加固（聚合 10 个子配置）
  phase53Integration: z.preprocess((v) => v ?? {}, Phase53IntegrationConfigSchema),
  // Phase 61：ACRouter 闭环模型路由
  closedLoopRouting: z.preprocess((v) => v ?? {}, ClosedLoopRoutingConfigSchema),
  // Phase 62：动态工作流模式与隔离治理——已删除（ExecutionOrchestrator 死代码清理）
  // Phase 63：上下文状态外部化（Harness-1 论文落地）
  stateExternalization: z.preprocess((v) => v ?? {}, StateExternalizationConfigSchema),
  // Phase 65：记忆系统重构（v4.6.4）
  memorySystem: z.preprocess((v) => v ?? {}, MemorySystemConfigSchema),
  // Phase 66：策略管道编号分段与治理——已删除（ExecutionOrchestrator 死代码清理）
  // Phase 67：推理质量诊断与SNR过滤——已删除（ExecutionOrchestrator 死代码清理）
  // Phase 68：检索/搜索/发现三分与知识图谱（v4.6.7）
  phase68Integration: z.preprocess((v) => v ?? {}, Phase68IntegrationConfigSchema),
  // Phase 69：Worktree 隔离执行与多代理并行编排——已删除（ExecutionOrchestrator 死代码清理）
  // Phase 70：上下文压缩技术深度优化（v4.7.1）
  phase70Integration: z.preprocess((v) => v ?? {}, Phase70IntegrationConfigSchema),
  // Phase 71：Plan diff + 遗漏点分析配置
  // 控制计划修订前后 diff 视图、LLM 遗漏点检查与修订历史持久化
  plan: z.preprocess((v) => v ?? {}, PlanConfigSchema),
  // Phase 73：工具层配置（当前包含 fileEdit.requireConfirmation）
  // 由 app-init.ts 读取后通过 FileEditTool.setRequireConfirmation 注入
  // 注：标记为 optional 以避免破坏 defaults.ts 等历史调用方（未提供时由读取方用 ?. + ?? 兜底）
  tools: ToolsConfigSchema.optional(),
  // 可观测性外部接入：OTel exporter（OTLP HTTP/JSON）
  // 默认 optional——未配置时 app-init.ts 不创建 exporter，/trace otel 显示"未启用"
  observability: ObservabilityConfigSchema,
  // Phase 81 Task 3+4 + Task 5：能力 Pack 开关（四层分层：Core/Extended/Standard/Freeze）
  // preprocess 兜底：未配置时解析为空对象，各 pack 默认 false，非 Core 模块退出默认装配
  // UI 在设置页"能力分层"tab 展示；enabled:true 可恢复对应模块装配
  packs: z.preprocess((v) => v ?? {}, PacksConfigSchema),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Plan diff + 遗漏点分析配置（Phase 71） */
export type PlanConfig = AppConfig['plan'];

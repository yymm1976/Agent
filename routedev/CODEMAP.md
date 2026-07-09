# RouteDev — 代码库索引（CODEMAP）
> 搜索代码前先读本文件定位目标模块，再进入具体文件。
> 最后更新：2026-07-08（CODEMAP 失真修复：删除 src/evaluation/ 条目、补齐已删除文件标注、修正文件名漂移）

## 目录总览
- `src/runtime/` — 核心运行时（装配工厂 + 目标执行器 + 通知 + 插件初始化 + shutdown）
- `src/agent/` — Agent 引擎层（ReAct Loop + 目标分解 + 记忆 + 多 Agent + 工作模式 + 权限门控 + 需求澄清）
- `src/agents/` — Agent Profile 模板与子 Agent 生命周期管理
- `src/cite/` — 引用管理（manager + resolver + types）
- `src/code-map/` — 代码地图（多语言 extractor + PageRank 排序 + 增量索引 + 查询器）
- `src/config/` — 配置系统（YAML 加载 + Zod 校验 + 热重载）
- `src/harness/` — 可观测性层（Trace + Audit + Checkpoint + 实验管理）
- `src/hooks/` — 内置钩子注册（文件变更验证 + 会话生命周期日志）
- `src/import/` — 外部生态导入（Anthropic Skills / Claude Plugin / Codex）
- `src/macros/` — 宏命令系统
- `src/mcp/` — Claude Bridge MCP
- `src/memory/` — 项目记忆（.routedev/ 目录管理）
- `src/observability/` — 轨迹导出与聚合分析
- `src/plugins/` — 插件系统（types + registry + sdk + filesystem-discovery）
- `src/policies/` — 策略引擎（call-owner 协调 + checkpoint 流水线 + intent-guard + 工具审批）
- `src/prompts/` — Prompt 模板系统（三级优先级）
- `src/router/` — 模型路由层（分类 + 路由 + LLM 客户端 + Token 追踪）
- `src/security/` — 安全层（沙箱 + 完整性清单 + 审计面板）
- `src/skills/` — Skill 系统（生命周期 + 路由 + 校验 + 市场管理）
- `src/tools/` — 工具框架（注册表 + 执行器 + 权限引擎 + 内置工具 + MCP）
- `src/utils/` — 通用工具（日志 + 路径 + 重试 + Token 估算）
- `desktop/` — Electron 桌面应用（主进程 + preload + renderer + shared 类型）

## 模块详解

### src/runtime/ — 核心运行时
**职责：** App 依赖装配工厂 + /goal 执行器 + 通知分级 + 插件初始化 + shutdown 清理链 + 环境健康检查
**关键文件：**
- `app-init.ts` — App 依赖装配工厂：createAppDependencies 集中创建所有服务实例
- `goal-runner.ts` — /goal 执行器：handleGoalCommand + executeGoalPlan
- `notification.ts` — 通知分级
- `plugin-init.ts` — 插件系统初始化辅助 + registerPermissionMiddleware
- `graceful-shutdown.ts` — shutdown 清理链
- `doctor.ts` — 环境健康检查
- `components/goal-progress.ts` — /goal 进度文本渲染
- `components/progress-bar-text.ts` — 纯字符串进度条（从原 ProgressBar.tsx 抽出，去 Ink 依赖）
**依赖：** agent/、router/、tools/、config/、harness/、memory/、prompts/、plugins/、utils/

### src/agent/ — Agent 引擎层
**职责：** ReAct 循环、目标分解与验证、分支管理、记忆维护、多 Agent 协作、工作模式、权限门控
**关键文件：**
- `loop.ts` — ReAct Agent Loop 核心引擎，不做路由和分类；集成中间件管线（2026-07-07 统计 1957 行）
- `loop-config.ts` — Loop 的配置和事件类型（63 行）
- `types.ts` — Agent 层核心类型：状态、ReAct 步骤、记忆、目标（127 行）
- `middleware.ts` — Agent 中间件管线（五阶段：onAgent/onReasoning/onActing/onModelCall/onSystemPrompt）（58 行）
- `middleware/loop-detection.ts` — 循环检测中间件（检测重复工具调用并打破）（Phase 38）
- `branch.ts` — BranchManager：分支对话管理（260 行）
- `context-compaction.ts` — ContextCompactor：五阶段渐进压缩（L1-L4 零 LLM，L5 摘要）（221 行）
- `dream-consolidator.ts` — DreamConsolidator：整理记忆（合并去重）（331 行）（已删除：Phase 56 死代码清理）
- `goal-parser.ts` — /goal 命令的目标分解器，LLM 拆步骤（137 行）
- `goal-types.ts` — 目标分解与验证相关类型（74 行）
- `goal-verifier.ts` — 目标完成度验证器，独立 LLM 验证 + 对抗性验证（288 行）
- `goal-gates.ts` — GoalGateManager：验收门控冻结/持久化/修改（173 行）
- `handoff-contract.ts` — 结构化交接文件（HANDOFF.md 模式）（51 行）
- `init-analyzer.ts` — InitAnalyzer：分析项目结构，生成 .routedev-rules.md（283 行）（已删除：Phase 59 死代码清理）
- `prompts.ts` — 默认 System Prompt（38 行）（已删除：Phase 59 死代码清理）
- `token-profiler.ts` — TokenProfiler：分组件 token 快照（五分表：系统提示词/对话历史/工具定义/工具返回/用户消息）（Phase 30）
- `concise-thinking.ts` — 简洁思考约束：CONCISE_THINKING_BLOCK + trimToolResult + shouldSkipConcise（Phase 30 实验性）
- `vision.ts` — VisionAssistant：多模态视觉辅助（148 行）
- `work-modes.ts` — WorkModeController + GuardedToolExecutorAdapter（build/plan/compose 三模式）（180 行）
- `memory/checkpoint-writer.ts` — CheckpointWriter：独立记忆维护子 Agent（212 行）
- `memory/context-manager.ts` — 上下文管理器：token 监控 → checkpoint → 压缩（2026-07-07 统计 877 行）；Phase 38 增强：知识图谱跨会话持久化（.routedev/memory/knowledge-graph.json）
- `memory/graph.ts` — KnowledgeGraph：PPR + 双路径召回 + Label Propagation 社区检测 + 模式聚类 + 置信度评分（Phase 36 增强）（2026-07-07 统计 1160 行）；Phase 38 增强：improve() 反馈 + forget() 遗忘 + recallV2() 多策略检索
- `memory/types.ts` — 增量 Checkpoint + 上下文压缩类型（110 行）
- `memory/dream-to-graph.ts` — Dream → KnowledgeGraph 信息流：归纳三步（合并同类/冲突检测/时效淘汰）（Phase 36）（236 行）（已删除：Phase 56 死代码清理）
- `multi/blackboard.ts` — 公共黑板：Worker 间共享任务共识（105 行）
- `multi/conflict.ts` — ConflictDetector：文件访问冲突检测（85 行）
- `multi/orchestrator.ts` — Orchestrator：分析步骤依赖，生成执行计划 + executeWorkerIsolated（401 行）
- `multi/types.ts` — 多 Agent 协作类型定义（97 行）
- `multi/worker-executor.ts` — WorkerExecutor：执行单步骤，注入角色 prompt + 异常隔离 + 任务感知上下文裁剪（Phase 36 增强）（560 行）
- `task-orchestrator.ts` — TaskOrchestrator：统一工作流调度中心，判定 intent 并分发（Phase 31）（342 行）
- `task-orchestrator-types.ts` — Phase 31 类型定义：TaskIntent/OrchestratorStage/TaskContext/SteeringMessage（Phase 31）（205 行）
- `requirements-gatherer.ts` — RequirementsGatherer：需求确认阶段，自动确认/主动追问/规划模式（Phase 31）（已删除：Phase 59 死代码清理）
- `complexity-analyzer.ts` — TaskComplexityAnalyzer：规则层+LLM层混合复杂度评估（Phase 31）（已删除：Phase 59 死代码清理）
- `execution-orchestrator.ts` — ExecutionOrchestrator：单/多 Agent 自适应执行编排（Phase 31）（已删除：Phase 62/66/67/69 死代码清理）
- `unified-reviewer.ts` — UnifiedReviewer：两层审查（GoalVerifier + 代码审查）（Phase 31）
- `completion-gate.ts` — CompletionGate：独立代码验证门（typecheck/lint/tests）（Phase 31）
- `failure-report.ts` — 结构化失败报告，规则生成建议不调用 LLM（Phase 31）（已删除：v3.7.0 死代码清理）
- `hooks.ts` — HookRunner：扩展钩子（pre/post-tool-call + on-session-start/end）（Phase 31 扩展）
- `step-executor.ts` — AgentLoopStepExecutor：DurableExecutor 的真实步骤执行器，调用 agentLoop.run()（Phase 35）（已删除：Phase 59 死代码清理）
- `requirements-clarifier.ts` — RequirementsClarifier：LLM 模糊度分析 + 追问生成 + 规则降级（Phase 37 Task 1）（已删除：Phase 59 死代码清理）
**依赖：** router/、tools/、harness/、utils/、config/

### src/config/ — 配置系统
**职责：** YAML 配置加载 + Zod Schema 校验 + 热重载
**关键文件：**
- `schema.ts` — 全局配置 Zod Schema，配置系统的"宪法"（248 行）
- `loader.ts` — 配置加载器：YAML 解析 + 环境变量 + 全局/项目合并（163 行）
- `defaults.ts` — 默认配置值（显式可读备份）（93 行）
**依赖：** 无外部模块依赖（被所有模块引用）

### src/harness/ — 可观测性层
**职责：** Trace 收集、Audit 日志、Git 检查点、实验分支管理
**关键文件：**
- `trace-collector.ts` — Trace 收集器：被动记录 Agent 执行事件流（380 行）
- `checkpoint-manager.ts` — 检查点管理器：基于 Git 的代码快照与回滚（287 行）
- `audit-logger.ts` — 审计日志器：记录敏感/关键操作到 JSONL（178 行）
- `tracing-executor.ts` — 装饰器：为 ToolExecutorAdapter 注入 Trace + Audit（97 行）
- `trace-types.ts` — Trace 与 Audit 系统类型定义（133 行）
- `types.ts` — 检查点系统类型定义（56 行）
- `experiment-manager.ts` — ExperimentManager：基于 Git Worktree 的实验分支管理（start/run/diff/adopt/discard）（Phase 37 Task 3）
**依赖：** router/、agent/、utils/

### src/hooks/ — 内置钩子注册（Phase 35）
**职责：** 注册生产环境内置生命周期钩子（文件变更验证 + 会话生命周期日志）
**关键文件：**
- `built-in.ts` — registerBuiltinHooks()：注册 3 个内置钩子（post-tool-call 文件验证 + on-session-start/end 审计日志）
**依赖：** agent/hooks.js、harness/audit-logger.js

### src/observability/ — 轨迹导出与聚合分析（Phase 35）
**职责：** 跨会话执行轨迹导出与聚合分析（终端 UI 退役 + 死代码清理后，trajectory-exporter.ts / trajectory-aggregator.ts 已删，当前 3 个活模块）
**关键文件：**
- `analytics-queue.ts` — 分析事件队列：缓冲 + 批量 flush 跨会话指标
- `integration.ts` — 集成入口：装配 analytics-queue + otel-exporter
- `otel-exporter.ts` — OpenTelemetry 协议导出器：将 trace/metrics 推送到 OTLP endpoint
**依赖：** harness/、router/

### src/memory/ — 项目记忆
**职责：** 自动维护 .routedev/ 下的项目级记忆文件
**关键文件：**
- `project-memory.ts` — 项目记忆：自动维护 .routedev/ 目录结构（230 行）
**依赖：** utils/、config/

> **注：** `/consolidate-memory` 命令未实现为独立 slash 命令，记忆整合通过自动触发（context-manager 的 checkpoint 压缩 + project-memory 的会话级维护）。原 `/dream` 命令已在 Phase 60 删除 deprecated alias。

### src/plugins/ — 插件系统
**职责：** 四种插件类型（theme/tool/hook/router）+ 注册表 + SDK
**关键文件：**
- `types.ts` — 插件基础接口 + 四种特化类型（128 行）
- `registry.ts` — PluginRegistry：discover/load/init/destroy/enable/disable（375 行）
- `sdk.ts` — 四个 define*Plugin 辅助函数（163 行）（已删除：Phase 59 死代码清理）
- `index.ts` — 导出聚合（5 行）（已删除：Phase 59 死代码清理）
**依赖：** agent/（中间件管线）、tools/（工具注册表）、utils/

### src/prompts/ — Prompt 模板系统
**职责：** 统一管理所有 Prompt 模板（三级优先级：项目>用户>内置）
**关键文件：**
- `manager.ts` — Prompt 模板管理器（387 行）
- `types.ts` — Prompt 模板系统类型定义（75 行）
**依赖：** utils/、config/

### src/router/ — 模型路由层
**职责：** 场景分类 + 模型路由 + LLM 客户端 + Token 追踪
**关键文件：**
- `router.ts` — 模型路由器：根据分类结果选模型 + 降级策略；Phase 0c 后 provider 配置优先（306 行）
- `classifier.ts` — 混合场景分类器：规则 + LLM 分类（212 行）
- `tracker.ts` — Token 追踪器：多维度归因 + 每日重置 + 预算检查（213 行）
- `token-counter.ts` — Token 计数器：轻量估算（约 90% 精度）（121 行）
- `config.ts` — 路由配置加载：桥接 config → router（47 行）
- `types.ts` — Router 层核心类型：LLM 消息、工具调用、Token、分类、路由（243 行）
- `llm/index.ts` — LLM 客户端工厂 + 管理器（121 行）
- `llm/base.ts` — LLM 客户端基类：超时、错误标准化、重试（180 行）
- `llm/openai.ts` — OpenAI 协议客户端：非流式/流式/工具调用（311 行）
- `llm/anthropic.ts` — Anthropic 协议客户端：非流式/流式/工具调用（305 行）
**依赖：** config/、utils/

### src/tools/ — 工具框架
**职责：** 工具注册表 + 执行器 + 权限引擎 + 安全检查 + 内置工具 + MCP 集成
**关键文件：**
- `registry.ts` — 工具注册表，管理所有已注册工具（50 行）
- `executor.ts` — 工具执行器：安全检查 → 执行 → 日志（Phase 0c 后不再做权限检查）（136 行）
- `adapter.ts` — 桥梁适配器：连接 Loop 的 ToolExecutorAdapter 和工具框架（45 行）
- `permission-engine.ts` — 三层权限引擎（deny>confirm>auto）— Phase 0c 后唯一权限源；Phase 29 后 deny 规则走 parseCommand tokenize（216 行）
- `security.ts` — 安全检查器：文件路径（path.relative 防前缀绕过）、命令黑名单（tokenize 首 token 匹配）、网络域名检查（136 行）
- `command-parser.ts` — **Phase 29 新增**：shell 命令 tokenize 解析器，输出 `ParsedCommand { command, args, hasPipe, hasSubstitution, hasRedirect, raw }`，供 SecurityChecker 与 PermissionEngine 共用（55 行）
- `types.ts` — Tool 层核心类型：工具接口、注册、执行结果、安全模型（153 行）
- `builtin/file-read.ts` — 读取文件内容（权限：auto）（90 行）
- `builtin/file-write.ts` — 写入或创建文件（权限：confirm）（78 行）
- `builtin/file-search.ts` — 搜索文件内容或按名称查找（权限：auto）；Phase 29 后复用 search-utils 公共函数（137 行）
- `builtin/shell-exec.ts` — 执行 Shell 命令（权限：confirm）+ RetryPolicy + CircuitBreaker + ALLOWED_ENV_KEYS 环境变量白名单（159 行）
- `builtin/git-op.ts` — Git 操作工具（119 行）
- `builtin/web-search.ts` — 网页搜索工具（DuckDuckGo HTML）（132 行）
- `builtin/code-search.ts` — 代码搜索工具（优先 ripgrep，回退 JS）；Phase 29 后复用 search-utils 公共函数（199 行）
- `builtin/search-utils.ts` — **Phase 29 新增**：搜索工具公共函数（walkDir/isIgnoredPath/matchGlob），消除 file-search 与 code-search 的重复代码
- `builtin/spawn-agent.ts` — 子 Agent 生成工具；Phase 38 增强：对象参数签名 + subagentType 角色过滤 + 防递归工具集隔离
- `mcp/client.ts` — MCP 客户端管理器：连接 Server、发现工具、注册（168 行）
- `mcp/mcp-tool.ts` — MCP 工具包装器：将 MCP 工具注册到本地 Registry（86 行）
- `mcp/types.ts` — MCP 客户端类型定义（45 行）
- `read-tracker.ts` — **Phase 31 新增**：ReadTracker 先读后写强制，新建文件例外（fs.access 检查存在性）
- `result-sanitizer.ts` — **Phase 31 新增**：ToolResultSanitizer 工具返回内容净化（注入检测+智能截断）
**依赖：** router/、utils/、harness/

### src/utils/ — 通用工具
**职责：** 日志、路径管理、重试熔断、Token 估算、活性检测
**关键文件：**
- `logger.ts` — Winston 日志模块（错误日志 + 全量日志滚动）（52 行）
- `paths.ts` — 路径工具：管理全局/项目级数据目录（61 行）
- `retry.ts` — 重试 + 熔断工具（仅用于 LLM 调用）（101 行）
- `token-estimate.ts` — 中文感知的 Token 估算（CJK 1.5x + 其他 /4）（12 行）
- `stall-detector.ts` — 子进程活性检测器（50 行）（已删除：Phase 56 死代码清理）
**依赖：** 无（被所有模块引用）

### src/macros/ — 宏命令系统（Phase 48 Task 5）
**职责：** 轻量工作流宏，通过 `!name` 触发器引用预定义的多步操作
**关键文件：**
- `manager.ts` — MacroManager：加载 + 注册 + 触发宏
- `builtin.ts` — 内置宏定义
- `types.ts` — 宏类型定义
**触发方式：** 用户输入 `!宏名` 隐式触发，由 MacroManager 在命令解析阶段匹配并展开
**UI 状态：**
- 设置页面仅有总开关（`phase48Integration.macrosEnabled`，默认 true）
- **无宏列表 / 编辑 / 删除 UI**——Grok F-017 标注：当前只能通过手动编辑 `.routedev/macros/*.json` 增删宏，GUI 管理 UI 计划后续 Phase 补充
**依赖：** config/、utils/

### desktop/ — Electron 桌面应用（Phase 33 后）
**职责：** 图形化桌面应用，提供完整 GUI 设置页面与对话界面，替代 CLI 交互
**关键文件：**
- `main/index.ts` — Electron 主进程入口，创建窗口 + 托盘 + IPC 注册（终端 UI 退役后清理悬空 IPC handler，仅保留通过 RouteDevEngine 调用引擎的入口）
- `main/config-store.ts` — 配置持久化（读写 config.yaml）
- `main/engine-bridge.ts` — 主进程与 RouteDev 引擎桥接（sendChat 补齐三项能力：Trajectory 汇总 + CircuitBreaker 模型熔断 + 微摘要推送）
- `main/updater.ts` — 自动更新（electron-updater）
- `preload/index.ts` — preload 脚本，暴露安全 IPC API 给 renderer
- `renderer/src/App.tsx` — React 主应用组件
- `renderer/src/pages/SettingsPage.tsx` — 设置页面（12 个标签页，覆盖全部配置项）（2026-07-07 统计 693 行）
- `renderer/src/pages/settings-helpers.ts` — SettingsPage 纯函数辅助模块（Phase 33 Task 5 提取，可单测）
- `renderer/src/pages/ChatPage.tsx` — 对话页面
- `renderer/src/pages/NewTaskPage.tsx` — 新建任务页面（替代原 TokenPage / TracePage，终端 UI 退役后整合）
- `renderer/src/pages/TokenPage.tsx` — Token 用量页面（已删除：终端 UI 退役清理）
- `renderer/src/pages/TracePage.tsx` — Trace 追踪页面（已删除：终端 UI 退役清理）
- `renderer/src/components/ui/` — UI 组件库（button/card/input/label/select/switch/alert/badge/textarea/separator）
- `renderer/src/components/CheckpointTimeline.tsx` — Checkpoint 时间轴组件：竖线 + 圆点节点布局，点击高亮 + 回滚确认对话框（Phase 47 Task 6）
- `renderer/src/store/useProjectsStore.ts` — 项目状态管理（zustand）
- `shared/ipc-types.ts` — IPC 类型定义（主进程与 renderer 共享）
**依赖：** src/（通过 main/engine-bridge 调用引擎）、electron、react、zustand、lucide-react、tailwindcss

## 测试目录
测试与源码镜像组织，约 300+ 个测试文件（终端 UI 退役 + 死代码清理后）：
- `tests/agent/` — Agent 引擎测试（branch/context/deep-review/init/memory/middleware/multi/tools/vision/workflow 子目录 + 顶层）
- `tests/agents/` — Agent Profile 与子 Agent 生命周期测试（profiles/activity-store/delegation-policy/gate-lifecycle/instance-harness/result-schemas/subagent-session）
- `tests/cite/` — 引用管理测试
- `tests/code-map/` — 代码地图测试（extractor/pagerank/cross-file-resolve/watcher）
- `tests/config/` — 配置加载测试 + loader-env（Phase 29 env fail-fast）
- `tests/harness/` — 可观测性测试（audit-logger/checkpoint/trace-collector/tracing-executor + checkpoint-rollback）
- `tests/integration/` — 集成测试（conversation-flow/goal-flow/ipc-bridge/performance-benchmark + phase31-workflow/phase39-48 系列 + phase47-task1~9 + phase50/51/65-67）
- `tests/memory/` — 记忆测试（checkpoint-writer/context-manager/project-memory/compress-enhanced + bm25/provenance/reputation/unified-memory）
- `tests/phase32/` — Phase 32 接线验证测试（agent-eval/integration/safety-hardening）
- `tests/phase33/` — Phase 33 设置页面纯函数测试（settings-helpers）
- `tests/phase35/` — Phase 35 执行基础设施激活测试（durable-wiring/hook-activation/trajectory/worker-context-filter）
- `tests/phase36/` — Phase 36 上下文智能增强测试（focus-aware-pruning/mcp-codebase-integration/minimalist-skill/knowledge-clustering）
- `tests/phase37/` — Phase 37 智能交互自动化测试（requirements-clarifier/schedule-engine/background-behavior/experiment-worktree/selective-rollback/plugin-ecosystem）
- `tests/plugins/` — 插件系统测试（registry/sdk/integration/plugin-command）
- `tests/policies/` — 策略引擎测试（call-owner-coordinator/checkpoint-pipeline/policy-engine）
- `tests/prompts/` — Prompt 模板测试
- `tests/router/` — 路由层测试（classifier/config/llm/router/token-counter/tracker + classifier-fallback/llm-phase29/router-ismodelavailable）
- `tests/runtime/` — 核心运行时测试（app-init/doctor/notification/goal-integration，4 个文件）
- `tests/tools/` — 工具框架测试（adapter/advanced/builtin/mcp/permission-engine/registry/security/tool-response + command-parser/permission-engine-deny/security-command/shell-exec-env）
- `tests/utils/` — 工具测试（retry/stall-detector/token-estimate）
- `tests/scripts/` — 脚本测试（verify）

## scripts/ — 工程脚本（Phase 47 后）
- `scripts/verify.ts` — Phase 17b 验收门脚本（`pnpm tsx scripts/verify.ts`），Phase 47 Task 2 后集成 checkDescriptionLint 检查项
- `scripts/lint-descriptions.ts` — description 质量审计脚本（Phase 47 Task 2）：扫描 src/tools/builtin/*.ts 和 SKILL.md，检查 MIN_LENGTH / NO_TRIGGER / NO_VERB 规则，过渡期不阻断（陷阱 #134）
- `scripts/action-entry.ts` — GitHub Action 入口脚本（Phase 47 Task 9）：读取 INPUT_* 环境变量 → Base64 解码 config → 构造 exec 命令 → 写回 GITHUB_OUTPUT，零依赖（不引入 @actions/core，陷阱 #141）
- `scripts/perf-gate.ts` — 性能门脚本
- `scripts/build-with-retry.ts` — 构建重试脚本（Windows Defender 排除项）
- `scripts/clean-release.ts` — 发布前清理脚本
- `scripts/setup-codebase-memory.sh` — codebase-memory-mcp 二进制安装脚本

## GitHub Action（Phase 47 Task 9）
- `action.yml` — GitHub Action 定义：inputs（prompt/work-mode/allowed-tools/config）+ outputs（result）+ runs（node20 + dist/index.js），config 必须用 Base64 传输（陷阱 #141）
- `.github/workflows/routedev-example.yml` — 示例 workflow：pull_request 触发 + checkout + RouteDev read-only 审查 + 评论

## .routedev/ — 项目级配置与 Skill（Phase 47 后）
- `.routedev/skills/minimalist-coding/SKILL.md` — 极简编码优先级 Skill（Ponytail 6 层 + Karpathy 4 原则）
- `.routedev/skills/codebase-intelligence/SKILL.md` — 代码智能导航 Skill（引导使用 codebase-memory-mcp）
- `.routedev/skills/pitfalls-guide/SKILL.md` — 陷阱速查手册 Skill（Phase 47 后含 81 条陷阱：1-64 + 126-142，按 Phase 分章）
- `.routedev/commands/` — 自定义 Slash 命令目录（Phase 47 Task 7，.md 文件 frontmatter + 模板变量）
- `.routedev/tech-debt.json` — 技术债记录文件（/tech-debt 命令维护，运行时生成）

## docs/ — 文档（Phase 37 后）
- `docs/ARCHITECTURE.md` — 架构总览
- `docs/PLUGIN_GUIDE.md` — 插件开发指南
- `docs/SECURITY_AUDIT_v2.0.md` — v2.0 安全审计报告
- `docs/PLUGIN_ECOSYSTEM_RESEARCH.md` — 插件生态兼容性研究报告（Phase 37 Task 4：MCP 桥梁/约定文件/插件市场/运行时差异四维度评估）

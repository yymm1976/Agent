# RouteDev — 代码库索引（CODEMAP）
> 搜索代码前先读本文件定位目标模块，再进入具体文件。
> 最后更新：2026-06-25（Phase 47 后）

## 目录总览
- `src/index.tsx` — CLI 主入口，参数解析与启动
- `src/cli/` — CLI 界面层（Ink UI + 命令系统 + 运行器 + 插件初始化 + 装配工厂）
- `src/agent/` — Agent 引擎层（ReAct Loop + 目标分解 + 记忆 + 多 Agent + 工作模式 + 权限门控 + 需求澄清）
- `src/channels/` — 渠道集成层（Webhook 服务器 + 适配器）
- `src/config/` — 配置系统（YAML 加载 + Zod 校验 + 热重载）
- `src/harness/` — 可观测性层（Trace + Audit + Checkpoint + 实验管理）
- `src/memory/` — 项目记忆（.routedev/ 目录管理）
- `src/plugins/` — 插件系统（types + registry + sdk + filesystem-discovery）
- `src/prompts/` — Prompt 模板系统（三级优先级）
- `src/router/` — 模型路由层（分类 + 路由 + LLM 客户端 + Token 追踪）
- `src/scheduler/` — 定时调度层（cron 解析 + 任务引擎 + 持久化）（Phase 37 新增）
- `src/tools/` — 工具框架（注册表 + 执行器 + 权限引擎 + 内置工具 + MCP）
- `src/utils/` — 通用工具（日志 + 路径 + 重试 + Token 估算）
- `desktop/` — Electron 桌面应用（主进程 + preload + renderer + shared 类型）

## 模块详解

### src/cli/ — CLI 界面层
**职责：** 终端 UI 渲染、命令解析分发、聊天/目标执行编排、服务装配
**关键文件：**
- `App.tsx` — 主应用组件，整合 ChatView + StatusBar + InputBox，管理消息状态（290 行）
- `app-init.ts` — App 依赖装配工厂：createAppDependencies 集中创建所有服务实例（202 行）
- `index.tsx` — CLI 主入口，参数解析 → 配置加载 → 渲染 App 或启动 serve（87 行）
- `args.ts` — CLI 参数解析（零依赖，手动解析 process.argv）（116 行）
- `chat-runner.ts` — 聊天运行器：分类路由 → 视觉处理 → Agent Loop → Token 统计（173 行）
- `goal-runner.ts` — 目标分解与执行器：handleGoalCommand + executeGoalPlan（273 行）
- `command-registry.ts` — 命令注册表，解耦命令解析与 App.tsx（63 行）
- `service-context.ts` — 服务对象容器 + createServiceContext 单一装配入口（172 行）
- `server.ts` — 服务器模式入口（`routedev serve`），不启动 Ink UI（98 行）
- `splash.ts` — CLI 启动画面（39 行）
- `plugin-init.ts` — 插件系统初始化辅助 + registerPermissionMiddleware（98 行）
- `wizard.tsx` — 首次运行向导（5 步骤配置）（436 行）
- `completion.ts` — readline Tab 补全：命令名 + 子命令（53 行）
- `commands/index.ts` — 命令导出（按字母顺序）（23 行）
- `commands/autonomy.ts` — 自治模式切换命令：/auto /semi /manual（33 行）
- `commands/branch.ts` — 对话分支管理命令：/branch list|switch|edit（59 行）
- `commands/build.ts` / `plan.ts` / `compose.ts` — 工作模式切换命令（Phase 20）
- `commands/channels.ts` — 渠道管理命令（21 行）
- `commands/checkpoint.ts` — 检查点管理命令：/checkpoint create|list（42 行）
- `commands/clear.ts` — 清屏命令（7 行）
- `commands/config.ts` — 配置命令（15 行）
- `commands/cost.ts` — Token 用量与费用查看命令：/cost（31 行）
- `commands/dream.ts` — 记忆整理命令：/dream（20 行）；Phase 38 增强：/dream 后调用 ingestToGraph 桥接知识图谱
- `commands/goal.ts` — 目标分解与执行命令：/goal（17 行）
- `commands/help.ts` — 帮助命令（38 行）
- `commands/history.ts` — 对话历史摘要查看命令：/history（26 行）
- `commands/init.ts` — 项目分析命令：/init（24 行）
- `commands/memory.ts` — 记忆管理命令（57 行）；Phase 38 增强：/memory list/forget/feedback 子命令
- `commands/pause.ts` — 中断当前执行命令：/pause（12 行）
- `commands/plugin.ts` — 插件管理命令：/plugin list|enable|disable|info（75 行）
- `commands/prompt.ts` — Prompt 模板命令（49 行）
- `commands/quit.ts` — 退出程序命令：/quit（13 行）
- `commands/rollback.ts` — 回滚到指定检查点命令：/rollback（44 行）
- `commands/status.ts` — 系统状态命令：/status（42 行）
- `commands/token.ts` — Token 分组件分析命令：/token（Phase 30，显示五组件占比）
- `commands/trace.ts` — Trace 查看命令（44 行）
- `commands/work-modes.ts` — 工作模式命令实现（45 行）
- `commands/tech-debt.ts` — 技术债管理命令：/tech-debt add|list|resolve（Phase 36，别名 /td）（162 行）
- `commands/clarify.ts` — 需求澄清命令：/clarify（Phase 37，触发 RequirementsClarifier 追问）
- `commands/schedule.ts` — 定时任务命令：/schedule list|add|remove|pause|resume（Phase 37，别名 /cron）
- `commands/experiment.ts` — 实验分支命令：/experiment start|run|diff|adopt|discard|list（Phase 37，基于 Git Worktree）
- `commands/review.ts` — /review 对抗性审查命令：调用独立子代理对当前 diff 做审查（Phase 47 Task 5，subagentType=reviewer + isolated + 临时 read-only 沙箱兜底，陷阱 #137）
- `components/ChatView.tsx` — 对话视图组件：显示消息列表，支持流式输出（60 行）
- `components/InputBox.tsx` — 输入框组件：文本输入 + Enter 发送 + Tab 补全（59 行）
- `components/StatusBar.tsx` — 状态栏组件：显示模型、场景等级、Token 消耗、工作模式（72 行）
- `components/StepCard.tsx` — 步骤卡片组件：5 种状态（pending/running/done/skipped/failed）（58 行）
- `components/StepEditor.tsx` — 交互式步骤编辑器：reducer 纯函数 + 13 种 Action（171 行）
- `components/TracePanel.tsx` — 全链路 Trace 可视化：条形图 + 分页（297 行）
- `components/ConfigReloadUI.tsx` — 配置热重载通知：热/冷更新分类（190 行）
- `exec-runner.ts` — 非交互 exec 模式执行器：parseExecArgs 参数 → applyWorkMode 沙箱 + headless → runExec 总超时（Phase 47 Task 3，陷阱 #135，进度走 stderr / 结果走 stdout / --json 输出结构化 JSON）
- `custom-commands.ts` — 自定义 Slash 命令加载器：从 .routedev/commands/ 加载 .md，frontmatter 解析 + 模板变量一次性替换（Phase 47 Task 7，陷阱 #139，fail-open + 与内置命令冲突时 warn 并忽略）
**依赖：** agent/、router/、tools/、config/、harness/、channels/、memory/、prompts/、plugins/、utils/

### src/agent/ — Agent 引擎层
**职责：** ReAct 循环、目标分解与验证、分支管理、记忆维护、多 Agent 协作、工作模式、权限门控
**关键文件：**
- `loop.ts` — ReAct Agent Loop 核心引擎，不做路由和分类；集成中间件管线（417 行）
- `loop-config.ts` — Loop 的配置和事件类型（63 行）
- `types.ts` — Agent 层核心类型：状态、ReAct 步骤、记忆、目标（127 行）
- `middleware.ts` — Agent 中间件管线（五阶段：onAgent/onReasoning/onActing/onModelCall/onSystemPrompt）（58 行）
- `middleware/loop-detection.ts` — 循环检测中间件（检测重复工具调用并打破）（Phase 38）
- `branch.ts` — BranchManager：分支对话管理（260 行）
- `context-compaction.ts` — ContextCompactor：五阶段渐进压缩（L1-L4 零 LLM，L5 摘要）（221 行）
- `dream-consolidator.ts` — DreamConsolidator：整理记忆（合并去重）（331 行）
- `goal-parser.ts` — /goal 命令的目标分解器，LLM 拆步骤（137 行）
- `goal-types.ts` — 目标分解与验证相关类型（74 行）
- `goal-verifier.ts` — 目标完成度验证器，独立 LLM 验证 + 对抗性验证（288 行）
- `goal-gates.ts` — GoalGateManager：验收门控冻结/持久化/修改（173 行）
- `handoff.ts` — 结构化交接文件（HANDOFF.md 模式）（51 行）
- `init-analyzer.ts` — InitAnalyzer：分析项目结构，生成 .routedev-rules.md（283 行）
- `prompts.ts` — 默认 System Prompt（38 行）
- `token-profiler.ts` — TokenProfiler：分组件 token 快照（五分表：系统提示词/对话历史/工具定义/工具返回/用户消息）（Phase 30）
- `concise-thinking.ts` — 简洁思考约束：CONCISE_THINKING_BLOCK + trimToolResult + shouldSkipConcise（Phase 30 实验性）
- `vision.ts` — VisionAssistant：多模态视觉辅助（148 行）
- `work-modes.ts` — WorkModeController + GuardedToolExecutorAdapter（build/plan/compose 三模式）（180 行）
- `memory/checkpoint-writer.ts` — CheckpointWriter：独立记忆维护子 Agent（212 行）
- `memory/context-manager.ts` — 上下文管理器：token 监控 → checkpoint → 压缩（578 行）；Phase 38 增强：知识图谱跨会话持久化（.routedev/memory/knowledge-graph.json）
- `memory/graph.ts` — KnowledgeGraph：PPR + 双路径召回 + Label Propagation 社区检测 + 模式聚类 + 置信度评分（Phase 36 增强）（683 行）；Phase 38 增强：improve() 反馈 + forget() 遗忘 + recallV2() 多策略检索
- `memory/types.ts` — 增量 Checkpoint + 上下文压缩类型（110 行）
- `memory/dream-to-graph.ts` — Dream → KnowledgeGraph 信息流：归纳三步（合并同类/冲突检测/时效淘汰）（Phase 36）（236 行）
- `multi/blackboard.ts` — 公共黑板：Worker 间共享任务共识（105 行）
- `multi/conflict.ts` — ConflictDetector：文件访问冲突检测（85 行）
- `multi/orchestrator.ts` — Orchestrator：分析步骤依赖，生成执行计划 + executeWorkerIsolated（401 行）
- `multi/types.ts` — 多 Agent 协作类型定义（97 行）
- `multi/worker-executor.ts` — WorkerExecutor：执行单步骤，注入角色 prompt + 异常隔离 + 任务感知上下文裁剪（Phase 36 增强）（560 行）
- `task-orchestrator.ts` — TaskOrchestrator：统一工作流调度中心，判定 intent 并分发（Phase 31）（342 行）
- `task-orchestrator-types.ts` — Phase 31 类型定义：TaskIntent/OrchestratorStage/TaskContext/SteeringMessage（Phase 31）（205 行）
- `requirements-gatherer.ts` — RequirementsGatherer：需求确认阶段，自动确认/主动追问/规划模式（Phase 31）
- `complexity-analyzer.ts` — TaskComplexityAnalyzer：规则层+LLM层混合复杂度评估（Phase 31）
- `execution-orchestrator.ts` — ExecutionOrchestrator：单/多 Agent 自适应执行编排（Phase 31）
- `unified-reviewer.ts` — UnifiedReviewer：两层审查（GoalVerifier + 代码审查）（Phase 31）
- `completion-gate.ts` — CompletionGate：独立代码验证门（typecheck/lint/tests）（Phase 31）
- `failure-report.ts` — 结构化失败报告，规则生成建议不调用 LLM（Phase 31）
- `hooks.ts` — HookRunner：扩展钩子（pre/post-tool-call + on-session-start/end）（Phase 31 扩展）
- `step-executor.ts` — AgentLoopStepExecutor：DurableExecutor 的真实步骤执行器，调用 agentLoop.run()（Phase 35）
- `requirements-clarifier.ts` — RequirementsClarifier：LLM 模糊度分析 + 追问生成 + 规则降级（Phase 37 Task 1）
**依赖：** router/、tools/、harness/、utils/、config/

### src/channels/ — 渠道集成层
**职责：** HTTP Webhook 服务器 + 多渠道适配器（企业微信/Telegram/Slack）
**关键文件：**
- `server.ts` — WebhookServer：HTTP 服务器，监听渠道 webhook（239 行）
- `manager.ts` — ChannelManager：渠道管理器（113 行）
- `message-router.ts` — MessageRouter：渠道消息处理（classify→route→LLM→回复）（185 行）
- `types.ts` — 渠道集成层类型定义（76 行）
- `adapters/telegram.ts` — Telegram Bot Adapter（长轮询模式）（154 行）
- `adapters/wechat-work.ts` — WeChatWorkAdapter：企业微信适配器（202 行）
- `adapters/slack.ts` — SlackAdapter：HMAC-SHA256 签名验证 + 消息去重 + 10s 超时（342 行）
**依赖：** router/、config/、utils/

### src/config/ — 配置系统
**职责：** YAML 配置加载 + Zod Schema 校验 + 热重载
**关键文件：**
- `schema.ts` — 全局配置 Zod Schema，配置系统的"宪法"（248 行）
- `loader.ts` — 配置加载器：YAML 解析 + 环境变量 + 全局/项目合并（163 行）
- `defaults.ts` — 默认配置值（显式可读备份）（93 行）
- `watcher.ts` — 配置文件热重载（最终一致）（51 行）
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
**职责：** 跨会话执行轨迹导出与聚合分析
**关键文件：**
- `trajectory-exporter.ts` — TrajectoryExporter：组装单会话完整轨迹（审计 + trace + token）
- `trajectory-aggregator.ts` — TrajectoryAggregator：跨会话聚合指标（成功率/平均 token/工具使用 Top 5）
**依赖：** harness/、router/

### src/memory/ — 项目记忆
**职责：** 自动维护 .routedev/ 下的项目级记忆文件
**关键文件：**
- `project-memory.ts` — 项目记忆：自动维护 .routedev/ 目录结构（230 行）
**依赖：** utils/、config/

### src/plugins/ — 插件系统
**职责：** 四种插件类型（theme/tool/hook/router）+ 注册表 + SDK
**关键文件：**
- `types.ts` — 插件基础接口 + 四种特化类型（128 行）
- `registry.ts` — PluginRegistry：discover/load/init/destroy/enable/disable（375 行）
- `sdk.ts` — 四个 define*Plugin 辅助函数（163 行）
- `index.ts` — 导出聚合（5 行）
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

### src/scheduler/ — 定时调度层（Phase 37 新增）
**职责：** cron 表达式解析、定时任务调度、任务持久化
**关键文件：**
- `cron-parser.ts` — 自研 5 字段 cron 解析器（支持星号/数字/列表/范围/步进，不引入 node-cron）
- `types.ts` — ScheduledTask/TaskStatus/TaskExecutionRecord 类型定义
- `store.ts` — ScheduleStore：JSON 文件持久化（原子写入）
- `engine.ts` — ScheduleEngine：setInterval 调度 + fire-and-forget 触发 + 事件回调
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
- `stall-detector.ts` — 子进程活性检测器（50 行）
**依赖：** 无（被所有模块引用）

### desktop/ — Electron 桌面应用（Phase 33 后）
**职责：** 图形化桌面应用，提供完整 GUI 设置页面与对话界面，替代 CLI 交互
**关键文件：**
- `main/index.ts` — Electron 主进程入口，创建窗口 + 托盘 + IPC 注册
- `main/config-store.ts` — 配置持久化（读写 config.yaml）
- `main/engine-bridge.ts` — 主进程与 RouteDev 引擎桥接
- `main/updater.ts` — 自动更新（electron-updater）
- `preload/index.ts` — preload 脚本，暴露安全 IPC API 给 renderer
- `renderer/src/App.tsx` — React 主应用组件
- `renderer/src/pages/SettingsPage.tsx` — 设置页面（12 个标签页，覆盖全部配置项）（Phase 33 后约 2500 行）
- `renderer/src/pages/settings-helpers.ts` — SettingsPage 纯函数辅助模块（Phase 33 Task 5 提取，可单测）
- `renderer/src/pages/ChatPage.tsx` — 对话页面
- `renderer/src/pages/TokenPage.tsx` — Token 用量页面
- `renderer/src/pages/TracePage.tsx` — Trace 追踪页面
- `renderer/src/components/ui/` — UI 组件库（button/card/input/label/select/switch/alert/badge/textarea/separator）
- `renderer/src/components/CheckpointTimeline.tsx` — Checkpoint 时间轴组件：竖线 + 圆点节点布局，点击高亮 + 回滚确认对话框（Phase 47 Task 6）
- `renderer/src/store/useProjectsStore.ts` — 项目状态管理（zustand）
- `shared/ipc-types.ts` — IPC 类型定义（主进程与 renderer 共享）
**依赖：** src/（通过 main/engine-bridge 调用引擎）、electron、react、zustand、lucide-react、tailwindcss

## 测试目录
测试与源码镜像组织，共 168 个测试文件（Phase 37 后）：
- `tests/agent/` — Agent 引擎测试（branch/dream/init/multi/vision/memory 子目录 + 顶层 + loop-iserror/orchestrator-cycle/vision-phase29）
- `tests/channels/` — 渠道集成测试（server/message-router/telegram/wechat-work/slack + 安全测试 + wechat-work-phase29/slack-phase29/manager-slack）
- `tests/cli/` — CLI 界面测试（args/command-registry/completion/splash/wizard/service-context + components + commands）
- `tests/config/` — 配置加载测试 + loader-env（Phase 29 env fail-fast）
- `tests/harness/` — 可观测性测试（audit-logger/checkpoint/trace-collector/tracing-executor + checkpoint-rollback）
- `tests/integration/` — 集成测试（conversation-flow/goal-flow/channel-flow/performance-benchmark + phase31-workflow/phase39-47 系列 + phase47-task1~9 + phase47 端到端）
- `tests/memory/` — 记忆测试（checkpoint-writer/context-manager/project-memory/compress-enhanced）
- `tests/phase32/` — Phase 32 接线验证测试（agent-eval/integration/safety-hardening）
- `tests/phase33/` — Phase 33 设置页面纯函数测试（settings-helpers）
- `tests/phase35/` — Phase 35 执行基础设施激活测试（durable-wiring/hook-activation/trajectory/worker-context-filter）
- `tests/phase36/` — Phase 36 上下文智能增强测试（focus-aware-pruning/mcp-codebase-integration/minimalist-skill/knowledge-clustering）
- `tests/phase37/` — Phase 37 智能交互自动化测试（requirements-clarifier/schedule-engine/background-behavior/experiment-worktree/selective-rollback/plugin-ecosystem）
- `tests/plugins/` — 插件系统测试（registry/sdk/integration/plugin-command）
- `tests/prompts/` — Prompt 模板测试
- `tests/router/` — 路由层测试（classifier/config/llm/router/token-counter/tracker + classifier-fallback/llm-phase29/router-ismodelavailable）
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

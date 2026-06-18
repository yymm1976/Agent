# RouteDev — 代码库索引（CODEMAP）
> 搜索代码前先读本文件定位目标模块，再进入具体文件。
> 最后更新：2026-06-18（Phase 29 后）

## 目录总览
- `src/index.tsx` — CLI 主入口，参数解析与启动
- `src/cli/` — CLI 界面层（Ink UI + 命令系统 + 运行器 + 插件初始化 + 装配工厂）
- `src/agent/` — Agent 引擎层（ReAct Loop + 目标分解 + 记忆 + 多 Agent + 工作模式 + 权限门控）
- `src/channels/` — 渠道集成层（Webhook 服务器 + 适配器）
- `src/config/` — 配置系统（YAML 加载 + Zod 校验 + 热重载）
- `src/harness/` — 可观测性层（Trace + Audit + Checkpoint）
- `src/memory/` — 项目记忆（.routedev/ 目录管理）
- `src/plugins/` — 插件系统（types + registry + sdk）
- `src/prompts/` — Prompt 模板系统（三级优先级）
- `src/router/` — 模型路由层（分类 + 路由 + LLM 客户端 + Token 追踪）
- `src/tools/` — 工具框架（注册表 + 执行器 + 权限引擎 + 内置工具 + MCP）
- `src/utils/` — 通用工具（日志 + 路径 + 重试 + Token 估算）

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
- `commands/dream.ts` — 记忆整理命令：/dream（20 行）
- `commands/goal.ts` — 目标分解与执行命令：/goal（17 行）
- `commands/help.ts` — 帮助命令（38 行）
- `commands/history.ts` — 对话历史摘要查看命令：/history（26 行）
- `commands/init.ts` — 项目分析命令：/init（24 行）
- `commands/memory.ts` — 记忆管理命令（57 行）
- `commands/pause.ts` — 中断当前执行命令：/pause（12 行）
- `commands/plugin.ts` — 插件管理命令：/plugin list|enable|disable|info（75 行）
- `commands/prompt.ts` — Prompt 模板命令（49 行）
- `commands/quit.ts` — 退出程序命令：/quit（13 行）
- `commands/rollback.ts` — 回滚到指定检查点命令：/rollback（44 行）
- `commands/status.ts` — 系统状态命令：/status（42 行）
- `commands/trace.ts` — Trace 查看命令（44 行）
- `commands/work-modes.ts` — 工作模式命令实现（45 行）
- `components/ChatView.tsx` — 对话视图组件：显示消息列表，支持流式输出（60 行）
- `components/InputBox.tsx` — 输入框组件：文本输入 + Enter 发送 + Tab 补全（59 行）
- `components/StatusBar.tsx` — 状态栏组件：显示模型、场景等级、Token 消耗、工作模式（72 行）
- `components/StepCard.tsx` — 步骤卡片组件：5 种状态（pending/running/done/skipped/failed）（58 行）
- `components/StepEditor.tsx` — 交互式步骤编辑器：reducer 纯函数 + 13 种 Action（171 行）
- `components/TracePanel.tsx` — 全链路 Trace 可视化：条形图 + 分页（297 行）
- `components/ConfigReloadUI.tsx` — 配置热重载通知：热/冷更新分类（190 行）
**依赖：** agent/、router/、tools/、config/、harness/、channels/、memory/、prompts/、plugins/、utils/

### src/agent/ — Agent 引擎层
**职责：** ReAct 循环、目标分解与验证、分支管理、记忆维护、多 Agent 协作、工作模式、权限门控
**关键文件：**
- `loop.ts` — ReAct Agent Loop 核心引擎，不做路由和分类；集成中间件管线（417 行）
- `loop-config.ts` — Loop 的配置和事件类型（63 行）
- `types.ts` — Agent 层核心类型：状态、ReAct 步骤、记忆、目标（127 行）
- `middleware.ts` — Agent 中间件管线（五阶段：onAgent/onReasoning/onActing/onModelCall/onSystemPrompt）（58 行）
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
- `vision.ts` — VisionAssistant：多模态视觉辅助（148 行）
- `work-modes.ts` — WorkModeController + GuardedToolExecutorAdapter（build/plan/compose 三模式）（180 行）
- `memory/checkpoint-writer.ts` — CheckpointWriter：独立记忆维护子 Agent（212 行）
- `memory/context-manager.ts` — 上下文管理器：token 监控 → checkpoint → 压缩（578 行）
- `memory/graph.ts` — KnowledgeGraph：PPR + 双路径召回 + Label Propagation 社区检测（380 行）
- `memory/types.ts` — 增量 Checkpoint + 上下文压缩类型（110 行）
- `multi/blackboard.ts` — 公共黑板：Worker 间共享任务共识（105 行）
- `multi/conflict.ts` — ConflictDetector：文件访问冲突检测（85 行）
- `multi/orchestrator.ts` — Orchestrator：分析步骤依赖，生成执行计划 + executeWorkerIsolated（401 行）
- `multi/types.ts` — 多 Agent 协作类型定义（97 行）
- `multi/worker-executor.ts` — WorkerExecutor：执行单步骤，注入角色 prompt + 异常隔离（148 行）
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
**职责：** Trace 收集、Audit 日志、Git 检查点
**关键文件：**
- `trace-collector.ts` — Trace 收集器：被动记录 Agent 执行事件流（380 行）
- `checkpoint-manager.ts` — 检查点管理器：基于 Git 的代码快照与回滚（287 行）
- `audit-logger.ts` — 审计日志器：记录敏感/关键操作到 JSONL（178 行）
- `tracing-executor.ts` — 装饰器：为 ToolExecutorAdapter 注入 Trace + Audit（97 行）
- `trace-types.ts` — Trace 与 Audit 系统类型定义（133 行）
- `types.ts` — 检查点系统类型定义（56 行）
**依赖：** router/、agent/、utils/

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
- `mcp/client.ts` — MCP 客户端管理器：连接 Server、发现工具、注册（168 行）
- `mcp/mcp-tool.ts` — MCP 工具包装器：将 MCP 工具注册到本地 Registry（86 行）
- `mcp/types.ts` — MCP 客户端类型定义（45 行）
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

## 测试目录
测试与源码镜像组织，共 91 个测试文件（Phase 29 后）：
- `tests/agent/` — Agent 引擎测试（branch/dream/init/multi/vision/memory 子目录 + 顶层 + loop-iserror/orchestrator-cycle/vision-phase29）
- `tests/channels/` — 渠道集成测试（server/message-router/telegram/wechat-work/slack + 安全测试 + wechat-work-phase29/slack-phase29/manager-slack）
- `tests/cli/` — CLI 界面测试（args/command-registry/completion/splash/wizard/service-context + components + commands）
- `tests/config/` — 配置加载测试 + loader-env（Phase 29 env fail-fast）
- `tests/harness/` — 可观测性测试（audit-logger/checkpoint/trace-collector/tracing-executor + checkpoint-rollback）
- `tests/integration/` — 集成测试（conversation-flow/goal-flow/channel-flow/performance-benchmark）
- `tests/memory/` — 记忆测试（checkpoint-writer/context-manager/project-memory/compress-enhanced）
- `tests/plugins/` — 插件系统测试（registry/sdk/integration/plugin-command）
- `tests/prompts/` — Prompt 模板测试
- `tests/router/` — 路由层测试（classifier/config/llm/router/token-counter/tracker + classifier-fallback/llm-phase29/router-ismodelavailable）
- `tests/tools/` — 工具框架测试（adapter/advanced/builtin/mcp/permission-engine/registry/security/tool-response + command-parser/permission-engine-deny/security-command/shell-exec-env）
- `tests/utils/` — 工具测试（retry/stall-detector/token-estimate）
- `tests/scripts/` — 脚本测试（verify）

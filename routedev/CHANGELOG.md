# RouteDev 变更记录

所有版本变更记录。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [3.8.0] - 2026-06-25

### Phase 47 — 文档瘦身 / 权限双旋钮 / 非交互模式 / 子代理审查 / Checkpoint 可视化 / 自定义命令 / fallback 兼容 / GitHub Action

### Added
- **Task 1：AGENTS.md 瘦身 + pitfalls-guide Skill** — AGENTS.md 从 200+ 行瘦身至 ≤120 行，仅保留 Top 10 核心陷阱；完整 81 条陷阱（1-64 + 126-142）迁移至 `.routedev/skills/pitfalls-guide/SKILL.md`，按 Phase 分章组织
- **Task 2：description 规范 + lint 脚本** — 新增 `scripts/lint-descriptions.ts` 审计 Tool/Skill description（MIN_LENGTH / NO_TRIGGER / NO_VERB 三规则）；`verify.ts` 集成 `checkDescriptionLint` 检查项（过渡期不阻断，陷阱 #134）；新增 `docs/DESCRIPTION_GUIDE.md` 规范文档；改写全部内置工具 description 使其合规
- **Task 3：routedev exec 非交互模式** — 新增 `src/cli/exec-runner.ts` 和 `src/cli/args.ts` 的 `ExecArgs` 类型；支持 `--json` / `--allowedTools` / `--timeout` / `--workMode` / `--maxSteps` / `--output` 参数；总超时返回退出码 2（陷阱 #135）；进度走 stderr / 结果走 stdout
- **Task 4：权限双旋钮（SandboxLevel + ApprovalLevel）** — `src/tools/permission-engine.ts` 新增沙箱级（read-only / workspace-write / full-access）和审批级（always-ask / on-request / never-ask）双旋钮；沙箱级判断在审批级之前（陷阱 #136）；headless 模式下 always-ask 自动 deny；`config.example.yaml` 新增 `security.sandbox` 和 `security.approval` 配置段
- **Task 5：/review 命令** — 新增 `src/cli/commands/review.ts` 对抗性审查命令；调用独立子代理（`subagentType: 'reviewer'` + `isolated: true`）；调用前临时设为 read-only 沙箱兜底（陷阱 #137）；支持 correctness / security / performance / style 四种 focus
- **Task 6：Checkpoint 可视化与语义化摘要** — 新增 `desktop/renderer/src/components/CheckpointTimeline.tsx` 时间轴组件；`CheckpointManager` 新增 `generateSummary()` 和 `setLLMClient()` 方法，LLM 生成不超过 30 字的中文摘要；LLM 超时/失败时降级为原始 description（陷阱 #138）；Checkpoint 接口新增 `summary` 和 `stats` 字段
- **Task 7：自定义 Slash 命令** — 新增 `src/cli/custom-commands.ts` 加载器；从 `.routedev/commands/` 目录加载 .md 文件（frontmatter + 模板变量）；支持 `{{git_diff}}` / `{{git_status}}` / `{{git_branch}}` 和 `$1` 位置参数；模板变量一次性替换不递归（陷阱 #139）；与内置命令冲突时 warn 并忽略
- **Task 8：fallback 兼容** — `src/memory/project-memory.ts` 新增 `loadProjectDoc()` / `mergeDocs()` / `truncateDoc()` 函数；支持 AGENTS.md / AGENTS.local.md / AGENTS.override.md / CLAUDE.md / CLAUDE.local.md 多文件名 fallback；AGENTS.override.md 语义是「跳过」而非「合并」（陷阱 #140）；`maxBytes` 默认 32768（对齐 Codex 32KiB）
- **Task 9：GitHub Action** — 新增 `action.yml`（inputs: prompt / work-mode / allowed-tools / config；outputs: result；runs: node20 + dist/index.js）；新增 `scripts/action-entry.ts` 入口脚本（零依赖，不引入 @actions/core）；config 必须用 Base64 传输（陷阱 #141）；新增 `.github/workflows/routedev-example.yml` 示例 workflow；新增 `docs/CI_SECURITY.md` 安全规范
- **Task 10：集成测试与文档同步** — 新增 `tests/integration/phase47.test.ts` 端到端集成测试（10 个测试覆盖 Task 1-9 协同）；AGENTS.md 新增陷阱 #133-142 简版；SKILL.md 追加 Phase 47 章节（10 条陷阱完整说明）；CODEMAP.md 新增 7 个条目；CHANGELOG.md 新增 v3.8.0 条目

### Changed
- AGENTS.md 行数从 200+ 行瘦身至 74 行（≤120 行约束）
- pitfalls-guide SKILL.md 陷阱总数从 71 条增至 81 条（新增 #133-142）
- `package.json` 版本号从 3.7.0 升至 3.8.0
- `config.example.yaml` 新增 `security.sandbox` / `security.approval` / `projectDoc` 三个配置段

### Pitfalls
- 新增 10 条陷阱（#133-142），覆盖 AGENTS.md 瘦身 / description lint / exec 超时 / 沙箱级优先 / review 沙箱兜底 / Checkpoint 摘要降级 / 模板变量转义 / override 跳过语义 / Base64 传输 / 沙箱缓存刷新

## [3.7.0] - 2026-06-25

### Fixed
- IPC 桥接：9 个桩实现 IPC handler 接通真实后端（CodeGraph/Experiment/Hook）
- Hook 接线：HookConfigRegistry 加载的配置转换为 HookDefinition 并注册到 HookRunner
- HttpRegistryClient：5 个 Not implemented 方法全部实现（fetch + URL 规范化）
- token-alert.json 事件类型修复：新增 on-model-call 事件 + 白名单校验
- 5 个 CLI 命令注册：/clarify /experiment /quality /schedule /trust
- /clarify 不再引用不存在的 /clarify-enrich

### Removed
- 9 个未引用的桌面组件（BranchPanel/BranchReviewModal/ExperimentReviewModal/MessageTimeline/RequirementChangeModal/Sidebar/SubAgentCard/ThinkingSteps/ToolApprovalModal）
- 3 个零引用源文件（blackboard-extension.ts/implicit-feedback-detector.ts/failure-report.ts）
- trust-gradient.ts 中 CompactionAuditLog 和 createSandboxedRegistry 导出
- 2 个死测试（declarative-context.test.ts/entity-state.test.ts）

### Added
- HookConfig → HookDefinition 转换器（adapter.ts）含变量替换和超时
- HookEvent 白名单校验（isValidConfig）
- on-model-call 事件类型

## [3.6.0] - 2026-06-24

### Added
- 语音交互管理（VoiceManager）：STT（web-speech/whisper-local/openai-whisper/off）+ TTS（system/openai/off），支持麦克风权限检查与回退提示
- TTS 安全策略：sanitizeForTTS 移除 markdown/代码块/工具调用/reasoning 标记，只朗读最终回复
- 人格引擎接线（PersonaEngine）：intensity=none 时不注入 system prompt，动态 import + fail-open
- 用户偏好持久化接线（PreferenceManager）：显式偏好 confidence=1.0，异步加载磁盘状态
- 情绪检测器接线（EQDetector）：注册到中间件管线，动态 import + fail-open
- 新增配置段：persona（启用/强度/当前人格 ID）+ voice（STT/TTS 提供商/语言/自动朗读）+ memory（推理/自动学习/注入阈值）+ discovery（功能发现/启动提示）
- App 接线：PersonaEngine / PreferenceManager / EQDetector / VoiceManager 四模块动态 import + fail-open 接入
- 集成测试：12 个测试覆盖 Schema / Defaults / VoiceManager sanitizeForTTS / VoiceManager getFallbackMessage / PersonaEngine / PreferenceManager

## [3.5.0] - 2026-06-24

### Added
- 消息节点持久化与恢复：JSONL 格式 + 备份 + 快照
- 节点级操作补全：删除/插入/撤销/重做/批量编辑
- 需求变更 diff 与影响分析：自动检测需求变更，判断是否需要重新规划
- 消息分支与 /goal/experiment 联动：双向映射 + 结果回写
- 多分支并行实验：文件冲突检测 + 结果对比视图
- UI 增强：消息时间线 + 需求变更弹窗
- 新增配置：conversation（持久化/节点上限/撤销栈）+ experiment（并行/冲突检测/自动清理）

## [3.4.0] - 2026-06-24

### Added
- 代码地图回退方案：tree-sitter 不可用时自动切换到正则引擎（CodeMapFallback）
- 策略冲突仲裁：security > skill > hook 三级优先级，Policy block 优先于 Skill injectPrompt（PolicyArbitrator）
- 远程市场 Registry 接口预留：StubRegistryClient（空列表）+ HttpRegistryClient（待实现）+ createRegistryClient 工厂
- 新增配置段：subAgents（子 Agent 并行上限 + 角色门控）/ goal（澄清 + 确认 + 审计模式 + token 预算）/ hookEnhancement（函数级 Hook + 沙箱 + 试用期 + 分组）
- 市场配置扩展：market.registryUrl / market.registryToken（远程 Registry 拉取）
- App 接线：CodeMapFallback / PolicyArbitrator / RegistryClient 三模块动态 import + fail-open 接入
- 集成测试：12 个测试覆盖 Schema / Defaults / Fallback / Arbitrator / RegistryClient

## [3.3.0] - 2026-06-24

### Added
- 自研代码地图引擎：tree-sitter (WASM) + SQLite + PageRank + Aider 风格渲染
- 代码地图压缩：RepoDistill 预算分配
- 多 Agent 编排升级：图状态机 + 结构化 Handoff + Score Card + 编排策略 + 变量池
- Skill/Hook 市场：SKILL.md 标准 + 草稿/发布生命周期 + 导入导出
- 策略引擎：Intent Guard + Playbook + Tool Guide + Tool Approval
- 推理模式：fast / balanced / accurate 三模式切换
- 分支 UI 闭环：BranchPanel + BranchReviewModal + ToolApprovalModal
- 新增设置：代码地图引擎 / 策略引擎 / 市场 / 推理模式

## [3.2.0] - 2026-06-24

### Added
- 构建管道加固：Windows Defender 排除项 + pre-build 清理 + 重试包装
- 渐进式信任权限系统：TrustGradientManager 接线 + 五级风险分类 + 偏好持久化 + /trust 命令
- 确定性路由：deterministic 分类级别 + 规则表 + 零 LLM 快速通道
- Agent 质量监测：QualitySignalMiddleware + ImplicitFeedbackDetector + QualityAggregator + /quality 命令
- 用户经验适配层：三级经验等级 + 行为差异化 + System Prompt 注入
- 新增设置：渐进式信任 / 质量监测 / 用户体验

## [3.1.0] - 2026-06-24

### Added
- 代码地图增强：双轨制架构（内置轻量 + CodeGraph MCP 外接）
- ContextInjector 中间件：自动注入项目结构到 system prompt
- Skill AI 自动生成：自然语言描述 → SKILL.md
- 代码风格分析器：从现有代码学习编码规范
- Hook AI 自动生成：自然语言描述 → Hook 配置
- Hook 模板库：10 个常用 Hook 模板一键启用
- 分支编辑-审查-合并工作流：Git Worktree 隔离 + 选择性合并
- 分支面板 UI：实时进度 + Diff 审查模态框
- 新增设置：代码地图 / Hooks / 实验分支配置

## v3.0.0 (2026-06-23)

### Phase 38：Harness 中间件、子 Agent 工具化与知识管理增强

本版本聚焦"补齐三个系统性架构缺口"——中间件管道从 1/5 激活到 5/5、子 Agent 从硬编码管道升级为可组合工具、知识图谱从"只进不出"升级为完整反馈闭环。基于 deepagents-in-action / deer-flow / cognee / multica 四项目对标调研提取设计模式。

#### Task 1：中间件管道全面激活
- **五阶段洋葱模型**：激活 onSystemPrompt / onModelCall / onReasoning / onAgent 四个死阶段（onActing 已有），形成完整的中间件管道
- **LoopDetectionMiddleware**：检测重复工具调用循环（滑动窗口 + argsHash），3 次重复后注入系统提示打破循环
- **fail-open 策略**：四个新阶段中间件异常时记录 warn 但继续执行；onActing 保持 fail-closed
- **配置**：`middleware.loopDetection`（enabled/windowSize/maxRepeats）

#### Task 2：子 Agent 工具化与防递归增强
- **增强签名**：SpawnAgentFunction 从 `(taskDescription, options?)` 升级为 `({ description, prompt, subagentType, maxIterations, isolated })`，向后兼容旧字符串参数
- **防递归：工具集物理隔离**：子 Agent 的 ToolRegistry 是父 Agent 的 clone() 但移除 spawn_agent，物理上无法再派遣孙子 Agent（替代深度计数器方案）
- **角色工具集**：general/researcher/coder/reviewer 四种角色，每种角色有工具白名单
- **并行上限**：maxConcurrentSubAgents（默认 3），达到上限时返回错误
- **竞态修复**：不再在共享 registry 上 register/unregister，每次 spawn 创建独立 childRegistry
- **配置**：`agent.maxConcurrentSubAgents`

#### Task 3：知识图谱反馈闭环与遗忘机制
- **/dream 桥接修复**：/dream 命令现在调用 ingestToGraph()，Dream 结果流入知识图谱（之前是死代码）
- **improve() 反馈**：useful 递增 validatedCount、incorrect 标记 deprecated、unused 递增 unusedCount
- **forget() 遗忘**：按 nodeIds 或 criteria（staleFor/unusedFor/type）遗忘，入边保护，dryRun 预览
- **/memory 扩展**：新增 list / forget / feedback 子命令

#### Task 4：多策略记忆检索与图谱持久化
- **recallV2() 多策略**：semantic / graph / temporal / type_weighted / hybrid 五种策略
- **自动策略路由器**：纯关键词匹配（不调用 LLM），根据查询特征选择最佳策略
- **跨会话持久化**：知识图谱保存到 `.routedev/memory/knowledge-graph.json`，debounce 500ms
- **配置**：`knowledgeGraph`（persistence/autoForget/recall）

#### Task 5：集成测试与文档同步
- **3 个集成测试**：中间件链顺序执行 + 子 Agent 防递归 + 知识图谱完整生命周期
- **AGENTS.md**：新增陷阱 #60-64
- **CODEMAP.md**：新增 Phase 38 模块索引
- **总计新增测试**：46 个（Task 1: 12 + Task 2: 17 + Task 3+4: 17 + Task 5: 3），远超 ≥35 要求

---

## v2.9.1 (2026-06-22)

### Phase 38：全量代码审查修复与 UI 打磨

本版本基于一次全量代码审查报告，修复 7 项 Critical、28+ 项 Important 问题，并隐藏桌面端所有页面滚动条。无新功能，聚焦稳定性与安全性。

#### Critical 修复（7 项，1 项经核验为误报）
1. **企业微信适配器 sendResponse 空桩**：改为真正调用 `sendToUser(targetId, text)`，根据返回值决定 success
2. **调度存储读取异常覆盖磁盘**：`load()` 区分 ENOENT（安全初始化空数组）与解析错误（不动 cache）；`save()` 在 cache 为 null 时拒绝写入
3. **ToolExecutor 忽略 requiresConfirmation**：在 ToolExecutionContext 增加 `requestConfirmation` 回调，executor 在文件/网络/shell 安全检查后透传确认请求，无回调时安全默认拒绝
4. **SSRF DNS 级防护未接入**（经核验为误报）：`checkSSRF` 实际已在 web-fetch.ts / web-search.ts 工具层调用，executor 层的 `checkNetworkRequest` 是字符串预拦截，二者分层正确
5. **Steering Queue 只入队不出队**：ReActAgentLoop 增加 `setSteeringConsumer`，在每次迭代前后 drain steering 消息并注入上下文
6. **工具级/会话级 Hook 只注册不触发**：ReActAgentLoop 增加 `setHookRunner`，在工具调用前后、session 起止处触发钩子；DurableExecutor 的 post-step retry 加硬上限 1 次
7. **AbortSignal 流返回后未检查**：callLLMStream 返回后立即检查 `signal.aborted`，已取消时直接 yield error + done 并 return

#### Important 修复（28+ 项）
- **安全与工具**：git blame 路径边界校验、search-utils Windows 路径规范化、file-edit 批量编辑基于原文做唯一性校验、MCP client 版本号从 package.json 动态读取、command-parser 引号平衡检查
- **Agent 循环**：declarative-context 默认改为关闭（实验性功能）、对话历史窗口化（保留最近 40 条）、post-step retry 硬上限
- **路由**：degrade() 即使最低 tier 不可用也返回模型并告警（不抛错）、toModelConfig() 透传 provider 字段、isReady() 拒绝 placeholder API Key、autoApprovePatterns 默认值与 schema 对齐、parseLLMResponse 校验 tier 枚举、validateConfigFile 先替换环境变量再校验
- **渠道**：rate-limit 清理定时器在 stop() 中 clearInterval、Bearer Token 在生产环境强制校验、适配器按 id 存储（支持同类型多实例）、Telegram 长轮询改递归 setTimeout 避免重叠、fetch 加超时、调度引擎 DST 两遍计算、移除未实现的 discord 类型
- **Harness**：trajectory 导出前 flush 缓冲、checkpoint 回滚前置检查覆盖 7 种 git status 字段、检查点元数据按项目隔离、experiment 采纳前检查主工作区脏状态并自动维护 .gitignore

#### UI 打磨
- 隐藏桌面端所有页面滚动条（Webkit `display: none` + Firefox `scrollbar-width: none`），保留滚动能力不影响布局

#### 测试修复（3 项）
- `safety-hardening.test.ts`：版本号期望改为动态读取 package.json
- `wechat-work.test.ts`：sendResponse 测试 mock sendToUser 避免调用真实 API
- `experiment-worktree.test.ts`：beforeEach 预置 .gitignore 排除 .routedev/

#### 验证
- typecheck + typecheck:desktop + test（170 文件 / 2117 用例通过）+ build 全部通过

---

## v2.9.0 (2026-06-20)

### Phase 37：智能交互自动化与开发者工作流增强

本版本聚焦"让 Agent 的交互更智能、工作流更自主"——五个子任务覆盖需求澄清追问、自动化调度与后台行为控制、Git 分支实验与选择性回滚、插件生态兼容研究、集成测试与文档同步。合并了原 Phase 37（需求澄清追问与自动化调度）+ 原 Phase 38（Git 分支实验与回滚增强），并新增插件生态兼容研究维度。

#### Task 1：/goal 需求澄清追问系统
- **RequirementsClarifier**：LLM 分析目标模糊度（0~1 分数），超过阈值时生成 1-3 个澄清问题
- **降级路径**：LLM 不可用时走基于规则的模糊度检测（检查"这个/那个/优化/重构"等歧义词，每词 0.2 分）
- **enrichGoal()**：将用户回答融入原始目标，生成 enrichedGoalText
- **/clarify 命令**：手动触发需求澄清
- **配置**：`optimization.clarification`（enabled/threshold/maxQuestions/skipIfConfident），默认 threshold=0.4

#### Task 2：自动化调度与后台行为控制
- **自研 cron 解析器**：5 字段解析（minute hour dom month dow），支持星号/数字/列表/范围/步进，不引入 node-cron 依赖
- **ScheduleEngine**：setInterval 调度 + fire-and-forget 触发（不阻塞主线程）+ 事件回调
- **ScheduleStore**：JSON 文件持久化（原子写入）
- **/schedule 命令**（别名 /cron）：list/add/remove/pause/resume
- **后台行为配置**：`general.backgroundBehavior`（exit/minimize-to-tray/ask × terminate/continue-in-background/prompt），Zod refine 组合校验
- **配置**：`scheduler`（enabled/maxTasks/defaultTimezone）

#### Task 3：Git 分支实验与选择性回滚
- **ExperimentManager**：基于 Git Worktree 的实验分支管理（start/run/diff/adopt/discard/list）
- **隔离机制**：`git worktree add -b <branch> <path> HEAD` 创建隔离工作目录
- **采纳**：`git merge --no-ff` 合并到主分支，冲突时 `git merge --abort` 中止（不自动解决冲突）
- **/experiment 命令**：start/run/diff/adopt/discard/list
- **/rollback 增强**：新增 file/step/preview 子命令
  - `/rollback file <path>`：文件级回滚
  - `/rollback preview`：预览差异
  - 回滚前自动创建快照检查点，防止误操作

#### Task 4：插件生态兼容研究
- **研究报告**：`docs/PLUGIN_ECOSYSTEM_RESEARCH.md` 覆盖四个维度（MCP 桥梁/约定文件/插件市场/运行时差异）
- **核心结论**：MCP 是工具层事实标准，RouteDev 已具备接入第三方 MCP 生态的能力，无需额外适配层
- **兼容性评估表**：列出 RouteDev 与 Codex/Claude Code 在工具层、约定层、运行时层的兼容项和不兼容项
- **推荐路径**：短期复用现有 MCP 客户端；中期升级 SDK 支持 Streamable HTTP；长期实现 resources/prompts 能力

#### Task 5：集成测试与文档同步
- **6 个测试文件，43 个测试用例**（远超 ≥31 个要求）：
  - `tests/phase37/requirements-clarifier.test.ts`（12 个）：模糊度分析、追问生成、目标富化、阈值边界、降级路径
  - `tests/phase37/schedule-engine.test.ts`（15 个）：cron 解析、任务调度、持久化、时区、通知
  - `tests/phase37/background-behavior.test.ts`（7 个）：配置解析、行为映射、托盘创建、组合校验
  - `tests/phase37/experiment-worktree.test.ts`（6 个）：Worktree 创建/运行/对比/采纳/丢弃
  - `tests/phase37/selective-rollback.test.ts`（3 个）：文件级/步骤级/预览回滚
  - `tests/phase37/plugin-ecosystem.test.ts`（4 个）：MCP 工具描述兼容、服务器配置兼容、命名空间兼容、参数校验兼容
- **AGENTS.md**：新增陷阱 #55-#59（RequirementsClarifier 阈值、ScheduleEngine 不阻塞主线程、系统托盘跨平台差异、Git Worktree 检查点隔离、merge conflict 中止原则）
- **CODEMAP.md**：新增 requirements-clarifier.ts、src/scheduler/、experiment-manager.ts、clarify/schedule/experiment 命令、tests/phase37/、docs/ 索引
- **package.json**：版本号升级到 v2.9.0

---

## v2.8.0 (2026-06-20)

### Phase 36：上下文智能增强与工程方法论集成

本版本聚焦"让 Agent 的记忆与上下文处理从规则驱动升级为智能驱动"——五个子任务覆盖 MCP 代码智能集成、任务感知上下文裁剪、极简编码方法论、知识图谱归纳层、集成测试与文档同步。同时融入了 Karpathy 4 原则（编码前思考/简单优先/手术式修改/目标驱动执行）作为 minimalist-coding Skill 的执行准则。

#### Task 1：codebase-memory-mcp 集成
- **配置层**：`config.example.yaml` 新增 `mcp.servers` 配置段，预配置 codebase-memory 服务器（默认 `enabled: false`，安装后启用）
- **安装脚本**：`scripts/setup-codebase-memory.sh` 自动检测系统架构（linux/macos/windows × x64/arm64）下载二进制
- **Skill 引导**：`.routedev/skills/codebase-intelligence/SKILL.md` 引导 Agent 在代码分析场景使用 codebase-memory-mcp 的 14 个工具（codegraph_search/callers/callees/impact/explore）

#### Task 2：任务感知上下文裁剪（SWE-Pruner 启发）
- **三分类**：`classifyInfoValue()` 对消息做信息价值分类（该扔/该缓存/该存），纯工具原始输出（content 全部为 tool_result）归入"该扔"直接丢弃
- **关注点声明**：`declareFocus()` 从 `task.description` 提取 3-5 个关注点关键词（纯文本处理，零额外 token 成本）
- **M/N 相关性评分**：`filterByKeyword()` 使用 focusKeywords 计算相关性分数（score = matchedCount/keywords.length，阈值 0.2），至少保留最近 2 条消息避免过滤过激进

#### Task 3：极简编码优先级 Skill + /tech-debt 命令
- **minimalist-coding Skill**：融合 Ponytail 6 层方案选择决策树（丢弃→标准库→原生能力→已有依赖→单行→最小实现）+ Karpathy 4 条执行准则
- **/tech-debt 命令**：add/list/resolve 三个子命令，数据持久化到 `.routedev/tech-debt.json`，别名 `/td`
- **红线规则**：信任边界验证、数据丢失处理、安全性检查、可访问性永远不在砍价清单上

#### Task 4：KnowledgeGraph 模式聚类与置信度
- **clusterSimilarNodes()**：Jaccard 相似度聚类合并（同 type 节点，相似度 > 阈值则合并，保留 validatedCount 最高的，创建 supersedes 边）
- **computeConfidence()**：置信度评分 = validatedCount × timeDecay × corroborationBonus（λ=0.01，半衰期约 70 天；corroborationBonus = 1 + 0.1 × distinctSources）
- **validUntil / supersededBy**：过时知识显式标记，recall() 默认排除已 superseded 的节点，`includeSuperseded` 选项允许"时间旅行"查询
- **Dream → KnowledgeGraph 归纳三步**：`ingestToGraph()` 函数实现合并同类（Jaccard > 0.6）→ 冲突检测（标识符完全不同→superseded）→ 时效淘汰（30 天未更新→archived）

#### Task 5：集成测试与文档同步
- **4 个测试文件，45 个测试用例**（远超 ≥16 个要求）：
  - `tests/phase36/focus-aware-pruning.test.ts`（8 个）：三分类、关键词提取、相关性计算、边界条件
  - `tests/phase36/mcp-codebase-integration.test.ts`（7 个）：MCP 配置 schema、config 完整性、脚本存在性、Skill 路由
  - `tests/phase36/minimalist-skill.test.ts`（12 个）：Skill 路由、Skill 内容完整性、tech-debt CRUD、别名、边界条件
  - `tests/phase36/knowledge-clustering.test.ts`（18 个）：聚类正确性、置信度计算、recall 排序、supersedeNode、archiveStaleNodes、Dream 注入
- **AGENTS.md**：新增陷阱 #49-#54（codebase-memory 命名空间、declareFocus 不调用 LLM、confidenceScore 是计算字段、DreamConsolidator 与 KG 可选桥接、熔断模式、description 写法）
- **CODEMAP.md**：新增 tech-debt.ts、dream-to-graph.ts、tests/phase36/、.routedev/skills/ 索引

### Phase 31/32 死代码接线 + 安全加固 + outputStyle 全端适配

本版本基于代码审查报告（AUDIT-REPORT-2026-06-20）进行系统性修复，涵盖 P0 死代码接线、Important 安全修复（9 项）、Minor 健壮性修复（5 项），以及 P1 outputStyle 全端适配。

### P0：Phase 31/32 四个死代码模块接线 + TokenTracker 任务级 API

#### 四个死代码模块完整接线
- **RequirementsGatherer**（需求确认）：在 `App.tsx` `dispatchOrchestratorAction` 中接线 `gather()` 异步生成器，支持多轮交互（澄清问题 → 需求摘要 → 用户确认）
- **TaskComplexityAnalyzer**（复杂度分析）：在 development 流水线中调用 `analyze()`，规则层 + LLM 层混合评估每步复杂度
- **ExecutionOrchestrator**（执行编排）：在 development 流水线中调用 `execute()`，根据复杂度自动选择单 Agent 串行或多 Agent 并行路径
- **UnifiedReviewer**（统一审查）：在 development 流水线中调用 `review()`，两层审查（GoalVerifier + 代码审查）
- **占位 deps 修复**：`ExecutionOrchestrator` 和 `UnifiedReviewer` 的 `systemPrompt` 改为 `systemPromptRef` ref 模式，与 `App.tsx` 共享，支持运行时热更新
- **完整 development 流水线**：`dispatchOrchestratorAction` 的 development 分支从回退 ChatRunner 改为驱动完整流水线（需求确认 → 计划生成 → 复杂度分析 → 执行编排 → 统一审查）

#### TokenTracker 任务级 API 接线
- `goal-runner.ts` 接入 `startTask`/`recordTaskUsage`/`endTask` 三阶段任务级预算追踪
- 任务预算取 `config.router.budget.perRequestLimit`（默认 100000 tokens）
- 预算耗尽时中止 goal 执行，预算接近上限时发出警告
- **设计修正**：`record()` 同时负责日预算和 `taskSpent` 累加，`recordTaskUsage()` 只查询状态（避免双计数）

### P1：Phase 34 outputStyle 全端适配 + CHANGELOG 补全

#### Desktop 端 outputStyle 适配
- `ChatPage.tsx` 将 `outputStyle` 传递给 `ToolCallCard` 组件

#### CLI 组件 outputStyle 适配
- `StatusBar.tsx`：minimal 隐藏 Token/自主/模式字段，verbose 显示编排摘要
- `StepCard.tsx`：minimal 缩短描述（40 字符）+ 隐藏依赖关系，verbose 不截断
- `StepEditor.tsx`：透传 `outputStyle` 给 `StepCard`
- `App.tsx`：StatusBar 和 StepEditor 调用处传入 `outputStyle`

#### CHANGELOG 补全
- 补充缺失的 v2.6.0 条目（Phase 34：Output Style 系统/微摘要系统/动作动词体系/Repo Map/过程评测指标）

### Important：9 项安全修复

1. **权限 deny 规则大小写统一**：`deny-find-delete` 和 `deny-dd-device` 改用 `.toLowerCase()`，防止 `FIND`/`DD` 大小写绕过
2. **Bash 安全检查 Layer 7 复杂度跳过修复**：复杂度超限时仍执行 Layer 1-4（低成本正则），仅跳过 Layer 5-6 注入分析，防止空格填充绕过危险命令检测
3. **权限中间件异常 fail-closed**：`middleware.execute('onActing')` 抛异常时拒绝工具执行（原为 fail-open）
4. **Electron fs:read 符号链接绕过修复**：路径校验改用 `resolveSecurePath`（realpathSync 解析后再校验）
5. **Electron sandbox 启用**：`sandbox: true`，缩小 preload 被 XSS 利用时的攻击面
6. **saveConfig Zod 校验**：配置保存前调用 `AppConfigSchema.parse()`，防止 XSS 场景下写入恶意配置
7. **Slack webhook 签名验证修复**：通用 webhook 路径识别 Slack header（`X-Slack-Signature`/`X-Slack-Request-Timestamp`）
8. **Telegram allowedUserIds 强制要求**：生产环境未配置时拒绝所有消息（开发环境允许）
9. **Checkpoint rollback git status fail-closed**：`git.status()` 异常时中止回滚（原为继续执行 `git reset --hard`）

### Minor：5 项健壮性修复

1. **openai.ts JSON.parse 保护**：`fn?.arguments` 解析添加 try-catch，非法 JSON 时降级为空对象
2. **server.ts 错误响应脱敏**：`{ error: String(error) }` 改为通用错误消息，不泄露内部细节
3. **wechat-work.ts 解密失败返回空字符串**：避免后续 XML 解析异常（原为返回密文）
4. **plugins/registry.ts 沙箱文档**：添加注释强调仅安装可信插件
5. **CSP connect-src 收紧**：生产环境移除 `localhost:5173`（仅开发环境注入）

### 测试与验证
- 全量 typecheck 通过（`tsc --noEmit`）
- 全量测试通过：1953 passed, 1 skipped（158 个测试文件）
- 修复 6 个因本次修改导致的测试失败，更新 2 个预先存在的测试失败

## v2.7.0 (2026-06-20)

### 上下文选择性传递与执行基础设施激活
Phase 35 聚焦"让已写好的基础设施真正跑起来"——三个关键断层修复：多 Agent Worker 收到未过滤的完整对话历史（token 浪费）；HookRunner 系统写好了但从未通电（8 个事件类型零注册）；DurableExecutor 的 StepExecutor 是假桩（永远返回 success）。本 Phase 不写新功能，而是激活已有基础设施。

### Task 1：Worker 上下文选择性传递
- `WorkerExecutor` 新增 `filterContext()` 方法，在 `execute()` 内部对 `conversationHistory` 做角色感知过滤
- 三种过滤策略：tail（保留最近 N 条，默认）、keyword（关键词相关性）、budget（token 预算裁剪）
- 配置开关 `optimization.workerContext`（enabled/strategy/maxMessages/maxTokens/fallbackToFull）
- 关闭过滤时回退到完整历史透传（向后兼容）
- Blackboard 的 completedSteps 通过 systemPrompt 注入，过滤不影响协作上下文可见性

### Task 2：HookRunner 生产激活与文件变更验证
- `app-init.ts` 创建 `HookRunner` 实例并传入 `DurableExecutor`，激活 `runStepWithHooks()`
- 新增 `src/hooks/built-in.ts`，注册 3 个内置钩子：
  - `post-tool-call` 文件验证（file_write/file_edit 后做轻量验证：可读性 + 大小 + JSON 语法）
  - `on-session-start` 会话启动审计日志（action: session_start）
  - `on-session-end` 会话结束审计日志（action: session_end）
- AuditAction 类型扩展 `session_start` / `session_end`
- 验证失败返回 continue + 警告消息（不 abort，仅提醒 Agent）

### Task 3：DurableExecutor 真实接线与会话恢复
- 新增 `src/agent/step-executor.ts`，`AgentLoopStepExecutor` 替换假桩
- 真实调用 `agentLoop.run()` 执行步骤（classify → route → agentLoop.run → StepResult）
- 每个 step 从空 conversationHistory 开始（step 间隔离）
- 应用启动时调用 `listRecoverable()` 检查可恢复执行并打印提示
- 测试场景下 classifier/modelRouter 未传入时回退到桩模式（向后兼容）

### Task 4：执行轨迹导出与聚合分析
- 新增 `src/observability/trajectory-exporter.ts`，`TrajectoryExporter` 组装单会话完整轨迹（审计 + trace + token + goal 摘要）
- 新增 `src/observability/trajectory-aggregator.ts`，`TrajectoryAggregator` 计算跨会话聚合指标（成功率/平均 token/工具使用 Top 5/模型 token 分布）
- `/trace` 命令扩展 `export` 和 `summary` 两个子命令
- 导出格式为 JSON，可被外部工具解析

### Task 5：集成测试与文档同步
- 新增 41 个单元测试（4 个测试文件），覆盖全部 5 个 Task
- AGENTS.md 新增陷阱 #45-48（HookRunner trace 传递/StepExecutor 不再是假桩/Worker 过滤位置/TrajectoryExporter 数据源）
- CODEMAP.md 新增 `src/hooks/`、`src/observability/`、`src/agent/step-executor.ts` 索引
- package.json 版本号升级到 v2.7.0

## v2.6.0 (2026-06-20)

### 交互展示重塑与代码检索增强
Phase 34 聚焦"把信息密度控制权交给用户"——用 `outputStyle` 枚举（minimal/standard/verbose）替换数字 `disclosureLevel`，同时补上 Repo Map 代码检索和 Trajectory 过程评测两个架构短板。研究依据来自《Agent 工具交互展示方案研究报告》和《实用型 Coding Agent 功能体系解构与自研项目构建指南》两份深度研究报告。

### Task 1：Output Style 系统
- `OutputStyleSchema` 枚举（minimal/standard/verbose）替换 `disclosureLevel` 数字
- `UIConfigSchema` 用 `z.preprocess` 实现向后兼容：旧配置 `disclosureLevel: 1/2/3` 自动映射为 `outputStyle: minimal/standard/verbose`
- 新增 `src/cli/output-style.ts`：`outputStyleToDisclosureLevel` / `shouldShowThinking` / `shouldShowToolDetails` / `shouldShowProgress` / `shouldShowAnimation` / `shouldAutoCollapseOnComplete` 等工具函数
- 新增 `/output-style` 命令：支持 `minimal`/`standard`/`verbose` 直接切换 + `next`/`cycle` 循环 + 兼容旧版数字 1/2/3
- `DisclosureLevel` 组件新增 `outputStyle` prop，自动映射默认披露层级
- 新增 15 个测试

### Task 2：完成后折叠与微摘要系统
- 非对称折叠策略：成功 → 折叠过程 + 展示微摘要；失败 → 自动展开过程 + 高亮错误
- 新增 `src/agent/micro-summary.ts`：`extractDecisions`（`<decision>` 标签提取）+ `extractDecisionFallback`（关键词降级提取：决定/选择/采用/改为/优化/重构）+ `estimateFileChanges`（从 tool_call span 估算 +n/-n 行变更）+ `generateMicroSummary`（四要素摘要：状态/统计/关键决策/文件变更）
- 新增 `src/cli/components/MicroSummaryCard.tsx`：非对称折叠卡片，按 `d` 键切换展开/折叠
- 关键决策提取采用方案 A+C 混合：模型遵守 `<decision>` 标签时精确提取，未遵守时降级为关键词匹配
- 新增 13 个测试

### Task 3：动作动词体系与工具执行反馈
- 新增 `src/cli/tool-verb.ts`：14 种内置工具三态动词模板（file_read/write/edit, shell_exec, git_op, code_search 等），running/completed/failed 三态
- 过去时动词（`已读取`/`已修改`/`测试通过`）替代进行时，降低用户焦虑
- `buildResultSuffix` 按 outputStyle 控制结果摘要密度
- 新增 `src/cli/components/Spinner.tsx`：字符旋转动画（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏，200ms 间隔）+ 30s 阈值后显示计时器
- `chat-runner.ts` 集成：`tool_call_start` 显示进行时 + Spinner，`tool_call_result` 替换为过去时动词 + 结果摘要
- 新增 11 个测试

### Task 4：Repo Map 代码检索增强
- 选择方案 C（轻量正则）零依赖实现：正则提取 export function/class/interface/type/enum/const/let/var/default 和命名导出
- 新增 `src/tools/repo-map.ts`：`extractSignatures` / `buildRepoMap`（扫描目录树，过滤忽略路径，限制 maxFiles=200/maxSignaturesPerFile=20） / `renderRepoMap`（控制总行数）
- 新增 `src/tools/builtin/repo-map.ts`：注册为 `repo_map` 内置工具，路径边界校验防止扫描项目外目录
- 跨平台路径统一：`relativePath` 用 `.replace(/\\/g, '/')` 统一为正斜杠
- 新增 20 个测试

### Task 5：过程评测指标（Harness-level Evaluation）
- 新增 `TrajectorySummary` 接口（13 个字段：taskId/totalTokens/totalCost/toolCallCount/llmCallCount/retryCount/durationMs/success/terminationReason 等）
- `TraceCollector.summarizeTrajectory` 从 span 列表计算汇总指标，优先使用 `session.totalUsage` 覆盖 span 累加值
- `AuditLogger.logTrajectorySummary` 持久化到 JSONL，成功记录为 `success`，失败记录为 `failure`
- `chat-runner.ts` 的 `finally` 块无条件触发汇总，覆盖成功/失败/取消三种终止场景（避免幸存者偏差）
- 新增 9 个测试

### Task 6：预存 typecheck 修复
- 修复 Phase 33 遗留的 5 个 typecheck 错误（workerContext/agentLoop/disclosureLevel/chat-runner 变量作用域）

### 测试统计
- Task 1 Output Style 系统：15 个测试
- Task 2 微摘要系统：13 个测试
- Task 3 动作动词体系：11 个测试
- Task 4 Repo Map：20 个测试
- Task 5 过程评测：9 个测试
- **Phase 34 新增合计：68 个测试**（≥20 要求，超额完成 340%）

### 关键设计决策
1. **Output Style 向后兼容**：不直接删除 `disclosureLevel`，而是在 `UIConfigSchema` 外层用 `z.preprocess` 检测旧字段并自动映射，旧配置文件无需修改即可平滑迁移
2. **微摘要关键决策提取采用"可选提取"策略**：不在系统提示词中强制要求 `<decision>` 标签（避免影响所有模型输出行为），模型遵守标签时精确提取，未遵守时降级为关键词匹配
3. **Repo Map 选择方案 C（轻量正则）**：零依赖、多语言友好，精度低于 tree-sitter 但足够作为代码检索的前置地图
4. **非对称折叠策略**：成功时折叠（minimal/standard 模式），失败时强制展开，符合"成功时用户只需结果，失败时用户需要诊断信息"的直觉
5. **Trajectory 汇总触发点**：在 `chat-runner.ts` 的 `finally` 块中无条件触发，`terminationReason` 区分 completed/error/cancelled，避免幸存者偏差

### 已知预留项
1. Repo Map 预构建缓存未实现，大仓库（500+ 文件）首次扫描可能耗时 >1s
2. Desktop 端（Electron）的 outputStyle 联动未实现，当前仅 CLI 端完成
3. Spinner 组件已创建但未在 chat-runner 中实际渲染
4. 微摘要卡片的"查看 Diff"按钮未实现

## v2.5.0 (2026-06-20)

### 设置补全与默认值校准
Phase 33 聚焦 SettingsPage 的功能补全——审计发现 12 个标签页覆盖约 73% 配置项，但存在 4 个功能性残缺（MCP 表单缺字段、渠道表单缺凭据、模型编辑缺降级 ID、Checkpoint 触发器不可编辑）和 4 个完整模块零入口（goalVerifier / adversarial / updates / prompts）。本 Phase 补全所有缺失入口，并提取纯函数辅助模块支持单元测试。

### Task 1：MCP 服务器表单补全
- stdio 传输方式新增 `args`（逗号分隔）/`env`（key=value 文本框）/`cwd` 三个字段
- http 传输方式新增 `headers`（key=value 文本框）字段
- 两种传输方式通用新增 `connectTimeout` 字段（可选，留空使用默认值）
- 已有 MCP 服务器支持编辑（点击编辑按钮回填表单，复用添加表单字段结构）
- MCP 表单 state 从 `showAddMcp`+`newMcp` 简化为 `mcpForm: McpFormState | null` + `mcpEditingId: string | null`

### Task 2：渠道选项表单补全
- 根据渠道类型动态渲染凭据字段：telegram(3)、wechat-work(5)、slack(3)
- 敏感字段（corpSecret/botToken/signingSecret 等）使用 password 类型 Input + 显示/隐藏切换
- 支持 `${ENV_VAR}` 环境变量引用，配置保存时保持占位符不展开
- Discord 从 Select 下拉列表移除（适配器未实现），显示灰色提示"Discord 适配器开发中，暂不可选"
- 已有渠道支持展开编辑凭据 options

### Task 3：缺失模块与字段补全
- **goalVerifier**（4 字段）插入"记忆 & 检查点"标签页：enabled/modelId/maxTokensPerVerification/autoVerify
- **adversarial**（3 字段）插入"安全设置"标签页：enabled/threshold(slider)/modelTier(select)
- **updates**（2 字段）插入"外观"标签页通用 Card：checkOnStartup/autoUpdate 两个 Switch
- **prompts**（3 字段）插入"可观测性"标签页：projectOverrides/cacheTtlSeconds/userTemplatesDir
- 模型编辑模态新增 `fallbackModelId` 字段（模型级降级 ID）
- Checkpoint `triggers[]` 支持表格编辑（level + action + 删除/添加）
- 版本号从硬编码 `2.2.0` 修复为 `getAppVersion()` 从 package.json 读取

### Task 4：默认值校准思考
- 研究发现 3 个死配置：`gateTimeout`/`gateRetry`/`reviewStrictness` 在 schema/defaults 中定义但实际代码中未消费
- 决策：保持默认值不变，不在此 Phase 补全消费逻辑（避免范围蔓延），记录为后续优化项
- 其余 4 个问题（goalVerifier.modelId/maxToolOutputChars/triggers 阈值/adversarial.threshold）经评估当前默认值合理

### Task 5：集成测试与文档同步
- 新建 `desktop/renderer/src/pages/settings-helpers.ts`：提取 SettingsPage 配置构造逻辑为可测试纯函数
  - `parseStringList`/`parseKeyValuePairs`/`keyValueToText` — 通用解析
  - `constructMcpServer`/`mcpServerToForm` — MCP 配置构造与回填
  - `getChannelOptionFields`/`isChannelTypeSupported`/`constructChannelOptions`/`constructChannelEntry` — 渠道配置
  - `getAppVersion` — 版本号读取
- 新建 `tests/phase33/settings-helpers.test.ts`：17 个测试覆盖所有纯函数（≥15 要求）
- AGENTS.md 新增 Phase 33 陷阱 #41-44
- CODEMAP.md 新增 desktop/ 模块详解 + tests/phase33/ 条目
- package.json 版本号 v2.4.0 → v2.5.0

### 测试统计
- Task 5 纯函数测试：17 个测试（1 个文件）
- **Phase 33 新增合计：17 个测试**

### 关键设计决策
1. **纯函数提取测试策略**：项目 vitest 配置为 `environment: 'node'`，无 React 渲染依赖（`@testing-library/react`/`jsdom`）。将 SettingsPage 的配置构造逻辑提取到独立 `.ts` 模块，绕过 React 组件测试环境限制
2. **MCP 表单添加/编辑共用**：通过 `mcpForm: McpFormState | null` + `mcpEditingId: string | null` 双 state 设计，添加模式 mcpEditingId=null，编辑模式 mcpEditingId=原始 server id，复用同一表单 UI
3. **Discord 处理方案 A**：从 Select 下拉列表移除 Discord 选项（方案 B 保留选项但显示警告会导致用户困惑），底部加灰色提示文字
4. **死配置不补全**：`gateTimeout`/`gateRetry`/`reviewStrictness` 三个配置虽在 schema 中定义但代码未消费，补全消费逻辑属于功能新增而非设置补全，超出本 Phase 范围

## v2.4.0 (2026-06-20)

### 接线验证与收尾
Phase 32 聚焦"写了不接等于没写"——Phase 31 的 8 个模块全部实现并测试，但零个接入生产路径。本 Phase 的唯一目标：让已有的东西真正跑起来。同时回应审查报告的两个 Critical 发现（C1: 8 个模块 100% 死代码；C2: 安全防护层全部未通电）和 Claude 的改进建议。

### Task 1：Phase 31 模块接线（C1/C2 修复）
- **TaskOrchestrator** 接入 `App.tsx` 的 `handleSubmit`：`unifiedPipeline` 为 true 时经 orchestrator 分发，false 时回退到 ChatRunner
- **ToolResultSanitizer** 接入 `loop.ts` 的 6 个工具结果注入点（并行 3 + 串行 3）
- **ReadTracker** 接入 `GuardedToolExecutorAdapter`：先读后写守卫，新建文件例外
- **CompletionGate** 接入 `goal-runner.ts` 验证阶段：GoalVerifier 之后运行 typecheck/lint/tests
- **TokenTracker** 双计数修复：`record()` 不再累加 `taskSpent`，由 `recordTaskUsage()` 单独负责
- **filterSensitiveFields** 接入 `ToolResultSanitizer.sanitize()`：JSON 内容敏感字段脱敏
- **CacheStatsTracker** 接入 `TokenTracker`：缓存命中统计

### Task 2：缓存架构激活
- `RoutingResult.enableCache` 全局启用——所有路由结果默认 `enableCache: true`
- Anthropic 请求的 system prompt 和 tools 定义均带 `cache_control: { type: 'ephemeral' }` 标记
- `CacheAwarePromptBuilder` 和 `CacheStatsTracker` 接入生产路径

### Task 3：Agent 行为 Eval
- 分类器黄金测试集 34 条（`tests/eval/classifier-golden.json`），覆盖命令/关键词/长度/回退全路径
- 降级链 5 级测试：主模型可用 → fallback → 降 tier → 强制最低 → placeholder apiKey
- ConflictDetector 已知盲区记录：不同文件语义冲突不检测、likelyFiles 为空不检测

### Task 4：安全加固
- MCP 工具 `validateArgs()` 新增类型校验（string/number/integer/boolean/array/object/null）
- MCP 工具描述注入检测：`discoverTools()` 中用 `ToolResultSanitizer` 检测 description 中的注入模式，恶意工具跳过注册
- MCP client 版本号从硬编码 `0.8.0` 改为 `ROUTEDEV_VERSION`（`2.4.0`）
- agents.md 陷阱 #22 修正：`DeclarativeContextAcquirer`/`EntityManager` 标注为死代码
- `chat-runner.ts` 传项目上下文给分类器：`detectProjectContext()` 检测项目类型 + git 状态

### Task 5：集成测试与文档同步
- 7 个端到端接线验证测试：缓存启用、Sanitizer 注入检测+脱敏、Token 双计数修复、ReadTracker 守卫
- AGENTS.md 新增 Phase 32 陷阱 #35-40
- 版本号 v2.3.0 → v2.4.0

### 测试统计
- Task 4 安全加固：9 个测试
- Task 3 Agent Eval：44 个测试（含 34 条黄金集）
- Task 5 集成测试：7 个测试
- **Phase 32 新增合计：60 个测试**

### 依赖变更
- `vite` 5.4.21 → 6.4.3（兼容 vitest 4.x）

## v2.3.0 (2026-06-19)

### 统一工作流编排
Phase 31 聚焦"同一件事走同一条路"——把三条互不相通的执行路径（普通聊天 / /goal 命令 / /compose 模式）合并为一条智能流水线，同时激活已写好但从未使用的多 Agent 基础设施。

### Task 1：TaskOrchestrator 核心状态机
- **TaskOrchestrator**（`src/agent/task-orchestrator.ts`）：所有非命令输入的调度中心
- 四种 intent 判定：quick_answer（直达 ChatRunner）/ development（完整流水线）/ explicit_goal（/goal）/ planning（/plan）
- 状态机：idle → understanding → confirming_requirements → planning → executing → reviewing → completed
- **Steering Queue**：用户在 Agent 工作时补充指令排队交付（最大 5 条，溢出丢弃最早并通知）
- 新增 12 个测试

### Task 2：需求确认 RequirementsGatherer
- **RequirementsGatherer**（`src/agent/requirements-gatherer.ts`）：异步生成器，根据 classifier 结果选择策略
- 自动确认（medium + confidence ≥ 0.7）/ 主动追问（complex 或 confidence < 0.7）/ 规划模式（reasoning 跳过）
- LLM 失败降级为 skipped，不卡住
- GoalParser 扩展接受可选 RequirementsSummary 注入 prompt
- 新增 8 个测试

### Task 3：任务分解与复杂度评估
- **TaskComplexityAnalyzer**（`src/agent/complexity-analyzer.ts`）：规则层（快速）+ LLM 层（仅在规则无法判断时调用）混合评估
- needsSubAgent 判定：complex → true；medium + estimatedFiles > 3 → true；parallelizable → true
- 总开关：单步骤或全部 simple 时不使用子 Agent
- 新增 10 个测试

### Task 4：执行编排（单/多 Agent 自适应）
- **ExecutionOrchestrator**（`src/agent/execution-orchestrator.ts`）：根据复杂度选择单/多 Agent 路径
- 单 Agent 路径：串行执行，与现有 goal-runner 行为一致
- 多 Agent 路径：激活 Orchestrator + WorkerExecutor + Blackboard，按并行组执行
- Worker 失败不中断后续步骤（容错）
- Token 追踪正确累加多 Agent 消耗
- 进度播报格式：`[3/5] ✅ 重构认证模块 | ⏱ 12s | ~2,340 tokens`
- 新增 10 个测试

### Task 5：统一审查与验收
- **UnifiedReviewer**（`src/agent/unified-reviewer.ts`）：两层审查
- 第一层：GoalVerifier 验证（复用现有）+ 对抗性验证
- 第二层：代码审查（内置 reviewer Worker 或外部 OCR 工具）
- 三种结果路径：全通过 / 有警告 / 未通过
- 审查模式配置：builtin（默认）/ ocr / none
- 新增 8 个测试

### Task 6：生产安全防护
- **ReadTracker**（`src/tools/read-tracker.ts`）：先读后写强制，新建文件例外
- **ToolResultSanitizer**（`src/tools/result-sanitizer.ts`）：注入检测（不删除内容只加警告）+ 智能截断（优先保留错误区域）
- **CompletionGate**（`src/agent/completion-gate.ts`）：独立代码验证门（typecheck/lint/tests），超时视为 skipped
- **FailureReport**（`src/agent/failure-report.ts`）：结构化失败报告，suggestion 基于规则生成不调用 LLM
- **TokenTracker 扩展**：任务级 Token 熔断（80% 警告、100% 中止），perRequestLimit 接入 checkBudget
- **HookRunner 扩展**：pre-tool-call / post-tool-call / on-session-start / on-session-end 事件
- **系统提示词**：新增 `<execution_discipline>` 区块
- 新增 50+ 个测试

### Task 7：集成测试与文档同步
- 端到端集成测试：Quick Answer 短路、需求确认交互、Steering Queue、Read-before-Write、Prompt Injection 检测、Token 熔断、CompletionGate、FailureReport、扩展钩子、行为评估
- 文档同步：AGENTS.md（12 个新陷阱）、CODEMAP.md（10 个新文件条目）、CHANGELOG.md、config.example.yaml、package.json、README.md
- 新增 11 个集成测试

### 配置项
新增 `optimization.workflow` 和 `optimization.safety` 配置 section：
```yaml
optimization:
  workflow:
    unifiedPipeline: true           # 统一流水线开关
    autoRequirements: true          # 自动需求确认
    reviewOnComplete: true          # 完成后审查
    reviewMode: 'builtin'           # 'builtin' | 'ocr' | 'none'
    reviewModel: 'auto'             # 'auto' 或指定模型
    reviewStrictness: 'medium'      # 'low' | 'medium' | 'high'
  safety:
    readBeforeWrite: true           # 先读后写强制
    maxToolOutputChars: 16000       # 工具输出最大字符数
    completionGate: true            # 完成门开关
    gateTimeout: 180000             # 验证门总超时（毫秒）
    gateRetry: 1                    # 验证失败重试次数
```

## v2.2.0 (2026-06-18)

### 可观测性与提示词工程
Phase 30 聚焦"装水表"——给 Token 流量装分表，让每一笔开销可观测、可归因、可优化。同时把 PromptTemplateManager 正式通电，重写系统提示词为 8 区块结构。

### Task 1：Token 可观测性基础设施
- **TokenProfiler**（`src/agent/token-profiler.ts`）：每次 LLM 调用前记录五组件快照（系统提示词/对话历史/工具定义/工具返回/用户消息）
- **`/token` 命令**：实时查看分组件 token 占比分析
- **ReAct Loop 埋点**：`loop.ts` 在 LLM 调用前 yield `token_profile` 事件
- **goal-runner 修复**：补全 `setTodayTokensUsed` 调用；验证步骤和对抗性验证步骤通过 `onUsage` 回调记录 token
- **TokenTracker.checkBudget() 接入**：chat-runner 循环结束后调用预算检查
- **会话级累计**：`persistSession()` 写入 `.routedev/token-logs/`，不因上下文压缩重置（借鉴 Reasonix Layer 5）
- 新增 19 个测试

### Task 2：结构化实体状态（实验性）
- **EntityManager**（`src/agent/entity-state.ts`）：维护 taskGoal/completedSteps/currentStep/blockers/keyDecisions/modifiedFiles/env
- `toPromptBlock()` 输出 < 200 tokens 的结构化状态块
- `updateFromConversation()` 只取最近 5 条消息，避免 token 膨胀
- 默认关闭（`optimization.structuredState.enabled: false`）
- 新增 19 个测试

### Task 3：声明式上下文获取（实验性）
- **DeclarativeContextAcquirer**（`src/agent/declarative-context.ts`）：两步调用模式（声明需求 → 精准提取）
- 5 秒超时降级：超时后回退到全量上下文，不阻断流程
- complex 路由触发：仅复杂任务启用，简单任务直接走原路径
- 默认关闭（`optimization.declarativeContext.enabled: false`）
- 新增 13 个测试

### Task 4：简洁思考约束（实验性）
- **CONCISE_THINKING_BLOCK**（`src/agent/concise-thinking.ts`）：输出纪律段落注入系统提示词
- `trimToolResult()`：裁剪冗长工具返回，保留关键信息
- `shouldSkipConcise()`：关键词跳过（debug/错误分析等场景不裁剪）
- 默认关闭（`optimization.conciseThinking.enabled: false`）
- 新增 17 个测试

### Task 5：系统提示词重构
- **main.system 模板重写**为 8 区块 XML 标签结构：identity/core_rules/routing_awareness/tool_protocol/progress_narration/completion_protocol/self_correction/anti_yes_engineer
- **PromptTemplateManager 正式接入主路径**：App.tsx 改用 `systemPromptRef` 模式，useEffect 异步渲染模板
- **Fallback 机制**：渲染失败时保留 `getSystemPrompt()` 初始值，不阻断启动
- **变量扩展**：从 7 个扩展到 11 个（新增 routeDecision/entityState/conciseThinking/cwd）
- 新增 11 个测试

### 配置变更
- 新增 `optimization` 顶层 section（`src/config/schema.ts`）
- `config.example.yaml` 同步新增 optimization 配置示例

### 测试覆盖
- 新增 79 个测试（5 个测试文件）
- 全量测试通过

### 文档同步
- AGENTS.md：新增 Phase 30 陷阱（20-22）
- CODEMAP.md：新增 4 个文件条目（token-profiler/entity-state/declarative-context/concise-thinking）
- config.example.yaml：新增 optimization section

## v0.0.1 (2026-06-18)

### 初始发布版本
将版本号重置为 0.0.1，作为项目对外发布的初始版本。本版本包含经过 29 个 Phase 迭代开发的完整功能集。

## v2.1.0 (2026-06-18)

### 安全加固与收尾闭环
Phase 29 是项目的最后一个开发 Phase，回应代码审查报告发现的安全缺口，将安全性从 5/10 提升到 7/10。

### 安全修复（12 项审查问题）
- **S1/S2/S3 命令解析绕过**：引入 `command-parser.ts` tokenize 解析，替代正则/子串匹配
  - `rm -rf "/"`（引号绕过）、`RM -rf /`（大写绕过）均被阻止
  - 新增 `find -delete`、`dd of=/dev/` deny 规则
  - `python program.py` 不再被误拦（子串匹配修复）
- **S5/S6 签名验证降级**：生产模式下 token/signingSecret 未配置时拒绝请求
- **S8 PKCS#7 padding oracle**：严格验证 padding 字节一致性，上界从 32 改为 16
- **S9 环境变量占位符**：`replaceEnvVars` 改为 fail-fast，启动时报错而非运行时 401
- **S11 API Key 占位符**：OpenAI/Anthropic 客户端空 key 时不构造假客户端，`isReady()` 返回 false
- **S12 vision 路径遍历**：`startsWith` 改为 `path.relative`，防止前缀匹配绕过
- **env 注入**：shell-exec 环境变量白名单过滤，阻止 `LD_PRELOAD`/`NODE_OPTIONS` 注入

### 架构修复（4 项）
- **A1 Slack 适配器注册**：ChannelManager 补充 `slack` case 分支
- **A2 末尾 import**：`manager.ts` 末尾 import 移至顶部
- **A4 搜索工具去重**：提取 `walkDir`/`isIgnoredPath`/`matchGlob` 到 `search-utils.ts`

### 运行时健壮性（4 项）
- **B1 isError 字符串匹配**：改为结构化错误标记识别，"修复了3个错误"不再误判
- **B3 isModelAvailable 恒 true**：实现真实检查（provider 配置 + API Key）
- **B4 分类器回退 simple**：改为 `complex`（保守策略，不确定时用强模型）
- **B10 rollback 无前置检查**：添加工作区干净检查，防止丢失未提交更改
- **B13 orchestrator 静默降级**：环检测时输出警告日志

### 边界案例（2 项）
- **B6 wechat parseInt NaN**：CreateTime/agentId 非数字时使用安全默认值

### 测试覆盖
- 新增 97 个测试（16 个测试文件），覆盖所有 Phase 29 修复
- 全量测试通过

### 文档同步
- AGENTS.md：更新陷阱警告（命令解析 tokenize、签名验证生产模式、env fail-fast、rollback 前置检查）
- CODEMAP.md：新增 `command-parser.ts` 和 `search-utils.ts` 条目
- README.md：版本号更新至 v2.1.0

## v2.0.0 (2026-06-18)

### 重大里程碑
经过 28 个 Phase 的迭代开发，RouteDev 正式发布 v2.0.0，达到商业交付标准。

### 核心能力
- **智能路由**：场景分类 → 模型选择 → 成本优化，全链路自动化
- **ReAct Agent Loop**：流式思考-行动循环，支持工具调用和多步任务
- **多 Agent 编排**：Orchestrator 分解任务，Worker 并行执行
- **Compose 管线**：需求→编码→测试→审查全流程自动编排
- **DurableExecutor**：长任务断点恢复，不怕中断
- **7 层安全防护**：权限→目录→命令→文件→网络→进程→审计
- **渐进式上下文**：5 阶段压缩 + 知识图谱 + 梦境整合
- **插件系统**：Theme/Tool/Hook/Router 四类插件，社区可扩展
- **渠道集成**：Telegram / Slack / 企业微信 / Discord

### Phase 28（质量验收与发布准备）
- 10 个 E2E 用户旅程测试
- 性能基线强制门（8 项指标）
- 安全终审（9 项审计，23 个测试）
- 测试覆盖率强化（33 个边界条件测试）
- 完整文档（CHANGELOG / ARCHITECTURE / PLUGIN_GUIDE / SECURITY_AUDIT）
- 蓝图合规度终审 ≥ 95%
- 版本号升级至 v2.0.0

### Phase 27（产品完善与商业交付标准）
- DurableExecutor 运行时集成 + /resume 交互式 UI
- RouterPlugin / ThemePlugin 接入
- 插件状态持久化
- DiffView 动作绑定（apply/reject）
- 通知持久化到审计日志
- Compose + HookRunner TracePanel 可视化
- notes.md 模块（Agent 唯一写通道）

### Phase 26（技术债务清零与架构加固）
- 路径遍历漏洞修复（code-search / file-search）
- 企业微信凭据脱敏
- ServiceContext 类型安全（消除 as any）
- /permissions 命令反映运行时规则
- 异步 I/O 替换同步写入（tracker / durable-executor）
- 自定义错误类体系（RouteDevError + 6 子类）
- 提示词模板五块结构改造

## v1.4.0 (2026-06-18)
Phase 27 完成版本。

## v1.3.0 (2026-06-18)
Phase 26 完成版本。

## v1.2.0 (2026-06-18)
Phase 25（UI 与交互优化）完成版本。

## v1.1.0 (2026-06-18)
Phase 24（功能补全与产品完善）完成版本。包含 CLI 设计系统、Compose 管线、DurableExecutor、HookRunner、/permissions、提示词规范、错误消息、Provider 校验等 8 个模块。

## v1.0.1 (2026-06-18)
Phase 0c（审计修复）完成版本。统一权限引擎、拆分 inferProviderId、收敛 App 组装、同步文档。

## v1.0.0 (2026-06-18)
Phase 20-23 完成版本。WorkModeController 三模式权限矩阵、PermissionEngine 三层权限、四类插件系统、TracePanel、SlackAdapter、SetupWizard 等。

## v0.8.0 - v0.1.0 (2026-06-17 ~ 2026-06-18)
Phase 01-19 迭代版本，涵盖项目骨架、核心类型、Router 层、CLI 对话、Agent Loop、工具框架、MCP 客户端、自主模式、检查点系统、多模态视觉、渠道集成、多 Agent 基础、可观测性、Prompt 模板系统、App 重构等。
